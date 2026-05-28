from __future__ import annotations

import re
from typing import Any

PRODUCTION_CHAT_SURFACE = "prod_chatui"

PUBLIC_FALLBACK_TEXT = "I’ll check that with the system first so I don’t give you the wrong answer."
PUBLIC_ERROR_FALLBACK_TEXT = "I’m having trouble checking that right now. Please try again in a moment."
PUBLIC_GREETING_FALLBACK_TEXT = "I’m good, thanks. What can I help you sort out with Ride Electric?"

FORBIDDEN_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"Odoo blocked",
        # Do not match bare "Odoo": legitimate retail answers cite Odoo ERP by name.
        r"tool blocked",
        r"blocked and did not execute",
        r"\bbackend\b",
        r"\borchestrator\b",
        r"legacy_odoo_public_surface_retired",
        r"agent\.orchestrator",
        r"Scorecard",
        r"Performer Rationale",
        r"Uncertainty",
        r"Next Drill-Down",
        r"Citations",
        r"Execution Truth",
        r"Source mode",
        r"trace_id",
        r"backend error",
        r"tool failed",
        r"\btool\b.*\bblocked\b",
        r"\bsemantic\b",
        r"\bstructured\b",
        r"provided documents",
        r"grounded information",
        r"\bdatabase\b",
        r"raw[_ ]payload",
        r"system prompt",
        r"internal policy",
    )
)


def is_production_chat_surface(surface: str | None) -> bool:
    return str(surface or "").strip().casefold() == PRODUCTION_CHAT_SURFACE


def contains_forbidden_public_output(value: object) -> bool:
    text = _stringify_for_scan(value)
    return any(pattern.search(text) for pattern in FORBIDDEN_PATTERNS)


def present_public_text(text: str, *, fallback: str = PUBLIC_FALLBACK_TEXT) -> tuple[str, bool]:
    if contains_forbidden_public_output(text):
        return fallback, False
    return text, True


