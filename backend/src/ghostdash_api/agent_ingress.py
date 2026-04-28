from __future__ import annotations

import hashlib
import json
import math
import re
import time
from datetime import datetime
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
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
    create_document_frame,
    get_agent,
    list_messages,
    lookup_cached_response,
    seed_default_agent_profiles,
    store_cached_response,
    upsert_docx_session,
)
from .agent_builds import (
    bp_mode_auditor_prompt,
    bp_mode_case_framing_prompt,
    build_odoo_action_tool_plan,
    case_framing_prompt,
    evidence_retrieval_prompt,
    parse_odoo_operation_action_request,
)
from .database import SessionLocal, get_session
from .elevenlabs_flash25_realtime import router as elevenlabs_flash25_realtime_router
from .models import (
    AgentConversationRecord,
    AgentMessageRecord,
    AgentProfileRecord,
    ChatUploadRecord,
    ConnectionRecord,
    DocumentFrameRecord,
)
from .magic_mike import MAGIC_MIKE_AGENT_NAME
from .public_response_presenter import (
    PUBLIC_GREETING_FALLBACK_TEXT,
    PublicStreamPresenter,
    contains_forbidden_public_output,
    is_production_chat_surface,
    present_public_chat_response_payload,
)
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
from .token_usage import estimate_token_count, resolve_chat_usage_dict
from .service_common import build_app
from .settings import get_settings
from .telemetry import log_instant_event
from .tool_registry import build_tool_readiness_summary, execute_tool_operation_for_agent
from .voice_ingress import (
    ELEVENLABS_STREAM_ROUTE,
    ELEVENLABS_TTS_STREAM_ROUTE,
    VoiceChatCompletionsRequest,
    VoicePreviewRequest,
    handle_tts_stream_websocket,
    handle_voice_chat_completions,
    handle_voice_stream_websocket,
    list_elevenlabs_voices,
    preview_elevenlabs_voice,
    voice_provider_health,
)
from .odoo_agentic import (
    external_citations_for_tool_events,
    run_odoo_agentic_tool_loop,
    should_use_odoo_agentic,
)
from .odoo_mas.pipeline import run_odoo_mas_pipeline

settings = get_settings()
DEFAULT_BUSINESS_STRUCTURE_QUESTION_BANK = (
    "Business structure question bank (answer once, reused until changed):\n"
    "1) What is the legal entity and operating brand map for this business?\n"
    "2) What business units/branches/stores/sites should be treated as distinct reporting entities?\n"
    "3) Which channels are channel scopes only (for example Shopify, marketplace, wholesale), not legal entities?\n"
    "4) Which entities roll up into group-level reporting, and how should group totals be interpreted?\n"
    "5) Any non-negotiable accounting or scope rules (for example include/exclude tax, refunds, intercompany, or specific journals)?"
)


def _present_chat_response_for_surface(response: ChatResponse, surface: str | None) -> ChatResponse:
    if not is_production_chat_surface(surface):
        return response
    return ChatResponse(**present_public_chat_response_payload(response.model_dump(mode="json")))


PRODUCTION_CHAT_ROUTE_MODE = "production_chat"
CONSUMER_CUSTOMER_AGENT_CATEGORY = "consumer_customer"
PRODUCTION_CONTRACT_ERROR = "Magic Mike is not available in the correct customer-service mode right now."


def _is_magic_mike_agent(agent: AgentProfileRecord) -> bool:
    return str(agent.name or "").strip().casefold() == MAGIC_MIKE_AGENT_NAME.casefold()


def _get_magic_mike_agent(session: Session) -> AgentProfileRecord | None:
    return session.scalar(
        select(AgentProfileRecord).where(
            AgentProfileRecord.name == MAGIC_MIKE_AGENT_NAME,
            AgentProfileRecord.enabled.is_(True),
        )
    )


def _is_greeting_intent(message: str) -> bool:
    normalized = re.sub(r"[^a-z0-9\s']", " ", str(message or "").casefold())
    normalized = " ".join(normalized.split())
    if not normalized:
        return False
    greeting_patterns = (
        r"^(hi|hello|hey|gday|good morning|morning|good afternoon|afternoon)(\s+magic|\s+mike|\s+magic mike)?$",
        r"^(hi|hello|hey|gday)\s+(magic|mike|magic mike)(\s+how('?s| is) it going)?$",
        r"^(how are you|how('?s| is) it going)(\s+magic|\s+mike|\s+magic mike)?$",
        r"^(hi|hello|hey)\s+(magic|mike|magic mike)[,\s]+how('?s| is) it going$",
    )
    return any(re.search(pattern, normalized) for pattern in greeting_patterns)


def _call_init_greeting(local_time: str | None = None, timezone_name: str | None = None) -> str:
    tz_name = str(timezone_name or "Australia/Brisbane").strip() or "Australia/Brisbane"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("Australia/Brisbane")
    now = datetime.now(tz)
    if local_time:
        try:
            parsed = datetime.fromisoformat(str(local_time).replace("Z", "+00:00"))
            now = parsed.astimezone(tz) if parsed.tzinfo else parsed.replace(tzinfo=tz)
        except Exception:
            pass
    if now.hour < 12:
        return "Morning, I’m Mike from Ride Electric. How are you?"
    if now.hour < 17:
        return "Afternoon, you’re speaking with Mike at Ride Electric. What can I help you with?"
    return "Evening, you’re speaking with Mike at Ride Electric. What can I help you with?"


def _production_contract_requested(body: ChatRequest) -> bool:
    return (
        str(body.route_mode or "").strip() == PRODUCTION_CHAT_ROUTE_MODE
        and str(body.agent_category or "").strip() == CONSUMER_CUSTOMER_AGENT_CATEGORY
        and body.public_presenter_required
        and body.retail_output_guard_required
        and body.diagnostics_visible is False
    )


def _resolve_production_chat_agent(
    *,
    session: Session,
    body: ChatRequest,
    requested_agent: AgentProfileRecord,
) -> AgentProfileRecord:
    if not is_production_chat_surface(body.surface):
        return requested_agent
    if not _production_contract_requested(body):
        raise HTTPException(400, PRODUCTION_CONTRACT_ERROR)
    magic_mike = _get_magic_mike_agent(session)
    if magic_mike is None:
        raise HTTPException(400, PRODUCTION_CONTRACT_ERROR)
    if body.agent_id and requested_agent.id != magic_mike.id:
        raise HTTPException(400, PRODUCTION_CONTRACT_ERROR)
    return magic_mike


def _is_valid_magic_mike_consumer_runtime(agent: AgentProfileRecord, guardrails_config: dict[str, Any]) -> bool:
    category = str(guardrails_config.get("agent_category") or "").strip()
    route_mode = str(guardrails_config.get("route_mode") or "").strip()
    if category and category != CONSUMER_CUSTOMER_AGENT_CATEGORY:
        return False
    if route_mode and route_mode != PRODUCTION_CHAT_ROUTE_MODE:
        return False
    return _is_magic_mike_agent(agent)


def _sanitize_production_guardrails(agent: AgentProfileRecord, guardrails_config: dict[str, Any]) -> dict[str, Any]:
    if not _is_magic_mike_agent(agent):
        return guardrails_config
    sanitized = dict(guardrails_config)
    sanitized["agent_category"] = CONSUMER_CUSTOMER_AGENT_CATEGORY
    sanitized["route_mode"] = PRODUCTION_CHAT_ROUTE_MODE
    sanitized["public_presenter_required"] = True
    sanitized["retail_output_guard_required"] = True
    sanitized["diagnostics_visible"] = False
    sanitized["business_structure_required"] = False
    sanitized["owner_operator_questionnaire"] = ""
    sanitized["owner_operator_questionnaire_compact"] = ""
    sanitized["business_structure_context"] = ""
    sanitized["business_structure_context_compact"] = ""
    return sanitized


def _public_safe_history_context(history_context: str) -> str:
    lines = []
    for line in str(history_context or "").splitlines():
        if contains_forbidden_public_output(line):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


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
MULTI_AGENT_HANDOFF_DELAY_SECONDS = 0.85
SUB_AGENT_MAX_RETRIES = max(0, int(getattr(settings, "app_sub_agent_max_retries", 1)))
SUB_AGENT_RETRY_BACKOFF_SECONDS = max(0.0, float(getattr(settings, "app_sub_agent_retry_backoff_ms", 300)) / 1000.0)


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


def build_route_decision(
    *,
    message: str,
    workflow_mode: str,
    tool_plan: dict[str, Any] | None,
    kb_enabled: bool,
    web_enabled: bool,
    odoo_ready: bool,
) -> dict[str, Any]:
    text = (message or "").strip()
    lower = text.lower()
    document_intent = any(
        needle in lower
        for needle in (
            "business strategy",
            "strategy document",
            "board",
            "board-ready",
            "board ready",
            "30 page",
            "30-page",
            "document",
            "report",
        )
    )
    suggest_specialist = any(
        needle in lower
        for needle in (
            "create an agent",
            "create a new agent",
            "new agent",
            "specialist agent",
            "suggest an agent",
            "suggest a specialist",
        )
    )
    normalized_tool_plan = _normalize_tool_plan(tool_plan)
    tool_mode = str(normalized_tool_plan.get("mode") or "none")
    tool_op = normalized_tool_plan.get("operation")
    uses_tool = tool_mode not in ("none", "")
    recommended_workers: list[dict[str, str]] = []

    if suggest_specialist and not uses_tool:
        route_type = "suggest_specialist"
        rationale = "Suggested specialist: request implies new capability; approve creation or choose an existing agent."
    elif uses_tool or workflow_mode in (
        "data_collector",
        "odoo_specialist",
        "documenter",
        "case_framing",
        "evidence_retrieval",
        "odoo_operations",
        "bp_mode",
    ):
        route_type = "workers"
        if tool_op:
            rationale = f"Escalated to evidence-backed work: tool plan {tool_mode} for {tool_op}."
        else:
            rationale = "Escalated to worker/evidence-backed work for higher certainty."
        if workflow_mode == "bp_mode":
            recommended_workers = [
                {"id": "case_framing_agent", "name": "Case Framing Agent", "role": "case_definition"},
                {"id": "lead_enterprise_architect", "name": "Lead Enterprise Technical Business Architect", "role": "orchestration"},
                {"id": "auditor_agent", "name": "KPMG/EY Style Auditor Agent", "role": "quality_gate"},
            ]
        else:
            recommended_workers = [
                {"id": "finance_analyst", "name": "GhostDASH Finance Analyst", "role": "financial_extraction_and_interpretation"},
                {"id": "business_documenter", "name": "GhostDASH Business Documenter", "role": "board_ready_document_formatting"},
            ]
    else:
        route_type = "direct"
        rationale = "Direct answer: no tool-backed or multi-agent escalation required for this turn."
        recommended_workers = []

    return {
        "route_type": route_type,
        "rationale_summary": rationale,
        "document_intent": document_intent,
        "tool_expectations": {
            "kb_enabled": bool(kb_enabled),
            "web_enabled": bool(web_enabled),
            "odoo_ready": bool(odoo_ready),
            "tool_plan": {
                "tool_id": normalized_tool_plan.get("tool_id"),
                "mode": tool_mode,
                "operation": tool_op,
            }
            if uses_tool
            else None,
        },
        "recommended_workers": recommended_workers,
        "suggested_specialist_template": None,
    }


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

