from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .approved_web import (
    fetch_approved_web_context,
    get_tool_config,
    normalize_allowed_urls,
    should_use_approved_web_context,
)
from .agent_memory import (
    append_message,
    build_history_context,
    build_response_cache_key,
    create_conversation,
    get_agent,
    list_messages,
    lookup_cached_response,
    seed_default_agent_profiles,
    store_cached_response,
)
from .database import SessionLocal, get_session
from .models import AgentConversationRecord, ChatUploadRecord
from .runtime import (
    LlmCompletionResult,
    generate_answer,
    resolve_llm_connection,
    seed_default_connections,
    should_use_openai_responses_chain,
    stream_answer,
    stream_answer_to_result,
)
from .runtime_defaults import resolve_query_top_k
from .runtime_profiles import resolve_agent_runtime_profile, resolve_corpora
from .schemas import ChatRequest, ChatResponse, ChatToolEvent, ChatUsage
from .token_usage import estimate_llm_turn_usage_dict
from .service_common import build_app
from .settings import get_settings
from .telemetry import log_instant_event
from .tool_registry import build_tool_readiness_summary, execute_tool_operation_for_agent

settings = get_settings()


def _effective_chat_model_id(body: ChatRequest, llm_config: dict) -> str:
    override = (body.llm_model_id or "").strip()
    if override:
        return override
    return str(llm_config.get("model_id", ""))


PROMPT_TRIM_MARKER = "\n...[trimmed for prompt budget]...\n"
USER_QUESTION_MARKER = "\n\nUser question:"
CHAT_COMPLETIONS_CONTEXT_LIMIT_TOKENS = 8192
CHAT_COMPLETIONS_COMPLETION_TOKEN_CAP = 4096
CHAT_COMPLETIONS_CONTEXT_SAFETY_TOKENS = 512

# OpenAI native /v1/responses is only used when talking to api.openai.com.
# For other OpenAI-compatible gateways, we route through chat completions semantics and must clamp.
OPENAI_NATIVE_RESPONSES_MAX_OUTPUT_TOKEN_CAP = 4096


@dataclass(frozen=True, slots=True)
class AnswerPromptBudget:
    name: str
    max_total_chars: int
    max_history_chars: int
    max_upload_chars: int
    max_approved_web_chars: int
    max_query_chars: int
    query_prefix_compaction_mode: str = "middle"


@dataclass(frozen=True, slots=True)
class PreparedAnswerPrompt:
    budget_name: str
    prompt: str
    original_chars: int
    total_chars: int
    compacted: bool
    trimmed_sections: tuple[str, ...]
    history_chars: int
    upload_chars: int
    approved_web_chars: int
    query_chars: int


@dataclass(frozen=True, slots=True)
class PreparedToolEvidence:
    plan: dict[str, Any]
    prompt_prefix: str
    citations: list[dict[str, Any]]
    tool_events: list[ChatToolEvent]
    can_cache_response: bool


RESPONSES_PRIMARY_ANSWER_PROMPT_BUDGET = AnswerPromptBudget(
    name="responses.primary",
    max_total_chars=18000,
    max_history_chars=1200,
    max_upload_chars=3000,
    max_approved_web_chars=2000,
    max_query_chars=9000,
    query_prefix_compaction_mode="middle",
)
RESPONSES_RETRY_ANSWER_PROMPT_BUDGET = AnswerPromptBudget(
    name="responses.retry",
    max_total_chars=12000,
    max_history_chars=400,
    max_upload_chars=1800,
    max_approved_web_chars=1200,
    max_query_chars=6500,
    query_prefix_compaction_mode="middle",
)
CHAT_COMPLETIONS_PRIMARY_ANSWER_PROMPT_BUDGET = AnswerPromptBudget(
    name="chat_completions.primary",
    max_total_chars=5200,
    max_history_chars=300,
    max_upload_chars=900,
    max_approved_web_chars=600,
    max_query_chars=3600,
    query_prefix_compaction_mode="head",
)
CHAT_COMPLETIONS_RETRY_ANSWER_PROMPT_BUDGET = AnswerPromptBudget(
    name="chat_completions.retry",
    max_total_chars=2800,
    max_history_chars=0,
    max_upload_chars=450,
    max_approved_web_chars=0,
    max_query_chars=1800,
    query_prefix_compaction_mode="head",
)

# Backwards-compatible aliases for tests and local helpers that use the default responses path.
PRIMARY_ANSWER_PROMPT_BUDGET = RESPONSES_PRIMARY_ANSWER_PROMPT_BUDGET
RETRY_ANSWER_PROMPT_BUDGET = RESPONSES_RETRY_ANSWER_PROMPT_BUDGET


def _normalize_tool_plan(raw_plan: dict[str, Any] | None) -> dict[str, Any]:
    normalized = dict(raw_plan or {})
    normalized.setdefault("tool_id", "odoo_primary")
    normalized.setdefault("mode", "none")
    normalized.setdefault("operation", None)
    normalized.setdefault("payload", {})
    normalized.setdefault("reason", "")
    normalized.setdefault("blocked_reason", None)
    normalized.setdefault("company_scope", {})
    normalized.setdefault("source_labels", [])
    normalized.setdefault("direct_answer", None)
    return normalized


def _safe_json(value: Any, *, max_chars: int = 2400) -> str:
    text = json.dumps(value, indent=2, sort_keys=True, default=str)
    if len(text) <= max_chars:
        return text
    return text[: max_chars - len(PROMPT_TRIM_MARKER)] + PROMPT_TRIM_MARKER


def _tool_citation_from_event(event: ChatToolEvent) -> dict[str, Any]:
    artifact_type = {
        "preview": "tool_preview",
        "blocked": "tool_blocked",
        "failed": "tool_failed",
        "executed": "tool_result",
        "planned": "tool_planned",
    }.get(event.status, "tool_result")
    label = event.operation or event.tool_id
    return {
        "document_id": f"tool:{event.tool_id}:{label}:{event.status}",
        "filename": f"Odoo {label}",
        "corpus": "external",
        "artifact_type": artifact_type,
        "source_path": f"/api/tools/{event.tool_id}/execute",
        "source_type": "tool",
        "title": f"Odoo {event.status}: {label}",
        "summary": event.summary,
        "operation": event.operation,
        "tool_id": event.tool_id,
        "tool_status": event.status,
    }


def _summarize_tool_payload(tool_response_data: dict[str, Any]) -> str:
    parts: list[str] = []
    if isinstance(tool_response_data.get("count"), int):
        parts.append(f"count={tool_response_data['count']}")
    records = tool_response_data.get("records")
    if isinstance(records, list):
        parts.append(f"records={len(records)}")
    rows = tool_response_data.get("rows")
    if isinstance(rows, list):
        parts.append(f"rows={len(rows)}")
    if tool_response_data.get("total_residual") is not None:
        parts.append(f"total_residual={tool_response_data['total_residual']}")
    if tool_response_data.get("revenue") is not None:
        parts.append(f"revenue={tool_response_data['revenue']}")
    if tool_response_data.get("cogs") is not None:
        parts.append(f"cogs={tool_response_data['cogs']}")
    if tool_response_data.get("gp") is not None:
        parts.append(f"gp={tool_response_data['gp']}")
    model = str(tool_response_data.get("model") or "").strip()
    if model:
        parts.append(f"model={model}")
    return ", ".join(parts) if parts else "tool response available"