def present_public_chat_response_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Shape a chat response payload for the customer-facing production chat surface."""
    safe_text, safe = present_public_text(str(payload.get("answer") or ""))
    return {
        "answer": safe_text,
        "query_mode": "blended",
        "citations": [],
        "conversation_mode": payload.get("conversation_mode") or "quick",
        "workflow_mode": payload.get("workflow_mode") or "standard",
        "conversation_id": payload.get("conversation_id"),
        "agent_id": payload.get("agent_id"),
        "cached": payload.get("cached", False),
        "usage": None,
        "effective_snapshot_id": None,
        "tool_summary": [],
        "tool_events": _present_public_tool_events(payload.get("tool_events")),
        "route_decision": None,
        "docx_artifacts": payload.get("docx_artifacts") or [],
        "docx_diagnostics": [],
        "public_safe": safe,
    }


class PublicStreamPresenter:
    def __init__(self, *, enabled: bool) -> None:
        self.enabled = enabled
        self._blocked = False
        self._fallback_emitted = False
        self._pending_delta = ""
        self._holdback_chars = max(len(pattern.pattern) for pattern in FORBIDDEN_PATTERNS) + 8

    def present_event(self, payload: dict[str, Any]) -> dict[str, Any] | list[dict[str, Any]] | None:
        if not self.enabled:
            return payload

        event_type = str(payload.get("type") or "")
        if event_type == "start":
            return {
                "type": "start",
                "api_mode": payload.get("api_mode"),
                "conversation_mode": payload.get("conversation_mode") or "quick",
                "workflow_mode": payload.get("workflow_mode") or "standard",
                "query_mode": "blended",
                "citations": [],
                "conversation_id": payload.get("conversation_id"),
                "agent_id": payload.get("agent_id"),
                "cached": payload.get("cached", False),
                "tool_events": [],
                "docx_artifacts": payload.get("docx_artifacts") or [],
                "docx_diagnostics": [],
            }

        if event_type == "tool_result":
            public_event = _present_public_tool_event(payload.get("tool_event"))
            if public_event is None:
                return None
            return {"type": "tool_result", "tool_event": public_event}

        if event_type == "delta":
            if self._blocked:
                return None
            self._pending_delta += str(payload.get("delta") or "")
            if contains_forbidden_public_output(self._pending_delta):
                self._blocked = True
                self._pending_delta = ""
                if self._fallback_emitted:
                    return None
                self._fallback_emitted = True
                return {"type": "delta", "delta": PUBLIC_FALLBACK_TEXT}
            if len(self._pending_delta) <= self._holdback_chars:
                return None
            emit_delta = self._pending_delta[:-self._holdback_chars]
            self._pending_delta = self._pending_delta[-self._holdback_chars :]
            return {"type": "delta", "delta": emit_delta} if emit_delta else None

        if event_type == "done":
            done_event = {
                "type": "done",
                "citations": [],
                "conversation_mode": payload.get("conversation_mode") or "quick",
                "workflow_mode": payload.get("workflow_mode") or "standard",
                "conversation_id": payload.get("conversation_id"),
                "cached": payload.get("cached", False),
                "tool_events": _present_public_tool_events(payload.get("tool_events")),
                "docx_artifacts": payload.get("docx_artifacts") or [],
                "docx_diagnostics": [],
                "public_safe": not self._blocked,
            }
            if self._blocked or not self._pending_delta:
                return done_event
            if contains_forbidden_public_output(self._pending_delta):
                self._pending_delta = ""
                self._blocked = True
                if self._fallback_emitted:
                    done_event["public_safe"] = False
                    return done_event
                self._fallback_emitted = True
                done_event["public_safe"] = False
                return [{"type": "delta", "delta": PUBLIC_FALLBACK_TEXT}, done_event]
            pending = self._pending_delta
            self._pending_delta = ""
            return [{"type": "delta", "delta": pending}, done_event]

        if event_type == "error":
            return {"type": "error", "error": PUBLIC_ERROR_FALLBACK_TEXT}

        return None


def _present_public_tool_events(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    events: list[dict[str, Any]] = []
    for item in value:
        public_item = _present_public_tool_event(item)
        if public_item is not None:
            events.append(public_item)
    return events


def _is_internal_odoo_tool_operation_slug(operation: str) -> bool:
    """Block internal op names like ``odoo.finance.roas`` in public tool metadata only."""
    op = (operation or "").strip()
    if not op:
        return False
    return bool(re.match(r"^odoo[._]", op, re.IGNORECASE))


def _present_public_tool_event(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    tool_id = str(value.get("tool_id") or "")
    status = str(value.get("status") or "")
    operation = str(value.get("operation") or "")
    if _is_internal_odoo_tool_operation_slug(operation):
        return None
    if contains_forbidden_public_output(" ".join([tool_id, status, operation, str(value.get("summary") or ""), str(value.get("blocked_reason") or "")])):
        return None

    payload = value.get("payload")
    public_payload = _present_public_tool_payload(payload)
    if public_payload is None:
        return None
    return {
        "tool_id": _public_tool_label(tool_id),
        "status": status if status in {"planned", "preview", "executed"} else "planned",
        "operation": None,
        "summary": _safe_summary(value.get("summary")),
        "blocked_reason": None,
        "payload": public_payload or {},
        "latency_ms": None,
    }


def _present_public_tool_payload(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    response = value.get("response")
    if isinstance(response, dict):
        public: dict[str, Any] = {}
        card = response.get("chat_summary_card")
        if isinstance(card, dict) and not contains_forbidden_public_output(card):
            public["response"] = {"chat_summary_card": card}
        report = response.get("apryse_report_document")
        if isinstance(report, dict) and not contains_forbidden_public_output(report):
            public.setdefault("response", {})["apryse_report_document"] = report
        return public or None
    return None


def _public_tool_label(tool_id: str) -> str:
    if tool_id == "odoo_primary":
        return "business_data"
    if tool_id == "apryse_docs":
        return "document_render"
    return "assistant_action"


def _safe_summary(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    if contains_forbidden_public_output(value):
        return None
    return value[:240]


def _stringify_for_scan(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return " ".join(_stringify_for_scan(item) for pair in value.items() for item in pair)
    if isinstance(value, (list, tuple, set)):
        return " ".join(_stringify_for_scan(item) for item in value)
    return str(value)
