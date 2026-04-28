"""Multi-step Odoo tool use for odoo_specialist (chat.completions + tool loop).

**North star (not fully productized here):** an "Ian" style engagement should feel like Cursor plus ERP —
a strong **head** model reasons about Odoo architecture and analytical strategy, while a lighter
**assistant** layer can ask a few *situation-aware* clarifying questions (grouping, acute vs chronic,
entity scope) before expensive `odoo_execute` passes. That split is a *two-role* product pattern:
separate runtime profiles / models (e.g. Gemini or GPT-5.x for planning synthesis, Llama-class for
fast dialogue), multi-turn clarifiers, then governed tools — **not** one static script per question.

**What this module implements today:** iterative `odoo_execute` with the configured connection model so
the specialist can loop on catalog operations until evidence is sufficient. Clarifying-question UX,
automatic "acute vs stock-out" diagnosis, and raw SQL are outside this file; route those through
workflow design (e.g. MAS head-agent consult), agent prompts, and future orchestration.
"""

from __future__ import annotations

import json
import time
from typing import Any

from sqlalchemy.orm import Session

from .models import ConnectionRecord
from .runtime import (
    LlmCompletionResult,
    _build_openai_compatible_client,
    _extract_openai_chat_usage,
    _merge_provider_connection,
    _normalize_provider_model_id,
    _provider_base_url,
    _is_gemini_native_base_url,
    wrap_outbound_call,
)
from .schemas import ChatRequest, ChatToolEvent, ToolExecuteResponse
from .settings import get_settings
from .telemetry import log_instant_event
from .token_usage import normalize_provider_usage_dict
from .tool_registry import execute_tool_operation_for_agent

settings = get_settings()

ODOO_AGENTIC_SYSTEM_SUFFIX = (
    "\n\nYou have access to the `odoo_execute` tool for read-only, validated Odoo operations. "
    "Call it as many times as needed to gather accurate ERP facts before answering — similar to an IDE agent that "
    "loops with tools until the user's request is satisfied. "
    "If the first result is incomplete, refine parameters or choose a different operation. "
    "When you have enough evidence, stop calling tools and write a direct, useful answer for the user.\n\n"
    "Operation choice: use core finance ops for company/branch P&L and GP — typically "
    "`odoo.finance.margin.period_summary`, `odoo.finance.revenue.period`, or `odoo.finance.cogs.period` "
    "with the requested `company_id` / `company_name_terms` and date window. "
    "For product catalog requests use `odoo.products.search_read`; for period order-book checks use "
    "`odoo.sales.orders.search_read`; for product ranking + per-product GP use `odoo.sales.products_gp.period_top`. "
    "Use `odoo.finance.shopify.monthly_roi` when the user asks for Shopify-channel ROAS, marketing/spend, or "
    "Shopify-linked revenue/fee metrics (including in the same question as Odoo/ledger asks — run both in a sensible order, "
    "and label which result is ledger-wide vs Shopify-tagged). "
    "Do not substitute the Shopify helper for *only* broad Odoo/ERP/branch GP when the user never asked for Shopify-channel numbers."
)

ODOO_EXECUTE_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "odoo_execute",
        "description": (
            "Execute one validated read-only Odoo operation against the connected ERP. "
            "Use operation ids from the GhostDASH Odoo catalog (e.g. dynamic query_spec, finance, exploration). "
            "Payload must match the operation schema."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "description": "Canonical operation id (e.g. odoo.query_spec.execute).",
                },
                "payload": {
                    "type": "object",
                    "description": "JSON object of parameters for this operation.",
                },
            },
            "required": ["operation"],
        },
    },
}

_TOOL_RESULT_MAX_CHARS = 28000


def connection_supports_odoo_agentic_tool_loop(
    connection: ConnectionRecord,
    *,
    use_openai_responses_chain: bool,
) -> bool:
    """Tool loop uses chat.completions with tools; native Responses-only chain cannot run this path."""
    pc = _merge_provider_connection(connection)
    base_url = _provider_base_url(pc)
    if (pc.provider_kind or "").strip().lower() == "google_gemini" and _is_gemini_native_base_url(base_url):
        return False
    if use_openai_responses_chain:
        return False
    return True


def should_use_odoo_agentic(
    *,
    body: ChatRequest,
    workflow_mode: str,
    odoo_ready: bool,
    connection: ConnectionRecord,
    use_openai_responses_chain: bool,
) -> bool:
    if not odoo_ready or workflow_mode != "odoo_specialist":
        return False
    explicit = body.odoo_agentic
    if explicit is False:
        return False
    if explicit is None and not bool(getattr(settings, "app_odoo_agentic_enabled", True)):
        return False
    return connection_supports_odoo_agentic_tool_loop(
        connection,
        use_openai_responses_chain=use_openai_responses_chain,
    )