# Tertiary prompt budget is used only when the provider length guardrail is triggered again.
# This prevents a deadend fallback ("prompt too long") by aggressively removing context
# until the provider accepts the request.
RESPONSES_TERTIARY_ANSWER_PROMPT_BUDGET = AnswerPromptBudget(
    name="responses.tertiary",
    max_total_chars=6500,
    max_history_chars=0,
    max_upload_chars=600,
    max_approved_web_chars=0,
    max_query_chars=3000,
    query_prefix_compaction_mode="head",
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

CHAT_COMPLETIONS_TERTIARY_ANSWER_PROMPT_BUDGET = AnswerPromptBudget(
    name="chat_completions.tertiary",
    max_total_chars=1900,
    max_history_chars=0,
    max_upload_chars=250,
    max_approved_web_chars=0,
    max_query_chars=900,
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


def _should_route_finance_plan_to_odoo_mas(*, agent_name: str | None, operation: str | None) -> bool:
    if str(agent_name or "").strip().casefold() != "finance agent":
        return False
    normalized_operation = str(operation or "").strip().casefold()
    return normalized_operation.startswith("odoo.finance.") or normalized_operation in {
        "odoo.rpc.query_spec",
        "odoo.rpc.read_group",
        "odoo.mas.intent.auto_route",
    }


def _should_force_finance_message_to_odoo_mas(*, agent_name: str | None, message: str | None) -> bool:
    if str(agent_name or "").strip().casefold() != "finance agent":
        return False
    text = str(message or "").strip().casefold()
    if not text or "odoo" not in text:
        return False
    finance_terms = (
        "revenue",
        "cogs",
        "gp",
        "gross profit",
        "margin",
        "net",
        "roas",
        "cash",
        "receivable",
        "payable",
        "opex",
        "ledger",
        "marketing",
        "p&l",
        "profit and loss",
    )
    return any(term in text for term in finance_terms)


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
    if tool_response_data.get("net_profit") is not None:
        parts.append(f"net_profit={tool_response_data['net_profit']}")
    if tool_response_data.get("roas") is not None:
        parts.append(f"roas={tool_response_data['roas']}")
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
            f"- requested_company_ids: {payload.get('company_ids') or payload.get('company_id')}",
            "- company summaries:",
        ]
        companies = list(data.get("companies") or [])
        for company in companies[:8]:
            if not isinstance(company, dict):
                continue
            lines.append(
                "  - "
                + " | ".join(
                    [
                        str(company.get("company_name") or company.get("company_id") or "company"),
                        f"total_revenue={company.get('total_revenue')}",
                        f"total_cogs={company.get('total_cogs')}",
                        f"total_gp={company.get('total_gp')}",
                        f"avg_gp_pct={company.get('avg_gp_pct')}",
                    ]
                )
            )
        total_revenue = 0.0
        total_cogs = 0.0
        total_gp = 0.0
        for company in companies:
            if not isinstance(company, dict):
                continue
            try:
                total_revenue += float(company.get("total_revenue") or 0.0)
                total_cogs += float(company.get("total_cogs") or 0.0)
                total_gp += float(company.get("total_gp") or 0.0)
            except (TypeError, ValueError):
                continue
        if companies:
            lines.extend(
                [
                    "- derived group totals:",
                    f"  - revenue={total_revenue}",
                    f"  - cogs={total_cogs}",
                    f"  - gp={total_gp}",
                    f"  - gp_pct={(total_gp / total_revenue) if total_revenue else 0.0}",
                ]
            )
        lines.extend(
            [
                "- monthly rows:",
            ]
        )
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

    if operation == "odoo.finance.shopify.monthly_roi":
        lines = [
            "Executed Odoo Shopify monthly ROI helper:",
            f"- date_from: {data.get('date_from')}",
            f"- date_to: {data.get('date_to')}",
            f"- company_ids: {data.get('company_ids')}",
            f"- line_count: {data.get('line_count')}",
            "- company summaries:",
        ]
        for company in list(data.get("companies") or [])[:8]:
            if not isinstance(company, dict):
                continue
            lines.append(
                "  - "
                + " | ".join(
                    [
                        str(company.get("company_name") or company.get("company_id") or "company"),
                        f"shopify_revenue={company.get('shopify_revenue')}",
                        f"discounts={company.get('shopify_discounts')}",
                        f"refunds={company.get('shopify_refunds')}",
                        f"shipping={company.get('shopify_shipping')}",
                        f"fees={company.get('shopify_fees')}",
                        f"marketing_spend={company.get('marketing_spend')}",
                        f"net_shopify_revenue={company.get('net_shopify_revenue')}",
                        f"roas={company.get('roas')}",
                        f"contribution_after_marketing={company.get('contribution_after_marketing')}",
                    ]
                )
            )
        if isinstance(data.get("group_totals"), dict):
            group_totals = dict(data.get("group_totals") or {})
            lines.extend(
                [
                    "- group totals:",
                    "  - "
                    + " | ".join(
                        [
                            f"shopify_revenue={group_totals.get('shopify_revenue')}",
                            f"discounts={group_totals.get('shopify_discounts')}",
                            f"refunds={group_totals.get('shopify_refunds')}",
                            f"shipping={group_totals.get('shopify_shipping')}",
                            f"fees={group_totals.get('shopify_fees')}",
                            f"marketing_spend={group_totals.get('marketing_spend')}",
                            f"net_shopify_revenue={group_totals.get('net_shopify_revenue')}",
                            f"roas={group_totals.get('roas')}",
                            f"contribution_after_marketing={group_totals.get('contribution_after_marketing')}",
                        ]
                    ),
                ]
            )
        accounts_used = data.get("accounts_used")
        if isinstance(accounts_used, dict):
            lines.append("- accounts used:")
            for category, account_names in accounts_used.items():
                if not isinstance(account_names, list):
                    continue
                lines.append(f"  - {category}: {', '.join(str(item) for item in account_names[:12])}")
        journals_used = list(data.get("journals_used") or [])
        if journals_used:
            lines.append("- journals used:")
            for journal_name in journals_used[:12]:
                lines.append(f"  - {journal_name}")
        vendors_used = list(data.get("vendors_used") or [])
        if vendors_used:
            lines.append("- vendors used:")
            for vendor_name in vendors_used[:12]:
                lines.append(f"  - {vendor_name}")
        attribution_note = str(data.get("attribution_note") or "").strip()
        if attribution_note:
            lines.append(f"- attribution_note: {attribution_note}")
        order_metrics = data.get("shopify_order_metrics")
        if isinstance(order_metrics, dict):
            lines.extend(
                [
                    "- supplemental order metrics:",
                    "  - "
                    + " | ".join(
                        [
                            f"date_from={order_metrics.get('date_from')}",
                            f"date_to={order_metrics.get('date_to')}",
                            f"order_count={order_metrics.get('order_count')}",
                            f"order_total={order_metrics.get('order_total')}",
                            f"aov={order_metrics.get('aov')}",
                        ]
                    ),
                ]
            )
            for company_metrics in list(order_metrics.get("companies") or [])[:8]:
                if not isinstance(company_metrics, dict):
                    continue
                lines.append(
                    "  - company orders: "
                    + " | ".join(
                        [
                            str(company_metrics.get("company_name") or company_metrics.get("company_id") or "company"),
                            f"order_count={company_metrics.get('order_count')}",
                            f"order_total={company_metrics.get('order_total')}",
                            f"aov={company_metrics.get('aov')}",
                        ]
                    )
                )
        return "\n".join(lines).strip()

    if operation == "odoo.finance.pnl.period_summary":
        lines = [
            "Executed Odoo P&L period summary:",
            f"- date_from: {data.get('date_from')}",
            f"- date_to: {data.get('date_to')}",
            f"- requested_company_ids: {payload.get('company_ids') or payload.get('company_id')}",
            "- company summaries:",
        ]
        companies = list(data.get("companies") or data.get("rows") or [])
        for company in companies[:8]:
            if not isinstance(company, dict):
                continue
            lines.append(
                "  - "
                + " | ".join(
                    [
                        str(company.get("company_name") or company.get("company_id") or "company"),
                        f"operating_income={company.get('operating_income')}",
                        f"other_income={company.get('other_income')}",
                        f"cost_of_revenue={company.get('cost_of_revenue')}",
                        f"total_gross_profit={company.get('total_gross_profit')}",
                        f"expenses={company.get('expenses')}",
                        f"depreciation={company.get('depreciation')}",
                        f"total_expenses={company.get('total_expenses')}",
                        f"net_profit={company.get('net_profit')}",
                        f"roas={company.get('roas')}",
                    ]
                )
            )
        if isinstance(data.get("group_totals"), dict):
            group_totals = dict(data.get("group_totals") or {})
            lines.append("- group totals:")
            lines.append(
                "  - "
                + " | ".join(
                    [
                        f"operating_income={group_totals.get('operating_income')}",
                        f"other_income={group_totals.get('other_income')}",
                        f"cost_of_revenue={group_totals.get('cost_of_revenue')}",
                        f"total_gross_profit={group_totals.get('total_gross_profit')}",
                        f"expenses={group_totals.get('expenses')}",
                        f"depreciation={group_totals.get('depreciation')}",
                        f"total_expenses={group_totals.get('total_expenses')}",
                        f"net_profit={group_totals.get('net_profit')}",
                        f"roas={group_totals.get('roas')}",
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


def _normalize_company_lookup(value: str) -> str:
    return "".join(ch for ch in value.casefold() if ch.isalnum())


def _extract_year_from_iso_date(value: Any) -> int | None:
    raw = str(value or "").strip()
    if len(raw) < 4 or not raw[:4].isdigit():
        return None
    year = int(raw[:4])
    if 1900 <= year <= 2100:
        return year
    return None


def _resolve_company_terms_for_payload(
    session: Session,
    *,
    agent_id: str,
    payload: dict[str, Any],
    tool_overrides: dict[str, bool] | None,
) -> tuple[dict[str, Any], ChatToolEvent | None, str | None, dict[str, Any] | None]:
    resolved_input = dict(payload)
    company_terms = [str(term).strip() for term in list(payload.get("company_name_terms") or []) if str(term).strip()]
    parsed_company_ids: list[int] = []
    for raw in list(resolved_input.get("company_ids") or []):
        try:
            parsed_company_ids.append(int(raw))
        except (TypeError, ValueError):
            continue
    candidate_years = {
        year
        for year in (
            _extract_year_from_iso_date(resolved_input.get("date_from")),
            _extract_year_from_iso_date(resolved_input.get("date_to")),
        )
        if year is not None
    }
    if company_terms and parsed_company_ids and candidate_years and all(company_id in candidate_years for company_id in parsed_company_ids):
        resolved_input.pop("company_ids", None)
        raw_company_id = resolved_input.get("company_id")
        try:
            parsed_company_id = int(raw_company_id)
        except (TypeError, ValueError):
            parsed_company_id = None
        if parsed_company_id in candidate_years:
            resolved_input.pop("company_id", None)
    if not company_terms or resolved_input.get("company_ids"):
        return resolved_input, None, None, None

    lookup_payload = {
        "model": "res.company",
        "domain": [],
        "fields": ["id", "name"],
        "limit": 100,
        "offset": 0,
        "order": "name asc",
    }
    tool_response, _readiness = execute_tool_operation_for_agent(
        session,
        agent_id=agent_id,
        operation="odoo.rpc.search_read",
        payload=lookup_payload,
        tool_overrides=tool_overrides,
        surface="consumer_chat",
    )
    if not tool_response.success:
        event = ChatToolEvent(
            tool_id="odoo_primary",
            status="blocked" if "blocked_reasons" in (tool_response.data or {}) else "failed",
            operation="odoo.rpc.search_read",
            summary=tool_response.message or "Could not resolve company names from Odoo.",
            blocked_reason=next(iter((tool_response.data or {}).get("blocked_reasons") or []), None),
            payload={"company_name_terms": company_terms, "requested_company_ids": parsed_company_ids},
            latency_ms=tool_response.latency_ms,
        )
        detail = (
            "Company-name resolution failed before the finance comparison could run:\n"
            + _safe_json(
                {
                    "operation": "odoo.rpc.search_read",
                    "payload": lookup_payload,
                    "message": tool_response.message,
                    "data": tool_response.data,
                }
            )
        )
        return resolved_input, event, detail, None

    records = list((tool_response.data or {}).get("records") or [])
    matches: list[tuple[str, int, str]] = []
    ambiguous_terms: list[dict[str, Any]] = []
    missing_terms: list[str] = []
    for term in company_terms:
        normalized_term = _normalize_company_lookup(term)
        candidates: list[tuple[int, str]] = []
        for record in records:
            try:
                company_id = int(record.get("id"))
            except (TypeError, ValueError):
                continue
            company_name = str(record.get("name") or "").strip()
            normalized_name = _normalize_company_lookup(company_name)
            if not normalized_name:
                continue
            if normalized_term == normalized_name or normalized_term in normalized_name:
                candidates.append((company_id, company_name))
        deduped_candidates = list(dict.fromkeys(candidates))
        if len(deduped_candidates) == 1:
            company_id, company_name = deduped_candidates[0]
            matches.append((term, company_id, company_name))
        elif len(deduped_candidates) > 1:
            ambiguous_terms.append(
                {
                    "term": term,
                    "matches": [{"id": company_id, "name": company_name} for company_id, company_name in deduped_candidates[:5]],
                }
            )
        else:
            missing_terms.append(term)

    if ambiguous_terms or missing_terms:
        event = ChatToolEvent(
            tool_id="odoo_primary",
            status="blocked",
            operation="odoo.rpc.search_read",
            summary="Could not safely resolve all named businesses to canonical Odoo companies.",
            blocked_reason="company_name_resolution_failed",
            payload={"company_name_terms": company_terms, "requested_company_ids": parsed_company_ids},
            latency_ms=tool_response.latency_ms,
        )
        detail = (
            "Named company resolution needs clarification before the finance comparison can run:\n"
            + _safe_json(
                {
                    "requested_terms": company_terms,
                    "matched": [{"term": term, "company_id": company_id, "company_name": company_name} for term, company_id, company_name in matches],
                    "ambiguous_terms": ambiguous_terms,
                    "missing_terms": missing_terms,
                }
            )
        )
        return resolved_input, event, detail, None

    resolved_payload = dict(resolved_input)
    resolved_payload["company_ids"] = [company_id for _term, company_id, _company_name in matches]
    if len(resolved_payload["company_ids"]) == 1:
        resolved_payload["company_id"] = resolved_payload["company_ids"][0]
    resolved_payload.pop("company_name_terms", None)
    resolution_summary = ", ".join(f"{term}->{company_name} ({company_id})" for term, company_id, company_name in matches)
    event = ChatToolEvent(
        tool_id="odoo_primary",
        status="executed",
        operation="odoo.rpc.search_read",
        summary=f"Resolved company names: {resolution_summary}",
        payload={"company_name_terms": company_terms, "company_ids": resolved_payload["company_ids"]},
        latency_ms=tool_response.latency_ms,
    )
    detail = (
        "Resolved named company scope from `res.company` before running the finance comparison:\n"
        + _safe_json(
            {
                "requested_terms": company_terms,
                "resolved": [
                    {"term": term, "company_id": company_id, "company_name": company_name}
                    for term, company_id, company_name in matches
                ],
            }
        )
    )
    return resolved_payload, event, detail, dict(tool_response.data or {})


def _supplement_shopify_orders_aov(
    session: Session,
    *,
    agent_id: str,
    payload: dict[str, Any],
    tool_overrides: dict[str, bool] | None,
) -> tuple[dict[str, Any] | None, ChatToolEvent | None, str]:
    date_from = str(payload.get("date_from") or "").strip()
    date_to = str(payload.get("date_to") or "").strip()
    if not date_from or not date_to:
        return None, None, ""
    company_ids = [value for value in list(payload.get("company_ids") or []) if isinstance(value, int)]
    company_id = payload.get("company_id")
    if isinstance(company_id, int) and company_id not in company_ids:
        company_ids.append(company_id)
    domain: list[Any] = [
        ["date_order", ">=", date_from],
        ["date_order", "<", date_to],
    ]
    if company_ids:
        domain.append(["company_id", "in", company_ids])
    orders_response, _readiness = execute_tool_operation_for_agent(
        session,
        agent_id=agent_id,
        operation="odoo.sales.orders.search_read",
        payload={
            "domain": domain,
            "limit": 500,
            "fields": ["id", "name", "state", "date_order", "amount_total", "company_id", "currency_id"],
        },
        tool_overrides=tool_overrides,
        surface="consumer_chat",
    )
    if not orders_response.success:
        return None, None, ""
    records = list((orders_response.data or {}).get("records") or [])
    total_orders = len(records)
    total_amount = 0.0
    by_company: dict[int, dict[str, Any]] = {}
    for record in records:
        if not isinstance(record, dict):
            continue
        try:
            amount = float(record.get("amount_total") or 0)
        except (TypeError, ValueError):
            amount = 0.0
        total_amount += amount
        company_field = record.get("company_id")
        if isinstance(company_field, list) and company_field and isinstance(company_field[0], int):
            resolved_company_id = int(company_field[0])
            entry = by_company.setdefault(
                resolved_company_id,
                {
                    "company_id": resolved_company_id,
                    "company_name": str(company_field[1]) if len(company_field) > 1 else f"Company {resolved_company_id}",
                    "order_count": 0,
                    "order_total": 0.0,
                    "aov": 0.0,
                },
            )
            entry["order_count"] += 1
            entry["order_total"] += amount
    for entry in by_company.values():
        count = int(entry.get("order_count") or 0)
        entry["aov"] = (float(entry.get("order_total") or 0.0) / count) if count else None
    summary_data = {
        "date_from": date_from,
        "date_to": date_to,
        "order_count": total_orders,
        "order_total": total_amount,
        "aov": (total_amount / total_orders) if total_orders else None,
        "companies": sorted(by_company.values(), key=lambda item: str(item.get("company_name") or "")),
    }
    event = ChatToolEvent(
        tool_id="odoo_primary",
        status="executed",
        operation="odoo.sales.orders.search_read",
        summary=f"orders={total_orders}",
        payload={"date_from": date_from, "date_to": date_to, "company_ids": company_ids},
        latency_ms=orders_response.latency_ms,
    )
    detail = (
        "Supplemental Odoo order-level pull for Shopify order_count/AOV:\n"
        + _safe_json(summary_data, max_chars=1800)
    )
    return summary_data, event, detail


def prepare_tool_evidence(
    session: Session,
    *,
    agent_id: str,
    agent_name: str | None = None,
    tool_overrides: dict[str, bool] | None,
    tool_plan: dict[str, Any] | None,
    workflow_mode: str | None = None,
    request_message: str | None = None,
) -> PreparedToolEvidence:
    is_bp_mode = str(workflow_mode or "").strip().casefold() == "bp_mode"
    normalized_plan = _normalize_tool_plan(tool_plan)
    mode = str(normalized_plan.get("mode") or "none")
    operation = str(normalized_plan.get("operation") or "").strip() or None
    payload = dict(normalized_plan.get("payload") or {})
    blocked_reason = str(normalized_plan.get("blocked_reason") or "").strip() or None
    reason = str(normalized_plan.get("reason") or "").strip()
    force_mas_autoroute = _should_force_finance_message_to_odoo_mas(agent_name=agent_name, message=request_message)

    if (mode == "none" or not operation) and not force_mas_autoroute:
        return PreparedToolEvidence(
            plan=normalized_plan,
            prompt_prefix="",
            citations=[],
            tool_events=[],
            can_cache_response=not is_bp_mode,
        )

    tool_events: list[ChatToolEvent] = []
    citations: list[dict[str, Any]] = []
    detail_blocks: list[str] = []
    if force_mas_autoroute and not operation:
        operation = "odoo.mas.intent.auto_route"
        mode = "required"
        normalized_plan["mode"] = mode
        normalized_plan["operation"] = operation

    if _should_route_finance_plan_to_odoo_mas(agent_name=agent_name, operation=operation):
        source_operation = operation
        mas_message = str(request_message or "").strip()
        if not mas_message:
            event = ChatToolEvent(
                tool_id=str(normalized_plan.get("tool_id") or "odoo_primary"),
                status="blocked",
                operation=source_operation,
                summary="MAS v2 routing requires the request message.",
                blocked_reason="missing_request_message",
                payload={"request": payload},
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

        mas_result = run_odoo_mas_pipeline(session, message=mas_message)
        if bool(mas_result.get("success")):
            markdown = str(mas_result.get("markdown") or "").strip()
            exec_truth: dict[str, object] = {
                "status": "executed",
                "operation": source_operation,
                "evidence_source_mode": "odoo_mas_v2",
            }
            if bool(mas_result.get("phase2")):
                exec_truth["phase2"] = True
            event = ChatToolEvent(
                tool_id=str(normalized_plan.get("tool_id") or "odoo_primary"),
                status="executed",
                operation=source_operation,
                summary="Executed via Odoo MAS v2 pipeline.",
                payload={
                    "request": payload,
                    "response": dict(mas_result),
                    "execution_truth": exec_truth,
                },
            )
            tool_events.append(event)
            citations.append(_tool_citation_from_event(event))
            detail_blocks.append(
                "Executed Odoo MAS v2 pipeline:\n"
                + (
                    markdown
                    if markdown
                    else _safe_json(
                        {
                            "intent": mas_result.get("intent"),
                            "metric_pack": mas_result.get("metric_pack"),
                            "reasoning": mas_result.get("reasoning"),
                        },
                        max_chars=1800,
                    )
                )
            )
            return PreparedToolEvidence(
                plan=normalized_plan,
                prompt_prefix=_build_tool_prompt_prefix(tool_events, detail_blocks),
                citations=citations,
                tool_events=tool_events,
                can_cache_response=False,
            )

        blocked_reason_mas = str(mas_result.get("blocked_reason") or "odoo_mas_failed")
        summary = str(mas_result.get("message") or "Odoo MAS v2 pipeline blocked this request.")
        event = ChatToolEvent(
            tool_id=str(normalized_plan.get("tool_id") or "odoo_primary"),
            status="blocked",
            operation=source_operation,
            summary=summary,
            blocked_reason=blocked_reason_mas,
            payload={
                "request": payload,
                "response": dict(mas_result),
                "execution_truth": {
                    "status": "blocked",
                    "operation": source_operation,
                    "evidence_source_mode": "odoo_mas_v2",
                },
            },
        )
        tool_events.append(event)
        citations.append(_tool_citation_from_event(event))
        detail_blocks.append("Odoo MAS v2 blocked:\n" + _safe_json(mas_result, max_chars=1800))
        return PreparedToolEvidence(
            plan=normalized_plan,
            prompt_prefix=_build_tool_prompt_prefix(tool_events, detail_blocks),
            citations=citations,
            tool_events=tool_events,
            can_cache_response=False,
        )

    if operation in {"odoo.finance.margin.monthly_comparison", "odoo.finance.shopify.monthly_roi", "odoo.finance.pnl.period_summary"} and payload.get("company_name_terms"):
        payload, resolution_event, resolution_detail, resolution_data = _resolve_company_terms_for_payload(
            session,
            agent_id=agent_id,
            payload=payload,
            tool_overrides=tool_overrides,
        )
        normalized_plan["payload"] = payload
        if resolution_event is not None:
            tool_events.append(resolution_event)
            citations.append(_tool_citation_from_event(resolution_event))
        if resolution_detail:
            detail_blocks.append(resolution_detail)
        if resolution_event is not None and resolution_event.status != "executed":
            return PreparedToolEvidence(
                plan=normalized_plan,
                prompt_prefix=_build_tool_prompt_prefix(tool_events, detail_blocks),
                citations=citations,
                tool_events=tool_events,
                can_cache_response=False,
            )
        if resolution_data:
            detail_blocks.append(_safe_json({"company_lookup": resolution_data}, max_chars=1600))

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
        if operation == "odoo.finance.shopify.monthly_roi" and _requests_shopify_order_metrics(request_message or ""):
            supplemental_metrics, supplemental_event, supplemental_detail = _supplement_shopify_orders_aov(
                session,
                agent_id=agent_id,
                payload=payload,
                tool_overrides=tool_overrides,
            )
            if supplemental_metrics is not None:
                merged_data = dict(tool_response.data or {})
                merged_data["shopify_order_metrics"] = supplemental_metrics
                tool_response.data = merged_data
            if supplemental_event is not None:
                tool_events.append(supplemental_event)
                citations.append(_tool_citation_from_event(supplemental_event))
            if supplemental_detail:
                detail_blocks.append(supplemental_detail)
        summary = _summarize_tool_payload(tool_response.data)
        event_payload = {
            "request": payload,
            "response": dict(tool_response.data or {}),
            "execution_truth": {
                "status": "executed",
                "operation": operation,
                "evidence_source_mode": (tool_response.data or {}).get("evidence_source_mode", "live_odoo"),
                "date_from": (tool_response.data or {}).get("date_from"),
                "date_to": (tool_response.data or {}).get("date_to"),
                "company_id": (tool_response.data or {}).get("company_id"),
                "company_ids": (tool_response.data or {}).get("company_ids"),
                "company_name_terms": (tool_response.data or {}).get("company_name_terms"),
                "company_scope_lock": (tool_response.data or {}).get("company_scope_lock"),
                "company_scope_lock_canonical": (tool_response.data or {}).get("company_scope_lock_canonical"),
                "scope_enforced": (tool_response.data or {}).get("scope_enforced"),
            },
        }
        if is_bp_mode:
            event_payload["bp_data_quality"] = {
                "fresh_data_requested": True,
                "data_accuracy_probability": (
                    0.9
                    if bool((tool_response.data or {}).get("evidence_source_mode") == "live_odoo")
                    else 0.6
                ),
                "confidence_weighting_note": "Weighted by execution status and live Odoo evidence source.",
            }
        event = ChatToolEvent(
            tool_id=str(normalized_plan.get("tool_id") or "odoo_primary"),
            status="executed",
            operation=operation,
            summary=summary,
            payload=event_payload,
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
            payload={
                "request": payload,
                "response": dict(tool_response.data or {}),
                "execution_truth": {
                    "status": "blocked" if "blocked_reasons" in (tool_response.data or {}) else "failed",
                    "operation": operation,
                    "date_from": payload.get("date_from"),
                    "date_to": payload.get("date_to"),
                    "company_id": payload.get("company_id"),
                    "company_ids": payload.get("company_ids"),
                    "company_name_terms": payload.get("company_name_terms"),
                    "company_scope_lock": payload.get("company_scope_lock"),
                    "company_scope_lock_canonical": payload.get("company_scope_lock_canonical"),
                    "scope_enforced": payload.get("scope_enforced"),
                },
            },
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
        can_cache_response=False if is_bp_mode else False,
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
    workflow_mode: str | None = None,
    embedding_model_id: str | None = None,
    kb_enabled: bool = True,
    odoo_ready: bool = False,
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
                "workflow_mode": workflow_mode,
                "embedding_model_id": embedding_model_id,
                "kb_enabled": kb_enabled,
                "odoo_ready": odoo_ready,
            },
        )
        response.raise_for_status()
        return response.json()


def resolve_docx_operation(docx_mode: Any) -> str:
    raw = getattr(docx_mode, "operation", "preview")
    if hasattr(raw, "value"):
        raw = getattr(raw, "value")
    operation = str(raw or "preview").strip().lower()
    if "." in operation:
        operation = operation.split(".")[-1]
    return operation or "preview"


async def render_docx_with_sidecar(
    *,
    docx_mode: Any,
    trace_id: str,
    agent_id: str,
    conversation_id: str,
    answer_text: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not docx_mode or not bool(getattr(docx_mode, "enabled", False)):
        return [], []
    operation = resolve_docx_operation(docx_mode)
    path = "/render/finalize" if operation == "finalize" else "/render/preview"
    template_id = str(getattr(docx_mode, "template_id", "") or "").strip()
    payload = {
        "template_id": template_id or None,
        "binding_overrides": dict(getattr(docx_mode, "binding_overrides", {}) or {}),
        "message_context": answer_text,
        "trace_id": trace_id,
        "agent_id": agent_id,
        "conversation_id": conversation_id,
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(f"{settings.app_docx_sidecar_url.rstrip('/')}{path}", json=payload)
        if response.status_code >= 400:
            return [], [
                {
                    "code": "docx_sidecar_error",
                    "message": f"Docx sidecar returned {response.status_code}",
                    "field": None,
                }
            ]
        data = response.json()
        artifacts = list(data.get("artifacts") or [])
        diagnostics = list(data.get("diagnostics") or [])
        return artifacts, diagnostics
    except Exception as exc:
        return [], [
            {
                "code": "docx_sidecar_unavailable",
                "message": f"Docx sidecar request failed: {exc!r}",
                "field": None,
            }
        ]


def validate_docx_finalize_output(
    *, operation: str, answer_text: str, required_sections: list[str] | None = None
) -> list[dict[str, Any]]:
    if operation != "finalize":
        return []
    lowered = str(answer_text or "").casefold()
    sections = list(required_sections or ["facts", "inferences", "assumptions", "risks", "actions"])
    missing = [section for section in sections if section not in lowered]
    if not missing:
        return []
    return [
        {
            "code": "docx_finalize_validation_failed",
            "message": f"Finalize output is missing required section(s): {', '.join(missing)}.",
            "field": "message_context",
        }
    ]


def render_docx_with_sidecar_sync(
    *,
    docx_mode: Any,
    trace_id: str,
    agent_id: str,
    conversation_id: str,
    answer_text: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not docx_mode or not bool(getattr(docx_mode, "enabled", False)):
        return [], []
    operation = resolve_docx_operation(docx_mode)
    path = "/render/finalize" if operation == "finalize" else "/render/preview"
    template_id = str(getattr(docx_mode, "template_id", "") or "").strip()
    payload = {
        "template_id": template_id or None,
        "binding_overrides": dict(getattr(docx_mode, "binding_overrides", {}) or {}),
        "message_context": answer_text,
        "trace_id": trace_id,
        "agent_id": agent_id,
        "conversation_id": conversation_id,
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(f"{settings.app_docx_sidecar_url.rstrip('/')}{path}", json=payload)
        if response.status_code >= 400:
            return [], [
                {
                    "code": "docx_sidecar_error",
                    "message": f"Docx sidecar returned {response.status_code}",
                    "field": None,
                }
            ]
        data = response.json()
        artifacts = list(data.get("artifacts") or [])
        diagnostics = list(data.get("diagnostics") or [])
        return artifacts, diagnostics
    except Exception as exc:
        return [], [
            {
                "code": "docx_sidecar_unavailable",
                "message": f"Docx sidecar request failed: {exc!r}",
                "field": None,
            }
        ]


def build_query_message(*, message: str, history_context: str) -> str:
    if not history_context:
        return message
    return (
        "Recent conversation memory:\n"
        f"{history_context}\n\n"
        f"Current user request:\n{message}"
    )


def resolve_conversation_mode(*, requested_mode: str | None, guardrails_config: dict[str, Any]) -> str:
    candidate = str(requested_mode or guardrails_config.get("conversation_mode") or "quick").strip().casefold()
    if candidate in {"quick", "board", "working_session"}:
        return candidate
    return "quick"


def resolve_workflow_mode(*, requested_mode: str | None, conversation: AgentConversationRecord | None = None) -> str:
    candidate = str(requested_mode or getattr(conversation, "workflow_mode", None) or "standard").strip().casefold()
    if candidate in {
        "standard",
        "data_collector",
        "documenter",
        "odoo_specialist",
        "case_framing",
        "evidence_retrieval",
        "odoo_operations",
        "bp_mode",
    }:
        return candidate
    return "standard"


def _sanitize_owner_operator_template(raw: str) -> str:
    text = " ".join(str(raw or "").split())
    if not text:
        return ""
    # Strip long hashable tails so malformed questionnaire text does not leak into answers.
    text = re.sub(r"Source template hashable text:\s*.*$", "", text, flags=re.IGNORECASE).strip()
    return text[:420].strip()


def build_owner_operator_questionnaire_directives(*, guardrails_config: dict[str, Any]) -> str:
    questionnaire = str(guardrails_config.get("owner_operator_questionnaire") or "").strip()
    compact = str(guardrails_config.get("owner_operator_questionnaire_compact") or "").strip()
    if not questionnaire and not compact:
        return ""
    preferred_template = compact or questionnaire
    sanitized_template = _sanitize_owner_operator_template(preferred_template)
    template_line = f"- Apply this owner-operator intent: {sanitized_template}\n" if sanitized_template else ""
    return (
        "Owner-operator guidance template (high priority):\n"
        f"{template_line}"
        "Enforcement notes:\n"
        "- Treat branch/location/store/site/shop as equivalent scope words.\n"
        "- If Retail, Burleigh, Brisbane, or Online are present, avoid redundant branch-mapping blockers.\n"
        "- Lead with a decisive answer and recommended actions; ask permission before destructive changes.\n"
        "- Expand key abbreviations once, for example return on ad spend (ROAS).\n"
        "- Never quote, paraphrase, or echo the owner-operator template text in the final answer."
    ).strip()


def _sanitize_business_structure_context(raw: str) -> str:
    lines = [line.strip() for line in str(raw or "").splitlines() if line.strip()]
    if not lines:
        return ""
    return "\n".join(lines)[:6000].strip()


def _compact_business_structure_context(raw: str) -> str:
    normalized = " ".join(str(raw or "").split())
    if not normalized:
        return ""
    return f"Business structure memory: {normalized[:900]}".strip()


def _resolve_business_structure_question_bank(guardrails_config: dict[str, Any]) -> str:
    configured = str(guardrails_config.get("business_structure_question_bank") or "").strip()
    return configured or DEFAULT_BUSINESS_STRUCTURE_QUESTION_BANK


def _looks_like_business_structure_capture_message(message: str) -> bool:
    lowered = str(message or "").casefold()
    return (
        lowered.startswith("business structure:")
        or lowered.startswith("business context:")
        or lowered.startswith("entity map:")
        or lowered.startswith("company structure:")
        or lowered.startswith("foundation:")
    )


def _extract_business_structure_payload(message: str) -> str | None:
    text = str(message or "").strip()
    if not text:
        return None
    normalized = text.casefold()
    for prefix in (
        "business structure:",
        "business context:",
        "entity map:",
        "company structure:",
        "foundation:",
    ):
        if normalized.startswith(prefix):
            payload = text[len(prefix):].strip()
            return payload or None
    return None


def maybe_bank_business_structure_context(
    session: Session,
    *,
    runtime_profile,
    guardrails_config: dict[str, Any],
    message: str,
) -> tuple[dict[str, Any], bool]:
    if not _looks_like_business_structure_capture_message(message):
        return guardrails_config, False
    captured = _sanitize_business_structure_context(_extract_business_structure_payload(message) or "")
    if not captured:
        return guardrails_config, False
    next_guardrails = dict(guardrails_config)
    if str(next_guardrails.get("business_structure_context") or "").strip() == captured:
        return next_guardrails, False
    next_guardrails["business_structure_context"] = captured
    next_guardrails["business_structure_context_compact"] = _compact_business_structure_context(captured)
    runtime_profile.guardrails_config_json = next_guardrails
    session.commit()
    session.refresh(runtime_profile)
    return next_guardrails, True


def build_business_structure_directives(*, guardrails_config: dict[str, Any]) -> str:
    if not bool(guardrails_config.get("business_structure_required", True)):
        return ""
    context = _sanitize_business_structure_context(str(guardrails_config.get("business_structure_context") or ""))
    if not context:
        return ""
    return (
        "Business structure memory (high priority):\n"
        f"{context}\n\n"
        "Use this as the authoritative entity/channel foundation for this runtime profile. "
        "If the user provides a newer structure, ask to update and replace this memory."
    ).strip()


def _requires_business_structure_for_message(message: str) -> bool:
    lowered = str(message or "").casefold()
    finance_terms = (
        "revenue",
        "cogs",
        "gross margin",
        "gross profit",
        "p&l",
        "profit and loss",
        "net profit",
        "finance",
        "forecast",
    )
    framing_terms = (
        "business",
        "board",
        "strategy",
        "performance",
        "performer",
        "underperform",
        "assessment",
        "commentary",
        "what matters",
        "recommend",
        "advice",
    )
    return any(term in lowered for term in finance_terms) and any(term in lowered for term in framing_terms)


def _has_explicit_branch_or_entity_scope(message: str) -> bool:
    lowered = str(message or "").casefold()
    explicit_tokens = (
        "burleigh",
        "brisbane",
        "retail",
        "ride electric",
        "company_id",
        "company ids",
        "branch",
        "branches",
    )
    return any(token in lowered for token in explicit_tokens)


def build_missing_business_structure_answer(
    *,
    message: str,
    workflow_mode: str,
    guardrails_config: dict[str, Any],
) -> str | None:
    if not bool(guardrails_config.get("business_structure_required", True)):
        return None
    if not _requires_business_structure_for_message(message):
        return None
    if _looks_like_business_structure_capture_message(message):
        return None
    existing = _sanitize_business_structure_context(str(guardrails_config.get("business_structure_context") or ""))
    if existing:
        return None
    # If the user already provides explicit branch/entity scope, let Odoo execution proceed.
    if _has_explicit_branch_or_entity_scope(message):
        return None
    if workflow_mode in {"case_framing", "evidence_retrieval", "odoo_operations"}:
        return None
    question_bank = _resolve_business_structure_question_bank(guardrails_config)
    return (
        "I can not give a meaningful business-performance answer yet because this runtime profile has no business structure memory.\n\n"
        "Please answer this question bank (you can paste it in one response; start with `Business structure:`):\n"
        f"{question_bank}\n\n"
        "Once you provide it, GhostDASH will store it in runtime memory and reuse it for future answers until you change it."
    )


def _looks_like_strategy_document_request(message: str) -> bool:
    lowered = str(message or "").casefold()
    return any(
        token in lowered
        for token in ("business plan", "board strategy", "strategy memo", "board memo", "memo", "plan")
    )


def _looks_like_financial_report_request(message: str) -> bool:
    lowered = str(message or "").casefold()
    finance_terms = ("financial report", "revenue", "cogs", "gross profit", "gross margin", "cashflow", "p&l", "profit")
    board_terms = ("board", "startup", "monthly", "report")
    return any(term in lowered for term in finance_terms) and any(term in lowered for term in board_terms)


def build_reporting_format_directives(*, message: str, guardrails_config: dict[str, Any]) -> str:
    strategy = _looks_like_strategy_document_request(message)
    financial = _looks_like_financial_report_request(message)
    if not strategy and not financial:
        return ""
    board_contract = str(guardrails_config.get("board_document_format_contract") or "").strip()
    financial_contract = str(guardrails_config.get("financial_report_format_contract") or "").strip()
    lines = ["Formatting contract (mandatory):"]
    if strategy:
        lines.extend(
            [
                "- Strategy, plan, and memo outputs must follow a board-ready business-plan structure.",
                (
                    f"- Use this configured section order:\n{board_contract}"
                    if board_contract
                    else "- Use sections in order: Executive summary, Context, Objectives, Strategic options, Chosen plan, Execution roadmap, Risks and mitigations, Decision requests."
                ),
                "- End with explicit owners, due dates, and measurable outcomes.",
            ]
        )
    if financial:
        lines.extend(
            [
                "- Financial reports must follow board reporting principles and be decision-first.",
                (
                    f"- Use this configured financial structure:\n{financial_contract}"
                    if financial_contract
                    else "- Include: headline performance summary, concise KPI table, variance vs prior period/plan, cash and runway implications, top drivers, risks, and next actions."
                ),
                "- Do not output raw ledger dumps without executive framing and variance commentary.",
            ]
        )
    return "\n".join(lines).strip()


def resolve_docx_finalize_required_sections(*, guardrails_config: dict[str, Any] | None) -> list[str]:
    incoming = (guardrails_config or {}).get("docx_finalize_required_sections")
    if not isinstance(incoming, list):
        incoming = ["facts", "inferences", "assumptions", "risks", "actions"]
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in incoming:
        section = str(raw or "").strip().casefold()
        if not section or section in seen:
            continue
        seen.add(section)
        normalized.append(section)
    return normalized or ["facts", "inferences", "assumptions", "risks", "actions"]


def normalize_docx_finalize_answer(*, operation: str, answer_text: str, required_sections: list[str]) -> str:
    if operation != "finalize":
        return answer_text
    text = str(answer_text or "").strip()
    lowered = text.casefold()
    missing = [section for section in required_sections if section not in lowered]
    if not missing:
        return text
    section_chunks: list[str] = []
    if text:
        section_chunks.append(text)
    for section in missing:
        title = section.capitalize()
        section_chunks.append(
            f"### {title}\n- PROVISIONAL: section auto-inserted for finalize contract compliance. "
            "Use source evidence and operator review to harden this section."
        )
    return "\n\n".join(section_chunks).strip()


def build_effective_system_prompt(
    *,
    base_system_prompt: str,
    conversation_mode: str,
    workflow_mode: str,
    guardrails_config: dict[str, Any] | None = None,
    message: str = "",
) -> str:
    workflow_directives = ""
    if workflow_mode == "data_collector":
        workflow_directives = (
            "Workflow mode: data_collector.\n"
            "- Lead the discussion like a strategist collecting truth.\n"
            "- Ask only the next highest-value question.\n"
            "- Produce short approval-ready outputs rather than long essays.\n"
            "- Do not silently promote speculative content into final document claims."
        )
    elif workflow_mode == "documenter":
        workflow_directives = (
            "Workflow mode: documenter.\n"
            "- Stay passive by default and operate from approved material.\n"
            "- Treat the document frame as the primary approved source.\n"
            "- Do not convert tentative discussion into final claims without clear grounding."
        )
    elif workflow_mode == "odoo_specialist":
        workflow_directives = (
            "Workflow mode: odoo_specialist.\n"
            "- Be retrieval-first, not prose-first.\n"
            "- Prefer exact governed Odoo evidence over generic strategy language.\n"
            "- State clearly whether Odoo ran, was blocked, or was unavailable.\n"
            "- Behave like an interactive agent (multi-step): one message may require several governed Odoo calls — "
            "e.g. company/period-scoped ledger GP or P&L first, and Shopify-channel ROI only when that channel was "
            "asked for. Treat Odoo (ERP) and Shopify (channel sub-ledger) as composable, not mutually exclusive.\n"
            "- Choose operations deliberately: product catalog pulls -> `odoo.products.search_read`; period sales-order checks -> "
            "`odoo.sales.orders.search_read`; ranked product GP requests -> `odoo.sales.products_gp.period_top`.\n"
            "- When the user describes a repeatable check they want at workflow design time, state the implied tool "
            "sequence (entities, date rules, operations) before answering."
        )
    elif workflow_mode == "case_framing":
        workflow_directives = (
            "Workflow mode: case_framing.\n"
            "- You are a case-framing agent only.\n"
            "- No tool access and no writes.\n"
            "- Frame the work only with this output contract: objective, sub_questions, required_evidence, "
            "recommended_workflow, risk_level, write_access_required.\n"
            "- Do not produce recommendations that require evidence collection or execution."
        )
    elif workflow_mode == "evidence_retrieval":
        workflow_directives = (
            "Workflow mode: evidence_retrieval.\n"
            "- Read-only evidence collection and normalization only.\n"
            "- No recommendations, no prescriptions, and no actions.\n"
            "- Return only factual findings, source attribution, freshness, contradictions, and missing-data flags."
        )
    elif workflow_mode == "odoo_operations":
        workflow_directives = (
            "Workflow mode: odoo_operations.\n"
            "- Execute only structured Odoo action requests.\n"
            "- Never execute from free text.\n"
            "- Required fields: target_model, operation, field_whitelist, reason, approval_state.\n"
            "- If the structure or approval state is invalid, explain the blocker and stop."
        )
    elif workflow_mode == "bp_mode":
        workflow_directives = (
            "Workflow mode: bp_mode.\n"
            "- Run as an enterprise closeout workflow: Case Framing -> Lead Architect -> Auditor.\n"
            "- Be proactive and outcome-focused: never stop at a blocker-only response.\n"
            "- If data is incomplete, return the strongest provisional answer plus exact next retrieval steps.\n"
            "- Prefer fresh governed Odoo evidence over cached assumptions.\n"
            "- Include confidence and freshness notes for financial claims.\n"
            "- Board output must include COGS, GP, Revenue, Net, and ROAS when requested."
        )
    if conversation_mode == "board":
        prompt = (
            f"{base_system_prompt}\n\n"
            "Conversation mode: board.\n"
            "- Deliver a full executive-grade first answer when the evidence supports it.\n"
            "- Start with the direct answer, then a compact scorecard, key drivers, risks, and next actions.\n"
            "- Do not force a staged 'continue' pattern for finance comparisons."
        ).strip()
    elif conversation_mode == "working_session":
        prompt = (
            f"{base_system_prompt}\n\n"
            "Conversation mode: working_session.\n"
            "- Work through ambiguity like a finance lead, using grounded evidence before asking the user to continue.\n"
            "- Resolve obvious company/entity ambiguity from Odoo when the required lookup is safe and available.\n"
            "- For board-style finance questions, return a developed first pass with: direct answer, scorecard, performer rationale, confidence limits, and recommended drill-down.\n"
            "- Do not force a staged 'continue' pattern when the first-pass answer can be completed."
        ).strip()
    else:
        prompt = base_system_prompt.strip()
    if workflow_directives:
        prompt = f"{prompt}\n\n{workflow_directives}".strip()
    owner_operator_directives = build_owner_operator_questionnaire_directives(
        guardrails_config=dict(guardrails_config or {})
    )
    if owner_operator_directives:
        prompt = f"{prompt}\n\n{owner_operator_directives}".strip()
    business_structure_directives = build_business_structure_directives(
        guardrails_config=dict(guardrails_config or {})
    )
    if business_structure_directives:
        prompt = f"{prompt}\n\n{business_structure_directives}".strip()
    reporting_format_directives = build_reporting_format_directives(
        message=message,
        guardrails_config=dict(guardrails_config or {}),
    )
    if reporting_format_directives:
        prompt = f"{prompt}\n\n{reporting_format_directives}".strip()
    return prompt


def append_tool_plan_system_hint(system_prompt: str, tool_plan: dict[str, Any] | None) -> str:
    """Attach optional planner hints (e.g. Odoo + Shopify dual intent) to the system prompt."""
    hint = (tool_plan or {}).get("multi_step_odoo_hint") if tool_plan else None
    if not hint:
        return system_prompt
    return f"{system_prompt}\n\nPlanner note:\n{hint}".strip()


DOCX_FIXED_AGENT_CANDIDATES = (
    "Docxtemplater Specialist",
    "Apryse Docs Specialist",
    "Business Marketing & Strategy Documenter",
)


def resolve_docx_fixed_agent(session: Session, *, fallback_agent) -> Any:
    candidates = list(session.scalars(select(AgentProfileRecord).where(AgentProfileRecord.enabled.is_(True))))
    by_name = {str(candidate.name).strip().casefold(): candidate for candidate in candidates}
    for preferred in DOCX_FIXED_AGENT_CANDIDATES:
        matched = by_name.get(preferred.casefold())
        if matched is not None:
            return matched
    return fallback_agent


def apply_docx_mode_directives(*, base_prompt: str, docx_mode: Any) -> str:
    if not docx_mode or not bool(getattr(docx_mode, "enabled", False)):
        return base_prompt
    operation = resolve_docx_operation(docx_mode)
    template_id = str(getattr(docx_mode, "template_id", "") or "").strip()
    directives = [
        "Doc mode: Apryse document workflow is enabled.",
        f"- Operation: {operation}.",
        "- Produce deterministic JSON-ready document binding data.",
        "- Do not invent template fields outside the provided template id and binding schema.",
        "- Prefer concise structured outputs suitable for iterative preview/finalize loops.",
    ]
    if template_id:
        directives.append(f"- Template id: {template_id}.")
    return f"{base_prompt}\n\n" + "\n".join(directives)


def _is_finance_analysis_message(message: str) -> bool:
    lowered = message.casefold()
    return any(
        term in lowered
        for term in (
            "revenue",
            "cogs",
            "gross margin",
            "gross profit",
            "performer",
            "performance",
            "ytd",
            "year so far",
            "year-to-date",
            "board",
            "finance",
        )
    )


def resolve_effective_query_top_k(
    *,
    session: Session,
    requested_top_k: int | None,
    runtime_profile,
    message: str,
    conversation_mode: str,
) -> int:
    base_top_k = resolve_query_top_k(session, requested_top_k, runtime_profile=runtime_profile)
    if requested_top_k is not None or not _is_finance_analysis_message(message):
        return base_top_k
    if conversation_mode == "working_session":
        return min(max(base_top_k, 12), 20)
    if conversation_mode == "board":
        return min(max(base_top_k, 10), 20)
    return base_top_k


def build_runtime_context_block(
    *,
    agent_name: str,
    runtime_profile_name: str,
    corpora: list[str],
    conversation_mode: str,
    workflow_mode: str,
    history_context: str,
    allowed_urls: list[str],
    used_approved_web: bool,
    tool_summary: list[dict] | None = None,
    openai_responses_chain: bool = False,
    owner_operator_template_compact: str = "",
    business_structure_context_compact: str = "",
) -> str:
    sanitized_owner_operator = _sanitize_owner_operator_template(owner_operator_template_compact)
    sanitized_business_structure = _sanitize_business_structure_context(business_structure_context_compact)
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
            f"Conversation mode: {conversation_mode}",
            f"Workflow mode: {workflow_mode}",
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
            (
                f"Owner-operator compact guidance: {sanitized_owner_operator}"
                if sanitized_owner_operator
                else "Owner-operator compact guidance: default"
            ),
            (
                f"Business structure memory: {sanitized_business_structure}"
                if sanitized_business_structure
                else "Business structure memory: missing"
            ),
        ]
    )


def build_effective_snapshot_id(
    *,
    agent_id: str,
    runtime_profile_id: str,
    corpora: list[str],
    conversation_mode: str,
    workflow_mode: str,
    tool_summary: list[dict],
    use_approved_web: bool,
    owner_operator_template_compact: str = "",
    business_structure_context_compact: str = "",
) -> str:
    snapshot_payload = {
        "agent_id": agent_id,
        "runtime_profile_id": runtime_profile_id,
        "corpora": list(corpora),
        "conversation_mode": conversation_mode,
        "workflow_mode": workflow_mode,
        "tool_summary": tool_summary,
        "use_approved_web": use_approved_web,
        "owner_operator_template_compact": owner_operator_template_compact,
        "business_structure_context_compact": business_structure_context_compact,
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


def build_document_frame_prompt_context(frame: DocumentFrameRecord | None) -> str:
    if frame is None:
        return ""
    fragments = [fragment for fragment in list(frame.fragments_json or []) if isinstance(fragment, dict)]
    if not fragments:
        return ""
    lines = [
        f"Document frame: {frame.title}",
        f"Status: {frame.status}",
        "Approved document fragments:",
    ]
    for fragment in fragments[-12:]:
        fragment_type = str(fragment.get("fragment_type") or "snippet")
        title = str(fragment.get("title") or "").strip()
        content = str(fragment.get("content") or "").strip()
        if not content:
            continue
        header = f"- {fragment_type}"
        if title:
            header += f": {title}"
        lines.append(header)
        lines.append(content[:1200])
    return "\n".join(lines).strip()


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


def _normalize_prompt_excerpt(text: str, *, max_chars: int, mode: str) -> str:
    """Collapse whitespace so first/last prompt excerpts are single-line and readable."""
    normalized = " ".join((text or "").split())
    if not normalized:
        return ""
    return _compact_text(normalized, max_chars, mode=mode)


def _build_llm_io_payload(
    usage: dict[str, int | bool],
    *,
    first_prompt_text: str,
    last_prompt_text: str,
) -> dict[str, Any]:
    prompt_tokens = int(usage.get("prompt_tokens") or 0)
    completion_tokens = int(usage.get("completion_tokens") or 0)
    total_tokens = int(usage.get("total_tokens") or (prompt_tokens + completion_tokens))
    return {
        "input_tokens": prompt_tokens,
        "output_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "input_first_text": _normalize_prompt_excerpt(first_prompt_text, max_chars=220, mode="head"),
        "input_last_text": _normalize_prompt_excerpt(last_prompt_text, max_chars=220, mode="tail"),
    }


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
) -> tuple[PreparedAnswerPrompt, PreparedAnswerPrompt, PreparedAnswerPrompt]:
    primary_budget, retry_budget, tertiary_budget = resolve_answer_prompt_budgets(api_mode)
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
    tertiary = prepare_answer_prompt(
        agent_name=agent_name,
        system_prompt=system_prompt,
        query_prompt=query_prompt,
        history_context=history_context,
        runtime_context=runtime_context,
        approved_web_context=approved_web_context,
        upload_context=upload_context,
        budget=tertiary_budget,
    )
    return primary, retry, tertiary


def resolve_answer_prompt_budgets(api_mode: str) -> tuple[AnswerPromptBudget, AnswerPromptBudget, AnswerPromptBudget]:
    if api_mode == "chat_completions":
        return (
            CHAT_COMPLETIONS_PRIMARY_ANSWER_PROMPT_BUDGET,
            CHAT_COMPLETIONS_RETRY_ANSWER_PROMPT_BUDGET,
            CHAT_COMPLETIONS_TERTIARY_ANSWER_PROMPT_BUDGET,
        )
    return (
        RESPONSES_PRIMARY_ANSWER_PROMPT_BUDGET,
        RESPONSES_RETRY_ANSWER_PROMPT_BUDGET,
        RESPONSES_TERTIARY_ANSWER_PROMPT_BUDGET,
    )


def unique_answer_prompt_variants(*variants: PreparedAnswerPrompt) -> list[PreparedAnswerPrompt]:
    unique_variants: list[PreparedAnswerPrompt] = []
    seen_prompts: set[str] = set()
    for variant in variants:
        if variant.prompt in seen_prompts:
            continue
        unique_variants.append(variant)
        seen_prompts.add(variant.prompt)
    return unique_variants


def build_staged_answer_directives(*, tool_plan: dict[str, Any] | None, conversation_mode: str) -> str:
    """Add answer-format constraints for expensive tool-heavy investigations."""
    plan = dict(tool_plan or {})
    operation = str(plan.get("operation") or "").strip()
    payload = dict(plan.get("payload") or {})
    requested_company_ids = [value for value in list(payload.get("company_ids") or []) if isinstance(value, int)]
    if not operation.startswith("odoo.finance."):
        return ""
    if conversation_mode == "board":
        return (
            "Answer constraints (board mode):\n"
            "- Return a full first-pass executive answer in one response.\n"
            "- Start with the direct answer and performer ranking.\n"
            "- Include a compact scorecard table for the compared businesses.\n"
            "- Explain top drivers, key risks, and recommended actions.\n"
            "- Do not end with a staged drill-down invitation."
        ).strip()
    if conversation_mode == "working_session":
        return (
            "Answer constraints (working session mode):\n"
            "- Work through the evidence like an analyst, not a passive summarizer.\n"
            "- Use the available grounded and Odoo evidence to resolve obvious ambiguity before asking the user for more.\n"
            "- Deliver a developed first pass with sections for direct answer, scorecard, performer rationale, uncertainty, and next drill-down.\n"
            "- Do not force staged output or append a staged drill-down invitation."
        ).strip()
    if operation == "odoo.finance.shopify.monthly_roi":
        return (
            "Answer constraints (Shopify ROI helper):\n"
            "- Use only the returned Odoo evidence. Do not mix in KB or web claims.\n"
            "- Return a monthly table with Shopify revenue, discounts, refunds, shipping, fees, marketing spend, net Shopify revenue, ROAS, and contribution after marketing spend.\n"
            "- State the exact journals, account codes/names, and vendors used from the Odoo result.\n"
            "- If attribution to Shopify is only proxy-level, say that explicitly and explain why.\n"
            "- Do not replace the requested table with a generic summary."
        ).strip()
    if operation == "odoo.finance.margin.monthly_comparison" and len(requested_company_ids) > 1:
        return (
            "Answer constraints (multi-company monthly comparison):\n"
            "- You must split the answer by each requested business, not just one example entity.\n"
            "- Include separate subsections for each requested company plus one combined group total.\n"
            "- Name the businesses explicitly and keep their totals distinct.\n"
            "- Do not collapse a multi-company Odoo result into a Retail-only summary.\n"
            "- If marketing or full overhead lines are not present in the returned Odoo operation, say that clearly and ask for the next Odoo drill-down needed."
        ).strip()
    if operation == "odoo.finance.pnl.period_summary" and len(requested_company_ids) > 1:
        return (
            "Answer constraints (multi-company P&L comparison):\n"
            "- Split the answer by each requested business and keep totals distinct.\n"
            "- Include a compact scorecard with revenue, COGS/cost of revenue, gross profit, total expenses, net profit, and ROAS.\n"
            "- State that these numbers come from Odoo posted P&L ledger lines for the selected period.\n"
            "- If ROAS is derived via ad-spend account inference, label that assumption clearly."
        ).strip()
    return (
        "Answer constraints (staged finance output):\n"
        "- First pass only: executive summary + what changed month-to-month + top drivers.\n"
        "- Keep it concise (no long-form report). Use bullets and a small month-by-month table.\n"
        "- End with: 'Say CONTINUE for deeper drill-down by code/journal/vendor.'"
    ).strip()


def build_tool_truthfulness_directives(*, tool_plan: dict[str, Any] | None, tool_events: list[ChatToolEvent]) -> str:
    plan = dict(tool_plan or {})
    tool_id = str(plan.get("tool_id") or "").strip()
    mode = str(plan.get("mode") or "none").strip()
    operation = str(plan.get("operation") or "").strip()
    if tool_id != "odoo_primary" or mode == "none":
        return ""

    executed = any(event.tool_id == "odoo_primary" and event.status == "executed" for event in tool_events)
    blocked = next((event for event in tool_events if event.tool_id == "odoo_primary" and event.status in {"blocked", "failed"}), None)
    preview = any(event.tool_id == "odoo_primary" and event.status in {"preview", "planned"} for event in tool_events)

    base = [
        "Critical tool truth constraints:",
        "- Never claim Odoo executed, started, triggered, is still running, or injected data unless a tool event in this turn proves it.",
        "- Treat tool events as authoritative over assistant prose.",
    ]

    if executed:
        base.extend(
            [
                "- Odoo executed in this turn. Use only the returned tool evidence.",
                "- Do not add imaginary post-processing steps like 'awaiting data injection' if the execution already completed.",
            ]
        )
    elif blocked is not None:
        base.extend(
            [
                f"- Odoo did not complete. State clearly that `{operation or 'the planned Odoo operation'}` was {blocked.status}.",
                "- Explain the blocked or failed state plainly instead of writing speculative progress language.",
            ]
        )
    elif preview or mode == "preview":
        base.extend(
            [
                "- This turn only contains a preview/planned Odoo operation, not a real execution result.",
                "- Do not say the data is being injected or that the lookup is underway unless a later tool event proves it.",
            ]
        )
    else:
        base.extend(
            [
                f"- Odoo was required for `{operation or 'this request'}`, but no executed or blocked tool result was returned.",
                "- Say explicitly that the Odoo handoff did not complete in the returned tool evidence.",
                "- Do not let semantic retrieval or document citations sound like ERP evidence.",
            ]
        )

    return "\n".join(base).strip()


def _is_business_finance_closeout_request(message: str) -> bool:
    lowered = str(message or "").casefold()
    finance_terms = (
        "financial",
        "revenue",
        "cogs",
        "gross margin",
        "marketing spend",
        "shopify",
        "aov",
        "orders",
        "board-ready",
        "dashboard",
    )
    recency_terms = (
        "today",
        "up to date",
        "up-to-date",
        "upto date",
        "month-to-date",
        "mtd",
        "last 30 days",
        "as of",
    )
    return any(term in lowered for term in finance_terms) and any(term in lowered for term in recency_terms)


def _requests_shopify_order_metrics(message: str) -> bool:
    lowered = str(message or "").casefold()
    return "shopify" in lowered and any(term in lowered for term in ("orders", "order count", "aov"))


def _is_group_overview_request(message: str) -> bool:
    lowered = str(message or "").casefold()
    if "group overview" not in lowered:
        return False
    return any(term in lowered for term in ("complete", "show all", "full overview"))


def build_group_overview_directives(
    *,
    message: str,
    tool_plan: dict[str, Any] | None,
    tool_events: list[ChatToolEvent],
) -> str:
    if not _is_group_overview_request(message):
        return ""
    executed = any(event.tool_id == "odoo_primary" and event.status == "executed" for event in tool_events)
    plan = dict(tool_plan or {})
    payload = dict(plan.get("payload") or {})
    date_from = str(payload.get("date_from") or "").strip() or "unknown"
    date_to = str(payload.get("date_to") or "").strip() or "unknown"
    return (
        "Ian group overview contract (strict format):\n"
        "- Apply this contract only when the user explicitly requests `Group Overview` with `complete`/`show all` semantics.\n"
        "- Use one markdown table with these exact headers (spelling preserved):\n"
        "  `Metric | Wrorkshopp | Staff | COGS | Mararketing | Waarrnty | ROAS | MAARRGING SWINGG ON PRIOORR MONTH | FORECASST`\n"
        "- Render exactly these rows in this order:\n"
        "  1) `Buurleigh`\n"
        "  2) `Brisbaane`\n"
        "  3) `Retail`\n"
        "  4) `Shopify`\n"
        "- Always include `Shopify` row visibility even though Shopify is not a unique business_id; treat Shopify as ledgered evidence scope.\n"
        "- If Shopify metrics are unavailable from current execution, keep the row and mark missing fields as `PROVISIONAL` or `UNAVAILABLE_FROM_CURRENT_OPERATION`.\n"
        f"- Keep the evidence window explicit: `{date_from} -> {date_to}` and executed status: `{'yes' if executed else 'no'}`.\n"
        "- Outside direct group-overview requests, do not force this format."
    )


def build_business_closeout_directives(
    *,
    message: str,
    tool_plan: dict[str, Any] | None,
    tool_events: list[ChatToolEvent],
) -> str:
    if not _is_business_finance_closeout_request(message):
        return ""
    plan = dict(tool_plan or {})
    operation = str(plan.get("operation") or "").strip().lower()
    if not operation.startswith("odoo.finance."):
        return ""
    executed = any(event.tool_id == "odoo_primary" and event.status == "executed" for event in tool_events)
    if not executed:
        return ""
    payload = dict(plan.get("payload") or {})
    date_from = str(payload.get("date_from") or "").strip()
    date_to = str(payload.get("date_to") or "").strip()
    assumptions = (
        f"- Use the current planned window `{date_from} -> {date_to}` as the reporting scope."
        if date_from and date_to
        else "- If user asks 'as of today' without a concrete period, default to month-to-date through today and label it as an assumption."
    )
    order_metric_instruction = (
        "- If orders/AOV are requested but missing from the executed operation, mark those fields `PROVISIONAL` or `UNAVAILABLE_FROM_CURRENT_OPERATION`, and continue with the dashboard."
        if _requests_shopify_order_metrics(message)
        else "- If one metric is missing, continue with a complete dashboard and mark only that metric as `PROVISIONAL`."
    )
    return (
        "Business closeout constraints (operator mode):\n"
        "- Deliver a complete board-ready dashboard in this turn; do not reply with only blocker questions.\n"
        "- Never output 'I cannot produce' or equivalent when at least one Odoo execution completed in this turn.\n"
        f"{assumptions}\n"
        f"{order_metric_instruction}\n"
        "- Include: Executive snapshot, scorecard by entity, anomalies, immediate actions, and explicit confidence labels.\n"
        "- If additional drill-downs are needed, place them in 'Next pulls' while still finalizing the current answer."
    )


def build_owner_operator_contract_directives(
    *,
    message: str,
    tool_plan: dict[str, Any] | None,
    tool_events: list[ChatToolEvent],
) -> str:
    if not _is_business_finance_closeout_request(message):
        return ""
    has_executed_odoo = any(event.tool_id == "odoo_primary" and event.status == "executed" for event in tool_events)
    plan = dict(tool_plan or {})
    payload = dict(plan.get("payload") or {})
    date_from = str(payload.get("date_from") or "").strip() or "unknown"
    date_to = str(payload.get("date_to") or "").strip() or "unknown"
    return (
        "Owner-operator response contract:\n"
        "- Start with a one-paragraph direct decision answer for 'what matters now'.\n"
        f"- Include a freshness line: `Evidence window: {date_from} -> {date_to}` and whether this turn executed Odoo ({'yes' if has_executed_odoo else 'no'}).\n"
        "- Separate sections explicitly: `Facts`, `Inferences`, and `Assumptions`.\n"
        "- End with `What to do next` containing 3-5 actions with owner, urgency, and expected business impact.\n"
        "- If data is incomplete, mark affected outputs as `PROVISIONAL` and list one exact highest-value next pull."
    )


def _looks_like_blocking_finance_answer(answer_text: str) -> bool:
    lowered = str(answer_text or "").casefold()
    blocker_phrases = (
        "i can't produce",
        "i cannot produce",
        "what i need from you",
        "one blocker",
        "please confirm",
        "to proceed",
        "choose one",
    )
    return any(phrase in lowered for phrase in blocker_phrases)


def normalize_business_abbreviations(answer_text: str) -> str:
    text = str(answer_text or "")
    lowered = text.casefold()
    replacements: list[tuple[str, str]] = [
        ("roas", "return on ad spend (ROAS)"),
        ("cogs", "cost of goods sold (COGS)"),
        ("aov", "average order value (AOV)"),
    ]
    for token, expanded in replacements:
        if expanded.casefold() in lowered:
            continue
        pattern = re.compile(rf"\b{re.escape(token)}\b", re.IGNORECASE)
        text, count = pattern.subn(expanded, text, count=1)
        if count:
            lowered = text.casefold()
    return text


def _remove_low_quality_response_artifacts(answer_text: str) -> str:
    text = str(answer_text or "").strip()
    if not text:
        return text
    patterns = (
        r"^\s*need use odoo tool likely\.\s*",
        r"^\s*need\s+to\s+use\s+odoo\s+tool\s+likely\.\s*",
        r"^\s*based on the provided context,\s*i will attempt to answer the user'?s question\.\s*",
    )
    for pattern in patterns:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE)
    return text.strip()


def _coerce_number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed


def _extract_bp_branch_metric_grounding(tool_events: list[ChatToolEvent]) -> dict[str, dict[str, float | None]]:
    branch_metrics: dict[str, dict[str, float | None]] = {}
    metric_candidates = {
        "revenue": ("revenue", "revenue_total", "operating_income", "total_income"),
        "cogs": ("cogs", "cost_of_goods", "cost_of_revenue", "cost_of_sales"),
        "gp": ("gp", "gross_profit", "total_gross_profit"),
        "net": ("net", "net_profit", "net_income"),
        "roas": ("roas", "roi"),
        "ad_spend": ("ad_spend", "advertising_spend", "marketing_spend"),
    }
    for event in tool_events:
        if event.tool_id != "odoo_primary" or event.status != "executed":
            continue
        payload = dict(event.payload or {})
        response = dict(payload.get("response") or {})
        candidate_rows: list[dict[str, Any]] = []
        rows = response.get("rows")
        companies = response.get("companies")
        if isinstance(rows, list):
            candidate_rows.extend([row for row in rows if isinstance(row, dict)])
        if isinstance(companies, list):
            candidate_rows.extend([row for row in companies if isinstance(row, dict)])
        for row in candidate_rows:
            company_name = str(row.get("company_name") or row.get("company") or "").strip().casefold()
            if "burleigh" in company_name:
                branch_key = "burleigh"
            elif "brisbane" in company_name:
                branch_key = "brisbane"
            else:
                continue
            branch_metrics.setdefault(branch_key, {})
            for metric, keys in metric_candidates.items():
                for key in keys:
                    value = _coerce_number(row.get(key))
                    if value is None:
                        continue
                    branch_metrics[branch_key][metric] = value
                    break
            revenue_value = _coerce_number(branch_metrics[branch_key].get("revenue"))
            ad_spend_value = _coerce_number(branch_metrics[branch_key].get("ad_spend"))
            if (
                branch_metrics[branch_key].get("roas") is None
                and revenue_value is not None
                and ad_spend_value not in (None, 0)
            ):
                branch_metrics[branch_key]["roas"] = revenue_value / float(ad_spend_value)
    return branch_metrics


def _build_bp_missing_grounding_response(
    *,
    request_message: str,
    tool_events: list[ChatToolEvent],
) -> str | None:
    metrics = _bp_required_metrics_from_message(request_message)
    if not metrics:
        return None
    branch_metrics = _extract_bp_branch_metric_grounding(tool_events)
    required_metric_keys = {"COGS": "cogs", "GP": "gp", "Revenue": "revenue", "Net": "net", "ROAS": "roas"}
    requested_metric_keys = [required_metric_keys[m] for m in metrics if m in required_metric_keys]
    has_complete_branch_grounding = all(
        branch_metrics.get("burleigh", {}).get(metric_key) is not None
        and branch_metrics.get("brisbane", {}).get(metric_key) is not None
        for metric_key in requested_metric_keys
    )
    if has_complete_branch_grounding:
        return None

    period_label = "requested period"
    lowered = request_message.casefold()
    if "march" in lowered:
        period_label = "March"
    missing_dimensions = [
        f"{period_label} date-bounded totals",
        "branch tagging for Burleigh vs Brisbane",
        "total revenue",
        "total net profit",
        "advertising spend",
    ]
    def _fmt(metric_key: str, value: float | None) -> str:
        if value is None:
            return "Not grounded"
        if metric_key == "roas":
            return f"{value:.2f}x"
        return f"${value:,.2f}"

    metric_labels = [
        ("revenue", "Revenue (REV)"),
        ("cogs", "Cost of Goods Sold (COGS)"),
        ("gp", "Gross Profit (GP)"),
        ("net", "Net Profit (NET)"),
        ("roas", "Return on ad spend (ROAS)"),
    ]
    burleigh_metrics = branch_metrics.get("burleigh", {})
    brisbane_metrics = branch_metrics.get("brisbane", {})
    table_rows: list[str] = []
    missing_requested_metrics: list[str] = []
    comparison_signals: list[str] = []
    for metric_key, label in metric_labels:
        burleigh_value = _coerce_number(burleigh_metrics.get(metric_key))
        brisbane_value = _coerce_number(brisbane_metrics.get(metric_key))
        status = "Grounded" if burleigh_value is not None and brisbane_value is not None else "Missing"
        if metric_key in requested_metric_keys and status != "Grounded":
            missing_requested_metrics.append(label)
        if burleigh_value is not None and brisbane_value is not None:
            if metric_key in {"revenue", "gp", "net", "roas"}:
                if burleigh_value > brisbane_value:
                    comparison_signals.append(f"{label}: Burleigh higher")
                elif brisbane_value > burleigh_value:
                    comparison_signals.append(f"{label}: Brisbane higher")
            elif metric_key == "cogs":
                if burleigh_value < brisbane_value:
                    comparison_signals.append(f"{label}: Burleigh lower (better)")
                elif brisbane_value < burleigh_value:
                    comparison_signals.append(f"{label}: Brisbane lower (better)")
        table_rows.append(
            f"| {label} | {_fmt(metric_key, burleigh_value)} | {_fmt(metric_key, brisbane_value)} | Not grounded | Not grounded | {status} |"
        )

    comparison_line = (
        "- Available comparison signal: " + "; ".join(comparison_signals[:4]) + "."
        if comparison_signals
        else "- Available comparison signal: insufficient complete KPI pairs to rank a winner confidently."
    )
    missing_line = (
        "_Missing grounded metrics this turn: " + ", ".join(missing_requested_metrics) + "._"
        if missing_requested_metrics
        else "_All requested KPI pairs were grounded in tool evidence this turn._"
    )

    return "\n".join(
        [
            "1) Headline Performance Summary",
            (
                f"For {period_label}, I cannot yet state which of Burleigh or Brisbane performed better on "
                "COGS, GP, Revenue, Net Profit, or Return on Ad Spend (ROAS) with high confidence because the grounded data in hand is incomplete."
            ),
            "",
            "What I can say now",
            "- The available evidence is transaction-fragment level, not branch-month summary level.",
            "- The retrieved evidence does not currently provide a full branch-level month scorecard for all requested KPIs.",
            "- So any board-style ranking right now would be provisional to the point of being misleading.",
            comparison_line,
            "",
            "2) KPI Scorecard (current, prior, variance)",
            f"{period_label} KPI scorecard - provisional status",
            "| KPI | Burleigh | Brisbane | Prior | Variance | Status |",
            "| --- | --- | --- | --- | --- | --- |",
            *table_rows,
            "",
            "_Notes (provisional):_",
            "_Current evidence is insufficient to give reliable branch-level COGS/GP/REV/NET/ROAS for the requested period._",
            missing_line,
            "_Missing grounded data includes: " + ", ".join(missing_dimensions) + "._",
            "_Next action: run Odoo P&L and channel spend pulls with explicit March + Burleigh/Brisbane scope before ranking performance._",
        ]
    ).strip()


def _looks_like_unexecuted_placeholder_answer(answer_text: str) -> bool:
    lowered = str(answer_text or "").casefold()
    if not lowered:
        return False
    placeholder_tokens = (
        "awaiting odoo evidence",
        "awaiting shopify evidence",
        "next tool call",
        "select * from account_move_line",
        "$x",
        "$y",
        "$z",
        "$w",
        "the language model returned no usable text for this turn",
        "what we know",
        "what to try",
    )
    return any(token in lowered for token in placeholder_tokens)


def _extract_latest_odoo_mas_markdown(tool_events: list[ChatToolEvent]) -> tuple[str | None, str | None]:
    for event in reversed(tool_events):
        if event.tool_id != "odoo_primary" or event.status != "executed":
            continue
        payload = dict(event.payload or {})
        execution_truth = dict(payload.get("execution_truth") or {})
        if str(execution_truth.get("evidence_source_mode") or "").strip().casefold() != "odoo_mas_v2":
            continue
        response = dict(payload.get("response") or {})
        markdown = str(response.get("markdown") or "").strip()
        if markdown:
            return markdown, str(event.operation or "odoo_mas_v2")
    return None, None


def _render_mas_truth_locked_answer(markdown: str, operation: str | None) -> str:
    op = operation or "odoo_mas_v2"
    return (
        f"{markdown.strip()}\n\n"
        "## Execution Truth\n"
        f"- Source mode: `odoo_mas_v2`\n"
        f"- Operation: `{op}`\n"
        "- This response is rendered directly from executed Odoo MAS evidence to prevent narrative drift."
    ).strip()


def _filter_citations_for_mas_truth(citations: list[dict], tool_events: list[ChatToolEvent]) -> list[dict]:
    mas_markdown, _mas_operation = _extract_latest_odoo_mas_markdown(tool_events)
    if not mas_markdown:
        return citations
    return [
        citation
        for citation in citations
        if str(citation.get("source_type") or "").strip().casefold() == "tool"
        and str(citation.get("tool_id") or "").strip() == "odoo_primary"
    ]


def normalize_finance_closeout_answer(
    *,
    answer_text: str,
    request_message: str,
    tool_plan: dict[str, Any] | None,
    tool_events: list[ChatToolEvent],
    workflow_mode: str | None = None,
) -> str:
    cleaned_answer = _remove_low_quality_response_artifacts(answer_text)
    mas_markdown, mas_operation = _extract_latest_odoo_mas_markdown(tool_events)
    if mas_markdown:
        return normalize_business_abbreviations(_render_mas_truth_locked_answer(mas_markdown, mas_operation))
    synthetic_placeholder_answer = _looks_like_unexecuted_placeholder_answer(cleaned_answer)
    if str(workflow_mode or "").strip().casefold() == "bp_mode":
        bp_missing_grounding_answer = _build_bp_missing_grounding_response(
            request_message=request_message,
            tool_events=tool_events,
        )
        if bp_missing_grounding_answer:
            return normalize_business_abbreviations(bp_missing_grounding_answer)
    if synthetic_placeholder_answer and _bp_required_metrics_from_message(request_message):
        bp_missing_grounding_answer = _build_bp_missing_grounding_response(
            request_message=request_message,
            tool_events=tool_events,
        )
        if bp_missing_grounding_answer:
            return normalize_business_abbreviations(bp_missing_grounding_answer)
    if not _is_business_finance_closeout_request(request_message):
        return normalize_business_abbreviations(cleaned_answer)
    executed_events = [event for event in tool_events if event.tool_id == "odoo_primary" and event.status == "executed"]
    if not executed_events:
        return normalize_business_abbreviations(cleaned_answer)
    plan = dict(tool_plan or {})
    payload = dict(plan.get("payload") or {})
    date_from = str(payload.get("date_from") or "unknown")
    date_to = str(payload.get("date_to") or "unknown")
    normalized = cleaned_answer
    lowered = normalized.casefold()
    if "facts" not in lowered or "inferences" not in lowered or "assumptions" not in lowered:
        normalized = (
            f"Evidence window: `{date_from} -> {date_to}`\n\n"
            "### Facts\n"
            "- Derived from executed Odoo tool events in this turn.\n\n"
            "### Inferences\n"
            "- Pattern-level interpretation based on the returned evidence.\n\n"
            "### Assumptions\n"
            "- State any provisional assumptions explicitly.\n\n"
            "### What to do next\n"
            "- Provide 3-5 owner actions with urgency and impact.\n\n"
            + normalized.strip()
        ).strip()
    if not _looks_like_blocking_finance_answer(cleaned_answer):
        return normalize_business_abbreviations(normalized)
    evidence_lines = [
        f"- `{event.operation or event.tool_id}`: {event.summary or 'executed'}"
        for event in executed_events[:5]
    ]
    rewritten = [
        "### Executive Dashboard (Provisional, Odoo-Grounded)",
        f"- Reporting window: `{date_from} -> {date_to}`",
        "- Status: Odoo executed in this turn; returning best-available board-ready output now.",
        "- Confidence: medium for executed metrics, low where fields are unavailable from current operation.",
        "",
        "#### Executed Odoo Evidence",
        *evidence_lines,
        "",
        "#### Immediate Actions",
        "- Confirm any requested metrics that remain unavailable from the current operation as `PROVISIONAL`.",
        "- Run the listed next pulls in parallel for higher-confidence refresh (do not block current dashboard delivery).",
        "",
        "#### Analyst Notes",
        normalized.strip(),
    ]
    return normalize_business_abbreviations("\n".join(rewritten).strip())


def _bp_required_metrics_from_message(message: str) -> list[str]:
    lowered = str(message or "").casefold()
    metric_map = (
        ("cogs", "COGS"),
        ("cost of goods", "COGS"),
        ("gp", "GP"),
        ("gross profit", "GP"),
        ("revenue", "Revenue"),
        ("net", "Net"),
        ("roas", "ROAS"),
        ("roi", "ROAS"),
    )
    metrics: list[str] = []
    for token, label in metric_map:
        if token in lowered and label not in metrics:
            metrics.append(label)
    return metrics


def evaluate_bp_audit(*, answer_text: str, tool_events: list[ChatToolEvent], request_message: str) -> dict[str, Any]:
    metrics = _bp_required_metrics_from_message(request_message)
    lowered_answer = str(answer_text or "").casefold()
    executed = any(event.tool_id == "odoo_primary" and event.status == "executed" for event in tool_events)
    missing_metrics = [metric for metric in metrics if metric.casefold() not in lowered_answer]
    fit_for_purpose = "pass" if executed else "fail"
    best_practice = "pass" if ("facts" in lowered_answer and "assumptions" in lowered_answer) else "fail"
    efficiency = "pass" if len(tool_events) <= 12 else "fail"
    business_value = "pass" if any(token in lowered_answer for token in ("what to do next", "action", "decision")) else "fail"
    hard_fail = fit_for_purpose == "fail"
    findings: list[str] = []
    if not executed:
        findings.append("No executed Odoo evidence was captured for BP mode.")
    if missing_metrics:
        findings.append(f"Missing requested metrics in final narrative: {', '.join(missing_metrics)}")
    if best_practice == "fail":
        findings.append("Final answer did not clearly separate facts and assumptions.")
    remediation_actions = [
        "Re-run required Odoo operations with explicit entity/date scope.",
        "Regenerate board output with required metrics and confidence notes.",
    ]
    if not missing_metrics:
        remediation_actions = remediation_actions[:1]
    confidence_score = 0.35 if hard_fail else 0.78 if not missing_metrics else 0.62
    return {
        "fit_for_purpose": fit_for_purpose,
        "best_practice": best_practice,
        "efficiency": efficiency,
        "business_value": business_value,
        "hard_fail": hard_fail,
        "findings": findings,
        "remediation_actions": remediation_actions,
        "confidence_score": confidence_score,
    }


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

    minimum_duplicate_size = max(12, len(text) // 4)
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


# User-visible fallbacks when the LLM returns nothing or a classified error.
# Copy is intentionally domain-neutral (no scenario-specific examples). When each runs: see
# artefacts/CHAT_ANSWER_FALLBACKS_2026-04-17.md


def build_blank_answer_fallback(*, citations: list[dict]) -> str:
    """Replace empty model output after generate + stream retry; error not length/context/timeout."""
    n = len(citations)
    citation_line = (
        f"- {n} citation(s) were prepared from retrieved context before generation."
        if n
        else "- No citations were attached before generation (retrieval may have returned nothing usable)."
    )
    fallback = [
        "The language model returned no usable text for this turn, so this message replaces the assistant reply.",
        "",
        "What we know:",
        citation_line,
        "- Retrieval can succeed even when generation fails; the Citations list may still show sources.",
        "- Typical causes: transient provider errors, empty completions, policy blocks with no body, or response shapes the client could not parse into text.",
        "",
        "What to try:",
        "1. Retry the same question once.",
        "2. Ask for a shorter answer or one subsection at a time (one metric, one period, or one table).",
        "3. In Agent Config, confirm model id, API mode, and optional max output tokens.",
        "4. If this repeats, check agent-ingress logs for the request trace id.",
    ]
    return "\n".join(fallback).strip()


def build_timeout_fallback(*, citations: list[dict]) -> str:
    """Model or network stopped before finishing; classified timeout."""
    fallback = [
        "Generation timed out before the model could finish this answer.",
        "",
        "What we know:",
        "- The request reached the provider and grounded context was used",
        f"- {len(citations)} citation(s) were available when the timeout occurred",
        "- This is a latency or execution-window limit, not missing retrieval data",
        "",
        "What to try:",
        "1. Ask for a shorter answer or split the work into smaller steps.",
        "2. Retry; streaming often delivers partial text before the window elapses.",
        "3. Narrow scope (one entity, one period, or one document) per message.",
    ]
    return "\n".join(fallback).strip()


def build_length_guardrail_fallback(*, citations: list[dict]) -> str:
    """Upstream rejected prompt size (provider length guardrail)."""
    fallback = [
        "The upstream model rejected the prompt length because the combined request was too long after retrieval.",
        "",
        "What we know:",
        "- Your question was kept for a shorter retry variant when possible",
        f"- {len(citations)} citation(s) were in play when the guardrail fired",
        "- This is a prompt-size limit at the provider, not a failure to retrieve",
        "",
        "What to try:",
        "1. Retry with a narrower question or less chat history in the thread.",
        "2. Ask for a brief summary first, then follow up for detail.",
        "3. Repeat the same intent with fewer uploaded files in one turn if applicable.",
    ]
    return "\n".join(fallback).strip()


def build_context_length_fallback(*, citations: list[dict]) -> str:
    """Context window exceeded (tokens: prompt + requested completion)."""
    fallback = [
        "Context window exceeded: the model rejected the total size of prompt plus requested completion.",
        "",
        "What we know:",
        "- Grounded or tool context was assembled",
        f"- {len(citations)} citation(s) were included before the limit was hit",
        "",
        "What to try:",
        "1. Lower max output tokens in the agent runtime profile and retry, or ask for a shorter answer first.",
        "2. Narrow the question (one month, one product line, one location) to shrink the prompt.",
    ]
    return "\n".join(fallback).strip()


def run_answer_with_prompt_variants(
    prompt_variants: list[PreparedAnswerPrompt],
    *,
    runner,
    trace_id: str,
    retry_route: str,
) -> tuple[LlmCompletionResult | None, Exception | None, str | None]:
    """Returns (completion_result, error, user_prompt_used_on_success)."""
    last_error: Exception | None = None
    for index, prompt_variant in enumerate(prompt_variants, start=1):
        try:
            result = runner(prompt_variant.prompt)
            if isinstance(result, LlmCompletionResult):
                return result, None, prompt_variant.prompt
            return LlmCompletionResult(text=str(result)), None, prompt_variant.prompt
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
    return None, last_error, None


def _resolved_llm_orchestration(llm_config: dict[str, Any]) -> dict[str, Any]:
    raw = dict((llm_config or {}).get("llm_orchestration") or {})
    trigger_mode = str(raw.get("trigger_mode") or "on_prompt_overflow").strip().lower()
    if trigger_mode not in {"on_prompt_overflow", "always_second_pass"}:
        trigger_mode = "on_prompt_overflow"
    prompt_token_soft_limit = raw.get("prompt_token_soft_limit")
    try:
        prompt_token_soft_limit = int(prompt_token_soft_limit) if prompt_token_soft_limit not in (None, "") else None
    except Exception:
        prompt_token_soft_limit = None
    return {
        "enabled": bool(raw.get("enabled", False)),
        "trigger_mode": trigger_mode,
        "prompt_token_soft_limit": prompt_token_soft_limit,
        "fallback_connection_id": str(raw.get("fallback_connection_id") or "").strip() or None,
        "fallback_provider": str(raw.get("fallback_provider") or "openai").strip() or "openai",
        "fallback_model_id": str(raw.get("fallback_model_id") or "").strip() or None,
        "include_primary_answer_context": bool(raw.get("include_primary_answer_context", True)),
    }


def _canonical_model_id(model_id: str | None) -> str:
    value = str(model_id or "").strip().lower()
    if value.startswith("openai/"):
        value = value.split("/", 1)[1]
    if value.startswith("model/"):
        value = value.split("/", 1)[1]
    return value.lstrip("/")


def _is_model_not_found_error(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    if response is not None and hasattr(response, "json"):
        try:
            payload = response.json()
        except Exception:
            payload = None
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict) and str(error.get("code") or "").strip().lower() == "model_not_found":
            return True
    text = repr(exc).lower()
    return "model_not_found" in text or "does not exist" in text


def _resolve_fallback_model_id(orchestration: dict[str, Any], *, primary_model_id: str) -> str:
    configured = str(orchestration.get("fallback_model_id") or "").strip()
    if configured and _canonical_model_id(configured) != _canonical_model_id(primary_model_id):
        return configured
    default_model = str(settings.app_default_chat_model or "").strip()
    if default_model and _canonical_model_id(default_model) != _canonical_model_id(primary_model_id):
        return default_model
    return primary_model_id


def _should_emit_multi_agent_handoff_trace(
    *,
    workflow_mode: str,
    route_decision: dict[str, Any] | None,
    tool_plan: dict[str, Any] | None,
) -> bool:
    route_type = str((route_decision or {}).get("route_type") or "").strip().lower()
    if route_type != "workers":
        return False
    normalized_plan = _normalize_tool_plan(tool_plan)
    tool_mode = str(normalized_plan.get("mode") or "none").strip().lower()
    operation = str(normalized_plan.get("operation") or "").strip().lower()
    if workflow_mode in {
        "data_collector",
        "odoo_specialist",
        "documenter",
        "case_framing",
        "evidence_retrieval",
        "odoo_operations",
        "bp_mode",
    }:
        return True
    return tool_mode in {"required", "preview"} and operation.startswith("odoo.finance.")


def _classify_sub_agent_role(name: str) -> str | None:
    lowered = (name or "").strip().casefold()
    if not lowered:
        return None
    if any(token in lowered for token in ("finance", "financial", "cfo")):
        return "finance_analyst"
    if any(token in lowered for token in ("case framing", "case_framing", "framing")):
        return "case_framing_agent"
    if any(token in lowered for token in ("lead enterprise", "architect", "orchestrator")):
        return "lead_enterprise_architect"
    if any(token in lowered for token in ("auditor", "kpmg", "ey", "ernst", "young")):
        return "auditor_agent"
    if any(token in lowered for token in ("documenter", "documentor", "writer", "board")):
        return "business_documenter"
    return None


def _resolve_orchestration_sub_agents(session: Session, lead_agent: AgentProfileRecord) -> list[AgentProfileRecord]:
    if str(lead_agent.agent_role or "lead").strip().lower() != "lead":
        return []
    sub_agents = list(
        session.scalars(
            select(AgentProfileRecord)
            .where(
                AgentProfileRecord.enabled.is_(True),
                AgentProfileRecord.agent_role == "sub",
                AgentProfileRecord.parent_agent_id == lead_agent.id,
            )
            .order_by(AgentProfileRecord.position.asc(), AgentProfileRecord.updated_at.desc())
        )
    )
    if not sub_agents:
        return []
    finance = next((agent for agent in sub_agents if _classify_sub_agent_role(agent.name) == "finance_analyst"), None)
    documenter = next((agent for agent in sub_agents if _classify_sub_agent_role(agent.name) == "business_documenter"), None)
    ordered: list[AgentProfileRecord] = []
    if finance is not None:
        ordered.append(finance)
    if documenter is not None and (finance is None or documenter.id != finance.id):
        ordered.append(documenter)
    for agent in sub_agents:
        if all(existing.id != agent.id for existing in ordered):
            ordered.append(agent)
    return ordered


def _build_worker_prompt(
    *,
    worker: AgentProfileRecord,
    user_message: str,
    tool_grounding_prompt: str,
    prior_worker_outputs: list[dict[str, str]],
) -> str:
    role_hint = _classify_sub_agent_role(worker.name)
    role_instruction = (
        "Frame the business case precisely: objective, metrics, entities, date-window, assumptions, and blockers."
        if role_hint == "case_framing_agent"
        else "Orchestrate end-to-end business architecture, challenge weak assumptions, and drive to a board-ready outcome."
        if role_hint == "lead_enterprise_architect"
        else "Audit fit-for-purpose, best-practice, efficiency, and business value; include remediation actions for each failing point."
        if role_hint == "auditor_agent"
        else
        "Return normalized financial facts, metrics, drivers, risks, assumptions, missing data, and a strategist-ready interpretation."
        if role_hint == "finance_analyst"
        else "Produce a board-ready structured document draft using only grounded facts and explicit assumptions."
        if role_hint == "business_documenter"
        else "Perform your specialist analysis using grounded evidence and return concise structured output."
    )
    prior_block = ""
    if prior_worker_outputs:
        prior_lines = [
            f"- {item['worker_name']} output:\n{item['content']}"
            for item in prior_worker_outputs
            if str(item.get("content") or "").strip()
        ]
        if prior_lines:
            prior_block = "Prior sub-agent outputs:\n" + "\n\n".join(prior_lines)
    sections = [
        f"Lead request:\n{user_message.strip()}",
        f"Role instruction:\n{role_instruction}",
        f"Grounded evidence bundle:\n{tool_grounding_prompt.strip()}",
    ]
    if prior_block:
        sections.append(prior_block)
    if _is_business_finance_closeout_request(user_message):
        sections.append(
            "Closeout rule:\n"
            "- Do not return only blocker questions.\n"
            "- Deliver a complete provisional output with confidence labels when evidence is partial."
        )
    sections.append("Respond with only your specialist output for the lead orchestrator.")
    return "\n\n".join(section for section in sections if section.strip()).strip()


def _run_sub_agent_completion(
    *,
    session: Session,
    worker: AgentProfileRecord,
    user_message: str,
    tool_grounding_prompt: str,
    prior_worker_outputs: list[dict[str, str]],
    fallback_api_mode: str,
    trace_id: str,
) -> LlmCompletionResult:
    worker_runtime_profile = resolve_agent_runtime_profile(session, worker)
    worker_llm_config = dict(worker_runtime_profile.llm_config_json or {})
    worker_connection = resolve_llm_connection(
        session,
        connection_id=worker_llm_config.get("connection_id"),
        provider=str(worker_llm_config.get("provider", "openai")),
    )
    worker_prompt = _build_worker_prompt(
        worker=worker,
        user_message=user_message,
        tool_grounding_prompt=tool_grounding_prompt,
        prior_worker_outputs=prior_worker_outputs,
    )
    if worker_llm_config.get("max_tokens") not in (None, ""):
        sub_max = int(worker_llm_config["max_tokens"])
    else:
        sub_max = int(
            max(1, int(getattr(settings, "app_sub_agent_max_output_tokens_default", 4096) or 4096))
        )
    return generate_answer(
        worker_prompt,
        worker_connection,
        api_mode=str(worker_llm_config.get("api_mode") or fallback_api_mode),
        system_prompt=str((worker_runtime_profile.guardrails_config_json or {}).get("system_prompt") or ""),
        model_id=str(worker_llm_config.get("model_id") or ""),
        temperature=float(worker_llm_config.get("temperature", 0)),
        max_tokens=sub_max,
        trace_id=trace_id,
        service="agent-ingress",
    )


def _execute_sub_agent_with_retries(
    *,
    session: Session,
    worker: AgentProfileRecord,
    user_message: str,
    tool_grounding_prompt: str,
    prior_worker_outputs: list[dict[str, str]],
    fallback_api_mode: str,
    trace_id: str,
) -> tuple[LlmCompletionResult, int]:
    attempts = max(1, SUB_AGENT_MAX_RETRIES + 1)
    last_error: Exception | None = None
    for attempt_number in range(1, attempts + 1):
        try:
            result = _run_sub_agent_completion(
                session=session,
                worker=worker,
                user_message=user_message,
                tool_grounding_prompt=tool_grounding_prompt,
                prior_worker_outputs=prior_worker_outputs,
                fallback_api_mode=fallback_api_mode,
                trace_id=trace_id,
            )
            return result, attempt_number
        except Exception as exc:  # pragma: no cover - tested via stream path behavior
            last_error = exc
    assert last_error is not None
    raise last_error


def _augment_prompt_with_worker_outputs(base_prompt: str, worker_outputs: list[dict[str, str]]) -> str:
    rendered = [
        f"{item['worker_name']}:\n{item['content']}"
        for item in worker_outputs
        if str(item.get("content") or "").strip()
    ]
    if not rendered:
        return base_prompt
    worker_block = (
        "Sub-agent handoff results (authoritative for this turn):\n"
        + "\n\n".join(rendered)
        + "\n\nUse these outputs directly in your final synthesis; do not ignore them."
    )
    if not base_prompt.strip():
        return worker_block
    return f"{worker_block}\n\n{base_prompt}".strip()


def _llm_orchestration_should_second_pass(
    orchestration: dict[str, Any],
    *,
    primary_prompt: str,
    primary_error: Exception | None,
) -> tuple[bool, str | None]:
    if not orchestration.get("enabled"):
        return False, None
    trigger_mode = str(orchestration.get("trigger_mode") or "on_prompt_overflow")
    if trigger_mode == "always_second_pass":
        return True, "always_second_pass"

    estimated_prompt_tokens = estimate_token_count(primary_prompt)
    configured_soft_limit = orchestration.get("prompt_token_soft_limit")
    default_soft_limit = CHAT_COMPLETIONS_CONTEXT_LIMIT_TOKENS - CHAT_COMPLETIONS_CONTEXT_SAFETY_TOKENS
    soft_limit = int(configured_soft_limit) if configured_soft_limit not in (None, "") else default_soft_limit

    if estimated_prompt_tokens >= soft_limit:
        return True, "prompt_soft_limit_exceeded"
    if primary_error is not None and is_length_guardrail_error(primary_error):
        return True, "primary_length_guardrail"
    if primary_error is not None and is_context_length_error(primary_error):
        return True, "primary_context_window"
    if primary_error is not None and _is_model_not_found_error(primary_error):
        return True, "primary_model_not_found"
    return False, None


def _build_step_usage(usage: dict[str, int | bool] | None) -> dict[str, int | bool]:
    if usage is None:
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "estimate": True}
    return {
        "prompt_tokens": int(usage.get("prompt_tokens") or 0),
        "completion_tokens": int(usage.get("completion_tokens") or 0),
        "total_tokens": int(usage.get("total_tokens") or 0),
        "estimate": bool(usage.get("estimate", False)),
    }


def _aggregate_usage(steps: list[dict[str, Any]]) -> dict[str, int | bool] | None:
    if not steps:
        return None
    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0
    any_step = False
    estimate = False
    for step in steps:
        if isinstance(step.get("usage"), dict):
            usage = _build_step_usage(step.get("usage"))
        else:
            usage = {
                "prompt_tokens": int(step.get("prompt_tokens") or 0),
                "completion_tokens": int(step.get("completion_tokens") or 0),
                "total_tokens": int(step.get("total_tokens") or 0),
                "estimate": bool(step.get("estimate", True)),
            }
        if usage["prompt_tokens"] or usage["completion_tokens"] or usage["total_tokens"]:
            any_step = True
        prompt_tokens += int(usage["prompt_tokens"])
        completion_tokens += int(usage["completion_tokens"])
        total_tokens += int(usage["total_tokens"])
        estimate = estimate or bool(usage["estimate"])
    if not any_step:
        return None
    if total_tokens <= 0:
        total_tokens = prompt_tokens + completion_tokens
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "estimate": estimate,
    }


def _build_execution_step(
    *,
    stage: str,
    reason: str | None,
    connection: ConnectionRecord,
    model_id: str,
    api_mode: str,
    usage: dict[str, int | bool] | None,
    prompt: str,
) -> dict[str, Any]:
    normalized_usage = _build_step_usage(usage)
    prompt_tokens = int(normalized_usage["prompt_tokens"] or estimate_token_count(prompt))
    completion_tokens = int(normalized_usage["completion_tokens"])
    total_tokens = int(normalized_usage["total_tokens"] or (prompt_tokens + completion_tokens))
    return {
        "stage": stage,
        "provider": connection.provider,
        "connection_label": connection.label,
        "model_id": model_id,
        "api_mode": api_mode,
        "reason": reason,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "estimate": bool(normalized_usage["estimate"]),
    }


def _with_primary_answer_context(prompt: str, primary_answer: str) -> str:
    draft = primary_answer.strip()
    if not draft:
        return prompt
    return (
        f"{prompt}\n\nIntermediate grounded draft (same guardrails, for refinement only):\n"
        f"{draft}\n\nRefine and return the final answer using the same grounding constraints."
    ).strip()


def resolve_answer_max_tokens(
    *,
    api_mode: str,
    configured_max_tokens: int | None,
    prompt: str,
    trace_id: str,
    openai_responses_chain: bool,
) -> int | None:
    """Resolve max output tokens for the LLM call.

    If `configured_max_tokens` is omitted/null, we omit a max token setting entirely
    (provider/model defaults apply).
    """

    if configured_max_tokens in (None, ""):
        log_instant_event(
            trace_id=trace_id,
            service="agent-ingress",
            route="chat_answer.max_tokens_omitted",
            status="ok",
            details={
                "api_mode": api_mode,
                "reason": "not_configured",
            },
        )
        return None

    configured = max(1, int(configured_max_tokens))

    if openai_responses_chain:
        return configured

    # For chat-completions style calls (including OpenAI-compatible gateways), honor the operator's
    # configured value and let the provider enforce its own limits.
    return configured


def create_app() -> FastAPI:
    app = build_app(
        service_name="agent-ingress",
        title="GhostDASH Agent Ingress",
        docs_url="/agent/docs",
        redoc_url="/agent/redoc",
        openapi_url="/agent/openapi.json",
        startup_hooks=[initialize_agent_runtime_state],
    )
    app.include_router(elevenlabs_flash25_realtime_router)
    app.add_api_websocket_route(ELEVENLABS_STREAM_ROUTE, handle_voice_stream_websocket)
    app.add_api_websocket_route(ELEVENLABS_TTS_STREAM_ROUTE, handle_tts_stream_websocket)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/agent/v1/chat/completions")
    async def voice_chat_completions(
        body: VoiceChatCompletionsRequest,
        request: Request,
        session: Session = Depends(get_session),
    ) -> StreamingResponse:
        return await handle_voice_chat_completions(body=body, request=request, session=session)

    @app.get("/agent/voice/voices")
    async def voice_voices(request: Request) -> dict:
        return await list_elevenlabs_voices(trace_id=request.state.trace_id)

    @app.post("/agent/voice/preview")
    async def voice_preview(body: VoicePreviewRequest, request: Request) -> Response:
        return await preview_elevenlabs_voice(body=body, trace_id=request.state.trace_id)

    @app.get("/agent/voice/health")
    async def voice_health() -> dict[str, Any]:
        return voice_provider_health()

    @app.post("/agent/chat", response_model=ChatResponse)
    async def agent_chat(
        body: ChatRequest,
        request: Request,
        session: Session = Depends(get_session),
    ) -> ChatResponse:
        requested_agent = get_agent(session, body.agent_id)
        requested_agent = _resolve_production_chat_agent(session=session, body=body, requested_agent=requested_agent)
        agent = resolve_docx_fixed_agent(session, fallback_agent=requested_agent) if body.docx_mode.enabled else requested_agent
        runtime_profile = resolve_agent_runtime_profile(session, agent)
        if body.docx_mode.enabled and resolve_docx_operation(body.docx_mode) == "finalize" and not str(body.docx_mode.template_id or "").strip():
            raise HTTPException(400, "docx_mode.template_id is required when operation is finalize")
        docx_artifacts: list[dict[str, Any]] = []
        docx_diagnostics: list[dict[str, Any]] = []
        corpora = resolve_corpora(runtime_profile, body.corpora)
        guardrails_config = _sanitize_production_guardrails(agent, dict(runtime_profile.guardrails_config_json or {}))
        if is_production_chat_surface(body.surface) and not _is_valid_magic_mike_consumer_runtime(agent, guardrails_config):
            raise HTTPException(400, PRODUCTION_CONTRACT_ERROR)
        guardrails_config, _captured_business_context = maybe_bank_business_structure_context(
            session,
            runtime_profile=runtime_profile,
            guardrails_config=guardrails_config,
            message=body.message,
        )
        conversation = session.get(AgentConversationRecord, body.conversation_id) if body.conversation_id else None
        if body.conversation_id and conversation is None:
            raise HTTPException(404, "conversation not found")
        if conversation is not None and conversation.agent_id != agent.id:
            raise HTTPException(400, "conversation does not belong to the selected agent")
        conversation_mode = resolve_conversation_mode(
            requested_mode=body.conversation_mode,
            guardrails_config=guardrails_config,
        )
        workflow_mode = resolve_workflow_mode(requested_mode=body.workflow_mode, conversation=conversation)
        call_init_turn = bool(body.call_init.enabled and _is_magic_mike_agent(agent))
        magic_call_init_greeting = call_init_turn and _is_magic_mike_agent(agent)
        magic_call_init_greeting = call_init_turn and _is_magic_mike_agent(agent)
        production_magic_greeting = (
            is_production_chat_surface(body.surface)
            and _is_magic_mike_agent(agent)
            and (call_init_turn or _is_greeting_intent(body.message))
        )
        missing_business_structure_answer = build_missing_business_structure_answer(
            message=body.message,
            workflow_mode=workflow_mode,
            guardrails_config=guardrails_config,
        )
        effective_system_prompt = build_effective_system_prompt(
            base_system_prompt=str(guardrails_config.get("system_prompt", "")),
            conversation_mode=conversation_mode,
            workflow_mode=workflow_mode,
            guardrails_config=guardrails_config,
            message=body.message,
        )
        effective_system_prompt = apply_docx_mode_directives(base_prompt=effective_system_prompt, docx_mode=body.docx_mode)
        top_k = resolve_effective_query_top_k(
            session=session,
            requested_top_k=body.top_k,
            runtime_profile=runtime_profile,
            message=body.message,
            conversation_mode=conversation_mode,
        )
        if conversation is None:
            frame_id: str | None = None
            if workflow_mode != "standard":
                frame = create_document_frame(
                    session,
                    title=f"{agent.name} strategic document",
                    metadata_json={"seed_workflow_mode": workflow_mode},
                )
                frame_id = frame.id
            conversation = create_conversation(
                session,
                agent_id=agent.id,
                message=body.message,
                corpora=corpora,
                api_mode=body.api_mode,
                conversation_mode=conversation_mode,
                workflow_mode=workflow_mode,
                document_frame_id=frame_id,
            )
            session.commit()
            session.refresh(conversation)
        chat_uploads = load_chat_uploads(session, conversation_id=conversation.id)
        chat_upload_context = build_chat_upload_prompt_context(chat_uploads)
        document_frame = (
            session.get(DocumentFrameRecord, conversation.document_frame_id) if conversation.document_frame_id else None
        )
        document_frame_context = build_document_frame_prompt_context(document_frame)
        combined_upload_context = "\n\n".join(
            part for part in (chat_upload_context, document_frame_context) if part.strip()
        )
        chat_upload_cache_context = build_chat_upload_cache_context(chat_uploads)
        history = list_messages(session, conversation.id, limit=max(settings.app_agent_memory_window_messages * 2, 20))
        history_context = build_history_context(history, window_messages=settings.app_agent_memory_window_messages)
        if is_production_chat_surface(body.surface):
            history_context = _public_safe_history_context(history_context)
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
        kb_tool = get_tool_config(tool_policy_config, "kb") or {}
        kb_enabled = bool(kb_tool.get("enabled", True))
        odoo_ready = any(item.id == "odoo_primary" and item.status == "ready" for item in tool_summary_models)
        web_enabled = bool(web_tool.get("enabled", False))
        effective_snapshot_id = build_effective_snapshot_id(
            agent_id=agent.id,
            runtime_profile_id=runtime_profile.id,
            corpora=corpora,
            conversation_mode=conversation_mode,
            workflow_mode=workflow_mode,
            tool_summary=tool_summary,
            use_approved_web=use_approved_web,
            owner_operator_template_compact=str(
                guardrails_config.get("owner_operator_questionnaire_compact") or ""
            ),
            business_structure_context_compact=str(
                guardrails_config.get("business_structure_context_compact") or ""
            ),
        )
        runtime_context = build_runtime_context_block(
            agent_name=agent.name,
            runtime_profile_name=str(runtime_profile.name),
            corpora=corpora,
            conversation_mode=conversation_mode,
            workflow_mode=workflow_mode,
            history_context=history_for_prompt,
            allowed_urls=allowed_urls,
            used_approved_web=use_approved_web,
            tool_summary=tool_summary,
            openai_responses_chain=use_openai_responses_chain,
            owner_operator_template_compact=str(
                guardrails_config.get("owner_operator_questionnaire_compact") or ""
            ),
            business_structure_context_compact=str(
                guardrails_config.get("business_structure_context_compact") or ""
            ),
        )
        if magic_call_init_greeting or production_magic_greeting:
            plan = {
                "query_mode": "blended",
                "direct_answer": (
                    _call_init_greeting(
                        local_time=body.call_init.local_time if call_init_turn else None,
                        timezone_name=body.call_init.timezone if call_init_turn else None,
                    )
                    if call_init_turn
                    else PUBLIC_GREETING_FALLBACK_TEXT
                ),
                "prompt": None,
                "citations": [],
                "tool_plan": {
                    "tool_id": None,
                    "mode": "none",
                    "reason": "call_init_greeting_bypass" if call_init_turn else "production_greeting_bypass",
                },
            }
        elif missing_business_structure_answer:
            plan = {
                "query_mode": "structured",
                "direct_answer": missing_business_structure_answer,
                "prompt": None,
                "citations": [],
                "tool_plan": {
                    "tool_id": "odoo_primary",
                    "mode": "none",
                    "reason": "business_structure_context_missing",
                },
            }
        elif workflow_mode == "case_framing":
            plan = {
                "query_mode": "structured",
                "direct_answer": None,
                "prompt": case_framing_prompt(body.message),
                "citations": [],
                "tool_plan": {
                    "tool_id": "odoo_primary",
                    "mode": "none",
                    "reason": "Case framing mode forbids tool access.",
                },
            }
        elif workflow_mode == "bp_mode":
            plan = await fetch_query_plan(
                plan_query_message,
                corpora,
                top_k,
                request.state.trace_id,
                current_message=body.message,
                workflow_mode=workflow_mode,
                embedding_model_id=dict(runtime_profile.kb_config_json or {}).get("embedding_model_id"),
                kb_enabled=kb_enabled,
                odoo_ready=odoo_ready,
            )
            existing_prompt = str(plan.get("prompt") or "").strip()
            bp_prompt_parts = [
                bp_mode_case_framing_prompt(body.message),
                (
                    "Lead architect execution contract:\n"
                    "- Retrieve fresh Odoo evidence for required financial metrics.\n"
                    "- Never terminate with blocker-only output.\n"
                    "- If evidence is partial, return provisional values plus remediation steps.\n"
                    "- Include an explicit confidence note per key metric."
                ),
                existing_prompt,
                "Auditor quality gate contract:\n" + bp_mode_auditor_prompt(body.message),
            ]
            plan["prompt"] = "\n\n".join(part for part in bp_prompt_parts if part).strip()
        elif workflow_mode == "odoo_operations":
            action_request, action_error = parse_odoo_operation_action_request(body.message)
            if action_request is None:
                plan = {
                    "query_mode": "structured",
                    "direct_answer": None,
                    "prompt": (
                        "Odoo Operations Agent blocked execution.\n"
                        "Reason: "
                        f"{action_error}\n\n"
                        "Provide only JSON with fields: target_model, operation, field_whitelist, reason, "
                        "approval_state, payload."
                    ),
                    "citations": [],
                    "tool_plan": {
                        "tool_id": "odoo_primary",
                        "mode": "none",
                        "blocked_reason": "invalid_structured_action_request",
                        "reason": action_error or "invalid_structured_action_request",
                    },
                }
            else:
                plan = {
                    "query_mode": "structured",
                    "direct_answer": None,
                    "prompt": (
                        "Structured Odoo action executed under governance. "
                        "Report execution outcome and returned data only."
                    ),
                    "citations": [],
                    "tool_plan": build_odoo_action_tool_plan(action_request),
                }
        else:
            plan = await fetch_query_plan(
                plan_query_message,
                corpora,
                top_k,
                request.state.trace_id,
                current_message=body.message,
                workflow_mode=workflow_mode,
                embedding_model_id=dict(runtime_profile.kb_config_json or {}).get("embedding_model_id"),
                kb_enabled=kb_enabled,
                odoo_ready=odoo_ready,
            )
            if workflow_mode == "evidence_retrieval":
                existing_prompt = str(plan.get("prompt") or "").strip()
                plan["prompt"] = (
                    f"{evidence_retrieval_prompt(body.message)}\n\n{existing_prompt}".strip()
                    if existing_prompt
                    else evidence_retrieval_prompt(body.message)
                )
        if is_production_chat_surface(body.surface) and _is_magic_mike_agent(agent):
            plan["tool_plan"] = {"tool_id": None, "mode": "none", "reason": "production_consumer_tool_policy"}
        effective_system_prompt = append_tool_plan_system_hint(effective_system_prompt, plan.get("tool_plan"))
        use_odoo_agentic = should_use_odoo_agentic(
            body=body,
            workflow_mode=workflow_mode,
            odoo_ready=False if is_production_chat_surface(body.surface) else odoo_ready,
            connection=connection,
            use_openai_responses_chain=use_openai_responses_chain,
        )
        tool_evidence = prepare_tool_evidence(
            session,
            agent_id=agent.id,
            agent_name=agent.name,
            tool_overrides=body.tool_overrides,
            tool_plan={"mode": "none"} if (use_odoo_agentic or workflow_mode == "case_framing") else plan.get("tool_plan"),
            workflow_mode=workflow_mode,
            request_message=body.message,
        )
        tool_events = tool_evidence.tool_events
        mas_markdown, mas_operation = _extract_latest_odoo_mas_markdown(tool_events)
        if mas_markdown and not plan.get("direct_answer") and not combined_upload_context:
            # Truth-lock MAS answers to executed deterministic markdown and bypass narrative rewrite.
            plan["direct_answer"] = normalize_business_abbreviations(
                _render_mas_truth_locked_answer(mas_markdown, mas_operation)
            )
        if body.docx_mode.enabled:
            tool_events.append(
                ChatToolEvent(
                    tool_id="apryse_docs",
                    status="planned",
                    operation=f"apryse_{body.docx_mode.operation}",
                    summary=(
                        f"Apryse doc mode active ({body.docx_mode.operation})"
                        + (
                            f" for template {body.docx_mode.template_id}"
                            if str(body.docx_mode.template_id or "").strip()
                            else ""
                        )
                    ),
                    payload={
                        "template_id": body.docx_mode.template_id,
                        "operation": body.docx_mode.operation,
                        "binding_override_keys": sorted(list((body.docx_mode.binding_overrides or {}).keys())),
                    },
                )
            )
        citations = (
            [*plan.get("citations", []), *web_citations]
            if use_odoo_agentic
            else [*tool_evidence.citations, *plan.get("citations", []), *web_citations]
        )
        citations = _filter_citations_for_mas_truth(citations, tool_evidence.tool_events)
        route_decision = build_route_decision(
            message=body.message,
            workflow_mode=workflow_mode,
            tool_plan=plan.get("tool_plan"),
            kb_enabled=kb_enabled,
            web_enabled=web_enabled,
            odoo_ready=odoo_ready,
        )
        route_decision["llm_execution"] = []
        plan_query_prompt = str(plan.get("prompt") or "")
        if tool_evidence.prompt_prefix:
            plan_query_prompt = (
                f"{tool_evidence.prompt_prefix}\n\n{plan_query_prompt}".strip()
                if plan_query_prompt
                else tool_evidence.prompt_prefix
            )
        staged_directives = build_staged_answer_directives(
            tool_plan=tool_evidence.plan,
            conversation_mode=conversation_mode,
        )
        if staged_directives:
            plan_query_prompt = f"{plan_query_prompt}\n\n{staged_directives}".strip() if plan_query_prompt else staged_directives
        tool_truth_directives = build_tool_truthfulness_directives(
            tool_plan=tool_evidence.plan,
            tool_events=tool_events,
        )
        if tool_truth_directives:
            plan_query_prompt = (
                f"{plan_query_prompt}\n\n{tool_truth_directives}".strip() if plan_query_prompt else tool_truth_directives
            )
        closeout_directives = build_business_closeout_directives(
            message=body.message,
            tool_plan=tool_evidence.plan,
            tool_events=tool_events,
        )
        if closeout_directives:
            plan_query_prompt = (
                f"{plan_query_prompt}\n\n{closeout_directives}".strip() if plan_query_prompt else closeout_directives
            )
        owner_contract_directives = build_owner_operator_contract_directives(
            message=body.message,
            tool_plan=tool_evidence.plan,
            tool_events=tool_events,
        )
        if owner_contract_directives:
            plan_query_prompt = (
                f"{plan_query_prompt}\n\n{owner_contract_directives}".strip()
                if plan_query_prompt
                else owner_contract_directives
            )
        group_overview_directives = build_group_overview_directives(
            message=body.message,
            tool_plan=tool_evidence.plan,
            tool_events=tool_events,
        )
        if group_overview_directives:
            plan_query_prompt = (
                f"{plan_query_prompt}\n\n{group_overview_directives}".strip()
                if plan_query_prompt
                else group_overview_directives
            )
        cache_key = None
        if (
            is_production_chat_surface(body.surface)
            or use_approved_web
            or use_openai_responses_chain
            or str(tool_evidence.plan.get("mode") or "none") != "none"
            or use_odoo_agentic
            or workflow_mode == "bp_mode"
        ):
            cached = None
        else:
            cache_key = build_response_cache_key(
                agent=agent,
                runtime_profile=runtime_profile,
                conversation_id=conversation.id,
                history_context=history_context,
                message=body.message
                + ("\n\n[chat_uploads]\n" + chat_upload_cache_context if chat_upload_cache_context else "")
                + ("\n\n[document_frame]\n" + document_frame_context if document_frame_context else ""),
                corpora=corpora,
                api_mode=body.api_mode,
                llm_model_id_override=body.llm_model_id,
                tool_state={
                    "tool_summary": tool_summary,
                    "tool_plan_mode": tool_evidence.plan.get("mode", "none"),
                    "conversation_mode": conversation_mode,
                    "workflow_mode": workflow_mode,
                },
            )
            cached = lookup_cached_response(session, agent_id=agent.id, request_hash=cache_key)
        resolved_model_id = _effective_chat_model_id(body, llm_config)
        new_openai_rid: str | None = None
        if cached is not None:
            cached_usage = ChatUsage(
                **resolve_chat_usage_dict(
                    provider_usage=None,
                    system_prompt="",
                    user_prompt=None,
                    completion="",
                    skip_llm=True,
                )
            )
            cached_answer = dedupe_answer_text(cached.answer_text)
            if cached_answer != cached.answer_text:
                cached.answer_text = cached_answer
                session.commit()
                session.refresh(cached)
            append_message(
                session,
                conversation_id=conversation.id,
                agent_id=agent.id,
                role="user",
                content=body.message,
                conversation_mode=conversation_mode,
                workflow_mode=workflow_mode,
            )
            append_message(
                session,
                conversation_id=conversation.id,
                agent_id=agent.id,
                role="assistant",
                content=cached.answer_text,
                query_mode=cached.query_mode,
                citations=cached.citations_json,
                tool_events=[],
                usage=cached_usage.model_dump(),
                route_decision=route_decision,
                api_mode=body.api_mode,
                conversation_mode=conversation_mode,
                workflow_mode=workflow_mode,
            )
            conversation.corpora_json = list(corpora)
            conversation.api_mode = body.api_mode
            conversation.conversation_mode = conversation_mode
            conversation.workflow_mode = workflow_mode
            session.commit()
            log_instant_event(
                trace_id=request.state.trace_id,
                service="agent-ingress",
                route="chat_response_cache.hit",
                status="ok",
                details={"agent_id": agent.id, "conversation_id": conversation.id},
            )
            if body.docx_mode.enabled:
                operation = resolve_docx_operation(body.docx_mode)
                required_sections = resolve_docx_finalize_required_sections(guardrails_config=guardrails_config)
                docx_answer_text = normalize_docx_finalize_answer(
                    operation=operation,
                    answer_text=cached.answer_text,
                    required_sections=required_sections,
                )
                finalize_diagnostics = validate_docx_finalize_output(
                    operation=operation,
                    answer_text=docx_answer_text,
                    required_sections=required_sections,
                )
                if finalize_diagnostics:
                    docx_artifacts = []
                    docx_diagnostics = list(finalize_diagnostics)
                else:
                    docx_artifacts, docx_diagnostics = await render_docx_with_sidecar(
                        docx_mode=body.docx_mode,
                        trace_id=request.state.trace_id,
                        agent_id=agent.id,
                        conversation_id=conversation.id,
                        answer_text=docx_answer_text,
                    )
                upsert_docx_session(
                    session,
                    conversation_id=conversation.id,
                    agent_id=agent.id,
                    template_id=body.docx_mode.template_id,
                    operation=body.docx_mode.operation,
                    status="rendered",
                    binding_json=body.docx_mode.binding_overrides or {},
                    artifacts_json=docx_artifacts,
                    diagnostics_json=docx_diagnostics,
                )
                session.commit()
            return _present_chat_response_for_surface(ChatResponse(
                answer=cached.answer_text,
                query_mode=cached.query_mode,
                citations=cached.citations_json,
                conversation_id=conversation.id,
                agent_id=agent.id,
                cached=True,
                usage=cached_usage,
                conversation_mode=conversation_mode,
                workflow_mode=workflow_mode,
                effective_snapshot_id=effective_snapshot_id,
                tool_summary=tool_summary_models,
                tool_events=tool_events,
                route_decision=route_decision,
                docx_artifacts=docx_artifacts,
                docx_diagnostics=docx_diagnostics,
            ), body.surface)
        if plan.get("direct_answer") and not combined_upload_context:
            answer = plan["direct_answer"]
        else:
            answer = ""
        completion_result: LlmCompletionResult | None = None
        raw_max_tokens = llm_config.get("max_tokens")
        configured_max_tokens = int(raw_max_tokens) if raw_max_tokens not in (None, "") else None
        can_cache_response = tool_evidence.can_cache_response
        if workflow_mode == "bp_mode":
            can_cache_response = False
        llm_orchestration = _resolved_llm_orchestration(llm_config)
        llm_execution_steps: list[dict[str, Any]] = []
        prompt_variants: list[PreparedAnswerPrompt] = []
        used_prompt: str | None = None
        if not answer:
            generate_error: Exception | None = None
            stream_error: Exception | None = None
            ran_odoo_agentic = False
            primary_prompt, retry_prompt, tertiary_prompt = prepare_answer_prompt_variants(
                api_mode=body.api_mode,
                agent_name=agent.name,
                system_prompt=effective_system_prompt,
                query_prompt=plan_query_prompt,
                history_context=history_for_prompt,
                runtime_context=runtime_context,
                approved_web_context=approved_web_context,
                upload_context=combined_upload_context,
            )
            log_answer_prompt_compaction(trace_id=request.state.trace_id, package=primary_prompt)
            prompt_variants = unique_answer_prompt_variants(primary_prompt, retry_prompt, tertiary_prompt)
            prev_rid = (conversation.openai_last_response_id or "").strip() or None
            if use_odoo_agentic and not plan.get("direct_answer"):
                ran_odoo_agentic = True
                max_it = max(1, int(getattr(settings, "app_odoo_agentic_max_iterations", 8)))
                docx_only = [e for e in tool_events if e.tool_id == "apryse_docs"]
                completion_result, agentic_tool_events = run_odoo_agentic_tool_loop(
                    session,
                    agent_id=agent.id,
                    connection=connection,
                    system_prompt=effective_system_prompt,
                    user_prompt=primary_prompt.prompt,
                    model_id=resolved_model_id,
                    temperature=float(llm_config.get("temperature", 0)),
                    max_tokens=resolve_answer_max_tokens(
                        api_mode=body.api_mode,
                        configured_max_tokens=configured_max_tokens,
                        prompt=primary_prompt.prompt,
                        trace_id=request.state.trace_id,
                        openai_responses_chain=use_openai_responses_chain,
                    ),
                    tool_overrides=body.tool_overrides,
                    trace_id=request.state.trace_id,
                    max_iterations=max_it,
                )
                tool_events = [*agentic_tool_events, *docx_only]
                citations = [
                    *external_citations_for_tool_events(agentic_tool_events),
                    *plan.get("citations", []),
                    *web_citations,
                ]
                answer = completion_result.text if completion_result is not None else ""
                can_cache_response = False
                if completion_result is not None:
                    new_openai_rid = completion_result.openai_response_id
                used_prompt = primary_prompt.prompt
                generate_error = None
                stream_error = None
                primary_prompt_used = used_prompt
                primary_last_error = None
                if completion_result is not None and primary_prompt_used:
                    llm_execution_steps.append(
                        _build_execution_step(
                            stage="primary",
                            reason="odoo_agentic_tool_loop",
                            connection=connection,
                            model_id=resolved_model_id,
                            api_mode=body.api_mode,
                            usage=completion_result.usage,
                            prompt=primary_prompt_used,
                        )
                    )
            else:
                completion_result, generate_error, used_prompt = run_answer_with_prompt_variants(
                    prompt_variants,
                    runner=lambda prompt: generate_answer(
                        prompt,
                        connection,
                        api_mode=body.api_mode,
                        system_prompt=effective_system_prompt,
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
                answer = completion_result.text if completion_result is not None else ""
                if completion_result is not None:
                    new_openai_rid = completion_result.openai_response_id
                if not answer.strip():
                    completion_result, stream_error, used_prompt = run_answer_with_prompt_variants(
                        prompt_variants,
                        runner=lambda prompt: stream_answer_to_result(
                            prompt,
                            connection,
                            api_mode=body.api_mode,
                            system_prompt=effective_system_prompt,
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
                    answer = completion_result.text if completion_result is not None else ""
                    if completion_result is not None:
                        new_openai_rid = completion_result.openai_response_id
                primary_prompt_used = used_prompt or (prompt_variants[0].prompt if prompt_variants else "")
                primary_last_error = stream_error or generate_error
                if completion_result is not None and primary_prompt_used:
                    llm_execution_steps.append(
                        _build_execution_step(
                            stage="primary",
                            reason="primary_generation",
                            connection=connection,
                            model_id=resolved_model_id,
                            api_mode=body.api_mode,
                            usage=completion_result.usage,
                            prompt=primary_prompt_used,
                        )
                    )

            should_second_pass, second_pass_reason = (
                (False, None)
                if ran_odoo_agentic
                else _llm_orchestration_should_second_pass(
                    llm_orchestration,
                    primary_prompt=primary_prompt_used or "",
                    primary_error=primary_last_error,
                )
            )
            if should_second_pass:
                try:
                    fallback_connection = resolve_llm_connection(
                        session,
                        connection_id=llm_orchestration.get("fallback_connection_id"),
                        provider=str(llm_orchestration.get("fallback_provider") or "openai"),
                    )
                    fallback_model_id = _resolve_fallback_model_id(
                        llm_orchestration,
                        primary_model_id=resolved_model_id,
                    )
                    second_prompt = primary_prompt_used or (prompt_variants[0].prompt if prompt_variants else "")
                    if llm_orchestration.get("include_primary_answer_context", True) and answer.strip():
                        second_prompt = _with_primary_answer_context(second_prompt, answer)
                    fallback_use_openai_responses_chain = should_use_openai_responses_chain(
                        fallback_connection, body.api_mode
                    )
                    fallback_prev_rid = prev_rid if fallback_connection.id == connection.id else None
                    second_result = generate_answer(
                        second_prompt,
                        fallback_connection,
                        api_mode=body.api_mode,
                        system_prompt=effective_system_prompt,
                        model_id=fallback_model_id,
                        temperature=float(llm_config.get("temperature", 0)),
                        max_tokens=resolve_answer_max_tokens(
                            api_mode=body.api_mode,
                            configured_max_tokens=configured_max_tokens,
                            prompt=second_prompt,
                            trace_id=request.state.trace_id,
                            openai_responses_chain=fallback_use_openai_responses_chain,
                        ),
                        trace_id=request.state.trace_id,
                        service="agent-ingress",
                        previous_response_id=fallback_prev_rid,
                        use_openai_responses_http=fallback_use_openai_responses_chain,
                    )
                    llm_execution_steps.append(
                        _build_execution_step(
                            stage="secondary",
                            reason=second_pass_reason,
                            connection=fallback_connection,
                            model_id=fallback_model_id,
                            api_mode=body.api_mode,
                            usage=second_result.usage,
                            prompt=second_prompt,
                        )
                    )
                    if second_result.text.strip():
                        answer = second_result.text
                        completion_result = second_result
                        used_prompt = second_prompt
                        if fallback_connection.id == connection.id:
                            new_openai_rid = second_result.openai_response_id
                except Exception as orchestration_exc:
                    can_cache_response = False
                    log_instant_event(
                        trace_id=request.state.trace_id,
                        service="agent-ingress",
                        route="chat_answer.second_pass.failed",
                        status="error",
                        error=repr(orchestration_exc),
                        details={
                            "reason": second_pass_reason,
                            "fallback_provider": llm_orchestration.get("fallback_provider"),
                        },
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
        answer = normalize_finance_closeout_answer(
            answer_text=answer,
            request_message=body.message,
            tool_plan=tool_evidence.plan,
            tool_events=tool_events,
            workflow_mode=workflow_mode,
        )
        answer = dedupe_answer_text(answer)
        if workflow_mode == "bp_mode":
            bp_audit = evaluate_bp_audit(
                answer_text=answer,
                tool_events=tool_events,
                request_message=body.message,
            )
            route_decision.setdefault("tool_expectations", {})
            route_decision["tool_expectations"]["bp_audit"] = bp_audit
            tool_events.append(
                ChatToolEvent(
                    tool_id="agent.bp_auditor",
                    status="executed" if not bool(bp_audit.get("hard_fail")) else "failed",
                    operation="agent.bp_auditor.evaluate",
                    summary=(
                        "BP audit passed"
                        if not bool(bp_audit.get("hard_fail"))
                        else "BP audit failed - remediation required"
                    ),
                    blocked_reason="bp_audit_hard_fail" if bool(bp_audit.get("hard_fail")) else None,
                    payload={"bp_audit": bp_audit},
                )
            )
        system_sp = effective_system_prompt
        fallback_user = prompt_variants[0].prompt if prompt_variants else ""
        skip_llm_turn = bool(plan.get("direct_answer") and not combined_upload_context)
        aggregated_provider_usage = _aggregate_usage(llm_execution_steps)
        response_usage = ChatUsage(
            **resolve_chat_usage_dict(
                provider_usage=aggregated_provider_usage
                or (completion_result.usage if completion_result is not None else None),
                system_prompt=system_sp,
                user_prompt=used_prompt,
                completion=answer,
                fallback_user_prompt=fallback_user,
                skip_llm=skip_llm_turn,
            )
        )
        route_decision["llm_execution"] = llm_execution_steps
        tool_events_payload = [
            {
                "tool_id": tool_event.tool_id,
                "status": tool_event.status,
                "operation": tool_event.operation,
                "summary": tool_event.summary,
                "blocked_reason": tool_event.blocked_reason,
                "payload": tool_event.payload,
                "latency_ms": tool_event.latency_ms,
            }
            for tool_event in tool_events
        ]
        append_message(
            session,
            conversation_id=conversation.id,
            agent_id=agent.id,
            role="user",
            content=body.message,
            conversation_mode=conversation_mode,
            workflow_mode=workflow_mode,
        )
        append_message(
            session,
            conversation_id=conversation.id,
            agent_id=agent.id,
            role="assistant",
            content=answer,
            query_mode=plan["query_mode"],
            citations=citations,
            tool_events=tool_events_payload,
            usage=response_usage.model_dump(),
            route_decision=route_decision,
            api_mode=body.api_mode,
            conversation_mode=conversation_mode,
            workflow_mode=workflow_mode,
        )
        conversation.corpora_json = list(corpora)
        conversation.api_mode = body.api_mode
        conversation.conversation_mode = conversation_mode
        conversation.workflow_mode = workflow_mode
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
        if body.docx_mode.enabled:
            operation = resolve_docx_operation(body.docx_mode)
            required_sections = resolve_docx_finalize_required_sections(guardrails_config=guardrails_config)
            docx_answer_text = normalize_docx_finalize_answer(
                operation=operation,
                answer_text=answer,
                required_sections=required_sections,
            )
            finalize_diagnostics = validate_docx_finalize_output(
                operation=operation,
                answer_text=docx_answer_text,
                required_sections=required_sections,
            )
            if finalize_diagnostics:
                docx_artifacts = []
                docx_diagnostics = list(finalize_diagnostics)
            else:
                docx_artifacts, docx_diagnostics = await render_docx_with_sidecar(
                    docx_mode=body.docx_mode,
                    trace_id=request.state.trace_id,
                    agent_id=agent.id,
                    conversation_id=conversation.id,
                    answer_text=docx_answer_text,
                )
            upsert_docx_session(
                session,
                conversation_id=conversation.id,
                agent_id=agent.id,
                template_id=body.docx_mode.template_id,
                operation=body.docx_mode.operation,
                status="rendered",
                binding_json=body.docx_mode.binding_overrides or {},
                artifacts_json=docx_artifacts,
                diagnostics_json=docx_diagnostics,
            )
            session.commit()
        return _present_chat_response_for_surface(ChatResponse(
            answer=answer,
            query_mode=plan["query_mode"],
            citations=citations,
            conversation_mode=conversation_mode,
            workflow_mode=workflow_mode,
            conversation_id=conversation.id,
            agent_id=agent.id,
            cached=False,
            usage=response_usage,
            effective_snapshot_id=effective_snapshot_id,
            tool_summary=tool_summary_models,
            tool_events=tool_events,
            route_decision=route_decision,
            docx_artifacts=docx_artifacts,
            docx_diagnostics=docx_diagnostics,
        ), body.surface)

    @app.post("/agent/chat/stream")
    async def agent_chat_stream(
        body: ChatRequest,
        request: Request,
        session: Session = Depends(get_session),
    ) -> StreamingResponse:
        requested_agent = get_agent(session, body.agent_id)
        requested_agent = _resolve_production_chat_agent(session=session, body=body, requested_agent=requested_agent)
        agent = resolve_docx_fixed_agent(session, fallback_agent=requested_agent) if body.docx_mode.enabled else requested_agent
        runtime_profile = resolve_agent_runtime_profile(session, agent)
        if body.docx_mode.enabled and resolve_docx_operation(body.docx_mode) == "finalize" and not str(body.docx_mode.template_id or "").strip():
            raise HTTPException(400, "docx_mode.template_id is required when operation is finalize")
        docx_artifacts: list[dict[str, Any]] = []
        docx_diagnostics: list[dict[str, Any]] = []
        corpora = resolve_corpora(runtime_profile, body.corpora)
        guardrails_config = _sanitize_production_guardrails(agent, dict(runtime_profile.guardrails_config_json or {}))
        if is_production_chat_surface(body.surface) and not _is_valid_magic_mike_consumer_runtime(agent, guardrails_config):
            raise HTTPException(400, PRODUCTION_CONTRACT_ERROR)
        guardrails_config, _captured_business_context = maybe_bank_business_structure_context(
            session,
            runtime_profile=runtime_profile,
            guardrails_config=guardrails_config,
            message=body.message,
        )
        conversation = session.get(AgentConversationRecord, body.conversation_id) if body.conversation_id else None
        if body.conversation_id and conversation is None:
            raise HTTPException(404, "conversation not found")
        if conversation is not None and conversation.agent_id != agent.id:
            raise HTTPException(400, "conversation does not belong to the selected agent")
        conversation_mode = resolve_conversation_mode(
            requested_mode=body.conversation_mode,
            guardrails_config=guardrails_config,
        )
        workflow_mode = resolve_workflow_mode(requested_mode=body.workflow_mode, conversation=conversation)
        call_init_turn = bool(body.call_init.enabled and _is_magic_mike_agent(agent))
        magic_call_init_greeting = call_init_turn and _is_magic_mike_agent(agent)
        production_magic_greeting = (
            is_production_chat_surface(body.surface)
            and _is_magic_mike_agent(agent)
            and (call_init_turn or _is_greeting_intent(body.message))
        )
        missing_business_structure_answer = build_missing_business_structure_answer(
            message=body.message,
            workflow_mode=workflow_mode,
            guardrails_config=guardrails_config,
        )
        effective_system_prompt = build_effective_system_prompt(
            base_system_prompt=str(guardrails_config.get("system_prompt", "")),
            conversation_mode=conversation_mode,
            workflow_mode=workflow_mode,
            guardrails_config=guardrails_config,
            message=body.message,
        )
        effective_system_prompt = apply_docx_mode_directives(base_prompt=effective_system_prompt, docx_mode=body.docx_mode)
        top_k = resolve_effective_query_top_k(
            session=session,
            requested_top_k=body.top_k,
            runtime_profile=runtime_profile,
            message=body.message,
            conversation_mode=conversation_mode,
        )
        if conversation is None:
            frame_id: str | None = None
            if workflow_mode != "standard":
                frame = create_document_frame(
                    session,
                    title=f"{agent.name} strategic document",
                    metadata_json={"seed_workflow_mode": workflow_mode},
                )
                frame_id = frame.id
            conversation = create_conversation(
                session,
                agent_id=agent.id,
                message=body.message,
                corpora=corpora,
                api_mode=body.api_mode,
                conversation_mode=conversation_mode,
                workflow_mode=workflow_mode,
                document_frame_id=frame_id,
            )
            session.commit()
            session.refresh(conversation)
        chat_uploads = load_chat_uploads(session, conversation_id=conversation.id)
        chat_upload_context = build_chat_upload_prompt_context(chat_uploads)
        document_frame = (
            session.get(DocumentFrameRecord, conversation.document_frame_id) if conversation.document_frame_id else None
        )
        document_frame_context = build_document_frame_prompt_context(document_frame)
        combined_upload_context = "\n\n".join(
            part for part in (chat_upload_context, document_frame_context) if part.strip()
        )
        chat_upload_cache_context = build_chat_upload_cache_context(chat_uploads)
        history = list_messages(session, conversation.id, limit=max(settings.app_agent_memory_window_messages * 2, 20))
        history_context = build_history_context(history, window_messages=settings.app_agent_memory_window_messages)
        if is_production_chat_surface(body.surface):
            history_context = _public_safe_history_context(history_context)
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
        kb_tool = get_tool_config(tool_policy_config, "kb") or {}
        kb_enabled = bool(kb_tool.get("enabled", True))
        odoo_ready = any(item.id == "odoo_primary" and item.status == "ready" for item in tool_summary_models)
        web_enabled = bool(web_tool.get("enabled", False))
        effective_snapshot_id = build_effective_snapshot_id(
            agent_id=agent.id,
            runtime_profile_id=runtime_profile.id,
            corpora=corpora,
            conversation_mode=conversation_mode,
            workflow_mode=workflow_mode,
            tool_summary=tool_summary,
            use_approved_web=use_approved_web,
            owner_operator_template_compact=str(
                guardrails_config.get("owner_operator_questionnaire_compact") or ""
            ),
            business_structure_context_compact=str(
                guardrails_config.get("business_structure_context_compact") or ""
            ),
        )
        runtime_context = build_runtime_context_block(
            agent_name=agent.name,
            runtime_profile_name=str(runtime_profile.name),
            corpora=corpora,
            conversation_mode=conversation_mode,
            workflow_mode=workflow_mode,
            history_context=history_for_prompt,
            allowed_urls=allowed_urls,
            used_approved_web=use_approved_web,
            tool_summary=tool_summary,
            openai_responses_chain=use_openai_responses_chain,
            owner_operator_template_compact=str(
                guardrails_config.get("owner_operator_questionnaire_compact") or ""
            ),
            business_structure_context_compact=str(
                guardrails_config.get("business_structure_context_compact") or ""
            ),
        )
        if magic_call_init_greeting or production_magic_greeting:
            plan = {
                "query_mode": "blended",
                "direct_answer": (
                    _call_init_greeting(
                        local_time=body.call_init.local_time if call_init_turn else None,
                        timezone_name=body.call_init.timezone if call_init_turn else None,
                    )
                    if call_init_turn
                    else PUBLIC_GREETING_FALLBACK_TEXT
                ),
                "prompt": None,
                "citations": [],
                "tool_plan": {
                    "tool_id": None,
                    "mode": "none",
                    "reason": "call_init_greeting_bypass" if call_init_turn else "production_greeting_bypass",
                },
            }
        elif missing_business_structure_answer:
            plan = {
                "query_mode": "structured",
                "direct_answer": missing_business_structure_answer,
                "prompt": None,
                "citations": [],
                "tool_plan": {
                    "tool_id": "odoo_primary",
                    "mode": "none",
                    "reason": "business_structure_context_missing",
                },
            }
        else:
            plan = await fetch_query_plan(
                plan_query_message,
                corpora,
                top_k,
                request.state.trace_id,
                current_message=body.message,
                workflow_mode=workflow_mode,
                embedding_model_id=dict(runtime_profile.kb_config_json or {}).get("embedding_model_id"),
                kb_enabled=kb_enabled,
                odoo_ready=odoo_ready,
            )
        if workflow_mode == "bp_mode" and not missing_business_structure_answer:
            existing_prompt = str(plan.get("prompt") or "").strip()
            bp_prompt_parts = [
                bp_mode_case_framing_prompt(body.message),
                (
                    "Lead architect execution contract:\n"
                    "- Retrieve fresh Odoo evidence for required financial metrics.\n"
                    "- Never terminate with blocker-only output.\n"
                    "- If evidence is partial, return provisional values plus remediation steps.\n"
                    "- Include an explicit confidence note per key metric."
                ),
                existing_prompt,
                "Auditor quality gate contract:\n" + bp_mode_auditor_prompt(body.message),
            ]
            plan["prompt"] = "\n\n".join(part for part in bp_prompt_parts if part).strip()
        if is_production_chat_surface(body.surface) and _is_magic_mike_agent(agent):
            plan["tool_plan"] = {"tool_id": None, "mode": "none", "reason": "production_consumer_tool_policy"}
        effective_system_prompt = append_tool_plan_system_hint(effective_system_prompt, plan.get("tool_plan"))
        use_odoo_agentic = should_use_odoo_agentic(
            body=body,
            workflow_mode=workflow_mode,
            odoo_ready=False if is_production_chat_surface(body.surface) else odoo_ready,
            connection=connection,
            use_openai_responses_chain=use_openai_responses_chain,
        )
        tool_evidence = prepare_tool_evidence(
            session,
            agent_id=agent.id,
            agent_name=agent.name,
            tool_overrides=body.tool_overrides,
            tool_plan={"mode": "none"} if use_odoo_agentic else plan.get("tool_plan"),
            workflow_mode=workflow_mode,
            request_message=body.message,
        )
        mas_markdown, mas_operation = _extract_latest_odoo_mas_markdown(tool_evidence.tool_events)
        if mas_markdown and not plan.get("direct_answer") and not combined_upload_context:
            # Truth-lock MAS answers to executed deterministic markdown and bypass narrative rewrite.
            plan["direct_answer"] = normalize_business_abbreviations(
                _render_mas_truth_locked_answer(mas_markdown, mas_operation)
            )
        if body.docx_mode.enabled:
            tool_evidence.tool_events.append(
                ChatToolEvent(
                    tool_id="apryse_docs",
                    status="planned",
                    operation=f"apryse_{body.docx_mode.operation}",
                    summary=(
                        f"Apryse doc mode active ({body.docx_mode.operation})"
                        + (
                            f" for template {body.docx_mode.template_id}"
                            if str(body.docx_mode.template_id or "").strip()
                            else ""
                        )
                    ),
                    payload={
                        "template_id": body.docx_mode.template_id,
                        "operation": body.docx_mode.operation,
                        "binding_override_keys": sorted(list((body.docx_mode.binding_overrides or {}).keys())),
                    },
                )
            )
        plan_query_prompt = str(plan.get("prompt") or "")
        if tool_evidence.prompt_prefix:
            plan_query_prompt = (
                f"{tool_evidence.prompt_prefix}\n\n{plan_query_prompt}".strip()
                if plan_query_prompt
                else tool_evidence.prompt_prefix
            )
        staged_directives = build_staged_answer_directives(
            tool_plan=tool_evidence.plan,
            conversation_mode=conversation_mode,
        )
        if staged_directives:
            plan_query_prompt = f"{plan_query_prompt}\n\n{staged_directives}".strip() if plan_query_prompt else staged_directives
        tool_truth_directives = build_tool_truthfulness_directives(
            tool_plan=tool_evidence.plan,
            tool_events=tool_evidence.tool_events,
        )
        if tool_truth_directives:
            plan_query_prompt = (
                f"{plan_query_prompt}\n\n{tool_truth_directives}".strip() if plan_query_prompt else tool_truth_directives
            )
        closeout_directives = build_business_closeout_directives(
            message=body.message,
            tool_plan=tool_evidence.plan,
            tool_events=tool_evidence.tool_events,
        )
        if closeout_directives:
            plan_query_prompt = (
                f"{plan_query_prompt}\n\n{closeout_directives}".strip() if plan_query_prompt else closeout_directives
            )
        owner_contract_directives = build_owner_operator_contract_directives(
            message=body.message,
            tool_plan=tool_evidence.plan,
            tool_events=tool_evidence.tool_events,
        )
        if owner_contract_directives:
            plan_query_prompt = (
                f"{plan_query_prompt}\n\n{owner_contract_directives}".strip()
                if plan_query_prompt
                else owner_contract_directives
            )
        group_overview_directives = build_group_overview_directives(
            message=body.message,
            tool_plan=tool_evidence.plan,
            tool_events=tool_evidence.tool_events,
        )
        if group_overview_directives:
            plan_query_prompt = (
                f"{plan_query_prompt}\n\n{group_overview_directives}".strip()
                if plan_query_prompt
                else group_overview_directives
            )
        cache_key = None
        if (
            is_production_chat_surface(body.surface)
            or use_approved_web
            or use_openai_responses_chain
            or str(tool_evidence.plan.get("mode") or "none") != "none"
            or use_odoo_agentic
            or workflow_mode == "bp_mode"
        ):
            cached = None
        else:
            cache_key = build_response_cache_key(
                agent=agent,
                runtime_profile=runtime_profile,
                conversation_id=conversation.id,
                history_context=history_context,
                message=body.message
                + ("\n\n[chat_uploads]\n" + chat_upload_cache_context if chat_upload_cache_context else "")
                + ("\n\n[document_frame]\n" + document_frame_context if document_frame_context else ""),
                corpora=corpora,
                api_mode=body.api_mode,
                llm_model_id_override=body.llm_model_id,
                tool_state={
                    "tool_summary": tool_summary,
                    "tool_plan_mode": tool_evidence.plan.get("mode", "none"),
                    "conversation_mode": conversation_mode,
                    "workflow_mode": workflow_mode,
                },
            )
            cached = lookup_cached_response(session, agent_id=agent.id, request_hash=cache_key)
        resolved_model_id = _effective_chat_model_id(body, llm_config)
        route_decision = build_route_decision(
            message=body.message,
            workflow_mode=workflow_mode,
            tool_plan=plan.get("tool_plan"),
            kb_enabled=kb_enabled,
            web_enabled=web_enabled,
            odoo_ready=odoo_ready,
        )
        route_decision["llm_execution"] = []
        prev_openai_rid = (conversation.openai_last_response_id or "").strip() or None
        openai_rid_out: list[str | None] = [None]
        raw_max_tokens = llm_config.get("max_tokens")
        configured_max_tokens = int(raw_max_tokens) if raw_max_tokens not in (None, "") else None
        llm_orchestration = _resolved_llm_orchestration(llm_config)
        prompt_variants: list[PreparedAnswerPrompt] = []
        if cached is None and not (plan.get("direct_answer") and not combined_upload_context):
            primary_prompt, retry_prompt, tertiary_prompt = prepare_answer_prompt_variants(
                api_mode=body.api_mode,
                agent_name=agent.name,
                system_prompt=effective_system_prompt,
                query_prompt=plan_query_prompt,
                history_context=history_for_prompt,
                runtime_context=runtime_context,
                approved_web_context=approved_web_context,
                upload_context=combined_upload_context,
            )
            log_answer_prompt_compaction(trace_id=request.state.trace_id, package=primary_prompt)
            prompt_variants = unique_answer_prompt_variants(primary_prompt, retry_prompt, tertiary_prompt)

        def _stream():
            public_presenter = PublicStreamPresenter(enabled=is_production_chat_surface(body.surface))

            def _encode(payload: dict) -> str:
                presented = public_presenter.present_event(payload)
                if presented is None:
                    return ""
                if isinstance(presented, list):
                    return "".join(f"data: {json.dumps(event)}\n\n" for event in presented)
                return f"data: {json.dumps(presented)}\n\n"

            ran_stream_odoo_agentic = False
            answer_parts: list[str] = []
            successful_user_prompt: str | None = None
            successful_provider_usage: dict[str, int | bool] | None = None
            llm_execution_steps: list[dict[str, Any]] = []
            worker_outputs: list[dict[str, str]] = []
            first_prompt_for_llm_io: str = ""
            last_prompt_for_llm_io: str = ""
            assistant_message_id: str | None = None
            stream_docx_artifacts: list[dict[str, Any]] = list(docx_artifacts)
            stream_docx_diagnostics: list[dict[str, Any]] = list(docx_diagnostics)
            citations = (
                cached.citations_json
                if cached is not None
                else (
                    [*plan.get("citations", []), *web_citations]
                    if use_odoo_agentic
                    else [*tool_evidence.citations, *plan.get("citations", []), *web_citations]
                )
            )
            citations = _filter_citations_for_mas_truth(citations, tool_evidence.tool_events)
            query_mode = cached.query_mode if cached is not None else plan["query_mode"]
            cache_response = tool_evidence.can_cache_response and not use_odoo_agentic
            if workflow_mode == "bp_mode":
                cache_response = False
            tool_events_payload = [
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
            ]
            route_decision_payload = dict(route_decision)
            route_decision_payload["llm_execution"] = []
            yield _encode(
                {
                    "type": "start",
                    "api_mode": body.api_mode,
                    "conversation_mode": conversation_mode,
                    "workflow_mode": workflow_mode,
                    "query_mode": query_mode,
                    "citations": citations,
                    "conversation_id": conversation.id,
                    "agent_id": agent.id,
                    "cached": cached is not None,
                    "effective_snapshot_id": effective_snapshot_id,
                    "tool_summary": tool_summary,
                    "route_decision": route_decision_payload,
                    "tool_events": [],
                    "docx_artifacts": stream_docx_artifacts,
                    "docx_diagnostics": stream_docx_diagnostics,
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
                stream_agentic_condition = (
                    use_odoo_agentic
                    and not (plan.get("direct_answer") and not combined_upload_context)
                    and bool(prompt_variants)
                )
                if stream_agentic_condition:
                    ran_stream_odoo_agentic = True
                    cache_response = False
                    max_it = max(1, int(getattr(settings, "app_odoo_agentic_max_iterations", 8)))
                    docx_only = [e for e in tool_evidence.tool_events if e.tool_id == "apryse_docs"]
                    agentic_result, agentic_tool_events = run_odoo_agentic_tool_loop(
                        session,
                        agent_id=agent.id,
                        connection=connection,
                        system_prompt=effective_system_prompt,
                        user_prompt=prompt_variants[0].prompt,
                        model_id=resolved_model_id,
                        temperature=float(llm_config.get("temperature", 0)),
                        max_tokens=resolve_answer_max_tokens(
                            api_mode=body.api_mode,
                            configured_max_tokens=configured_max_tokens,
                            prompt=prompt_variants[0].prompt,
                            trace_id=request.state.trace_id,
                            openai_responses_chain=use_openai_responses_chain,
                        ),
                        tool_overrides=body.tool_overrides,
                        trace_id=request.state.trace_id,
                        max_iterations=max_it,
                    )
                    for ev in agentic_tool_events:
                        yield _encode({"type": "tool_result", "tool_event": ev.model_dump()})
                    answer_text_agentic = (agentic_result.text or "").strip()
                    chunk_size = 240
                    for i in range(0, len(answer_text_agentic), chunk_size):
                        chunk = answer_text_agentic[i : i + chunk_size]
                        yield _encode({"type": "delta", "delta": chunk})
                        answer_parts.append(chunk)
                    tool_evidence.tool_events[:] = [*agentic_tool_events, *docx_only]
                    citations = [
                        *external_citations_for_tool_events(agentic_tool_events),
                        *plan.get("citations", []),
                        *web_citations,
                    ]
                    successful_user_prompt = prompt_variants[0].prompt
                    successful_provider_usage = agentic_result.usage
                    llm_execution_steps.append(
                        _build_execution_step(
                            stage="primary",
                            reason="odoo_agentic_tool_loop",
                            connection=connection,
                            model_id=resolved_model_id,
                            api_mode=body.api_mode,
                            usage=agentic_result.usage,
                            prompt=prompt_variants[0].prompt,
                        )
                    )
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
                if not ran_stream_odoo_agentic and _should_emit_multi_agent_handoff_trace(
                    workflow_mode=workflow_mode,
                    route_decision=route_decision,
                    tool_plan=plan.get("tool_plan"),
                ):
                    if str(agent.agent_role or "lead").strip().lower() != "lead":
                        invalid_orchestrator_event = ChatToolEvent(
                            tool_id="agent.orchestrator",
                            status="failed",
                            operation="agent.orchestrator.resolve_workers",
                            summary="Selected orchestrator must be a lead agent.",
                            blocked_reason="invalid_orchestrator_role",
                            payload={"agent_id": agent.id, "agent_role": agent.agent_role},
                        )
                        tool_evidence.tool_events.append(invalid_orchestrator_event)
                        yield _encode({"type": "tool_result", "tool_event": invalid_orchestrator_event.model_dump()})
                    else:
                        worker_agents = _resolve_orchestration_sub_agents(session, agent)
                        if not worker_agents:
                            no_worker_event = ChatToolEvent(
                                tool_id="agent.orchestrator",
                                status="failed",
                                operation="agent.orchestrator.resolve_workers",
                                summary="Lead orchestrator could not resolve sub-agents under this lead.",
                                blocked_reason="no_sub_agents_configured",
                                payload={"lead_agent_id": agent.id},
                            )
                            tool_evidence.tool_events.append(no_worker_event)
                            yield _encode({"type": "tool_result", "tool_event": no_worker_event.model_dump()})
                        for worker in worker_agents:
                            worker_role = _classify_sub_agent_role(worker.name) or "sub_agent"
                            planned_event = ChatToolEvent(
                                tool_id=f"agent.{worker_role}",
                                status="planned",
                                operation=f"agent.{worker_role}.execute",
                                summary=f"Calling {worker.name} and waiting for response.",
                                payload={"worker_agent_id": worker.id, "worker_name": worker.name, "stage": "dispatch"},
                            )
                            tool_evidence.tool_events.append(planned_event)
                            yield _encode({"type": "tool_result", "tool_event": planned_event.model_dump()})
                            try:
                                worker_result, attempts_used = _execute_sub_agent_with_retries(
                                    session=session,
                                    worker=worker,
                                    user_message=body.message,
                                    tool_grounding_prompt=plan_query_prompt,
                                    prior_worker_outputs=worker_outputs,
                                    fallback_api_mode=body.api_mode,
                                    trace_id=request.state.trace_id,
                                )
                                worker_text = str(worker_result.text or "").strip()
                                worker_outputs.append({"worker_name": worker.name, "content": worker_text})
                                completed_event = ChatToolEvent(
                                    tool_id=f"agent.{worker_role}",
                                    status="executed",
                                    operation=f"agent.{worker_role}.execute",
                                    summary=f"{worker.name} completed and returned specialist output.",
                                    payload={
                                        "worker_agent_id": worker.id,
                                        "worker_name": worker.name,
                                        "stage": "completed",
                                        "attempts_used": attempts_used,
                                        "output_excerpt": _normalize_prompt_excerpt(worker_text, max_chars=320, mode="head"),
                                    },
                                )
                                tool_evidence.tool_events.append(completed_event)
                                yield _encode({"type": "tool_result", "tool_event": completed_event.model_dump()})
                            except Exception as worker_exc:
                                failed_event = ChatToolEvent(
                                    tool_id=f"agent.{worker_role}",
                                    status="failed",
                                    operation=f"agent.{worker_role}.execute",
                                    summary=f"{worker.name} failed during delegated execution.",
                                    blocked_reason="sub_agent_execution_failed",
                                    payload={
                                        "worker_agent_id": worker.id,
                                        "worker_name": worker.name,
                                        "attempts_used": SUB_AGENT_MAX_RETRIES + 1,
                                        "error": repr(worker_exc),
                                    },
                                )
                                tool_evidence.tool_events.append(failed_event)
                                yield _encode({"type": "tool_result", "tool_event": failed_event.model_dump()})
            if cached is None and plan.get("direct_answer") and not combined_upload_context:
                yield _encode({"type": "delta", "delta": plan["direct_answer"]})
                answer_parts.append(plan["direct_answer"])
            elif cached is None and not ran_stream_odoo_agentic:
                stream_error: Exception | None = None
                primary_prompt_used = ""
                for attempt_index, prompt_variant in enumerate(prompt_variants, start=1):
                    try:
                        if use_openai_responses_chain and openai_rid_out is not None:
                            openai_rid_out[0] = None
                        active_prompt = _augment_prompt_with_worker_outputs(prompt_variant.prompt, worker_outputs)
                        usage_out: list[dict[str, int | bool] | None] = [None]
                        for delta in stream_answer(
                            active_prompt,
                            connection,
                            api_mode=body.api_mode,
                            system_prompt=effective_system_prompt,
                            model_id=resolved_model_id,
                            temperature=float(llm_config.get("temperature", 0)),
                            max_tokens=resolve_answer_max_tokens(
                                api_mode=body.api_mode,
                                configured_max_tokens=configured_max_tokens,
                                prompt=active_prompt,
                                trace_id=request.state.trace_id,
                                openai_responses_chain=use_openai_responses_chain,
                            ),
                            trace_id=request.state.trace_id,
                            service="agent-ingress",
                            previous_response_id=prev_openai_rid,
                            use_openai_responses_http=use_openai_responses_chain,
                            openai_response_id_out=openai_rid_out if use_openai_responses_chain else None,
                            usage_out=usage_out,
                        ):
                            answer_parts.append(delta)
                            yield _encode({"type": "delta", "delta": delta})
                        successful_user_prompt = active_prompt
                        primary_prompt_used = active_prompt
                        if not first_prompt_for_llm_io:
                            first_prompt_for_llm_io = active_prompt
                        successful_provider_usage = usage_out[0]
                        llm_execution_steps.append(
                            _build_execution_step(
                                stage="primary",
                                reason="primary_generation",
                                connection=connection,
                                model_id=resolved_model_id,
                                api_mode=body.api_mode,
                                usage=usage_out[0],
                                prompt=active_prompt,
                            )
                        )
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
                should_second_pass, second_pass_reason = _llm_orchestration_should_second_pass(
                    llm_orchestration,
                    primary_prompt=primary_prompt_used or (prompt_variants[0].prompt if prompt_variants else ""),
                    primary_error=stream_error,
                )
                if should_second_pass:
                    try:
                        fallback_connection = resolve_llm_connection(
                            session,
                            connection_id=llm_orchestration.get("fallback_connection_id"),
                            provider=str(llm_orchestration.get("fallback_provider") or "openai"),
                        )
                        fallback_model_id = _resolve_fallback_model_id(
                            llm_orchestration,
                            primary_model_id=resolved_model_id,
                        )
                        second_prompt = primary_prompt_used or (prompt_variants[0].prompt if prompt_variants else "")
                        if llm_orchestration.get("include_primary_answer_context", True) and answer_parts:
                            second_prompt = _with_primary_answer_context(second_prompt, "".join(answer_parts))
                        if not first_prompt_for_llm_io:
                            first_prompt_for_llm_io = second_prompt
                        fallback_use_openai_responses_chain = should_use_openai_responses_chain(
                            fallback_connection, body.api_mode
                        )
                        fallback_prev_rid = prev_openai_rid if fallback_connection.id == connection.id else None
                        second_result = stream_answer_to_result(
                            second_prompt,
                            fallback_connection,
                            api_mode=body.api_mode,
                            system_prompt=effective_system_prompt,
                            model_id=fallback_model_id,
                            temperature=float(llm_config.get("temperature", 0)),
                            max_tokens=resolve_answer_max_tokens(
                                api_mode=body.api_mode,
                                configured_max_tokens=configured_max_tokens,
                                prompt=second_prompt,
                                trace_id=request.state.trace_id,
                                openai_responses_chain=fallback_use_openai_responses_chain,
                            ),
                            trace_id=request.state.trace_id,
                            service="agent-ingress",
                            previous_response_id=fallback_prev_rid,
                            use_openai_responses_http=fallback_use_openai_responses_chain,
                        )
                        llm_execution_steps.append(
                            _build_execution_step(
                                stage="secondary",
                                reason=second_pass_reason,
                                connection=fallback_connection,
                                model_id=fallback_model_id,
                                api_mode=body.api_mode,
                                usage=second_result.usage,
                                prompt=second_prompt,
                            )
                        )
                        if second_result.text.strip():
                            answer_parts = [second_result.text.strip()]
                            successful_user_prompt = second_prompt
                            successful_provider_usage = second_result.usage
                            last_prompt_for_llm_io = second_prompt
                            if fallback_connection.id == connection.id and openai_rid_out and len(openai_rid_out) > 0:
                                openai_rid_out[0] = second_result.openai_response_id
                    except Exception as orchestration_exc:
                        cache_response = False
                        log_instant_event(
                            trace_id=request.state.trace_id,
                            service="agent-ingress",
                            route="chat_stream.second_pass.failed",
                            status="error",
                            error=repr(orchestration_exc),
                            details={
                                "reason": second_pass_reason,
                                "fallback_provider": llm_orchestration.get("fallback_provider"),
                            },
                        )
                if primary_prompt_used and not first_prompt_for_llm_io:
                    first_prompt_for_llm_io = primary_prompt_used
                if primary_prompt_used and not last_prompt_for_llm_io:
                    last_prompt_for_llm_io = primary_prompt_used
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
            answer_text = normalize_finance_closeout_answer(
                answer_text="".join(answer_parts),
                request_message=body.message,
                tool_plan=tool_evidence.plan,
                tool_events=tool_evidence.tool_events,
                workflow_mode=workflow_mode,
            )
            answer_text = dedupe_answer_text(answer_text)
            route_decision_with_execution = dict(route_decision)
            route_decision_with_execution["llm_execution"] = llm_execution_steps
            if workflow_mode == "bp_mode":
                bp_audit = evaluate_bp_audit(
                    answer_text=answer_text,
                    tool_events=tool_evidence.tool_events,
                    request_message=body.message,
                )
                route_decision_with_execution.setdefault("tool_expectations", {})
                route_decision_with_execution["tool_expectations"]["bp_audit"] = bp_audit
                auditor_event = ChatToolEvent(
                    tool_id="agent.bp_auditor",
                    status="executed" if not bool(bp_audit.get("hard_fail")) else "failed",
                    operation="agent.bp_auditor.evaluate",
                    summary=(
                        "BP audit passed"
                        if not bool(bp_audit.get("hard_fail"))
                        else "BP audit failed - remediation required"
                    ),
                    blocked_reason="bp_audit_hard_fail" if bool(bp_audit.get("hard_fail")) else None,
                    payload={"bp_audit": bp_audit},
                )
                tool_evidence.tool_events.append(auditor_event)
                yield _encode({"type": "tool_result", "tool_event": auditor_event.model_dump()})
            if body.docx_mode.enabled:
                operation = resolve_docx_operation(body.docx_mode)
                required_sections = resolve_docx_finalize_required_sections(guardrails_config=guardrails_config)
                docx_answer_text = normalize_docx_finalize_answer(
                    operation=operation,
                    answer_text=answer_text,
                    required_sections=required_sections,
                )
                finalize_diagnostics = validate_docx_finalize_output(
                    operation=operation,
                    answer_text=docx_answer_text,
                    required_sections=required_sections,
                )
                if finalize_diagnostics:
                    stream_docx_artifacts = []
                    stream_docx_diagnostics = list(finalize_diagnostics)
                else:
                    stream_docx_artifacts, stream_docx_diagnostics = render_docx_with_sidecar_sync(
                        docx_mode=body.docx_mode,
                        trace_id=request.state.trace_id,
                        agent_id=agent.id,
                        conversation_id=conversation.id,
                        answer_text=docx_answer_text,
                    )
            tool_events_payload = [
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
            ]
            with SessionLocal() as stream_session:
                append_message(
                    stream_session,
                    conversation_id=conversation.id,
                    agent_id=agent.id,
                    role="user",
                    content=body.message,
                    conversation_mode=conversation_mode,
                    workflow_mode=workflow_mode,
                )
                assistant_message = append_message(
                    stream_session,
                    conversation_id=conversation.id,
                    agent_id=agent.id,
                    role="assistant",
                    content=answer_text,
                    query_mode=query_mode,
                    citations=citations,
                    tool_events=tool_events_payload,
                    usage=None,
                    route_decision=route_decision_with_execution,
                    api_mode=body.api_mode,
                    conversation_mode=conversation_mode,
                    workflow_mode=workflow_mode,
                )
                stream_session.flush()
                assistant_message_id = assistant_message.id
                stream_conversation = stream_session.get(AgentConversationRecord, conversation.id)
                if stream_conversation is not None:
                    stream_conversation.corpora_json = list(corpora)
                    stream_conversation.api_mode = body.api_mode
                    stream_conversation.conversation_mode = conversation_mode
                    stream_conversation.workflow_mode = workflow_mode
                    if use_openai_responses_chain and openai_rid_out and openai_rid_out[0]:
                        stream_conversation.openai_last_response_id = openai_rid_out[0]
                if body.docx_mode.enabled:
                    upsert_docx_session(
                        stream_session,
                        conversation_id=conversation.id,
                        agent_id=agent.id,
                        template_id=body.docx_mode.template_id,
                        operation=body.docx_mode.operation,
                        status="rendered",
                        binding_json=body.docx_mode.binding_overrides or {},
                        artifacts_json=stream_docx_artifacts,
                        diagnostics_json=stream_docx_diagnostics,
                    )
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
            system_sp_stream = effective_system_prompt
            fb_prompt_stream = prompt_variants[0].prompt if prompt_variants else ""
            skip_llm_stream = cached is not None or (
                plan is not None and bool(plan.get("direct_answer")) and not combined_upload_context
            )
            aggregated_provider_usage = _aggregate_usage(llm_execution_steps)
            usage_stream = resolve_chat_usage_dict(
                provider_usage=aggregated_provider_usage or successful_provider_usage,
                system_prompt=system_sp_stream,
                user_prompt=successful_user_prompt,
                completion=answer_text,
                fallback_user_prompt=fb_prompt_stream,
                skip_llm=skip_llm_stream,
            )
            first_prompt_for_llm_io = first_prompt_for_llm_io or successful_user_prompt or fb_prompt_stream
            last_prompt_for_llm_io = last_prompt_for_llm_io or successful_user_prompt or fb_prompt_stream
            llm_io_payload = _build_llm_io_payload(
                usage_stream,
                first_prompt_text=first_prompt_for_llm_io,
                last_prompt_text=last_prompt_for_llm_io,
            )
            if assistant_message_id is not None:
                with SessionLocal() as usage_session:
                    assistant_message = usage_session.get(AgentMessageRecord, assistant_message_id)
                    if assistant_message is not None:
                        assistant_message.usage_json = dict(usage_stream)
                        usage_session.commit()
            yield _encode(
                {
                    "type": "done",
                    "citations": citations,
                    "conversation_mode": conversation_mode,
                    "workflow_mode": workflow_mode,
                    "conversation_id": conversation.id,
                    "cached": cached is not None,
                    "usage": usage_stream,
                    "llm_io": llm_io_payload,
                    "effective_snapshot_id": effective_snapshot_id,
                    "tool_summary": tool_summary,
                    "tool_events": tool_events_payload,
                    "route_decision": route_decision_with_execution,
                    "docx_artifacts": stream_docx_artifacts,
                    "docx_diagnostics": stream_docx_diagnostics,
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