def _format_tool_result_for_prompt(*, operation: str, payload: dict[str, Any], message: str, data: dict[str, Any]) -> str:
    if operation == "odoo.finance.margin.period_summary":
        return "\n".join(
            [
                "Executed Odoo period margin summary:",
                f"- revenue: {data.get('revenue')}",
                f"- cogs: {data.get('cogs')}",
                f"- gp: {data.get('gp')}",
                f"- gp_pct: {data.get('gp_pct')}",
                f"- date_from: {data.get('date_from')}",
                f"- date_to: {data.get('date_to')}",
            ]
        ).strip()

    if operation == "odoo.finance.margin.monthly_comparison":
        lines = [
            "Executed Odoo monthly margin comparison:",
            f"- date_from: {data.get('date_from')}",
            f"- date_to: {data.get('date_to')}",
            "- monthly rows:",
        ]
        for row in list(data.get("rows") or [])[:8]:
            if not isinstance(row, dict):
                continue
            lines.append(
                "  - "
                + " | ".join(
                    [
                        str(row.get("company_name") or row.get("company_id") or "company"),
                        str(row.get("month") or ""),
                        f"revenue={row.get('revenue')}",
                        f"cogs={row.get('cogs')}",
                        f"gp={row.get('gp')}",
                        f"gp_pct={row.get('gp_pct')}",
                    ]
                )
            )
        anomalies = list(data.get("anomalies") or [])
        if anomalies:
            lines.append("- anomaly candidates:")
            for anomaly in anomalies[:6]:
                if not isinstance(anomaly, dict):
                    continue
                lines.append(
                    "  - "
                    + " | ".join(
                        [
                            str(anomaly.get("company_name") or anomaly.get("company_id") or "company"),
                            str(anomaly.get("month") or ""),
                            str(anomaly.get("metric") or "metric"),
                            f"delta_pct={anomaly.get('delta_pct')}",
                            str(anomaly.get("reason") or ""),
                        ]
                    )
                )
        return "\n".join(lines).strip()

    if operation == "odoo.finance.cogs.monthly_code_breakdown":
        lines = [
            "Executed Odoo monthly COGS code breakdown:",
            f"- date_from: {data.get('date_from')}",
            f"- date_to: {data.get('date_to')}",
            "- monthly buckets:",
        ]
        for bucket in list(data.get("buckets") or [])[:6]:
            if not isinstance(bucket, dict):
                continue
            lines.append(
                "  - "
                + " | ".join(
                    [
                        str(bucket.get("company_name") or bucket.get("company_id") or "company"),
                        str(bucket.get("month") or ""),
                        f"total_cogs={bucket.get('total_cogs')}",
                    ]
                )
            )
            for code_row in list(bucket.get("top_codes") or [])[:3]:
                if not isinstance(code_row, dict):
                    continue
                lines.append(
                    "    - "
                    + " | ".join(
                        [
                            str(code_row.get("account_code") or code_row.get("account_id") or "account"),
                            str(code_row.get("account_name") or ""),
                            f"cogs={code_row.get('cogs')}",
                        ]
                    )
                )
        anomalies = list(data.get("anomalies") or [])
        if anomalies:
            lines.append("- anomaly candidates:")
            for anomaly in anomalies[:6]:
                if not isinstance(anomaly, dict):
                    continue
                lines.append(
                    "  - "
                    + " | ".join(
                        [
                            str(anomaly.get("company_name") or anomaly.get("company_id") or "company"),
                            str(anomaly.get("month") or ""),
                            str(anomaly.get("account_code") or anomaly.get("account_id") or "account"),
                            str(anomaly.get("account_name") or ""),
                            f"cogs={anomaly.get('cogs')}",
                            f"previous_cogs={anomaly.get('previous_cogs')}",
                            f"delta_pct={anomaly.get('delta_pct')}",
                            str(anomaly.get("reason") or ""),
                        ]
                    )
                )
        return "\n".join(lines).strip()

    return (
        "Executed Odoo result:\n"
        + _safe_json(
            {
                "operation": operation,
                "data": data,
            },
            max_chars=1600,
        )
    )


def _build_tool_prompt_prefix(tool_events: list[ChatToolEvent], details: list[str]) -> str:
    if not tool_events and not details:
        return ""
    sections = ["Tool evidence:"]
    for event in tool_events:
        line = f"- {event.status}: {event.operation or event.tool_id}"
        if event.summary:
            line += f" | {event.summary}"
        sections.append(line)
    if details:
        sections.append("Tool details:\n" + "\n\n".join(details))
    return "\n\n".join(section.strip() for section in sections if section.strip())


def _coerce_monthly_margin_company_ids(
    payload: dict[str, Any],
    revenue_data: dict[str, Any],
    cogs_data: dict[str, Any],
) -> list[int]:
    explicit_ids = [value for value in list(payload.get("company_ids") or []) if isinstance(value, int)]
    if explicit_ids:
        return explicit_ids
    if isinstance(payload.get("company_id"), int):
        return [int(payload["company_id"])]
    seen_ids: list[int] = []
    for data in (revenue_data, cogs_data):
        for row in list(data.get("rows") or []):
            if not isinstance(row, dict):
                continue
            company_field = row.get("company_id")
            if not isinstance(company_field, (list, tuple)) or not company_field:
                continue
            try:
                company_id = int(company_field[0])
            except (TypeError, ValueError):
                continue
            if company_id not in seen_ids:
                seen_ids.append(company_id)
    return seen_ids


def _extract_month_value(row: dict[str, Any], key: str) -> str:
    value = row.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    range_block = row.get("__range")
    if isinstance(range_block, dict):
        range_value = range_block.get(key)
        if isinstance(range_value, dict):
            start_value = range_value.get("from")
            if isinstance(start_value, str) and start_value:
                return start_value
    return "unknown"


def _synthesize_monthly_margin_comparison(
    *,
    payload: dict[str, Any],
    revenue_data: dict[str, Any],
    cogs_data: dict[str, Any],
) -> dict[str, Any]:
    company_name_by_id: dict[int, str] = {}
    for raw_map in (revenue_data.get("company_name_by_id"), cogs_data.get("company_name_by_id")):
        if not isinstance(raw_map, dict):
            continue
        for key, value in raw_map.items():
            try:
                company_id = int(key)
            except (TypeError, ValueError):
                continue
            if value:
                company_name_by_id[company_id] = str(value)

    revenue_by_key: dict[tuple[int, str], float] = {}
    for row in list(revenue_data.get("rows") or []):
        if not isinstance(row, dict):
            continue
        company_field = row.get("company_id")
        if not isinstance(company_field, (list, tuple)) or not company_field:
            continue
        try:
            company_id = int(company_field[0])
        except (TypeError, ValueError):
            continue
        month_key = _extract_month_value(row, "invoice_date:month")
        revenue_by_key[(company_id, month_key)] = float(row.get("amount_untaxed_signed") or 0.0)
        if len(company_field) > 1 and company_field[1]:
            company_name_by_id.setdefault(company_id, str(company_field[1]))

    cogs_by_key: dict[tuple[int, str], float] = {}
    for row in list(cogs_data.get("rows") or []):
        if not isinstance(row, dict):
            continue
        company_field = row.get("company_id")
        if not isinstance(company_field, (list, tuple)) or not company_field:
            continue
        try:
            company_id = int(company_field[0])
        except (TypeError, ValueError):
            continue
        month_key = _extract_month_value(row, "date:month")
        cogs_by_key[(company_id, month_key)] = float(row.get("balance") or 0.0)
        if len(company_field) > 1 and company_field[1]:
            company_name_by_id.setdefault(company_id, str(company_field[1]))

    months_seen = sorted({month for (_company_id, month) in {*revenue_by_key.keys(), *cogs_by_key.keys()}})
    company_ids = _coerce_monthly_margin_company_ids(payload, revenue_data, cogs_data)
    comparison_rows: list[dict[str, Any]] = []
    company_summaries: list[dict[str, Any]] = []

    for company_id in company_ids:
        running_gp = 0.0
        monthly_rows: list[dict[str, Any]] = []
        previous_gp: float | None = None
        anomalies: list[dict[str, Any]] = []
        for month_key in months_seen:
            revenue = revenue_by_key.get((company_id, month_key), 0.0)
            cogs = cogs_by_key.get((company_id, month_key), 0.0)
            gp = revenue - cogs
            gp_pct = (gp / revenue) if revenue else 0.0
            row = {
                "company_id": company_id,
                "company_name": company_name_by_id.get(company_id, str(company_id)),
                "month": month_key,
                "revenue": revenue,
                "cogs": cogs,
                "gp": gp,
                "gp_pct": gp_pct,
            }
            if previous_gp is not None and previous_gp:
                gp_delta_pct = (gp - previous_gp) / abs(previous_gp)
                row["gp_delta_pct"] = gp_delta_pct
                if abs(gp_delta_pct) >= 0.2:
                    anomalies.append(
                        {
                            "company_id": company_id,
                            "company_name": company_name_by_id.get(company_id, str(company_id)),
                            "month": month_key,
                            "metric": "gp",
                            "delta_pct": gp_delta_pct,
                            "reason": "GP moved more than 20% versus prior month.",
                        }
                    )
            monthly_rows.append(row)
            comparison_rows.append(row)
            running_gp += gp
            previous_gp = gp
        total_revenue = sum(item["revenue"] for item in monthly_rows)
        company_summaries.append(
            {
                "company_id": company_id,
                "company_name": company_name_by_id.get(company_id, str(company_id)),
                "months": monthly_rows,
                "total_revenue": total_revenue,
                "total_cogs": sum(item["cogs"] for item in monthly_rows),
                "total_gp": running_gp,
                "avg_gp_pct": (running_gp / total_revenue) if total_revenue else 0.0,
                "anomalies": anomalies,
            }
        )

    return {
        "result_type": "monthly_margin_comparison",
        "date_from": revenue_data.get("date_from"),
        "date_to": revenue_data.get("date_to"),
        "months": revenue_data.get("months"),
        "company_ids": company_ids,
        "company_name_by_id": company_name_by_id,
        "rows": comparison_rows,
        "companies": company_summaries,
        "anomalies": [item for company in company_summaries for item in list(company.get("anomalies") or [])],
        "revenue_source": revenue_data,
        "cogs_source": cogs_data,
    }


def _fallback_monthly_margin_comparison(
    session: Session,
    *,
    agent_id: str,
    payload: dict[str, Any],
    tool_overrides: dict[str, bool] | None,
) -> tuple[ChatToolEvent, str] | None:
    revenue_response, _readiness = execute_tool_operation_for_agent(
        session,
        agent_id=agent_id,
        operation="odoo.finance.revenue.monthly",
        payload=payload,
        tool_overrides=tool_overrides,
        surface="consumer_chat",
    )
    cogs_response, _readiness = execute_tool_operation_for_agent(
        session,
        agent_id=agent_id,
        operation="odoo.finance.cogs.monthly",
        payload=payload,
        tool_overrides=tool_overrides,
        surface="consumer_chat",
    )
    if not revenue_response.success or not cogs_response.success:
        return None
    synthesized = _synthesize_monthly_margin_comparison(
        payload=payload,
        revenue_data=dict(revenue_response.data or {}),
        cogs_data=dict(cogs_response.data or {}),
    )
    event = ChatToolEvent(
        tool_id="odoo_primary",
        status="executed",
        operation="odoo.finance.margin.monthly_comparison",
        summary="Monthly comparison synthesized from `odoo.finance.revenue.monthly` and `odoo.finance.cogs.monthly` fallback.",
        payload=payload,
        latency_ms=(revenue_response.latency_ms or 0) + (cogs_response.latency_ms or 0),
    )
    detail = (
        "Named helper fallback used because `odoo.finance.margin.monthly_comparison` was unavailable in the live stack.\n"
        + _format_tool_result_for_prompt(
            operation="odoo.finance.margin.monthly_comparison",
            payload=payload,
            message="Synthesized from monthly revenue and monthly COGS fallback operations.",
            data=synthesized,
        )
    )
    return event, detail