def _summarize_tool_data(data: dict[str, Any]) -> str:
    parts: list[str] = []
    if isinstance(data.get("count"), int):
        parts.append(f"count={data['count']}")
    records = data.get("records")
    if isinstance(records, list):
        parts.append(f"records={len(records)}")
    rows = data.get("rows")
    if isinstance(rows, list):
        parts.append(f"rows={len(rows)}")
    if data.get("total_residual") is not None:
        parts.append(f"total_residual={data['total_residual']}")
    if data.get("revenue") is not None:
        parts.append(f"revenue={data['revenue']}")
    if data.get("cogs") is not None:
        parts.append(f"cogs={data['cogs']}")
    if data.get("gp") is not None:
        parts.append(f"gp={data['gp']}")
    model = str(data.get("model") or "").strip()
    if model:
        parts.append(f"model={model}")
    return ", ".join(parts) if parts else "tool response available"


def _chat_tool_event_from_execute(
    *,
    operation: str,
    request_payload: dict[str, Any],
    tool_response: ToolExecuteResponse,
) -> ChatToolEvent:
    data = dict(tool_response.data or {})
    if tool_response.success:
        summary = _summarize_tool_data(data)
        event_payload = {
            "request": request_payload,
            "response": data,
            "execution_truth": {
                "status": "executed",
                "operation": operation,
                "evidence_source_mode": data.get("evidence_source_mode", "live_odoo"),
                "date_from": data.get("date_from"),
                "date_to": data.get("date_to"),
                "company_id": data.get("company_id"),
                "company_ids": data.get("company_ids"),
                "company_name_terms": data.get("company_name_terms"),
                "company_scope_lock": data.get("company_scope_lock"),
                "company_scope_lock_canonical": data.get("company_scope_lock_canonical"),
                "scope_enforced": data.get("scope_enforced"),
            },
        }
        return ChatToolEvent(
            tool_id="odoo_primary",
            status="executed",
            operation=operation,
            summary=summary,
            payload=event_payload,
            latency_ms=tool_response.latency_ms,
        )
    blocked_reasons = list(data.get("blocked_reasons") or [])
    blocked_reason = blocked_reasons[0] if blocked_reasons else None
    return ChatToolEvent(
        tool_id="odoo_primary",
        status="blocked" if "blocked_reasons" in data else "failed",
        operation=operation,
        summary=tool_response.message,
        blocked_reason=blocked_reason,
        payload={
            "request": request_payload,
            "response": data,
            "execution_truth": {
                "status": "blocked" if "blocked_reasons" in data else "failed",
                "operation": operation,
                "date_from": request_payload.get("date_from"),
                "date_to": request_payload.get("date_to"),
                "company_id": request_payload.get("company_id"),
                "company_ids": request_payload.get("company_ids"),
                "company_name_terms": request_payload.get("company_name_terms"),
                "company_scope_lock": request_payload.get("company_scope_lock"),
                "company_scope_lock_canonical": request_payload.get("company_scope_lock_canonical"),
                "scope_enforced": request_payload.get("scope_enforced"),
            },
        },
        latency_ms=tool_response.latency_ms,
    )


def _tool_result_content_for_llm(event: ChatToolEvent) -> str:
    payload = event.model_dump()
    text = json.dumps(payload, indent=2, sort_keys=True, default=str)
    if len(text) <= _TOOL_RESULT_MAX_CHARS:
        return text
    trim = "\n...[truncated]...\n"
    return text[: _TOOL_RESULT_MAX_CHARS - len(trim)] + trim


