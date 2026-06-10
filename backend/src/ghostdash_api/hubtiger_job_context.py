"""Build customer-safe, LLM-ready workshop job context (SMS + mechanic messages)."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

# Mirrors scripts/hubtiger/hubtiger-proxy/index.js SERVICE_STATUS_LABELS
SERVICE_STATUS_LABELS: dict[int, str] = {
    10: "Pick Ups",
    20: "Booked In",
    30: "Waiting for Work",
    40: "Waiting - Client",
    50: "Waiting - Parts",
    60: "Same day repair",
    70: "Need Advice",
    80: "Working On",
    90: "Bike Ready",
    100: "Collected",
    110: "Deliveries",
    120: "Fitting booked in",
    130: "Fitting completed",
}

CLOSED_STATUS_CODES = frozenset({100, 130})

_SMS_IMPORTANCE_PATTERNS: list[tuple[str, str, str]] = [
    (r"\bquote\b|\bestimate\b|\bapproval\b|\bapprove\b", "critical", "quote_or_approval"),
    (r"\bdeclin(e|ed)\b", "high", "quote_declined"),
    (r"\bpick\s*up\b|\bready\b|\bcollect\b", "high", "pickup_notification"),
    (r"\bpay\b|\binvoice\b|\bpayment\b", "high", "payment_request"),
    (r"\bparts?\b.*\bdelay\b|\bwaiting\b.*\bparts\b", "high", "parts_delay"),
    (r"\bfailed\b|\bundeliver", "high", "delivery_failed"),
    (r"\?", "normal", "customer_question"),
    (r"\bfault\b|\bissue\b|\bproblem\b", "normal", "extra_fault_info"),
]

_MECHANIC_RELEVANCE_PATTERNS: list[tuple[str, str, str]] = [
    (r"\bdiagnos", "critical", "diagnosis"),
    (r"\bsafety\b|\bdanger", "critical", "safety_issue"),
    (r"\bquote\b|\bestimate\b", "high", "quote_required"),
    (r"\bparts?\b", "high", "parts_required"),
    (r"\bwaiting\b.*\bcustomer\b|\bclient\b", "high", "waiting_on_customer"),
    (r"\bready\b|\bpick\s*up\b|\bcollect\b", "high", "ready_for_pickup"),
    (r"\bdelay\b|\bback\s*order", "high", "delay_reason"),
    (r"\btest\b|\bcannot\s+reproduce", "normal", "further_testing"),
    (r"\brepair\b|\bfix\b|\bstatus\b", "normal", "repair_status"),
]

_QUOTE_STATUS_PATTERNS: list[tuple[str, str]] = [
    (r"\bawaiting\b.*\bapproval\b|\bapprove\b.*\bquote\b", "awaiting_customer"),
    (r"\bapproved\b", "approved"),
    (r"\bdeclin(e|ed)\b", "declined"),
    (r"\bquote\b.*\bsent\b|\bsent\b.*\bquote\b", "sent"),
    (r"\bquote\b", "sent"),
    (r"\bexpired\b", "expired"),
]

_CUSTOMER_ACTION_PATTERNS: list[tuple[str, str]] = [
    (r"\bapprove\b.*\bquote\b|\bquote\b.*\bapprove\b", "approve quote by SMS"),
    (r"\breply\b|\bmore\s+information\b|\bquestion\b", "reply with more information"),
    (r"\bpay\b|\binvoice\b", "pay invoice"),
    (r"\bpick\s*up\b|\bcollect\b|\bready\b", "collect vehicle"),
]

_VSETT_RE = re.compile(r"\bVSETT\b", re.IGNORECASE)


def _trim(text: Any, *, max_chars: int = 500) -> str:
    value = str(text or "").strip()
    if len(value) <= max_chars:
        return value
    return value[: max(0, max_chars - 3)] + "..."


def _parse_note_lines(value: Any) -> list[str]:
    raw = str(value or "").replace("<br/>", "\n").replace("<br>", "\n").replace("\r", "\n")
    return [line for line in (_trim(part, max_chars=2000) for part in raw.split("\n")) if line]


def _parse_timestamp(value: Any) -> str | None:
    text = _trim(value, max_chars=40)
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        return parsed.isoformat()
    except ValueError:
        return text


def _status_label(status_raw: Any, fallback: str | None = None) -> tuple[str, str | None]:
    if fallback and str(fallback).strip():
        return _trim(fallback, max_chars=80), None
    try:
        code = int(status_raw)
    except (TypeError, ValueError):
        code = None
    if code is not None and code in SERVICE_STATUS_LABELS:
        return SERVICE_STATUS_LABELS[code], None
    if status_raw is not None and str(status_raw).strip():
        return (
            "Active - exact status unclear",
            f"No customer-facing status mapping found for raw status: {status_raw}",
        )
    return "Active - exact status unclear", "No customer-facing status mapping found for raw status: unknown"


def _is_open_status(status_raw: Any, status_label: str) -> bool:
    try:
        code = int(status_raw)
    except (TypeError, ValueError):
        code = None
    if code is not None:
        return code not in CLOSED_STATUS_CODES
    lowered = status_label.lower()
    return not any(token in lowered for token in ("collected", "fitting completed", "completed"))


def speakable_vehicle_label(text: str | None) -> str | None:
    if not text:
        return None
    return _VSETT_RE.sub("Vee-set", str(text).strip())


def _classify_text(
    body: str,
    patterns: list[tuple[str, str, str]],
    *,
    default_level: str,
    default_reason: str,
) -> tuple[str, str | None]:
    lowered = body.lower()
    best_level = default_level
    best_reason: str | None = default_reason
    rank = {"low": 0, "normal": 1, "high": 2, "critical": 3}
    for pattern, level, reason in patterns:
        if re.search(pattern, lowered):
            if rank.get(level, 0) >= rank.get(best_level, 0):
                best_level = level
                best_reason = reason
    return best_level, best_reason


def _sms_direction(item: dict[str, Any]) -> str:
    raw = _trim(item.get("direction") or item.get("Direction"), max_chars=32).lower()
    if raw in {"in", "inbound", "received"}:
        return "inbound"
    if raw in {"out", "outbound", "sent"}:
        return "outbound"
    return "unknown"


def _sms_sender(direction: str, channel: str) -> str:
    if channel and channel.lower() not in {"sms", "text"}:
        return "system"
    if direction == "inbound":
        return "customer"
    if direction == "outbound":
        return "workshop"
    return "unknown"


def normalize_sms_message(item: dict[str, Any], *, max_chars: int) -> dict[str, Any]:
    body = _trim(item.get("text") or item.get("Message") or item.get("message"), max_chars=max_chars)
    direction = _sms_direction(item)
    channel = _trim(item.get("channel") or item.get("Channel"), max_chars=32) or "sms"
    importance, importance_reason = _classify_text(
        body,
        _SMS_IMPORTANCE_PATTERNS,
        default_level="normal",
        default_reason=None,
    )
    delivery = _trim(item.get("delivery_status") or item.get("Status") or item.get("status"), max_chars=32).lower()
    if delivery not in {"sent", "delivered", "failed"}:
        delivery = "unknown" if delivery else None
    return {
        "id": item.get("id") or item.get("ID"),
        "timestamp": _parse_timestamp(item.get("created_at") or item.get("CreatedDate") or item.get("createdAt")),
        "direction": direction,
        "sender": _sms_sender(direction, channel),
        "body": body,
        "delivery_status": delivery,
        "is_customer_visible": True,
        "importance": importance,
        "importance_reason": importance_reason,
    }


def normalize_mechanic_message(
    *,
    body: str,
    author: str | None,
    timestamp: str | None,
    message_id: str | None,
    is_internal: bool,
    max_chars: int,
) -> dict[str, Any]:
    trimmed = _trim(body, max_chars=max_chars)
    if is_internal:
        return {
            "id": message_id,
            "timestamp": timestamp,
            "author": author,
            "body": trimmed,
            "is_customer_safe": False,
            "customer_relevance": "low",
            "customer_relevance_reason": "internal_workshop_note",
        }
    relevance, relevance_reason = _classify_text(
        trimmed,
        _MECHANIC_RELEVANCE_PATTERNS,
        default_level="normal",
        default_reason="workshop_update",
    )
    return {
        "id": message_id,
        "timestamp": timestamp,
        "author": author,
        "body": trimmed,
        "is_customer_safe": True,
        "customer_relevance": relevance,
        "customer_relevance_reason": relevance_reason,
    }


def _extract_primary_job_row(shaped_data: dict[str, Any]) -> dict[str, Any]:
    for key in ("matches", "results", "job_cards"):
        rows = shaped_data.get(key)
        if isinstance(rows, list) and rows and isinstance(rows[0], dict):
            return dict(rows[0])
    if shaped_data.get("jobCardNo") or shaped_data.get("job_card_no") or shaped_data.get("id"):
        return dict(shaped_data)
    return {}


def _mechanic_messages_from_sources(
    row: dict[str, Any],
    raw_detail: dict[str, Any] | None,
    *,
    max_chars: int,
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    memory = raw_detail.get("memory") if isinstance(raw_detail, dict) else None
    notes = memory.get("notes") if isinstance(memory, dict) else None

    def _append_lines(lines: list[str], *, author: str, is_internal: bool, prefix: str) -> None:
        for index, line in enumerate(lines):
            if not line:
                continue
            messages.append(
                normalize_mechanic_message(
                    body=line,
                    author=author,
                    timestamp=None,
                    message_id=f"{prefix}_{index}",
                    is_internal=is_internal,
                    max_chars=max_chars,
                )
            )

    if isinstance(notes, dict):
        _append_lines(notes.get("external") or [], author="workshop", is_internal=False, prefix="assessment")
        _append_lines(notes.get("internal") or [], author="workshop", is_internal=True, prefix="internal")

    detail = raw_detail if isinstance(raw_detail, dict) else {}
    tech_notes = detail.get("Technician_Notes") or row.get("technicianNotes") or row.get("Technician_Notes")
    assessment = detail.get("InitialAssesment_Notes") or row.get("assessmentNotes") or row.get("InitialAssesment_Notes")
    internal = detail.get("PostServiceInspection_Notes") or row.get("internalNotes") or row.get("PostServiceInspection_Notes")

    if tech_notes and not any(m.get("author") == "technician" for m in messages):
        _append_lines(_parse_note_lines(tech_notes), author="technician", is_internal=False, prefix="technician")
    if assessment:
        _append_lines(_parse_note_lines(assessment), author="workshop", is_internal=False, prefix="assessment_raw")
    if internal:
        _append_lines(_parse_note_lines(internal), author="workshop", is_internal=True, prefix="inspection")

    messages.sort(key=lambda item: (item.get("timestamp") or "", item.get("id") or ""))
    return messages


def _build_sms_chain(messages: list[dict[str, Any]], *, max_chars: int) -> list[dict[str, Any]]:
    chain = [normalize_sms_message(item, max_chars=max_chars) for item in messages if isinstance(item, dict)]
    chain.sort(key=lambda item: (item.get("timestamp") or "", str(item.get("id") or "")))
    return chain


def _infer_quote_state(sms_chain: list[dict[str, Any]], job_card: dict[str, Any]) -> dict[str, Any]:
    combined = " ".join(str(item.get("body") or "") for item in sms_chain).lower()
    status_label = str(job_card.get("status_label") or "").lower()
    quote_status = "unknown"
    for pattern, status in _QUOTE_STATUS_PATTERNS:
        if re.search(pattern, combined):
            quote_status = status
            break
    if quote_status == "unknown" and "waiting - client" in status_label:
        quote_status = "awaiting_customer"

    customer_action = "unknown"
    customer_action_required = quote_status in {"sent", "awaiting_customer"}
    for pattern, action in _CUSTOMER_ACTION_PATTERNS:
        if re.search(pattern, combined):
            customer_action = action
            customer_action_required = True
            break
    if "bike ready" in status_label and customer_action == "unknown":
        customer_action = "collect vehicle"
        customer_action_required = True

    amount = job_card.get("latest_quote_amount")
    if amount is None:
        amount = job_card.get("price_estimate") or job_card.get("priceEstimate")

    return {
        "has_quote": quote_status not in {"unknown", "not_sent"},
        "quote_status": quote_status if quote_status != "unknown" else "not_sent",
        "latest_quote_amount": float(amount) if amount is not None and str(amount).strip() else None,
        "latest_quote_sent_at": None,
        "customer_action_required": customer_action_required,
        "customer_action": customer_action,
    }


def _summarize_chain(
    items: list[dict[str, Any]],
    *,
    level_key: str,
    body_key: str = "body",
    min_level: str = "high",
) -> str | None:
    rank = {"low": 0, "normal": 1, "high": 2, "critical": 3}
    threshold = rank.get(min_level, 2)
    important = [item for item in items if rank.get(str(item.get(level_key) or "normal"), 0) >= threshold]
    if not important:
        important = items[-1:] if items else []
    if not important:
        return None
    latest = important[-1]
    snippet = _trim(latest.get(body_key), max_chars=140)
    if not snippet:
        return None
    return snippet


def _build_llm_context(
    *,
    job_card: dict[str, Any],
    sms_chain: list[dict[str, Any]],
    mechanic_messages: list[dict[str, Any]],
    quote_state: dict[str, Any],
) -> dict[str, Any]:
    safe_mechanic = [m for m in mechanic_messages if m.get("is_customer_safe")]
    speakable_status = job_card.get("speakable_status") or job_card.get("status_label") or "Active"
    important_sms = _summarize_chain(
        [m for m in sms_chain if m.get("is_customer_visible")],
        level_key="importance",
    )
    important_mechanic = _summarize_chain(safe_mechanic, level_key="customer_relevance")
    pending_action = None
    if quote_state.get("customer_action_required"):
        pending_action = str(quote_state.get("customer_action") or "unknown")

    parts = [speakable_status]
    vehicle = job_card.get("vehicle_label")
    if vehicle:
        parts.append(str(vehicle))
    if important_sms:
        parts.append(f"Latest SMS: {important_sms}")
    if important_mechanic:
        parts.append(f"Workshop note: {important_mechanic}")
    if pending_action and pending_action != "none":
        parts.append(f"Customer action: {pending_action}")

    return {
        "speakable_status": speakable_status,
        "important_sms_summary": important_sms,
        "important_mechanic_message_summary": important_mechanic,
        "pending_customer_action": pending_action if pending_action not in {None, "none", "unknown"} else None,
        "next_workshop_action": _infer_next_workshop_action(job_card, mechanic_messages),
        "customer_safe_summary": ". ".join(parts)[:500],
        "do_not_say": [
            "raw status numbers",
            "database IDs",
            "internal-only mechanic shorthand",
            "private staff-only comments",
        ],
    }


def _infer_next_workshop_action(job_card: dict[str, Any], mechanic_messages: list[dict[str, Any]]) -> str | None:
    status_label = str(job_card.get("status_label") or "").lower()
    if "waiting - parts" in status_label:
        return "Workshop is waiting on parts."
    if "waiting - client" in status_label:
        return "Workshop is waiting for customer response."
    if "bike ready" in status_label:
        return "Vehicle is ready for pickup."
    for message in reversed(mechanic_messages):
        if not message.get("is_customer_safe"):
            continue
        body = str(message.get("body") or "").lower()
        if "parts" in body:
            return "Workshop is sourcing parts."
        if "test" in body:
            return "Workshop is completing further testing."
    return None


def build_job_card_section(row: dict[str, Any], raw_detail: dict[str, Any] | None) -> dict[str, Any]:
    detail = raw_detail if isinstance(raw_detail, dict) else {}
    memory_job = {}
    if isinstance(detail.get("memory"), dict) and isinstance(detail["memory"].get("job"), dict):
        memory_job = detail["memory"]["job"]

    status_raw = (
        row.get("statusCode")
        or row.get("status_code")
        or memory_job.get("statusCode")
        or detail.get("StatusID")
    )
    fallback_label = (
        row.get("statusLabel")
        or row.get("status_label")
        or row.get("status")
        or memory_job.get("statusLabel")
        or detail.get("StatusLabel")
    )
    status_label, mapping_warning = _status_label(status_raw, str(fallback_label) if fallback_label else None)
    is_open = _is_open_status(status_raw, status_label)

    bike = _trim(
        row.get("bike")
        or row.get("bikeDescription")
        or detail.get("BikeDescription")
        or memory_job.get("bike"),
        max_chars=120,
    )
    vehicle_label = speakable_vehicle_label(bike)

    booked_at = _parse_timestamp(
        row.get("scheduledDate")
        or row.get("scheduled_date")
        or memory_job.get("dateCheckedIn")
        or detail.get("DateCheckedIn")
    )
    created_at = _parse_timestamp(row.get("lastUpdated") or row.get("last_updated") or detail.get("UpdatedDate"))

    technician_name = _trim(
        row.get("technicianName")
        or row.get("technician_name")
        or detail.get("TechnicianDescription")
        or memory_job.get("technicianName"),
        max_chars=80,
    )
    technician_id = row.get("technicianId") or row.get("technician_id") or memory_job.get("technicianId")

    latest_note = ""
    for source in (
        detail.get("Technician_Notes"),
        detail.get("InitialAssesment_Notes"),
        row.get("technicianNotes"),
        row.get("assessmentNotes"),
    ):
        lines = _parse_note_lines(source)
        if lines:
            latest_note = lines[-1]
            break

    job_card = {
        "job_card_id": str(row.get("id") or detail.get("ID") or memory_job.get("id") or ""),
        "job_number": _trim(row.get("jobCardNo") or row.get("job_card_no") or detail.get("JobCardNo"), max_chars=32) or None,
        "customer_name": _trim(
            row.get("customerName")
            or row.get("customer_name")
            or detail.get("CyclistDescription"),
            max_chars=80,
        )
        or None,
        "customer_mobile": _trim(
            row.get("customerMobile")
            or row.get("phone")
            or detail.get("PhoneNumber"),
            max_chars=32,
        )
        or None,
        "vehicle_label": vehicle_label,
        "vehicle_make": None,
        "vehicle_model": None,
        "booked_at": booked_at,
        "created_at": created_at,
        "is_open": is_open,
        "status_raw": status_raw,
        "status_label": status_label,
        "assigned_mechanic": {
            "id": str(technician_id) if technician_id is not None else None,
            "name": technician_name or None,
        },
        "latest_workshop_note": _trim(latest_note, max_chars=240) or None,
        "speakable_status": status_label,
        "price_estimate": detail.get("PriceEstimate") or row.get("priceEstimate"),
    }
    if mapping_warning:
        job_card["status_mapping_warning"] = mapping_warning
    return job_card


def build_job_llm_context(
    shaped_data: dict[str, Any],
    *,
    raw_detail: dict[str, Any] | None = None,
    max_chars: int = 512,
) -> dict[str, Any]:
    row = _extract_primary_job_row(shaped_data)
    raw_messages = shaped_data.get("messages")
    messages = raw_messages if isinstance(raw_messages, list) else []
    job_card = build_job_card_section(row, raw_detail)
    sms_chain = _build_sms_chain(messages, max_chars=max_chars)
    mechanic_messages = _mechanic_messages_from_sources(row, raw_detail, max_chars=max_chars)
    quote_state = _infer_quote_state(sms_chain, job_card)
    llm_context = _build_llm_context(
        job_card=job_card,
        sms_chain=sms_chain,
        mechanic_messages=mechanic_messages,
        quote_state=quote_state,
    )
    return {
        "job_card": job_card,
        "sms_chain": sms_chain,
        "mechanic_messages": mechanic_messages,
        "quote_state": quote_state,
        "llm_context": llm_context,
        "retrieval_meta": {
            "sms_count": len(sms_chain),
            "mechanic_message_count": len(mechanic_messages),
            "important_sms_count": sum(1 for m in sms_chain if m.get("importance") in {"high", "critical"}),
            "important_mechanic_message_count": sum(
                1 for m in mechanic_messages if m.get("customer_relevance") in {"high", "critical"} and m.get("is_customer_safe")
            ),
            "job_card_id": job_card.get("job_card_id"),
            "messages_retrieved": bool(messages),
            "detail_retrieved": bool(raw_detail),
        },
    }


def sort_job_rows_for_llm(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Open jobs first, then newest booked-in / scheduled date."""

    def sort_key(row: dict[str, Any]) -> tuple[int, float]:
        status_raw = row.get("statusCode") or row.get("status_code")
        fallback = row.get("statusLabel") or row.get("status") or row.get("status_label")
        label, _ = _status_label(status_raw, str(fallback) if fallback else None)
        is_open = 0 if _is_open_status(status_raw, label) else 1
        booked_raw = (
            row.get("scheduledDate")
            or row.get("scheduled_date")
            or row.get("lastUpdated")
            or row.get("last_updated")
        )
        booked_ts = 0.0
        parsed = _parse_timestamp(booked_raw)
        if parsed:
            try:
                booked_ts = datetime.fromisoformat(parsed.replace("Z", "+00:00")).timestamp()
            except ValueError:
                booked_ts = 0.0
        return (is_open, -booked_ts)

    return sorted(rows, key=sort_key)


def log_job_context_retrieval(*, trace_id: str, operation: str, meta: dict[str, Any]) -> None:
    logger.info(
        json.dumps(
            {
                "trace_id": trace_id,
                "span_id": trace_id[:16],
                "service": "control-api",
                "route": f"hubtiger/{operation}/job_context",
                "operation": operation,
                "job_card_id": meta.get("job_card_id"),
                "retrieval_success": bool(meta.get("job_card_id")),
                "sms_count": meta.get("sms_count", 0),
                "mechanic_message_count": meta.get("mechanic_message_count", 0),
                "important_sms_count": meta.get("important_sms_count", 0),
                "important_mechanic_message_count": meta.get("important_mechanic_message_count", 0),
                "messages_retrieved": meta.get("messages_retrieved"),
                "detail_retrieved": meta.get("detail_retrieved"),
                "status": "ok",
                "error": None,
            },
            ensure_ascii=True,
        )
    )