def prepare_tool_evidence(
    session: Session,
    *,
    agent_id: str,
    tool_overrides: dict[str, bool] | None,
    tool_plan: dict[str, Any] | None,
) -> PreparedToolEvidence:
    normalized_plan = _normalize_tool_plan(tool_plan)
    mode = str(normalized_plan.get("mode") or "none")
    operation = str(normalized_plan.get("operation") or "").strip() or None
    payload = dict(normalized_plan.get("payload") or {})
    blocked_reason = str(normalized_plan.get("blocked_reason") or "").strip() or None
    reason = str(normalized_plan.get("reason") or "").strip()

    if mode == "none" or not operation:
        return PreparedToolEvidence(
            plan=normalized_plan,
            prompt_prefix="",
            citations=[],
            tool_events=[],
            can_cache_response=True,
        )

    tool_events: list[ChatToolEvent] = []
    citations: list[dict[str, Any]] = []
    detail_blocks: list[str] = []

    if mode == "preview":
        event = ChatToolEvent(
            tool_id=str(normalized_plan.get("tool_id") or "odoo_primary"),
            status="preview",
            operation=operation,
            summary=reason or "Operation preview only; no Odoo execution performed.",
            payload=payload,
        )
        tool_events.append(event)
        citations.append(_tool_citation_from_event(event))
        detail_blocks.append(f"Preview only. Canonical operation payload:\n{_safe_json({'operation': operation, 'payload': payload})}")
        return PreparedToolEvidence(
            plan=normalized_plan,
            prompt_prefix=_build_tool_prompt_prefix(tool_events, detail_blocks),
            citations=citations,
            tool_events=tool_events,
            can_cache_response=False,
        )

    if blocked_reason:
        event = ChatToolEvent(
            tool_id=str(normalized_plan.get("tool_id") or "odoo_primary"),
            status="blocked",
            operation=operation,
            summary=reason or "Odoo execution blocked before dispatch.",
            blocked_reason=blocked_reason,
            payload=payload,
        )
        tool_events.append(event)
        citations.append(_tool_citation_from_event(event))
        return PreparedToolEvidence(
            plan=normalized_plan,
            prompt_prefix=_build_tool_prompt_prefix(tool_events, []),
            citations=citations,
            tool_events=tool_events,
            can_cache_response=False,
        )

    tool_response, _readiness = execute_tool_operation_for_agent(
        session,
        agent_id=agent_id,
        operation=operation,
        payload=payload,
        tool_overrides=tool_overrides,
        surface="consumer_chat",
    )
    if tool_response.success:
        summary = _summarize_tool_payload(tool_response.data)
        event = ChatToolEvent(
            tool_id=str(normalized_plan.get("tool_id") or "odoo_primary"),
            status="executed",
            operation=operation,
            summary=summary,
            payload=payload,
            latency_ms=tool_response.latency_ms,
        )
        tool_events.append(event)
        citations.append(_tool_citation_from_event(event))
        detail_blocks.append(
            _format_tool_result_for_prompt(
                operation=operation,
                payload=payload,
                message=tool_response.message,
                data=tool_response.data,
            )
        )
    else:
        fallback_result: tuple[ChatToolEvent, str] | None = None
        if (
            operation == "odoo.finance.margin.monthly_comparison"
            and "unsupported odoo operation" in str(tool_response.message or "").casefold()
        ):
            fallback_result = _fallback_monthly_margin_comparison(
                session,
                agent_id=agent_id,
                payload=payload,
                tool_overrides=tool_overrides,
            )
        if fallback_result is not None:
            event, detail = fallback_result
            tool_events.append(event)
            citations.append(_tool_citation_from_event(event))
            detail_blocks.append(detail)
            return PreparedToolEvidence(
                plan=normalized_plan,
                prompt_prefix=_build_tool_prompt_prefix(tool_events, detail_blocks),
                citations=citations,
                tool_events=tool_events,
                can_cache_response=False,
            )
        blocked_reasons = list((tool_response.data or {}).get("blocked_reasons") or [])
        event = ChatToolEvent(
            tool_id=str(normalized_plan.get("tool_id") or "odoo_primary"),
            status="blocked" if "blocked_reasons" in (tool_response.data or {}) else "failed",
            operation=operation,
            summary=tool_response.message,
            blocked_reason=blocked_reason or (blocked_reasons[0] if blocked_reasons else None),
            payload=payload,
            latency_ms=tool_response.latency_ms,
        )
        tool_events.append(event)
        citations.append(_tool_citation_from_event(event))
        detail_blocks.append(
            "Odoo execution failed or was blocked:\n"
            + _safe_json(
                {
                    "operation": operation,
                    "payload": payload,
                    "message": tool_response.message,
                    "data": tool_response.data,
                }
            )
        )
    return PreparedToolEvidence(
        plan=normalized_plan,
        prompt_prefix=_build_tool_prompt_prefix(tool_events, detail_blocks),
        citations=citations,
        tool_events=tool_events,
        can_cache_response=False,
    )


def initialize_agent_runtime_state() -> None:
    with SessionLocal() as session:
        seed_default_connections(session)
        seed_default_agent_profiles(session)


async def fetch_query_plan(
    message: str,
    corpora: list[str],
    top_k: int,
    trace_id: str,
    *,
    current_message: str | None = None,
) -> dict:
    async with httpx.AsyncClient(timeout=240.0) as client:
        response = await client.post(
            f"{settings.app_workflow_runtime_url.rstrip('/')}/internal/query-plan",
            json={
                "message": message,
                "current_message": current_message or message,
                "corpora": corpora,
                "top_k": top_k,
                "trace_id": trace_id,
            },
        )
        response.raise_for_status()
        return response.json()


def build_query_message(*, message: str, history_context: str) -> str:
    if not history_context:
        return message
    return (
        "Recent conversation memory:\n"
        f"{history_context}\n\n"
        f"Current user request:\n{message}"
    )


def build_runtime_context_block(
    *,
    agent_name: str,
    runtime_profile_name: str,
    corpora: list[str],
    history_context: str,
    allowed_urls: list[str],
    used_approved_web: bool,
    tool_summary: list[dict] | None = None,
    openai_responses_chain: bool = False,
) -> str:
    memory_line = (
        "Conversation state is carried by OpenAI Responses API; no transcript is pasted here."
        if openai_responses_chain
        else f"Conversation memory loaded: {'yes' if history_context else 'no'}"
    )
    return "\n".join(
        [
            f"Agent name: {agent_name}",
            f"Runtime profile: {runtime_profile_name}",
            f"Active corpora: {', '.join(corpora) if corpora else 'none'}",
            memory_line,
            f"Approved web used: {'yes' if used_approved_web else 'no'}",
            (
                "Tool readiness: "
                + (
                    "; ".join(
                        f"{item.get('id', 'tool')}={item.get('status', 'unknown')}"
                        for item in list(tool_summary or [])
                    )
                    if tool_summary
                    else "none"
                )
            ),
        ]
    )