def external_citations_for_tool_events(events: list[ChatToolEvent]) -> list[dict[str, Any]]:
    """Mirror agent_ingress `_tool_citation_from_event` for Odoo tool rows."""
    out: list[dict[str, Any]] = []
    for event in events:
        if event.tool_id != "odoo_primary":
            continue
        artifact_type = {
            "preview": "tool_preview",
            "blocked": "tool_blocked",
            "failed": "tool_failed",
            "executed": "tool_result",
            "planned": "tool_planned",
        }.get(event.status, "tool_result")
        label = event.operation or event.tool_id
        out.append(
            {
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
        )
    return out


def _merge_usage(
    current: dict[str, int | bool] | None,
    new: dict[str, int | bool] | None,
) -> dict[str, int | bool] | None:
    if new is None:
        return current
    if current is None:
        return dict(new)
    pt = int(current.get("prompt_tokens") or 0) + int(new.get("prompt_tokens") or 0)
    ct = int(current.get("completion_tokens") or 0) + int(new.get("completion_tokens") or 0)
    tt = int(current.get("total_tokens") or 0) + int(new.get("total_tokens") or 0)
    if tt == 0 and (pt or ct):
        tt = pt + ct
    return normalize_provider_usage_dict(
        prompt_tokens=pt,
        completion_tokens=ct,
        total_tokens=tt,
    )


def run_odoo_agentic_tool_loop(
    session: Session,
    *,
    agent_id: str,
    connection: ConnectionRecord,
    system_prompt: str,
    user_prompt: str,
    model_id: str | None,
    temperature: float,
    max_tokens: int | None,
    tool_overrides: dict[str, bool] | None,
    trace_id: str | None,
    max_iterations: int,
) -> tuple[LlmCompletionResult, list[ChatToolEvent]]:
    """Run chat.completions with `odoo_execute` until the model finishes or max_iterations."""
    pc = _merge_provider_connection(connection)
    resolved_model = _normalize_provider_model_id(pc.provider, model_id, settings.app_default_chat_model)
    client = _build_openai_compatible_client(pc)
    full_system = (system_prompt or "").strip() + ODOO_AGENTIC_SYSTEM_SUFFIX
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": full_system},
        {"role": "user", "content": user_prompt},
    ]
    tool_events: list[ChatToolEvent] = []
    total_usage: dict[str, int | bool] | None = None
    last_text = ""

    def _one_completion() -> Any:
        kwargs: dict[str, Any] = {
            "model": resolved_model,
            "messages": messages,
            "tools": [ODOO_EXECUTE_TOOL_SPEC],
            "tool_choice": "auto",
            "temperature": temperature,
            "stream": False,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        return client.chat.completions.create(**kwargs)

    iteration = 0
    while iteration < max_iterations:
        iteration += 1
        t0 = time.perf_counter()

        def _run_call() -> Any:
            return _one_completion()

        if trace_id:
            response = wrap_outbound_call(
                trace_id=trace_id,
                service="agent-ingress",
                route="odoo_agentic.chat_completions",
                fn=_run_call,
            )
        else:
            response = _run_call()

        usage = _extract_openai_chat_usage(response)
        total_usage = _merge_usage(total_usage, usage)
        choice = response.choices[0] if response.choices else None
        msg = choice.message if choice else None
        if msg is None:
            break

        # Include null `content` when tool_calls are present (OpenAI expects explicit null).
        raw_msg = msg.model_dump()
        messages.append(raw_msg)

        tool_calls = getattr(msg, "tool_calls", None) or []
        if not tool_calls:
            last_text = (getattr(msg, "content", None) or "").strip()
            if trace_id:
                log_instant_event(
                    trace_id=trace_id,
                    service="agent-ingress",
                    route="odoo_agentic.finish",
                    status="ok",
                    details={"iteration": iteration, "latency_ms": int((time.perf_counter() - t0) * 1000)},
                )
            return (
                LlmCompletionResult(text=last_text, openai_response_id=None, usage=total_usage),
                tool_events,
            )

        for tc in tool_calls:
            fn = getattr(tc, "function", None)
            name = getattr(fn, "name", None) or ""
            args_raw = getattr(fn, "arguments", None) or "{}"
            tool_call_id = getattr(tc, "id", None) or ""
            if name != "odoo_execute":
                err_payload = {"error": "unsupported_tool", "name": name}
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": json.dumps(err_payload),
                    }
                )
                continue
            try:
                parsed = json.loads(args_raw) if isinstance(args_raw, str) else {}
            except json.JSONDecodeError as exc:
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": json.dumps({"error": "invalid_arguments_json", "detail": str(exc)}),
                    }
                )
                continue
            if not isinstance(parsed, dict):
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": json.dumps({"error": "arguments_must_be_object"}),
                    }
                )
                continue
            operation = str(parsed.get("operation") or "").strip()
            payload = parsed.get("payload")
            if not operation:
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": json.dumps({"error": "operation_required"}),
                    }
                )
                continue
            if payload is not None and not isinstance(payload, dict):
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": json.dumps({"error": "payload_must_be_object"}),
                    }
                )
                continue
            exec_payload = dict(payload or {})
            tool_response, _readiness = execute_tool_operation_for_agent(
                session,
                agent_id=agent_id,
                operation=operation,
                payload=exec_payload,
                tool_overrides=tool_overrides,
                surface="consumer_chat",
            )
            event = _chat_tool_event_from_execute(
                operation=operation,
                request_payload=exec_payload,
                tool_response=tool_response,
            )
            tool_events.append(event)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": _tool_result_content_for_llm(event),
                }
            )
            if trace_id:
                log_instant_event(
                    trace_id=trace_id,
                    service="agent-ingress",
                    route="odoo_agentic.tool_executed",
                    status="ok",
                    details={
                        "iteration": iteration,
                        "operation": operation,
                        "tool_status": event.status,
                    },
                )

    if trace_id:
        log_instant_event(
            trace_id=trace_id,
            service="agent-ingress",
            route="odoo_agentic.max_iterations",
            status="ok",
            details={"max_iterations": max_iterations},
        )
    return (
        LlmCompletionResult(
            text=last_text or "I could not finish analyzing Odoo data within the allowed tool steps.",
            openai_response_id=None,
            usage=total_usage,
        ),
        tool_events,
    )