def build_effective_snapshot_id(
    *,
    agent_id: str,
    runtime_profile_id: str,
    corpora: list[str],
    tool_summary: list[dict],
    use_approved_web: bool,
) -> str:
    snapshot_payload = {
        "agent_id": agent_id,
        "runtime_profile_id": runtime_profile_id,
        "corpora": list(corpora),
        "tool_summary": tool_summary,
        "use_approved_web": use_approved_web,
    }
    return hashlib.sha256(json.dumps(snapshot_payload, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def load_chat_uploads(session: Session, *, conversation_id: str) -> list[ChatUploadRecord]:
    return list(
        session.scalars(
            select(ChatUploadRecord)
            .where(
                ChatUploadRecord.conversation_id == conversation_id,
                ChatUploadRecord.status != "rejected",
            )
            .order_by(ChatUploadRecord.created_at.asc())
        )
    )


def build_chat_upload_cache_context(uploads: list[ChatUploadRecord]) -> str:
    if not uploads:
        return ""
    lines = []
    for upload in uploads:
        lines.append(
            "|".join(
                [
                    upload.id,
                    upload.filename,
                    upload.status,
                    upload.persistence_mode or "unset",
                    upload.collection_id or "none",
                    upload.updated_at.isoformat(),
                ]
            )
        )
    return "\n".join(lines)


def build_chat_upload_prompt_context(uploads: list[ChatUploadRecord]) -> str:
    if not uploads:
        return ""

    sections: list[str] = []
    remaining_budget = 14000
    for upload in uploads:
        header = (
            f"File: {upload.filename}\n"
            f"Status: {upload.status}\n"
            f"Persistence mode: {upload.persistence_mode or 'undecided'}\n"
        )
        if upload.error_message and not upload.extracted_text:
            body = f"Extraction warning: {upload.error_message}\n"
        else:
            text = (upload.extracted_text or "").strip()
            if not text:
                body = "No extracted text preview is available for this file yet.\n"
            else:
                excerpt = text[: min(len(text), max(0, remaining_budget - len(header) - 32))]
                body = f"Extracted context:\n{excerpt}\n"
        block = f"{header}{body}".strip()
        if len(block) > remaining_budget:
            break
        sections.append(block)
        remaining_budget -= len(block)
        if remaining_budget < 600:
            break
    if not sections:
        return ""
    return "Conversation upload context:\n\n" + "\n\n".join(sections)


def build_answer_prompt(
    *,
    agent_name: str,
    system_prompt: str,
    query_prompt: str,
    history_context: str,
    runtime_context: str,
    approved_web_context: str,
    upload_context: str,
) -> str:
    sections = [f"Agent profile: {agent_name}", f"Runtime context:\n{runtime_context}"]
    if history_context:
        sections.append(f"Recent conversation memory:\n{history_context}")
    if upload_context:
        sections.append(upload_context)
    if approved_web_context:
        sections.append(f"Approved web source context:\n{approved_web_context}")
    if query_prompt:
        sections.append(query_prompt)
    return "\n\n".join(section.strip() for section in sections if section.strip())


def _compact_text(text: str, max_chars: int, *, mode: str) -> str:
    value = text.strip()
    if not value or max_chars <= 0:
        return ""
    if len(value) <= max_chars:
        return value
    if max_chars <= len(PROMPT_TRIM_MARKER) + 32:
        return value[-max_chars:] if mode == "tail" else value[:max_chars]
    keep_chars = max_chars - len(PROMPT_TRIM_MARKER)
    if mode == "tail":
        return PROMPT_TRIM_MARKER + value[-keep_chars:]
    if mode == "head":
        return value[:keep_chars] + PROMPT_TRIM_MARKER
    head_chars = keep_chars // 2
    tail_chars = keep_chars - head_chars
    return value[:head_chars] + PROMPT_TRIM_MARKER + value[-tail_chars:]


def _extract_user_question_block(query_prompt: str) -> str:
    value = query_prompt.strip()
    if USER_QUESTION_MARKER not in value:
        return ""
    _, question_suffix = value.rsplit(USER_QUESTION_MARKER, 1)
    return f"{USER_QUESTION_MARKER}{question_suffix}".rstrip()


def _compact_query_prompt(query_prompt: str, max_chars: int, *, prefix_mode: str) -> str:
    value = query_prompt.strip()
    if not value or max_chars <= 0:
        return ""
    if len(value) <= max_chars:
        return value
    question_block = _extract_user_question_block(value)
    if not question_block:
        return _compact_text(value, max_chars, mode=prefix_mode)
    if len(question_block) >= max_chars:
        return _compact_text(question_block.lstrip(), max_chars, mode="tail")
    prefix = value[: -len(question_block)].rstrip()
    prefix_budget = max_chars - len(question_block)
    prefix_text = _compact_text(prefix, prefix_budget, mode=prefix_mode)
    if not prefix_text:
        return question_block.lstrip()
    return f"{prefix_text.rstrip()}{question_block}"


def _remaining_query_budget(
    *,
    agent_name: str,
    system_prompt: str,
    history_context: str,
    runtime_context: str,
    approved_web_context: str,
    upload_context: str,
    max_total_chars: int,
    query_prompt: str,
) -> int:
    prompt_without_query = build_answer_prompt(
        agent_name=agent_name,
        system_prompt=system_prompt,
        query_prompt="",
        history_context=history_context,
        runtime_context=runtime_context,
        approved_web_context=approved_web_context,
        upload_context=upload_context,
    )
    separator_overhead = 2 if prompt_without_query and query_prompt.strip() else 0
    return max(0, max_total_chars - len(prompt_without_query) - separator_overhead)


def prepare_answer_prompt(
    *,
    agent_name: str,
    system_prompt: str,
    query_prompt: str,
    history_context: str,
    runtime_context: str,
    approved_web_context: str,
    upload_context: str,
    budget: AnswerPromptBudget,
) -> PreparedAnswerPrompt:
    history_value = history_context.strip()
    upload_value = upload_context.strip()
    approved_web_value = approved_web_context.strip()
    query_value = query_prompt.strip()
    original_prompt = build_answer_prompt(
        agent_name=agent_name,
        system_prompt=system_prompt,
        query_prompt=query_value,
        history_context=history_value,
        runtime_context=runtime_context,
        approved_web_context=approved_web_value,
        upload_context=upload_value,
    )

    compacted_history = _compact_text(history_value, budget.max_history_chars, mode="tail")
    compacted_upload = _compact_text(upload_value, budget.max_upload_chars, mode="middle")
    compacted_approved_web = _compact_text(approved_web_value, budget.max_approved_web_chars, mode="middle")

    def _fit_query() -> str:
        return _compact_query_prompt(
            query_value,
            min(
                budget.max_query_chars,
                _remaining_query_budget(
                    agent_name=agent_name,
                    system_prompt=system_prompt,
                    history_context=compacted_history,
                    runtime_context=runtime_context,
                    approved_web_context=compacted_approved_web,
                    upload_context=compacted_upload,
                    max_total_chars=budget.max_total_chars,
                    query_prompt=query_value,
                ),
            ),
            prefix_mode=budget.query_prefix_compaction_mode,
        )

    compacted_query = _fit_query()
    prompt = build_answer_prompt(
        agent_name=agent_name,
        system_prompt=system_prompt,
        query_prompt=compacted_query,
        history_context=compacted_history,
        runtime_context=runtime_context,
        approved_web_context=compacted_approved_web,
        upload_context=compacted_upload,
    )

    if len(prompt) > budget.max_total_chars and compacted_history:
        compacted_history = ""
        compacted_query = _fit_query()
        prompt = build_answer_prompt(
            agent_name=agent_name,
            system_prompt=system_prompt,
            query_prompt=compacted_query,
            history_context=compacted_history,
            runtime_context=runtime_context,
            approved_web_context=compacted_approved_web,
            upload_context=compacted_upload,
        )
    if len(prompt) > budget.max_total_chars and compacted_approved_web:
        compacted_approved_web = _compact_text(approved_web_value, budget.max_approved_web_chars // 2, mode="middle")
        compacted_query = _fit_query()
        prompt = build_answer_prompt(
            agent_name=agent_name,
            system_prompt=system_prompt,
            query_prompt=compacted_query,
            history_context=compacted_history,
            runtime_context=runtime_context,
            approved_web_context=compacted_approved_web,
            upload_context=compacted_upload,
        )
    if len(prompt) > budget.max_total_chars and compacted_upload:
        compacted_upload = _compact_text(upload_value, budget.max_upload_chars // 2, mode="middle")
        compacted_query = _fit_query()
        prompt = build_answer_prompt(
            agent_name=agent_name,
            system_prompt=system_prompt,
            query_prompt=compacted_query,
            history_context=compacted_history,
            runtime_context=runtime_context,
            approved_web_context=compacted_approved_web,
            upload_context=compacted_upload,
        )
    if len(prompt) > budget.max_total_chars and compacted_approved_web:
        compacted_approved_web = ""
        compacted_query = _fit_query()
        prompt = build_answer_prompt(
            agent_name=agent_name,
            system_prompt=system_prompt,
            query_prompt=compacted_query,
            history_context=compacted_history,
            runtime_context=runtime_context,
            approved_web_context=compacted_approved_web,
            upload_context=compacted_upload,
        )
    if len(prompt) > budget.max_total_chars and compacted_upload:
        compacted_upload = ""
        compacted_query = _fit_query()
        prompt = build_answer_prompt(
            agent_name=agent_name,
            system_prompt=system_prompt,
            query_prompt=compacted_query,
            history_context=compacted_history,
            runtime_context=runtime_context,
            approved_web_context=compacted_approved_web,
            upload_context=compacted_upload,
        )

    trimmed_sections = tuple(
        section_name
        for section_name, original_value, compacted_value in (
            ("history", history_value, compacted_history),
            ("upload_context", upload_value, compacted_upload),
            ("approved_web_context", approved_web_value, compacted_approved_web),
            ("query_prompt", query_value, compacted_query),
        )
        if original_value != compacted_value
    )
    return PreparedAnswerPrompt(
        budget_name=budget.name,
        prompt=prompt,
        original_chars=len(original_prompt),
        total_chars=len(prompt),
        compacted=bool(trimmed_sections),
        trimmed_sections=trimmed_sections,
        history_chars=len(compacted_history),
        upload_chars=len(compacted_upload),
        approved_web_chars=len(compacted_approved_web),
        query_chars=len(compacted_query),
    )


def prepare_answer_prompt_variants(
    *,
    api_mode: str,
    agent_name: str,
    system_prompt: str,
    query_prompt: str,
    history_context: str,
    runtime_context: str,
    approved_web_context: str,
    upload_context: str,
) -> tuple[PreparedAnswerPrompt, PreparedAnswerPrompt]:
    primary_budget, retry_budget = resolve_answer_prompt_budgets(api_mode)
    primary = prepare_answer_prompt(
        agent_name=agent_name,
        system_prompt=system_prompt,
        query_prompt=query_prompt,
        history_context=history_context,
        runtime_context=runtime_context,
        approved_web_context=approved_web_context,
        upload_context=upload_context,
        budget=primary_budget,
    )
    retry = prepare_answer_prompt(
        agent_name=agent_name,
        system_prompt=system_prompt,
        query_prompt=query_prompt,
        history_context=history_context,
        runtime_context=runtime_context,
        approved_web_context=approved_web_context,
        upload_context=upload_context,
        budget=retry_budget,
    )
    return primary, retry


def resolve_answer_prompt_budgets(api_mode: str) -> tuple[AnswerPromptBudget, AnswerPromptBudget]:
    if api_mode == "chat_completions":
        return CHAT_COMPLETIONS_PRIMARY_ANSWER_PROMPT_BUDGET, CHAT_COMPLETIONS_RETRY_ANSWER_PROMPT_BUDGET
    return RESPONSES_PRIMARY_ANSWER_PROMPT_BUDGET, RESPONSES_RETRY_ANSWER_PROMPT_BUDGET


def unique_answer_prompt_variants(*variants: PreparedAnswerPrompt) -> list[PreparedAnswerPrompt]:
    unique_variants: list[PreparedAnswerPrompt] = []
    seen_prompts: set[str] = set()
    for variant in variants:
        if variant.prompt in seen_prompts:
            continue
        unique_variants.append(variant)
        seen_prompts.add(variant.prompt)
    return unique_variants


def build_staged_answer_directives(*, tool_plan: dict[str, Any] | None) -> str:
    """Add answer-format constraints for expensive tool-heavy investigations."""
    plan = dict(tool_plan or {})
    operation = str(plan.get("operation") or "").strip()
    if not operation.startswith("odoo.finance."):
        return ""
    return (
        "Answer constraints (staged finance output):\n"
        "- First pass only: executive summary + what changed month-to-month + top drivers.\n"
        "- Keep it concise (no long-form report). Use bullets and a small month-by-month table.\n"
        "- End with: 'Say CONTINUE for deeper drill-down by code/journal/vendor.'"
    ).strip()


def log_answer_prompt_compaction(*, trace_id: str, package: PreparedAnswerPrompt) -> None:
    if not package.compacted:
        return
    log_instant_event(
        trace_id=trace_id,
        service="agent-ingress",
        route="chat_answer_prompt.compacted",
        status="ok",
        details={
            "budget": package.budget_name,
            "original_chars": package.original_chars,
            "final_chars": package.total_chars,
            "history_chars": package.history_chars,
            "upload_chars": package.upload_chars,
            "approved_web_chars": package.approved_web_chars,
            "query_chars": package.query_chars,
            "trimmed_sections": list(package.trimmed_sections),
        },
    )


def is_length_guardrail_error(exc: Exception) -> bool:
    details = [repr(exc), str(exc)]
    body = getattr(exc, "body", None)
    if body is not None:
        try:
            details.append(json.dumps(body, sort_keys=True))
        except TypeError:
            details.append(str(body))
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            details.append(json.dumps(response.json(), sort_keys=True))
        except Exception:
            details.append(str(response))
    message = " ".join(fragment for fragment in details if fragment).lower()
    return "input exceeds max length" in message or ("guardrail" in message and "max length" in message)


def is_context_length_error(exc: Exception) -> bool:
    details = [repr(exc), str(exc)]
    body = getattr(exc, "body", None)
    if body is not None:
        try:
            details.append(json.dumps(body, sort_keys=True))
        except TypeError:
            details.append(str(body))
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            details.append(json.dumps(response.json(), sort_keys=True))
        except Exception:
            details.append(str(response))
    message = " ".join(fragment for fragment in details if fragment).lower()
    return (
        "maximum context length" in message
        or "context_length_exceeded" in message
        or ("requested" in message and "tokens" in message and "maximum" in message and "context" in message)
    )


def is_timeout_error(exc: Exception) -> bool:
    if isinstance(exc, (TimeoutError, httpx.TimeoutException)):
        return True
    message = " ".join(fragment for fragment in (repr(exc), str(exc)) if fragment).lower()
    return "timed out" in message or "timeout" in message or "readtimeout" in message


def dedupe_answer_text(answer: str) -> str:
    text = answer.strip()
    if not text:
        return text

    minimum_duplicate_size = max(200, len(text) // 4)
    for split in range(len(text) // 2, minimum_duplicate_size - 1, -1):
        left = text[:split].strip()
        right = text[split:].strip()
        if left and left == right:
            return left

    paragraphs = [paragraph for paragraph in text.split("\n\n") if paragraph.strip()]
    if len(paragraphs) >= 2:
        deduped: list[str] = []
        for paragraph in paragraphs:
            normalized = paragraph.strip()
            if deduped and deduped[-1].strip() == normalized:
                continue
            deduped.append(paragraph)
        return "\n\n".join(deduped).strip()

    return text


def build_blank_answer_fallback(*, citations: list[dict]) -> str:
    fallback = [
        "There is not enough reliable generated answer content available from the model response for me to give you a complete strategic paper yet.",
        "",
        "What I can confirm:",
        "- grounded source material was retrieved",
        f"- citation count available: {len(citations)}",
        "- the request should be re-run or narrowed into staged steps such as market impact, FY26 risks, and response options",
        "",
        "Immediate best next step:",
        "1. split the position paper into demand impact, legal/regulatory impact, and strategic options",
        "2. confirm the exact Queensland law change and effective date",
        "3. isolate which product categories are exposed to the projected 4-6 million turnover risk",
        "4. rebuild the FY26 strategy from those grounded components",
    ]
    return "\n".join(fallback).strip()


def build_timeout_fallback(*, citations: list[dict]) -> str:
    fallback = [
        "Insufficient execution window warning: the strategic request is valid, but the model timed out before it could finish a full long-form answer.",
        "",
        "What I can confirm:",
        "- the request was grounded and processed",
        f"- citation count available: {len(citations)}",
        "- this is a response-time failure, not a grounded-data failure",
        "",
        "Best next step:",
        "1. rerun the request in smaller stages such as regulatory impact, financial exposure, and FY26 strategic options",
        "2. or continue in streaming mode so the answer can arrive incrementally",
        "3. or narrow the first pass to an executive summary, then expand section by section",
    ]
    return "\n".join(fallback).strip()


def build_length_guardrail_fallback(*, citations: list[dict]) -> str:
    fallback = [
        "The grounded answer could not be completed because the upstream model rejected the prompt length after retrieval.",
        "",
        "What I can confirm:",
        "- your question was preserved for the retry path",
        f"- citation count available: {len(citations)}",
        "- this is a prompt-size guardrail failure, not a workflow-runtime retrieval failure",
        "",
        "Best next step:",
        "1. retry with a narrower follow-up or shorter conversation thread",
        "2. ask for an executive summary first, then expand section by section",
        "3. keep the same question if you want the system to rebuild with less history",
    ]
    return "\n".join(fallback).strip()


def build_context_length_fallback(*, citations: list[dict]) -> str:
    fallback = [
        "Model context window exceeded: the upstream model rejected the request size (prompt + requested completion).",
        "",
        "What I can confirm:",
        "- grounded/tool evidence was retrieved and processed",
        f"- citation count available: {len(citations)}",
        "",
        "Best next step:",
        "1. reduce runtime `max_tokens` (output) and rerun, or use staged output (ask for an executive summary first)",
        "2. narrow scope (one month / one company at a time) to keep the prompt smaller",
    ]
    return "\n".join(fallback).strip()


def run_answer_with_prompt_variants(
    prompt_variants: list[PreparedAnswerPrompt],
    *,
    runner,
    trace_id: str,
    retry_route: str,
) -> tuple[str, Exception | None, str | None, str | None]:
    """Returns (answer, error, user_prompt_used_on_success, openai_response_id)."""
    last_error: Exception | None = None
    for index, prompt_variant in enumerate(prompt_variants, start=1):
        try:
            result = runner(prompt_variant.prompt)
            if isinstance(result, LlmCompletionResult):
                return result.text, None, prompt_variant.prompt, result.openai_response_id
            return result, None, prompt_variant.prompt, None
        except Exception as exc:  # pragma: no cover - behavior validated through route tests
            last_error = exc
            if index >= len(prompt_variants) or not is_length_guardrail_error(exc):
                break
            next_variant = prompt_variants[index]
            log_instant_event(
                trace_id=trace_id,
                service="agent-ingress",
                route=retry_route,
                status="retry",
                error=repr(exc),
                details={
                    "from_budget": prompt_variant.budget_name,
                    "to_budget": next_variant.budget_name,
                    "from_chars": prompt_variant.total_chars,
                    "to_chars": next_variant.total_chars,
                    "from_trimmed_sections": list(prompt_variant.trimmed_sections),
                    "to_trimmed_sections": list(next_variant.trimmed_sections),
                },
            )
    return "", last_error, None, None


def resolve_answer_max_tokens(
    *,
    api_mode: str,
    configured_max_tokens: int,
    prompt: str,
    trace_id: str,
    openai_responses_chain: bool,
) -> int | None:
    """Resolve max output tokens for the LLM call.

    - For OpenAI native /v1/responses chains, avoid passing extreme `max_output_tokens`
      values that can trigger immediate context validation errors on smaller models.
    - For all OpenAI-compatible chat-completions style calls (including local gateways),
      clamp to a safe completion cap + estimated available context.
    """

    configured = max(1, int(configured_max_tokens))

    if openai_responses_chain:
        if configured <= OPENAI_NATIVE_RESPONSES_MAX_OUTPUT_TOKEN_CAP:
            return configured
        log_instant_event(
            trace_id=trace_id,
            service="agent-ingress",
            route="chat_answer.max_tokens_omitted",
            status="ok",
            details={
                "api_mode": api_mode,
                "configured_max_tokens": configured,
                "reason": "openai_native_responses_chain",
            },
        )
        return None

    estimated_prompt_tokens = max(1, math.ceil(len(prompt.strip()) / 2))
    available_completion_tokens = max(
        256,
        CHAT_COMPLETIONS_CONTEXT_LIMIT_TOKENS - estimated_prompt_tokens - CHAT_COMPLETIONS_CONTEXT_SAFETY_TOKENS,
    )
    resolved_max_tokens = min(configured, CHAT_COMPLETIONS_COMPLETION_TOKEN_CAP, available_completion_tokens)
    if resolved_max_tokens != configured:
        log_instant_event(
            trace_id=trace_id,
            service="agent-ingress",
            route="chat_answer.max_tokens_clamped",
            status="ok",
            details={
                "api_mode": api_mode,
                "configured_max_tokens": configured,
                "resolved_max_tokens": resolved_max_tokens,
                "prompt_chars": len(prompt),
                "estimated_prompt_tokens": estimated_prompt_tokens,
                "available_completion_tokens": available_completion_tokens,
            },
        )
    return resolved_max_tokens


def create_app() -> FastAPI:
    app = build_app(
        service_name="agent-ingress",
        title="GhostDASH Agent Ingress",
        docs_url="/agent/docs",
        redoc_url="/agent/redoc",
        openapi_url="/agent/openapi.json",
        startup_hooks=[initialize_agent_runtime_state],
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/agent/chat", response_model=ChatResponse)
    async def agent_chat(
        body: ChatRequest,
        request: Request,
        session: Session = Depends(get_session),
    ) -> ChatResponse:
        agent = get_agent(session, body.agent_id)
        runtime_profile = resolve_agent_runtime_profile(session, agent)
        corpora = resolve_corpora(runtime_profile, body.corpora)
        top_k = resolve_query_top_k(session, body.top_k, runtime_profile=runtime_profile)
        conversation = session.get(AgentConversationRecord, body.conversation_id) if body.conversation_id else None
        if body.conversation_id and conversation is None:
            raise HTTPException(404, "conversation not found")
        if conversation is not None and conversation.agent_id != agent.id:
            raise HTTPException(400, "conversation does not belong to the selected agent")
        if conversation is None:
            conversation = create_conversation(
                session,
                agent_id=agent.id,
                message=body.message,
                corpora=corpora,
                api_mode=body.api_mode,
            )
            session.commit()
            session.refresh(conversation)
        chat_uploads = load_chat_uploads(session, conversation_id=conversation.id)
        chat_upload_context = build_chat_upload_prompt_context(chat_uploads)
        chat_upload_cache_context = build_chat_upload_cache_context(chat_uploads)
        history = list_messages(session, conversation.id, limit=max(settings.app_agent_memory_window_messages * 2, 20))
        history_context = build_history_context(history, window_messages=settings.app_agent_memory_window_messages)
        llm_config = dict(runtime_profile.llm_config_json or {})
        connection = resolve_llm_connection(
            session,
            connection_id=llm_config.get("connection_id"),
            provider=str(llm_config.get("provider", "openai")),
        )
        use_openai_responses_chain = should_use_openai_responses_chain(connection, body.api_mode)
        history_for_prompt = "" if use_openai_responses_chain else history_context
        plan_query_message = body.message if use_openai_responses_chain else build_query_message(
            message=body.message, history_context=history_context
        )
        guardrails_config = dict(runtime_profile.guardrails_config_json or {})
        tool_policy_config = dict(runtime_profile.tool_policy_config_json or {})
        web_tool = get_tool_config(tool_policy_config, "web") or {}
        allowed_urls = normalize_allowed_urls(web_tool.get("allowed_urls"))
        use_approved_web = bool(web_tool.get("enabled")) and should_use_approved_web_context(
            message=body.message,
            allowed_urls=allowed_urls,
            force_use=body.use_approved_web,
        )
        approved_web_context = ""
        web_citations: list[dict] = []
        if use_approved_web:
            approved_web_context, web_citations = await fetch_approved_web_context(
                message=body.message,
                allowed_urls=allowed_urls,
            )
        tool_summary_models = build_tool_readiness_summary(
            session,
            agent_id=agent.id,
            tool_overrides=body.tool_overrides,
        )
        tool_summary = [item.model_dump() for item in tool_summary_models]
        effective_snapshot_id = build_effective_snapshot_id(
            agent_id=agent.id,
            runtime_profile_id=runtime_profile.id,
            corpora=corpora,
            tool_summary=tool_summary,
            use_approved_web=use_approved_web,
        )
        runtime_context = build_runtime_context_block(
            agent_name=agent.name,
            runtime_profile_name=str(runtime_profile.name),
            corpora=corpora,
            history_context=history_for_prompt,
            allowed_urls=allowed_urls,
            used_approved_web=use_approved_web,
            tool_summary=tool_summary,
            openai_responses_chain=use_openai_responses_chain,
        )
        plan = await fetch_query_plan(
            plan_query_message,
            corpora,
            top_k,
            request.state.trace_id,
            current_message=body.message,
        )
        tool_evidence = prepare_tool_evidence(
            session,
            agent_id=agent.id,
            tool_overrides=body.tool_overrides,
            tool_plan=plan.get("tool_plan"),
        )
        tool_events = tool_evidence.tool_events
        citations = [*tool_evidence.citations, *plan.get("citations", []), *web_citations]
        plan_query_prompt = str(plan.get("prompt") or "")
        if tool_evidence.prompt_prefix:
            plan_query_prompt = (
                f"{tool_evidence.prompt_prefix}\n\n{plan_query_prompt}".strip()
                if plan_query_prompt
                else tool_evidence.prompt_prefix
            )
        staged_directives = build_staged_answer_directives(tool_plan=tool_evidence.plan)
        if staged_directives:
            plan_query_prompt = f"{plan_query_prompt}\n\n{staged_directives}".strip() if plan_query_prompt else staged_directives
        cache_key = None
        if use_approved_web or use_openai_responses_chain or str(tool_evidence.plan.get("mode") or "none") != "none":
            cached = None
        else:
            cache_key = build_response_cache_key(
                agent=agent,
                runtime_profile=runtime_profile,
                history_context=history_context,
                message=body.message + ("\n\n[chat_uploads]\n" + chat_upload_cache_context if chat_upload_cache_context else ""),
                corpora=corpora,
                api_mode=body.api_mode,
                llm_model_id_override=body.llm_model_id,
                tool_state={"tool_summary": tool_summary, "tool_plan_mode": tool_evidence.plan.get("mode", "none")},
            )
            cached = lookup_cached_response(session, agent_id=agent.id, request_hash=cache_key)
        resolved_model_id = _effective_chat_model_id(body, llm_config)
        new_openai_rid: str | None = None
        if cached is not None:
            cached_answer = dedupe_answer_text(cached.answer_text)
            if cached_answer != cached.answer_text:
                cached.answer_text = cached_answer
                session.commit()
                session.refresh(cached)
            append_message(session, conversation_id=conversation.id, agent_id=agent.id, role="user", content=body.message)
            append_message(
                session,
                conversation_id=conversation.id,
                agent_id=agent.id,
                role="assistant",
                content=cached.answer_text,
                query_mode=cached.query_mode,
                citations=cached.citations_json,
                api_mode=body.api_mode,
            )
            conversation.corpora_json = list(corpora)
            conversation.api_mode = body.api_mode
            session.commit()
            log_instant_event(
                trace_id=request.state.trace_id,
                service="agent-ingress",
                route="chat_response_cache.hit",
                status="ok",
                details={"agent_id": agent.id, "conversation_id": conversation.id},
            )
            return ChatResponse(
                answer=cached.answer_text,
                query_mode=cached.query_mode,
                citations=cached.citations_json,
                conversation_id=conversation.id,
                agent_id=agent.id,
                cached=True,
                usage=ChatUsage(**estimate_llm_turn_usage_dict(system_prompt="", user_prompt=None, completion="", skip_llm=True)),
                effective_snapshot_id=effective_snapshot_id,
                tool_summary=tool_summary_models,
                tool_events=[],
            )
        if plan.get("direct_answer") and not chat_upload_context:
            answer = plan["direct_answer"]
        else:
            answer = ""
        configured_max_tokens = int(llm_config.get("max_tokens", 2000))
        can_cache_response = tool_evidence.can_cache_response
        prompt_variants: list[PreparedAnswerPrompt] = []
        used_prompt: str | None = None
        if not answer:
            primary_prompt, retry_prompt = prepare_answer_prompt_variants(
                api_mode=body.api_mode,
                agent_name=agent.name,
                system_prompt=str(guardrails_config.get("system_prompt", "")),
                query_prompt=plan_query_prompt,
                history_context=history_for_prompt,
                runtime_context=runtime_context,
                approved_web_context=approved_web_context,
                upload_context=chat_upload_context,
            )
            log_answer_prompt_compaction(trace_id=request.state.trace_id, package=primary_prompt)
            prompt_variants = unique_answer_prompt_variants(primary_prompt, retry_prompt)
            prev_rid = (conversation.openai_last_response_id or "").strip() or None
            answer, generate_error, used_prompt, new_openai_rid = run_answer_with_prompt_variants(
                prompt_variants,
                runner=lambda prompt: generate_answer(
                    prompt,
                    connection,
                    api_mode=body.api_mode,
                    system_prompt=str(guardrails_config.get("system_prompt", "")),
                    model_id=resolved_model_id,
                    temperature=float(llm_config.get("temperature", 0)),
                    max_tokens=resolve_answer_max_tokens(
                        api_mode=body.api_mode,
                        configured_max_tokens=configured_max_tokens,
                        prompt=prompt,
                        trace_id=request.state.trace_id,
                        openai_responses_chain=use_openai_responses_chain,
                    ),
                    trace_id=request.state.trace_id,
                    service="agent-ingress",
                    previous_response_id=prev_rid,
                    use_openai_responses_http=use_openai_responses_chain,
                ),
                trace_id=request.state.trace_id,
                retry_route="chat_answer.length_retry",
            )
            stream_error: Exception | None = None
            if not answer.strip():
                answer, stream_error, used_prompt, new_openai_rid = run_answer_with_prompt_variants(
                    prompt_variants,
                    runner=lambda prompt: stream_answer_to_result(
                        prompt,
                        connection,
                        api_mode=body.api_mode,
                        system_prompt=str(guardrails_config.get("system_prompt", "")),
                        model_id=resolved_model_id,
                        temperature=float(llm_config.get("temperature", 0)),
                        max_tokens=resolve_answer_max_tokens(
                            api_mode=body.api_mode,
                            configured_max_tokens=configured_max_tokens,
                            prompt=prompt,
                            trace_id=request.state.trace_id,
                            openai_responses_chain=use_openai_responses_chain,
                        ),
                        trace_id=request.state.trace_id,
                        service="agent-ingress",
                        previous_response_id=prev_rid,
                        use_openai_responses_http=use_openai_responses_chain,
                    ),
                    trace_id=request.state.trace_id,
                    retry_route="chat_answer.length_retry_stream",
                )
            if not answer.strip():
                can_cache_response = False
                last_error = stream_error or generate_error
                if last_error is not None and is_length_guardrail_error(last_error):
                    answer = build_length_guardrail_fallback(citations=citations)
                    log_instant_event(
                        trace_id=request.state.trace_id,
                        service="agent-ingress",
                        route="chat_answer.length_fallback",
                        status="ok",
                        error=repr(last_error),
                        details={"citation_count": len(citations)},
                    )
                elif last_error is not None and is_context_length_error(last_error):
                    answer = build_context_length_fallback(citations=citations)
                    log_instant_event(
                        trace_id=request.state.trace_id,
                        service="agent-ingress",
                        route="chat_answer.context_length_fallback",
                        status="ok",
                        error=repr(last_error),
                        details={"citation_count": len(citations)},
                    )
                elif last_error is not None and is_timeout_error(last_error):
                    answer = build_timeout_fallback(citations=citations) if citations else build_blank_answer_fallback(citations=citations)
                else:
                    answer = build_blank_answer_fallback(citations=citations)
        answer = dedupe_answer_text(answer)
        system_sp = str(guardrails_config.get("system_prompt", ""))
        fallback_user = prompt_variants[0].prompt if prompt_variants else ""
        skip_llm_turn = bool(plan.get("direct_answer") and not chat_upload_context)
        response_usage = ChatUsage(
            **estimate_llm_turn_usage_dict(
                system_prompt=system_sp,
                user_prompt=used_prompt,
                completion=answer,
                fallback_user_prompt=fallback_user,
                skip_llm=skip_llm_turn,
            )
        )
        append_message(session, conversation_id=conversation.id, agent_id=agent.id, role="user", content=body.message)
        append_message(
            session,
            conversation_id=conversation.id,
            agent_id=agent.id,
            role="assistant",
            content=answer,
            query_mode=plan["query_mode"],
            citations=citations,
            api_mode=body.api_mode,
        )
        conversation.corpora_json = list(corpora)
        conversation.api_mode = body.api_mode
        if use_openai_responses_chain and new_openai_rid:
            conversation.openai_last_response_id = new_openai_rid
        session.commit()
        if not use_approved_web and can_cache_response and not use_openai_responses_chain:
            store_cached_response(
                session,
                agent_id=agent.id,
                request_hash=cache_key or "",
                answer_text=answer,
                query_mode=plan["query_mode"],
                citations=citations,
            )
        return ChatResponse(
            answer=answer,
            query_mode=plan["query_mode"],
            citations=citations,
            conversation_id=conversation.id,
            agent_id=agent.id,
            cached=False,
            usage=response_usage,
            effective_snapshot_id=effective_snapshot_id,
            tool_summary=tool_summary_models,
            tool_events=tool_events,
        )

    @app.post("/agent/chat/stream")
    async def agent_chat_stream(
        body: ChatRequest,
        request: Request,
        session: Session = Depends(get_session),
    ) -> StreamingResponse:
        agent = get_agent(session, body.agent_id)
        runtime_profile = resolve_agent_runtime_profile(session, agent)
        corpora = resolve_corpora(runtime_profile, body.corpora)
        top_k = resolve_query_top_k(session, body.top_k, runtime_profile=runtime_profile)
        conversation = session.get(AgentConversationRecord, body.conversation_id) if body.conversation_id else None
        if body.conversation_id and conversation is None:
            raise HTTPException(404, "conversation not found")
        if conversation is not None and conversation.agent_id != agent.id:
            raise HTTPException(400, "conversation does not belong to the selected agent")
        if conversation is None:
            conversation = create_conversation(
                session,
                agent_id=agent.id,
                message=body.message,
                corpora=corpora,
                api_mode=body.api_mode,
            )
            session.commit()
            session.refresh(conversation)
        chat_uploads = load_chat_uploads(session, conversation_id=conversation.id)
        chat_upload_context = build_chat_upload_prompt_context(chat_uploads)
        chat_upload_cache_context = build_chat_upload_cache_context(chat_uploads)
        history = list_messages(session, conversation.id, limit=max(settings.app_agent_memory_window_messages * 2, 20))
        history_context = build_history_context(history, window_messages=settings.app_agent_memory_window_messages)
        llm_config = dict(runtime_profile.llm_config_json or {})
        connection = resolve_llm_connection(
            session,
            connection_id=llm_config.get("connection_id"),
            provider=str(llm_config.get("provider", "openai")),
        )
        use_openai_responses_chain = should_use_openai_responses_chain(connection, body.api_mode)
        history_for_prompt = "" if use_openai_responses_chain else history_context
        plan_query_message = body.message if use_openai_responses_chain else build_query_message(
            message=body.message, history_context=history_context
        )
        guardrails_config = dict(runtime_profile.guardrails_config_json or {})
        tool_policy_config = dict(runtime_profile.tool_policy_config_json or {})
        web_tool = get_tool_config(tool_policy_config, "web") or {}
        allowed_urls = normalize_allowed_urls(web_tool.get("allowed_urls"))
        use_approved_web = bool(web_tool.get("enabled")) and should_use_approved_web_context(
            message=body.message,
            allowed_urls=allowed_urls,
            force_use=body.use_approved_web,
        )
        approved_web_context = ""
        web_citations: list[dict] = []
        if use_approved_web:
            approved_web_context, web_citations = await fetch_approved_web_context(
                message=body.message,
                allowed_urls=allowed_urls,
            )
        tool_summary_models = build_tool_readiness_summary(
            session,
            agent_id=agent.id,
            tool_overrides=body.tool_overrides,
        )
        tool_summary = [item.model_dump() for item in tool_summary_models]
        effective_snapshot_id = build_effective_snapshot_id(
            agent_id=agent.id,
            runtime_profile_id=runtime_profile.id,
            corpora=corpora,
            tool_summary=tool_summary,
            use_approved_web=use_approved_web,
        )
        runtime_context = build_runtime_context_block(
            agent_name=agent.name,
            runtime_profile_name=str(runtime_profile.name),
            corpora=corpora,
            history_context=history_for_prompt,
            allowed_urls=allowed_urls,
            used_approved_web=use_approved_web,
            tool_summary=tool_summary,
            openai_responses_chain=use_openai_responses_chain,
        )
        plan = await fetch_query_plan(
            plan_query_message,
            corpora,
            top_k,
            request.state.trace_id,
            current_message=body.message,
        )
        tool_evidence = prepare_tool_evidence(
            session,
            agent_id=agent.id,
            tool_overrides=body.tool_overrides,
            tool_plan=plan.get("tool_plan"),
        )
        plan_query_prompt = str(plan.get("prompt") or "")
        if tool_evidence.prompt_prefix:
            plan_query_prompt = (
                f"{tool_evidence.prompt_prefix}\n\n{plan_query_prompt}".strip()
                if plan_query_prompt
                else tool_evidence.prompt_prefix
            )
        staged_directives = build_staged_answer_directives(tool_plan=tool_evidence.plan)
        if staged_directives:
            plan_query_prompt = f"{plan_query_prompt}\n\n{staged_directives}".strip() if plan_query_prompt else staged_directives
        cache_key = None
        if use_approved_web or use_openai_responses_chain or str(tool_evidence.plan.get("mode") or "none") != "none":
            cached = None
        else:
            cache_key = build_response_cache_key(
                agent=agent,
                runtime_profile=runtime_profile,
                history_context=history_context,
                message=body.message + ("\n\n[chat_uploads]\n" + chat_upload_cache_context if chat_upload_cache_context else ""),
                corpora=corpora,
                api_mode=body.api_mode,
                llm_model_id_override=body.llm_model_id,
                tool_state={"tool_summary": tool_summary, "tool_plan_mode": tool_evidence.plan.get("mode", "none")},
            )
            cached = lookup_cached_response(session, agent_id=agent.id, request_hash=cache_key)
        resolved_model_id = _effective_chat_model_id(body, llm_config)
        prev_openai_rid = (conversation.openai_last_response_id or "").strip() or None
        openai_rid_out: list[str | None] = [None]
        configured_max_tokens = int(llm_config.get("max_tokens", 2000))
        prompt_variants: list[PreparedAnswerPrompt] = []
        if cached is None and not (plan.get("direct_answer") and not chat_upload_context):
            primary_prompt, retry_prompt = prepare_answer_prompt_variants(
                api_mode=body.api_mode,
                agent_name=agent.name,
                system_prompt=str(guardrails_config.get("system_prompt", "")),
                query_prompt=plan_query_prompt,
                history_context=history_for_prompt,
                runtime_context=runtime_context,
                approved_web_context=approved_web_context,
                upload_context=chat_upload_context,
            )
            log_answer_prompt_compaction(trace_id=request.state.trace_id, package=primary_prompt)
            prompt_variants = unique_answer_prompt_variants(primary_prompt, retry_prompt)

        def _encode(payload: dict) -> str:
            return f"data: {json.dumps(payload)}\n\n"

        def _stream():
            answer_parts: list[str] = []
            successful_user_prompt: str | None = None
            citations = cached.citations_json if cached is not None else [*tool_evidence.citations, *plan.get("citations", []), *web_citations]
            query_mode = cached.query_mode if cached is not None else plan["query_mode"]
            cache_response = tool_evidence.can_cache_response
            yield _encode(
                {
                    "type": "start",
                    "api_mode": body.api_mode,
                    "query_mode": query_mode,
                    "citations": citations,
                    "conversation_id": conversation.id,
                    "agent_id": agent.id,
                    "cached": cached is not None,
                    "effective_snapshot_id": effective_snapshot_id,
                    "tool_summary": tool_summary,
                    "tool_events": [],
                }
            )
            if cached is not None:
                cached_answer = dedupe_answer_text(cached.answer_text)
                if cached_answer != cached.answer_text:
                    with SessionLocal() as cache_session:
                        cache_row = cache_session.get(type(cached), cached.id)
                        if cache_row is not None:
                            cache_row.answer_text = cached_answer
                            cache_session.commit()
                    cached.answer_text = cached_answer
                yield _encode({"type": "delta", "delta": cached.answer_text})
                answer_parts.append(cached.answer_text)
            else:
                for tool_event in tool_evidence.tool_events:
                    yield _encode(
                        {
                            "type": "tool_result",
                            "tool_event": {
                                "tool_id": tool_event.tool_id,
                                "status": tool_event.status,
                                "operation": tool_event.operation,
                                "summary": tool_event.summary,
                                "blocked_reason": tool_event.blocked_reason,
                                "payload": tool_event.payload,
                                "latency_ms": tool_event.latency_ms,
                            },
                        }
                    )
            if cached is None and plan.get("direct_answer") and not chat_upload_context:
                yield _encode({"type": "delta", "delta": plan["direct_answer"]})
                answer_parts.append(plan["direct_answer"])
            elif cached is None:
                stream_error: Exception | None = None
                for attempt_index, prompt_variant in enumerate(prompt_variants, start=1):
                    try:
                        if use_openai_responses_chain and openai_rid_out is not None:
                            openai_rid_out[0] = None
                        for delta in stream_answer(
                            prompt_variant.prompt,
                            connection,
                            api_mode=body.api_mode,
                            system_prompt=str(guardrails_config.get("system_prompt", "")),
                            model_id=resolved_model_id,
                            temperature=float(llm_config.get("temperature", 0)),
                            max_tokens=resolve_answer_max_tokens(
                                api_mode=body.api_mode,
                                configured_max_tokens=configured_max_tokens,
                                prompt=prompt_variant.prompt,
                                trace_id=request.state.trace_id,
                                openai_responses_chain=use_openai_responses_chain,
                            ),
                            trace_id=request.state.trace_id,
                            service="agent-ingress",
                            previous_response_id=prev_openai_rid,
                            use_openai_responses_http=use_openai_responses_chain,
                            openai_response_id_out=openai_rid_out if use_openai_responses_chain else None,
                        ):
                            answer_parts.append(delta)
                            yield _encode({"type": "delta", "delta": delta})
                        successful_user_prompt = prompt_variant.prompt
                        stream_error = None
                        break
                    except Exception as exc:
                        stream_error = exc
                        if answer_parts or attempt_index >= len(prompt_variants) or not is_length_guardrail_error(exc):
                            break
                        next_variant = prompt_variants[attempt_index]
                        log_instant_event(
                            trace_id=request.state.trace_id,
                            service="agent-ingress",
                            route="chat_stream.length_retry",
                            status="retry",
                            error=repr(exc),
                            details={
                                "from_budget": prompt_variant.budget_name,
                                "to_budget": next_variant.budget_name,
                                "from_chars": prompt_variant.total_chars,
                                "to_chars": next_variant.total_chars,
                            },
                        )
                if stream_error is not None:
                    cache_response = False
                if stream_error is not None and not answer_parts:
                    if is_length_guardrail_error(stream_error):
                        fallback = build_length_guardrail_fallback(citations=citations)
                        log_instant_event(
                            trace_id=request.state.trace_id,
                            service="agent-ingress",
                            route="chat_stream.length_fallback",
                            status="ok",
                            error=repr(stream_error),
                            details={"citation_count": len(citations)},
                        )
                    elif is_context_length_error(stream_error):
                        fallback = build_context_length_fallback(citations=citations)
                        log_instant_event(
                            trace_id=request.state.trace_id,
                            service="agent-ingress",
                            route="chat_stream.context_length_fallback",
                            status="ok",
                            error=repr(stream_error),
                            details={"citation_count": len(citations)},
                        )
                    elif is_timeout_error(stream_error):
                        fallback = build_timeout_fallback(citations=citations) if citations else build_blank_answer_fallback(citations=citations)
                    else:
                        fallback = build_blank_answer_fallback(citations=citations)
                    answer_parts.append(fallback)
                    yield _encode({"type": "delta", "delta": fallback})
            answer_text = dedupe_answer_text("".join(answer_parts))
            with SessionLocal() as stream_session:
                append_message(
                    stream_session,
                    conversation_id=conversation.id,
                    agent_id=agent.id,
                    role="user",
                    content=body.message,
                )
                append_message(
                    stream_session,
                    conversation_id=conversation.id,
                    agent_id=agent.id,
                    role="assistant",
                    content=answer_text,
                    query_mode=query_mode,
                    citations=citations,
                    api_mode=body.api_mode,
                )
                stream_conversation = stream_session.get(AgentConversationRecord, conversation.id)
                if stream_conversation is not None:
                    stream_conversation.corpora_json = list(corpora)
                    stream_conversation.api_mode = body.api_mode
                    if use_openai_responses_chain and openai_rid_out and openai_rid_out[0]:
                        stream_conversation.openai_last_response_id = openai_rid_out[0]
                stream_session.commit()
                if (
                    cached is None
                    and not use_approved_web
                    and cache_response
                    and not use_openai_responses_chain
                ):
                    store_cached_response(
                        stream_session,
                        agent_id=agent.id,
                        request_hash=cache_key or "",
                        answer_text=answer_text,
                        query_mode=query_mode,
                        citations=citations,
                    )
            system_sp_stream = str(guardrails_config.get("system_prompt", ""))
            fb_prompt_stream = prompt_variants[0].prompt if prompt_variants else ""
            skip_llm_stream = cached is not None or (
                plan is not None and bool(plan.get("direct_answer")) and not chat_upload_context
            )
            usage_stream = estimate_llm_turn_usage_dict(
                system_prompt=system_sp_stream,
                user_prompt=successful_user_prompt,
                completion=answer_text,
                fallback_user_prompt=fb_prompt_stream,
                skip_llm=skip_llm_stream,
            )
            yield _encode(
                {
                    "type": "done",
                    "citations": citations,
                    "conversation_id": conversation.id,
                    "cached": cached is not None,
                    "usage": usage_stream,
                    "effective_snapshot_id": effective_snapshot_id,
                    "tool_summary": tool_summary,
                    "tool_events": [
                        {
                            "tool_id": tool_event.tool_id,
                            "status": tool_event.status,
                            "operation": tool_event.operation,
                            "summary": tool_event.summary,
                            "blocked_reason": tool_event.blocked_reason,
                            "payload": tool_event.payload,
                            "latency_ms": tool_event.latency_ms,
                        }
                        for tool_event in tool_evidence.tool_events
                    ],
                }
            )

        return StreamingResponse(
            _stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return app


app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run(
        "ghostdash_api.agent_ingress:app",
        host="0.0.0.0",
        port=8001,
        reload=False,
        access_log=False,
        log_config=None,
    )


if __name__ == "__main__":
    run()
