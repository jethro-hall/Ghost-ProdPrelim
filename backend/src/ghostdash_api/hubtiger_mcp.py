"""GhostDash HubTiger MCP adapter — shared by control API diagnostics and ElevenLabs ingress."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlencode

import httpx

from .hubtiger_job_context import (
    build_job_llm_context,
    log_job_context_retrieval,
    sort_job_rows_for_llm,
    speakable_vehicle_label,
)
from .schemas import HubTigerTestResponse, PublicToolResult
from .settings import get_settings

# Matches control / HubTiger MCP test console write operations.
HUBTIGER_WRITE_OPERATIONS = frozenset(
    {
        "booking_create",
        "booking_finalize",
        "booking_submit",
        "booking_update",
        "quote_add_line_item",
        "booking_customer_confirm",
        "booking_bike_confirm",
    }
)
HUBTIGER_HUMAN_REVIEW_OPERATIONS = frozenset(
    {"booking_create", "booking_finalize", "booking_submit", "booking_update", "quote_add_line_item"}
)
HUBTIGER_SCHEDULE_PREFLIGHT_OPERATIONS = frozenset({"booking_create", "booking_update"})
HUBTIGER_BOOKING_STAGE_READ_OPERATIONS = frozenset(
    {"booking_slot_hold", "booking_customer_search", "booking_bike_list", "booking_service_set"}
)
HUBTIGER_PUBLIC_PENDING_BOOKING_MESSAGE = (
    "I've sent that to our workshop team to confirm. You'll get SMS once it's locked in."
)
HUBTIGER_READ_OPERATIONS = frozenset(
    {"availability_lookup", "job_lookup", "job_search", "job_retrieve", "quote_preview", "customer_search"}
)
HUBTIGER_ALLOWED_OPERATIONS = HUBTIGER_READ_OPERATIONS | HUBTIGER_WRITE_OPERATIONS | HUBTIGER_BOOKING_STAGE_READ_OPERATIONS

_HUBTIGER_FUNCTION_ALIASES = {
    "availability_lookup": "availability_lookup",
    "booking_availability": "availability_lookup",
    "availability": "availability_lookup",
    "hubtiger_booking_availability": "availability_lookup",
    "job_lookup": "job_lookup",
    "job_search": "job_search",
    "search_jobs": "job_search",
    "job_retrieve": "job_retrieve",
    "retrieve_job": "job_retrieve",
    "lookup_job": "job_lookup",
    "look_up_job": "job_lookup",
    "hubtiger_job_lookup": "job_lookup",
    "hubtiger_job_search": "job_search",
    "hubtiger_job_get": "job_retrieve",
    "quote_preview": "quote_preview",
    "preview_quote": "quote_preview",
    "hubtiger_quote_preview": "quote_preview",
    "hubtiger_quote_preview_price": "quote_preview",
    "customer_search": "customer_search",
    "hubtiger_customer_search": "customer_search",
    "customer_lookup_by_phone": "customer_search",
    "booking_create": "booking_create",
    "create_booking": "booking_create",
    "hubtiger_booking_create": "booking_create",
    "hubtiger_service_job_submit": "booking_create",
    "booking_finalize": "booking_finalize",
    "hubtiger_booking_finalize": "booking_finalize",
    "booking_submit": "booking_submit",
    "hubtiger_booking_submit": "booking_submit",
    "booking_service_set": "booking_service_set",
    "hubtiger_booking_service": "booking_service_set",
    "booking_slot_hold": "booking_slot_hold",
    "hubtiger_booking_slot": "booking_slot_hold",
    "booking_customer_search": "booking_customer_search",
    "hubtiger_booking_customer_search": "booking_customer_search",
    "booking_customer_confirm": "booking_customer_confirm",
    "hubtiger_booking_customer_confirm": "booking_customer_confirm",
    "booking_bike_list": "booking_bike_list",
    "hubtiger_booking_bike_list": "booking_bike_list",
    "booking_bike_confirm": "booking_bike_confirm",
    "hubtiger_booking_bike_confirm": "booking_bike_confirm",
    "booking_update": "booking_update",
    "update_booking": "booking_update",
    "edit_booking": "booking_update",
    "hubtiger_booking_update": "booking_update",
    "quote_add_line_item": "quote_add_line_item",
    "add_quote_line_item": "quote_add_line_item",
    "hubtiger_quote_add_line_item": "quote_add_line_item",
    "quote_find_add": "quote_add_line_item",
}

_STORE_ALIASES = {
    "brisbane newstead": "brisbane",
    "newstead": "brisbane",
    "southport": "southport",
    "burleigh": "burleigh",
}

_CACHE_BYPASS_ALIASES = frozenset({"no_cache", "nocache", "bypass", "fresh", "force_fresh"})

_HUBTIGER_ALLOWED_PAYLOAD_KEYS: dict[str, frozenset[str]] = {
    "availability_lookup": frozenset(
        {
            "store",
            "date",
            "start_date",
            "end_date",
            "deadline_date",
            "by_date",
            "must_complete_by",
            "days",
            "service_type",
            "scheduling_goal",
            "customer_request",
            "service_notes",
            "preferred_time",
            "requiredMinutes",
            "technicians",
            "limit",
            "cache_mode",
        }
    ),
    "job_lookup": frozenset(
        {
            "store",
            "job_id",
            "job_card_no",
            "job_card",
            "phone",
            "mobile",
            "first_name",
            "last_name",
            "customer_id",
            "customer",
            "query",
            "q",
            "limit",
            "cache_mode",
        }
    ),
    "job_search": frozenset(
        {
            "store",
            "phone",
            "mobile",
            "first_name",
            "last_name",
            "customer_id",
            "customer",
            "query",
            "q",
            "limit",
            "cache_mode",
        }
    ),
    "job_retrieve": frozenset(
        {
            "store",
            "job_id",
            "job_card_no",
            "job_card",
            "include_messages",
            "limit",
            "cache_mode",
        }
    ),
    "quote_preview": frozenset(
        {
            "store",
            "serviceId",
            "service_id",
            "job_id",
            "search",
            "query",
            "quantity",
            "dryRun",
            "limit",
            "cache_mode",
        }
    ),
    "booking_create": frozenset(
        {
            "store",
            "ID",
            "BikeID",
            "ServiceTypes",
            "ServiceType",
            "ServiceDate",
            "serviceDate",
            "RequiredByDate",
            "required_by_date",
            "PleaseBookIn",
            "NewJobcardID",
            "Notes",
            "notes",
            "customer_notes",
            "issue_description",
            "customer_request",
            "TechnicianID",
            "technician_id",
            "technicianId",
            "firstName",
            "first_name",
            "lastName",
            "last_name",
            "mobile",
            "phone",
            "email",
            "vehicleModel",
            "vehicle_model",
            "manufacturer",
            "bike_manufacturer",
            "model",
            "bike_model",
            "service_type",
            "service_type_key",
            "serviceType",
            "serviceTypeKey",
            "needs_workshop_callback",
            "non_standard_service",
            "requiredMinutes",
            "Duration",
            "duration",
            "isBikeHere",
            "bike_is_here",
            "CouponCode",
            "PreServiceChecklist",
            "ServiceTypeQuestions",
            "CollectionInfo",
            "DeliveryInfo",
            "SelectedThirdParty",
            "SelectedThirdPartyIsResponsibileForPayment",
            "PreApprovedAmount",
            "CreatedBy",
            "BikeBay",
            "IsCollection",
            "IsDelivery",
            "sendCommunication",
            "send_communication",
            "cache_mode",
        }
    ),
    "booking_service_set": frozenset(
        {
            "booking_session_id",
            "bookingSessionId",
            "issue_description",
            "customer_request",
            "notes",
            "Notes",
            "service_type",
            "service_type_key",
            "serviceType",
            "serviceTypeKey",
            "needs_workshop_callback",
            "non_standard_service",
            "cache_mode",
        }
    ),
    "booking_submit": frozenset(
        {
            "booking_session_id",
            "bookingSessionId",
            "issue_description",
            "customer_request",
            "notes",
            "Notes",
            "service_type",
            "serviceType",
            "needs_workshop_callback",
            "sendCommunication",
            "send_communication",
            "cache_mode",
        }
    ),
    "booking_finalize": frozenset(
        {
            "store",
            "booking_session_id",
            "bookingSessionId",
            "issue_description",
            "customer_request",
            "notes",
            "Notes",
            "service_type",
            "service_type_key",
            "serviceType",
            "serviceTypeKey",
            "needs_workshop_callback",
            "non_standard_service",
            "sendCommunication",
            "send_communication",
            "cache_mode",
        }
    ),
    "booking_slot_hold": frozenset(
        {
            "store",
            "booking_session_id",
            "bookingSessionId",
            "ServiceDate",
            "service_date",
            "TechnicianID",
            "technician_id",
            "slot_label",
            "slotLabel",
            "slot_from_availability",
            "skip_slot_step",
            "cache_mode",
        }
    ),
    "booking_customer_search": frozenset(
        {
            "store",
            "booking_session_id",
            "bookingSessionId",
            "first_name",
            "firstName",
            "last_name",
            "lastName",
            "mobile",
            "phone",
            "email",
            "cache_mode",
        }
    ),
    "booking_customer_confirm": frozenset(
        {
            "booking_session_id",
            "bookingSessionId",
            "customer_id",
            "customerId",
            "create_new",
            "createNew",
            "confirm_create",
            "cache_mode",
        }
    ),
    "booking_bike_list": frozenset(
        {
            "booking_session_id",
            "bookingSessionId",
            "cache_mode",
        }
    ),
    "booking_bike_confirm": frozenset(
        {
            "booking_session_id",
            "bookingSessionId",
            "bike_id",
            "bikeId",
            "create_new",
            "createNew",
            "vehicle_model",
            "vehicleModel",
            "manufacturer",
            "bike_manufacturer",
            "model",
            "bike_model",
            "colour",
            "color",
            "year",
            "model_year",
            "cache_mode",
        }
    ),
    "booking_update": frozenset(
        {
            "store",
            "id",
            "ID",
            "job_id",
            "jobId",
            "ServiceDate",
            "RequiredByDate",
            "TechnicianID",
            "technician_id",
            "technicianId",
            "Notes",
            "StatusID",
            "BikeBay",
            "sendCommunication",
            "send_communication",
            "cache_mode",
        }
    ),
}

# Public `data` must not include credential-like fields. Avoid matching business keys (e.g. "author") via careful patterns.
_REDACT_KEY = re.compile(
    r"(^|_)(password|secret|token|api_?key|bearer|authorization|cookie|credential|private_?key|accesstoken|refreshtoken|"
    r"auth_?header|mcp_?url|proxy_?url|xi[-_]api|x[-_]?ghost[-_]?voice[-_]?key)(_|$)",
    re.IGNORECASE,
)


def _should_redact_key(key: str) -> bool:
    return bool(_REDACT_KEY.search(str(key)))


def _normalize_store(store: str | None) -> str | None:
    raw = str(store or "").strip()
    if not raw:
        return None
    key = raw.lower()
    return _STORE_ALIASES.get(key, key)


def _normalize_au_phone(phone: str | None) -> str | None:
    raw = str(phone or "").strip()
    if not raw:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits:
        return None
    if digits.startswith("0") and len(digits) == 10:
        return f"+61{digits[1:]}"
    if digits.startswith("61"):
        return f"+{digits}"
    if raw.startswith("+"):
        return raw
    return digits


def _trim_text(value: Any, *, max_chars: int) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return raw[: max(1, max_chars)]


def _normalize_digits(value: Any) -> str:
    return "".join(ch for ch in str(value or "").strip() if ch.isdigit())


def _normalize_cache_mode(value: Any) -> str | None:
    raw = _trim_text(value, max_chars=32).lower().replace("-", "_")
    if not raw:
        return None
    if raw in _CACHE_BYPASS_ALIASES:
        return "bypass"
    if raw in {"cache", "default", "prefer_cache"}:
        return "default"
    return None


def _resolve_primary_query(payload: dict[str, Any]) -> str:
    for key in ("q", "query"):
        candidate = _trim_text(payload.get(key), max_chars=128)
        if candidate:
            return candidate
    return ""


def _identifier_context(payload: dict[str, Any]) -> dict[str, Any]:
    job_card_no = _trim_text(payload.get("job_card_no") or payload.get("job_card"), max_chars=64)
    if job_card_no:
        return {"identifier_type": "job_card_no", "identifier_confidence": "exact", "identifier_value": job_card_no}

    job_id = _trim_text(payload.get("job_id"), max_chars=64)
    if job_id:
        return {"identifier_type": "job_id", "identifier_confidence": "exact", "identifier_value": job_id}

    phone = _normalize_au_phone(payload.get("phone") or payload.get("mobile"))
    if phone:
        digits = _normalize_digits(phone)
        if 0 < len(digits) < 8:
            return {
                "identifier_type": "phone_fragment",
                "identifier_confidence": "weak",
                "identifier_value": digits,
                "ambiguous_identifier": digits,
                "possible_identifier_types": ["phone_fragment", "job_card_no"],
            }
        return {"identifier_type": "phone", "identifier_confidence": "high", "identifier_value": phone}

    first_name = _trim_text(payload.get("first_name"), max_chars=64)
    last_name = _trim_text(payload.get("last_name"), max_chars=64)
    if first_name and last_name:
        return {"identifier_type": "name_full", "identifier_confidence": "medium", "identifier_value": f"{first_name} {last_name}"}
    if first_name or last_name:
        return {"identifier_type": "name_partial", "identifier_confidence": "low", "identifier_value": first_name or last_name}

    customer = payload.get("customer")
    if isinstance(customer, dict):
        nested_first = _trim_text(customer.get("first_name"), max_chars=64)
        nested_last = _trim_text(customer.get("last_name"), max_chars=64)
        nested_phone = _normalize_au_phone(customer.get("phone"))
        if nested_phone:
            digits = _normalize_digits(nested_phone)
            if 0 < len(digits) < 8:
                return {
                    "identifier_type": "phone_fragment",
                    "identifier_confidence": "weak",
                    "identifier_value": digits,
                    "ambiguous_identifier": digits,
                    "possible_identifier_types": ["phone_fragment", "job_card_no"],
                }
            return {"identifier_type": "phone", "identifier_confidence": "high", "identifier_value": nested_phone}
        if nested_first and nested_last:
            return {
                "identifier_type": "name_full",
                "identifier_confidence": "medium",
                "identifier_value": f"{nested_first} {nested_last}",
            }
        if nested_first or nested_last:
            return {"identifier_type": "name_partial", "identifier_confidence": "low", "identifier_value": nested_first or nested_last}

    primary_query = _resolve_primary_query(payload)
    if primary_query:
        if primary_query.startswith("#") and _normalize_digits(primary_query[1:]):
            return {"identifier_type": "job_card_no", "identifier_confidence": "exact", "identifier_value": primary_query}
        digits = _normalize_digits(primary_query)
        if digits and len(digits) <= 4:
            return {
                "identifier_type": "ambiguous_numeric",
                "identifier_confidence": "weak",
                "identifier_value": primary_query,
                "ambiguous_identifier": digits,
                "possible_identifier_types": ["phone_fragment", "job_card_no"],
            }
        tokens = [t for t in re.split(r"[\s,./!?;:_-]+", primary_query) if t]
        if len(tokens) == 1 and primary_query.isalpha():
            return {"identifier_type": "name_partial", "identifier_confidence": "low", "identifier_value": primary_query}
        return {"identifier_type": "query_text", "identifier_confidence": "medium", "identifier_value": primary_query}

    return {"identifier_type": "unknown", "identifier_confidence": "unknown", "identifier_value": ""}


def _clarification_envelope(
    *,
    operation: str,
    context: dict[str, Any],
    requested_store: str | None,
) -> dict[str, Any]:
    ambiguous_identifier = _trim_text(context.get("ambiguous_identifier"), max_chars=32)
    if ambiguous_identifier:
        assistant_prompt = (
            f"Is {ambiguous_identifier} the job card number or the last digits of your phone number? "
            "Please confirm job card, full phone, or full name."
        )
        allowed_actions = ["ask_identifier_type", "ask_for_phone", "ask_for_job_card", "ask_for_store"]
    else:
        assistant_prompt = (
            "I found too many possible matches. Ask for surname, phone number, store, or job card number."
            if context.get("identifier_type") == "name_partial"
            else "I need one stronger identifier. Ask for job card number, full phone, or full name."
        )
        allowed_actions = ["ask_for_last_name", "ask_for_phone", "ask_for_job_card", "ask_for_store"]
    return {
        "truncated": False,
        "operation": operation,
        "count": 0,
        "selection_required": True,
        "identified_customer": None,
        "assistant_prompt": assistant_prompt,
        "allowed_next_actions": allowed_actions,
        "store_requested": requested_store or "",
        "store_matched": "",
        "store_match": None,
        "store_verification": "unknown" if requested_store else "not_requested",
        "identifier_type": context.get("identifier_type"),
        "identifier_confidence": context.get("identifier_confidence"),
        "ambiguous_identifier": ambiguous_identifier or None,
        "possible_identifier_types": context.get("possible_identifier_types", []),
    }


def _sanitize_payload_for_operation(operation: str, payload: dict[str, Any], *, max_search_chars: int) -> dict[str, Any]:
    allowed = _HUBTIGER_ALLOWED_PAYLOAD_KEYS.get(operation)
    if not allowed:
        return dict(payload)

    out: dict[str, Any] = {}
    for key in allowed:
        if key not in payload:
            continue
        value = payload.get(key)
        if key in {"query", "q", "search"}:
            compact = _trim_text(value, max_chars=max_search_chars)
            if compact:
                out[key] = compact
            continue
        if key in {
            "first_name",
            "last_name",
            "job_id",
            "job_card_no",
            "job_card",
            "store",
            "date",
            "start_date",
            "end_date",
            "deadline_date",
            "by_date",
            "must_complete_by",
            "scheduling_goal",
            "service_type",
        }:
            compact = _trim_text(value, max_chars=128)
            if compact:
                out[key] = compact
            continue
        if key in {"customer_request", "service_notes", "preferred_time"}:
            compact = _trim_text(value, max_chars=512)
            if compact:
                out[key] = compact
            continue
        if key == "days":
            try:
                day_count = int(value)
            except (TypeError, ValueError):
                continue
            if 1 <= day_count <= 14:
                out[key] = day_count
            continue
        if key in {"phone", "mobile"}:
            compact = _normalize_au_phone(_trim_text(value, max_chars=32))
            if compact:
                out[key] = compact
            continue
        if key == "cache_mode":
            normalized = _normalize_cache_mode(value)
            if normalized:
                out[key] = normalized
            continue
        if key == "customer" and isinstance(value, dict):
            customer: dict[str, Any] = {}
            phone = _normalize_au_phone(_trim_text(value.get("phone"), max_chars=32))
            first_name = _trim_text(value.get("first_name"), max_chars=64)
            last_name = _trim_text(value.get("last_name"), max_chars=64)
            if phone:
                customer["phone"] = phone
            if first_name:
                customer["first_name"] = first_name
            if last_name:
                customer["last_name"] = last_name
            if customer:
                out[key] = customer
            continue
        out[key] = value
    return out


def _cap_list(value: Any, *, max_items: int) -> Any:
    if isinstance(value, list):
        return value[: max(1, max_items)]
    return value


def _shape_public_hubtiger_data(
    data: dict[str, Any],
    *,
    operation: str,
    max_rows: int,
    max_matches: int,
    max_chars: int,
    requested_store: str | None = None,
    identifier_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    shaped = sanitize_public_hubtiger_data(data)
    if not isinstance(shaped, dict):
        return {}

    # Prevent huge payloads for voice/tool consumers.
    list_limits = {
        "rows": max_rows,
        "results": max_matches,
        "matches": max_matches,
        "technicians": max_rows,
        "samples": max_rows,
    }
    for key, limit in list_limits.items():
        if key in shaped and isinstance(shaped[key], list):
            items = cast(list[Any], shaped[key])
            if len(items) > limit:
                shaped[f"{key}_total"] = len(items)
                shaped[key] = items[:limit]

    # Availability payloads can be very large; keep top rows + earliest.
    if operation == "availability_lookup" and isinstance(shaped.get("rows"), list):
        shaped["rows"] = _cap_list(shaped["rows"], max_items=max_rows)

    # Clamp oversized strings defensively.
    for key, value in list(shaped.items()):
        if isinstance(value, str) and len(value) > max_chars:
            shaped[key] = value[:max_chars]

    if operation in {"job_lookup", "job_search", "job_retrieve"}:
        shaped = _augment_job_lookup_data(
            shaped,
            max_matches=max_matches,
            max_chars=max_chars,
            requested_store=requested_store,
            identifier_context=identifier_context,
        )

    return shaped


def _compact_job_case_label(row: dict[str, Any], *, max_chars: int) -> str:
    customer_name = _trim_text(row.get("customerName") or row.get("customer_name"), max_chars=80)
    bike = _trim_text(row.get("bike") or row.get("bikeDescription"), max_chars=80)
    status = _trim_text(row.get("statusLabel") or row.get("status"), max_chars=48)
    job_card_no = _trim_text(row.get("jobCardNo") or row.get("job_card_no"), max_chars=32)
    parts = [part for part in (job_card_no, bike, status) if part]
    if customer_name:
        parts.insert(0, customer_name)
    label = " | ".join(parts)
    return label[: max(24, max_chars)]


def _extract_store_value(row: dict[str, Any], *, max_chars: int) -> str:
    for key in (
        "store",
        "storeName",
        "store_name",
        "branch",
        "branchName",
        "branch_name",
        "workshop",
        "workshopName",
        "workshop_name",
        "location",
    ):
        value = _trim_text(row.get(key), max_chars=max_chars)
        if value:
            return _normalize_store(value) or value
    return ""


def _augment_job_lookup_data(
    data: dict[str, Any],
    *,
    max_matches: int,
    max_chars: int,
    requested_store: str | None = None,
    identifier_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    raw_matches = data.get("matches")
    raw_results = data.get("results")
    rows = raw_matches if isinstance(raw_matches, list) else raw_results if isinstance(raw_results, list) else []
    match_rows = [row for row in rows if isinstance(row, dict)]
    if not match_rows:
        return data

    match_rows = sort_job_rows_for_llm(match_rows)
    if isinstance(raw_matches, list):
        data["matches"] = match_rows[: len(raw_matches)]
    if isinstance(raw_results, list):
        data["results"] = match_rows[: len(raw_results)]

    count = int(data.get("count") or len(match_rows))
    normalized_requested_store = _normalize_store(requested_store)
    case_options: list[dict[str, Any]] = []
    matched_stores: list[str] = []
    customer_names = [
        _trim_text(row.get("customerName") or row.get("customer_name"), max_chars=80)
        for row in match_rows
        if _trim_text(row.get("customerName") or row.get("customer_name"), max_chars=80)
    ]
    identified_customer = customer_names[0] if customer_names else "this customer"
    for row in match_rows[: max(1, max_matches)]:
        matched_store = _extract_store_value(row, max_chars=64)
        if matched_store:
            matched_stores.append(matched_store)
        bike_label = _trim_text(row.get("bike") or row.get("bikeDescription"), max_chars=80)
        option = {
            "id": row.get("id"),
            "job_card_no": _trim_text(row.get("jobCardNo") or row.get("job_card_no"), max_chars=32),
            "customer_name": _trim_text(row.get("customerName") or row.get("customer_name"), max_chars=80),
            "bike": bike_label,
            "speakable_vehicle_label": speakable_vehicle_label(bike_label),
            "status": _trim_text(row.get("statusLabel") or row.get("status"), max_chars=48),
            "is_open": row.get("isOpen") if row.get("isOpen") is not None else row.get("is_open"),
            "scheduled_date": _trim_text(row.get("scheduledDate") or row.get("scheduled_date"), max_chars=40),
            "last_updated": _trim_text(row.get("lastUpdated") or row.get("last_updated"), max_chars=40),
            "store_matched": matched_store,
        }
        option["label"] = _compact_job_case_label(option, max_chars=max_chars)
        case_options.append(option)

    context = dict(identifier_context or {})
    identifier_type = _trim_text(context.get("identifier_type"), max_chars=32) or "unknown"
    identifier_confidence = _trim_text(context.get("identifier_confidence"), max_chars=16) or "unknown"
    exact_identifier = identifier_confidence == "exact"

    unique_matched_stores = sorted({store for store in matched_stores if store})
    first_store_match = unique_matched_stores[0] if len(unique_matched_stores) == 1 else ""
    store_verification = "not_requested"
    store_match: bool | None = None
    if normalized_requested_store:
        if not unique_matched_stores:
            store_verification = "unknown"
            store_match = None
        elif all((_normalize_store(store) or store) == normalized_requested_store for store in unique_matched_stores):
            store_verification = "matched"
            store_match = True
        else:
            store_verification = "mismatch"
            store_match = False

    selection_required = count > 1
    if store_verification == "mismatch":
        selection_required = True
    elif store_verification == "unknown" and not exact_identifier:
        selection_required = True

    if store_verification == "mismatch":
        assistant_prompt = (
            f"I found {count} potential job cards, but store mismatch exists. "
            "Ask the customer to confirm the correct store or choose a listed job card."
        )
    elif selection_required:
        assistant_prompt = f"I found {count} job cards for {identified_customer}. Ask which job they are calling about."
    else:
        assistant_prompt = f"I found 1 job card for {identified_customer}. Confirm this is the correct case before continuing."
    summary = {
        "identified_customer": identified_customer[:80],
        "job_card_count": count,
        "selection_required": selection_required,
        "assistant_prompt": assistant_prompt[: max(64, max_chars)],
        "store_requested": normalized_requested_store or "",
        "store_matched": first_store_match,
        "store_match": store_match,
        "store_verification": store_verification,
        "identifier_type": identifier_type,
        "identifier_confidence": identifier_confidence,
        "identifier_value": _trim_text(context.get("identifier_value"), max_chars=64),
        "ambiguous_identifier": _trim_text(context.get("ambiguous_identifier"), max_chars=32) or None,
        "possible_identifier_types": context.get("possible_identifier_types", []),
        "allowed_next_actions": (
            ["clarify_store", "list_matching_cases"]
            if selection_required and store_verification in {"mismatch", "unknown"} and normalized_requested_store
            else ["list_matching_cases"]
        ),
        "options": case_options,
    }
    augmented = dict(data)
    augmented["job_cards"] = case_options
    augmented["case_select"] = summary
    augmented["identified_customer"] = identified_customer[:80]
    augmented["job_card_count"] = count
    augmented["store_requested"] = normalized_requested_store or ""
    augmented["store_matched"] = first_store_match
    augmented["store_match"] = store_match
    augmented["store_verification"] = store_verification
    augmented["selection_required"] = selection_required
    augmented["identifier_type"] = identifier_type
    augmented["identifier_confidence"] = identifier_confidence
    return augmented


async def _maybe_compact_query_with_local_llm(
    *,
    query: str,
    timeout_ms: int,
    max_tokens: int,
) -> str:
    settings = get_settings()
    base_url = str(settings.openai_base_url or "").strip().rstrip("/")
    model = str(settings.app_default_chat_model or "").strip()
    api_key = str(settings.openai_api_key or "").strip()
    if not base_url or not model:
        return query
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = {
        "model": model,
        "temperature": 0,
        "max_tokens": max(8, max_tokens),
        "messages": [
            {
                "role": "system",
                "content": (
                    "Extract a compact service/product lookup phrase from user text. "
                    "Return only plain text, 2-6 words, no punctuation."
                ),
            },
            {"role": "user", "content": query},
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=max(0.5, timeout_ms / 1000.0)) as client:
            response = await client.post(f"{base_url}/chat/completions", headers=headers, json=body)
        if response.status_code >= 400:
            return query
        payload = response.json() if response.content else {}
        choices = payload.get("choices") if isinstance(payload, dict) else None
        if not isinstance(choices, list) or not choices:
            return query
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = str((message or {}).get("content") or "").strip()
        return content or query
    except Exception:
        return query


def normalize_hubtiger_tool_call(
    *,
    function: str | None = None,
    operation: str | None = None,
    payload: dict[str, Any] | None = None,
    store: str | None = None,
    date: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    customer: dict[str, Any] | None = None,
    cache_mode: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """Normalize minimal tool inputs into canonical HubTiger operation + payload."""
    requested = str(operation or function or "").strip().lower()
    canonical_operation = _HUBTIGER_FUNCTION_ALIASES.get(requested)
    if canonical_operation not in HUBTIGER_ALLOWED_OPERATIONS:
        raise ValueError(
            "Unsupported HubTiger function. Use one of: "
            "availability_lookup, job_lookup, job_search, job_retrieve, quote_preview, "
            "booking_slot_hold, booking_customer_search, booking_customer_confirm, booking_bike_list, booking_bike_confirm, "
            "booking_service_set, booking_submit, booking_finalize, booking_create, booking_update, quote_add_line_item."
        )
    normalized_payload: dict[str, Any] = dict(payload or {})
    resolved_cache_mode = _normalize_cache_mode(cache_mode or normalized_payload.get("cache_mode"))
    if resolved_cache_mode == "bypass":
        normalized_payload["cache_mode"] = "bypass"

    normalized_store = _normalize_store(store)
    if normalized_store and not str(normalized_payload.get("store") or "").strip():
        normalized_payload["store"] = normalized_store

    resolved_start_date = str(start_date or date or "").strip()
    if resolved_start_date and not str(normalized_payload.get("start_date") or "").strip():
        normalized_payload["start_date"] = resolved_start_date

    resolved_end_date = str(end_date or "").strip()
    if resolved_end_date and not str(normalized_payload.get("end_date") or "").strip():
        normalized_payload["end_date"] = resolved_end_date

    customer_payload = dict(customer or {})
    phone = _normalize_au_phone(cast(str | None, customer_payload.get("phone")))
    first_name = str(customer_payload.get("first_name") or "").strip() or None
    last_name = str(customer_payload.get("last_name") or "").strip() or None
    if phone and not str(normalized_payload.get("phone") or "").strip():
        normalized_payload["phone"] = phone
    if phone and not str(normalized_payload.get("mobile") or "").strip():
        normalized_payload["mobile"] = phone
    if first_name and not str(normalized_payload.get("first_name") or "").strip():
        normalized_payload["first_name"] = first_name
    if last_name and not str(normalized_payload.get("last_name") or "").strip():
        normalized_payload["last_name"] = last_name
    if phone or first_name or last_name:
        existing_customer = normalized_payload.get("customer")
        if not isinstance(existing_customer, dict):
            existing_customer = {}
        if phone and not str(existing_customer.get("phone") or "").strip():
            existing_customer["phone"] = phone
        if first_name and not str(existing_customer.get("first_name") or "").strip():
            existing_customer["first_name"] = first_name
        if last_name and not str(existing_customer.get("last_name") or "").strip():
            existing_customer["last_name"] = last_name
        normalized_payload["customer"] = existing_customer

    if canonical_operation == "availability_lookup":
        normalized_payload = _enrich_availability_window(normalized_payload)
        has_store = bool(str(normalized_payload.get("store") or "").strip())
        has_start_date = bool(str(normalized_payload.get("start_date") or "").strip())
        has_deadline = bool(
            str(
                normalized_payload.get("end_date")
                or normalized_payload.get("deadline_date")
                or normalized_payload.get("by_date")
                or normalized_payload.get("must_complete_by")
                or ""
            ).strip()
        )
        if not has_store:
            raise ValueError("availability_lookup requires `store` (southport, brisbane, or burleigh).")
        if not has_start_date and not has_deadline:
            raise ValueError(
                "availability_lookup requires a search window: `start_date` and/or `end_date` / `deadline_date`."
            )

    if canonical_operation == "job_lookup":
        lookup_keys = (
            "job_id",
            "job_card_no",
            "job_card",
            "phone",
            "mobile",
            "first_name",
            "last_name",
            "customer_id",
            "customer",
            "query",
            "q",
        )
        if not any(k in normalized_payload and normalized_payload.get(k) for k in lookup_keys):
            raise ValueError("job_lookup requires at least one customer or job identifier.")
    if canonical_operation == "job_search":
        lookup_keys = ("phone", "mobile", "first_name", "last_name", "customer_id", "customer", "query", "q")
        if not any(k in normalized_payload and normalized_payload.get(k) for k in lookup_keys):
            raise ValueError("job_search requires a customer identifier (phone, name, or query).")
    if canonical_operation == "job_retrieve":
        retrieve_keys = ("job_id", "job_card_no", "job_card")
        if not any(k in normalized_payload and normalized_payload.get(k) for k in retrieve_keys):
            raise ValueError("job_retrieve requires `job_id`, `job_card_no`, or `job_card`.")
    if canonical_operation == "booking_update":
        id_keys = ("id", "ID", "job_id", "jobId")
        if not any(k in normalized_payload and normalized_payload.get(k) for k in id_keys):
            raise ValueError("booking_update requires one identifier: `id`, `ID`, `job_id`, or `jobId`.")
    if canonical_operation == "booking_create":
        if not _normalize_store(store) and not _normalize_store(cast(str | None, normalized_payload.get("store"))):
            raise ValueError("booking_create requires `store` (southport, brisbane, or burleigh).")
        if _is_agent_booking_payload(normalized_payload):
            agent_missing = _agent_booking_missing_fields(normalized_payload)
            if agent_missing:
                raise ValueError(
                    "booking_create requires customer booking fields: "
                    + ", ".join(agent_missing)
                )
        else:
            for required_key in ("ID", "BikeID"):
                if normalized_payload.get(required_key) in (None, ""):
                    raise ValueError(f"booking_create requires `{required_key}`.")
            service_types = normalized_payload.get("ServiceTypes") or normalized_payload.get("ServiceType")
            if not service_types:
                raise ValueError("booking_create requires `ServiceTypes` (or `ServiceType`).")
        if not _extract_booking_technician_id(normalized_payload):
            raise ValueError("booking_create requires `TechnicianID` so schedule can be validated.")
        schedule_err = _validate_booking_service_datetime(normalized_payload)
        if schedule_err:
            raise ValueError(schedule_err)
    if canonical_operation == "booking_slot_hold":
        if not _normalize_store(cast(str | None, normalized_payload.get("store"))):
            raise ValueError("booking_slot_hold requires `store` (southport, brisbane, or burleigh).")
        skip_slot = bool(
            normalized_payload.get("slot_from_availability") or normalized_payload.get("skip_slot_step")
        )
        if not skip_slot:
            if not str(normalized_payload.get("ServiceDate") or normalized_payload.get("service_date") or "").strip():
                raise ValueError("booking_slot_hold requires `ServiceDate` and `TechnicianID`, or set slot_from_availability after availability lookup.")
            schedule_err = _validate_booking_service_datetime(normalized_payload)
            if schedule_err:
                raise ValueError(schedule_err)
    if canonical_operation == "booking_customer_search":
        if not str(normalized_payload.get("booking_session_id") or normalized_payload.get("bookingSessionId") or "").strip():
            raise ValueError("booking_customer_search requires `booking_session_id` from booking_slot_hold.")
        for field in ("first_name", "last_name", "mobile"):
            key = field
            alt = "firstName" if field == "first_name" else "lastName" if field == "last_name" else "phone"
            if not str(normalized_payload.get(key) or normalized_payload.get(alt) or "").strip():
                raise ValueError(f"booking_customer_search requires `{field}`.")
    if canonical_operation in {
        "booking_customer_confirm",
        "booking_bike_list",
        "booking_bike_confirm",
        "booking_service_set",
        "booking_submit",
        "booking_finalize",
    }:
        if not str(normalized_payload.get("booking_session_id") or normalized_payload.get("bookingSessionId") or "").strip():
            raise ValueError(f"{canonical_operation} requires `booking_session_id`.")
    if canonical_operation == "booking_service_set":
        if not str(
            normalized_payload.get("issue_description")
            or normalized_payload.get("customer_request")
            or normalized_payload.get("notes")
            or normalized_payload.get("Notes")
            or ""
        ).strip():
            raise ValueError("booking_service_set requires `issue_description`.")
        if not str(normalized_payload.get("service_type") or normalized_payload.get("serviceType") or "").strip():
            raise ValueError("booking_service_set requires `service_type` (service_full or service_plus).")
    if canonical_operation == "booking_finalize":
        if not str(
            normalized_payload.get("issue_description")
            or normalized_payload.get("customer_request")
            or normalized_payload.get("notes")
            or normalized_payload.get("Notes")
            or ""
        ).strip():
            raise ValueError("booking_finalize requires `issue_description` (what the customer wants done).")
        if not str(normalized_payload.get("service_type") or normalized_payload.get("serviceType") or "").strip():
            raise ValueError("booking_finalize requires `service_type` (service_full or service_plus).")
    return canonical_operation, normalized_payload


def _parse_iso_date(value: str | None) -> date | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def _enrich_availability_window(payload: dict[str, Any]) -> dict[str, Any]:
    """Expand deadline-style requests into a concrete scan window for HubTiger MCP."""
    out = dict(payload or {})
    today = date.today()
    start = _parse_iso_date(cast(str | None, out.get("start_date") or out.get("date"))) or today
    deadline = _parse_iso_date(
        cast(
            str | None,
            out.get("deadline_date")
            or out.get("by_date")
            or out.get("must_complete_by")
            or out.get("end_date"),
        )
    )
    out["start_date"] = start.isoformat()
    if deadline and deadline >= start:
        out["end_date"] = deadline.isoformat()
        span_days = (deadline - start).days + 1
        out["days"] = max(1, min(14, span_days))
        if not str(out.get("scheduling_goal") or "").strip():
            out["scheduling_goal"] = "before_deadline"
    else:
        raw_days = out.get("days")
        try:
            day_count = int(raw_days) if raw_days is not None else 0
        except (TypeError, ValueError):
            day_count = 0
        if day_count < 1:
            out["days"] = 7
        else:
            out["days"] = max(1, min(14, day_count))
        end = start + timedelta(days=int(out["days"]) - 1)
        out.setdefault("end_date", end.isoformat())
    return out


def _extract_booking_service_date(payload: dict[str, Any]) -> str:
    for key in ("ServiceDate", "serviceDate", "scheduled_date", "start_date", "date", "RequiredByDate", "requiredByDate"):
        raw = _trim_text(payload.get(key), max_chars=40)
        if not raw:
            continue
        parsed = _parse_iso_date(raw)
        if parsed:
            return parsed.isoformat()
    return ""


def _extract_booking_technician_id(payload: dict[str, Any]) -> str:
    for key in ("TechnicianID", "technician_id", "technicianId"):
        value = payload.get(key)
        if value is None:
            continue
        raw = str(value).strip()
        if raw:
            return raw
    return ""


def _extract_required_minutes(payload: dict[str, Any]) -> int:
    for key in ("requiredMinutes", "Duration", "duration"):
        value = payload.get(key)
        if value is None:
            continue
        try:
            minutes = int(value)
        except Exception:
            continue
        if minutes > 0:
            return minutes
    return 60


def _extract_booking_datetime(payload: dict[str, Any]) -> datetime | None:
    for key in ("ServiceDate", "serviceDate", "scheduled_date", "RequiredByDate", "requiredByDate"):
        raw = _trim_text(payload.get(key), max_chars=40)
        if not raw:
            continue
        normalized = raw.replace("Z", "+00:00")
        try:
            if "T" in normalized:
                return datetime.fromisoformat(normalized)
            parsed_date = date.fromisoformat(normalized[:10])
            return datetime.combine(parsed_date, time(9, 0))
        except ValueError:
            continue
    return None


def _is_agent_booking_payload(payload: dict[str, Any]) -> bool:
    if payload.get("ID") and payload.get("BikeID"):
        service_types = payload.get("ServiceTypes") or payload.get("ServiceType")
        if service_types:
            return False
    return bool(
        payload.get("firstName")
        or payload.get("first_name")
        or payload.get("lastName")
        or payload.get("last_name")
        or payload.get("mobile")
        or payload.get("phone")
        or payload.get("vehicleModel")
        or payload.get("vehicle_model")
    )


def _agent_booking_missing_fields(payload: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if not str(payload.get("firstName") or payload.get("first_name") or "").strip():
        missing.append("first_name")
    if not str(payload.get("lastName") or payload.get("last_name") or "").strip():
        missing.append("last_name")
    if not _normalize_au_phone(cast(str | None, payload.get("mobile") or payload.get("phone"))):
        missing.append("mobile")
    vehicle = str(payload.get("vehicleModel") or payload.get("vehicle_model") or "").strip()
    manufacturer = str(payload.get("manufacturer") or payload.get("bike_manufacturer") or "").strip()
    model = str(payload.get("model") or payload.get("bike_model") or "").strip()
    if not vehicle and not (manufacturer and model):
        missing.append("vehicle_model")
    if not str(
        payload.get("Notes")
        or payload.get("notes")
        or payload.get("customer_notes")
        or payload.get("issue_description")
        or ""
    ).strip():
        missing.append("issue_description")
    if not str(payload.get("ServiceDate") or payload.get("serviceDate") or "").strip():
        missing.append("ServiceDate")
    return missing


def _validate_booking_service_datetime(payload: dict[str, Any]) -> str | None:
    service_dt = _extract_booking_datetime(payload)
    if not service_dt:
        return "booking_create requires a valid service date (`ServiceDate` or `RequiredByDate`)."
    compare_dt = service_dt.replace(tzinfo=None) if service_dt.tzinfo else service_dt
    now = datetime.now()
    if compare_dt < now + timedelta(minutes=30):
        return "Booking time must be at least 30 minutes in the future."
    if compare_dt.weekday() == 6:
        return "Bookings are available Monday to Saturday only."
    slot_minutes = compare_dt.hour * 60 + compare_dt.minute
    open_minutes = 8 * 60 + 30
    close_minutes = 17 * 60
    if slot_minutes < open_minutes or slot_minutes >= close_minutes:
        return "Bookings are available between 8:30am and 5:00pm, Monday to Saturday."
    return None


def _booking_create_requires_schedule_preflight(payload: dict[str, Any]) -> bool:
    return bool(_extract_booking_service_date(payload) and _extract_booking_technician_id(payload))


def _build_booking_preflight_payload(payload: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    store = _normalize_store(cast(str | None, payload.get("store")))
    if not store:
        return None, "booking_create requires `store` so schedule can be validated."
    service_date = _extract_booking_service_date(payload)
    if not service_date:
        return None, "booking_create requires a valid service date (`ServiceDate` or `RequiredByDate`)."
    technician_id = _extract_booking_technician_id(payload)
    if not technician_id:
        return None, "booking_create requires `TechnicianID` so schedule can be validated."
    preflight = {
        "store": store,
        "start_date": service_date,
        "end_date": service_date,
        "technicians": technician_id,
        "requiredMinutes": _extract_required_minutes(payload),
        "cache_mode": "bypass",
    }
    return preflight, None


def _unwrap_mcp_availability_data(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize MCP /execute availability payload to the slot-offer shape."""
    if not isinstance(payload, dict):
        return {}
    nested = payload.get("data")
    if isinstance(nested, dict) and any(
        key in nested
        for key in ("recommended_slot", "rows", "backup_slots", "booking_offers", "slots_by_date")
    ):
        return nested
    return payload


def _is_schedule_slot_available(data: dict[str, Any], *, technician_id: str, service_date_iso: str, required_minutes: int) -> bool:
    data = _unwrap_mcp_availability_data(data)
    target_date = str(service_date_iso or "")[:10]
    tech_digits = _normalize_digits(technician_id)

    def _slot_offer_matches(offer: dict[str, Any]) -> bool:
        if not isinstance(offer, dict):
            return False
        offer_tech = _normalize_digits(
            offer.get("TechnicianID") or offer.get("technician_id") or offer.get("technicianId") or offer.get("id")
        )
        if tech_digits and offer_tech and offer_tech != tech_digits:
            return False
        slot_raw = str(offer.get("available_slot") or offer.get("ServiceDate") or offer.get("display") or "").strip()
        if target_date and slot_raw and not slot_raw.startswith(target_date):
            return False
        return bool(slot_raw or offer_tech)

    rows = data.get("rows")
    if isinstance(rows, list) and rows:
        target_day = service_date_iso.replace("-", "")
        for row in rows:
            if not isinstance(row, dict):
                continue
            row_tech = _normalize_digits(row.get("id"))
            if tech_digits and row_tech and row_tech != tech_digits:
                continue
            row_date = _trim_text(row.get("date"), max_chars=16)
            if target_day and row_date and row_date != target_day:
                continue
            rounded = row.get("roundedAvailableTime")
            available = row.get("availableTime")
            candidate = rounded if rounded is not None else available
            try:
                minutes = int(candidate)
            except Exception:
                continue
            if minutes >= max(1, required_minutes):
                return True

    recommended = data.get("recommended_slot")
    if isinstance(recommended, dict) and _slot_offer_matches(recommended):
        return True
    for slot in data.get("backup_slots") or []:
        if isinstance(slot, dict) and _slot_offer_matches(slot):
            return True
    for slot in data.get("booking_offers") or []:
        if isinstance(slot, dict) and _slot_offer_matches(slot):
            return True
    for day in data.get("slots_by_date") or []:
        if not isinstance(day, dict):
            continue
        for slot in day.get("slots") or []:
            if isinstance(slot, dict) and _slot_offer_matches(slot):
                return True
    return False


def _build_preflight_snapshot(payload: dict[str, Any], *, slot_available: bool) -> dict[str, Any]:
    return {
        "store": _normalize_store(cast(str | None, payload.get("store"))),
        "technician_id": _extract_booking_technician_id(payload),
        "service_date": _extract_booking_service_date(payload),
        "required_minutes": _extract_required_minutes(payload),
        "slot_available": slot_available,
    }


async def _run_booking_schedule_preflight(
    *,
    client: httpx.AsyncClient,
    base_url: str,
    operation: str,
    normalized_payload: dict[str, Any],
    mode: str,
    trace_id: str,
) -> tuple[dict[str, Any] | None, HubTigerMcpCallResult | None]:
    """Validate schedule via availability_lookup. Returns (snapshot, error_result)."""
    preflight_payload, preflight_err = _build_booking_preflight_payload(normalized_payload)
    if preflight_err or not preflight_payload:
        return None, HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=mode,
            operation=operation,
            message=preflight_err or f"{operation} preflight could not be prepared.",
            trace_id=trace_id,
            data={"error_code": "booking_preflight_missing_fields"},
        )
    preflight_request = build_hubtiger_mcp_post_body("availability_lookup", preflight_payload)
    if not preflight_request:
        return None, HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=mode,
            operation=operation,
            message=f"{operation} preflight request is invalid.",
            trace_id=trace_id,
            data={"error_code": "booking_preflight_invalid"},
        )
    preflight = await client.post(f"{base_url}/execute", json=preflight_request)
    if preflight.status_code >= 400:
        return None, HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=mode,
            operation=operation,
            message="Booking schedule is unavailable right now. Please retry shortly or offer callback.",
            trace_id=trace_id,
            data={
                "error_code": "booking_preflight_unavailable",
                "status_code": preflight.status_code,
            },
            upstream_status_code=preflight.status_code,
        )
    preflight_body = preflight.json() if preflight.content else {}
    preflight_ok = bool(preflight_body.get("ok", preflight_body.get("success", False)))
    preflight_data = preflight_body.get("data") if isinstance(preflight_body, dict) else {}
    if not isinstance(preflight_data, dict):
        preflight_data = {}
    preflight_data = _unwrap_mcp_availability_data(preflight_data)
    if not preflight_ok:
        return None, HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=mode,
            operation=operation,
            message="Booking cannot proceed because schedule validation failed.",
            trace_id=trace_id,
            data={"error_code": "booking_preflight_failed"},
        )
    technician_id = _extract_booking_technician_id(normalized_payload)
    service_date_iso = _extract_booking_service_date(normalized_payload)
    required_minutes = _extract_required_minutes(normalized_payload)
    slot_available = _is_schedule_slot_available(
        preflight_data,
        technician_id=technician_id,
        service_date_iso=service_date_iso,
        required_minutes=required_minutes,
    )
    snapshot = _build_preflight_snapshot(normalized_payload, slot_available=slot_available)
    if not slot_available:
        return snapshot, HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=mode,
            operation=operation,
            message="Selected technician is not available for that store/date. Please pick another slot.",
            trace_id=trace_id,
            data={"error_code": "booking_slot_unavailable"},
        )
    return snapshot, None


def _extract_primary_job_id(data: dict[str, Any]) -> str:
    direct = _trim_text(data.get("id") or data.get("job_id") or data.get("jobId"), max_chars=64)
    if direct:
        return direct
    for key in ("matches", "results", "job_cards"):
        rows = data.get(key)
        if not isinstance(rows, list) or not rows:
            continue
        first = rows[0]
        if not isinstance(first, dict):
            continue
        candidate = _trim_text(first.get("id") or first.get("job_id") or first.get("jobId"), max_chars=64)
        if candidate:
            return candidate
    return ""


def _shape_message_item(item: dict[str, Any], *, max_chars: int) -> dict[str, Any]:
    return {
        "id": item.get("ID") or item.get("id"),
        "direction": _trim_text(item.get("Direction") or item.get("direction"), max_chars=32),
        "channel": _trim_text(item.get("Channel") or item.get("channel"), max_chars=32) or "sms",
        "created_at": _trim_text(item.get("CreatedDate") or item.get("created_at") or item.get("createdAt"), max_chars=40),
        "job_card_no": _trim_text(item.get("JobCardNo") or item.get("job_card_no"), max_chars=32),
        "phone": _trim_text(item.get("PhoneNumber") or item.get("phone"), max_chars=32),
        "text": _trim_text(item.get("Message") or item.get("message") or item.get("text"), max_chars=max_chars),
        "read": bool(item.get("MessageRead", item.get("read", False))),
    }


def _summarize_messages(messages: list[dict[str, Any]]) -> str:
    if not messages:
        return "No customer messages were found for this job."
    latest = messages[0]
    snippet = _trim_text(latest.get("text"), max_chars=120)
    direction = _trim_text(latest.get("direction"), max_chars=24) or "message"
    return f"{len(messages)} message(s). Latest {direction}: {snippet}" if snippet else f"{len(messages)} message(s) found."


def _queue_hubtiger_write_review(
    *,
    trace_id: str,
    operation: str,
    payload: dict[str, Any],
    execute_request: dict[str, Any] | None,
    preflight_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from .hubtiger_write_review import append_pending_review

    now = datetime.now(timezone.utc)
    review_id = f"ht_review_{now.strftime('%Y%m%dT%H%M%SZ')}_{trace_id[:12]}"
    entry: dict[str, Any] = {
        "review_id": review_id,
        "created_at": now.isoformat(),
        "trace_id": trace_id,
        "status": "pending_staff_review",
        "operation": operation,
        "execute_request": execute_request or {},
        "payload": payload,
    }
    if preflight_snapshot:
        entry["preflight_passed_at"] = now.isoformat()
        entry["preflight_snapshot"] = preflight_snapshot
    queue_path = append_pending_review(entry)
    return {
        "review_id": review_id,
        "review_status": "pending_staff_review",
        "customer_outcome": "pending_staff_review",
        "booking_confirmed": False,
        "review_queue_file": str(queue_path),
        "queued_execute_request": execute_request or {},
    }


def _build_job_search_query(payload: dict[str, Any]) -> str:
    def _normalize_search_phone(candidate: str) -> str:
        raw = str(candidate or "").strip()
        if not raw:
            return ""
        digits = "".join(ch for ch in raw if ch.isdigit())
        if raw.startswith("+61") and len(digits) == 11 and digits.startswith("61"):
            return f"0{digits[2:]}"
        return raw

    for key in ("phone", "mobile"):
        candidate = _normalize_search_phone(str(payload.get(key) or "").strip())
        if candidate:
            return candidate
    for key in ("job_id", "job_card_no", "job_card"):
        candidate = str(payload.get(key) or "").strip()
        if candidate:
            return candidate
    for key in ("q", "query"):
        candidate = str(payload.get(key) or "").strip()
        if candidate:
            return candidate
    first_name = str(payload.get("first_name") or "").strip()
    last_name = str(payload.get("last_name") or "").strip()
    full_name = f"{first_name} {last_name}".strip()
    if full_name:
        return full_name
    if first_name:
        return first_name
    if last_name:
        return last_name
    customer = payload.get("customer")
    if isinstance(customer, dict):
        nested_phone = _normalize_search_phone(str(customer.get("phone") or "").strip())
        if nested_phone:
            return nested_phone
        nested_name = f"{str(customer.get('first_name') or '').strip()} {str(customer.get('last_name') or '').strip()}".strip()
        if nested_name:
            return nested_name
        nested_first_name = str(customer.get("first_name") or "").strip()
        if nested_first_name:
            return nested_first_name
        nested_last_name = str(customer.get("last_name") or "").strip()
        if nested_last_name:
            return nested_last_name
    return ""


def _build_job_retrieve_query(payload: dict[str, Any]) -> str:
    for key in ("job_card_no", "job_card", "job_id"):
        candidate = str(payload.get(key) or "").strip()
        if candidate:
            return candidate
    return ""


def build_hubtiger_execute_request(operation: str, payload: dict[str, Any] | None) -> dict[str, Any] | None:
    """Map canonical operations to HubTiger MCP /execute contract for deterministic routing."""
    body = dict(payload or {})
    cache_mode = _normalize_cache_mode(body.get("cache_mode"))
    bypass_cache = cache_mode == "bypass"
    if operation == "availability_lookup":
        start = _parse_iso_date(cast(str | None, body.get("start_date"))) or _parse_iso_date(cast(str | None, body.get("date")))
        end = _parse_iso_date(cast(str | None, body.get("end_date")))
        from_date = (start or date.today()).isoformat()
        to_date = (end or ((start or date.today()) + timedelta(days=2))).isoformat()
        query: dict[str, Any] = {
            "store": str(body.get("store") or "").strip(),
            "fromDate": from_date,
            "toDate": to_date,
            "requiredMinutes": int(body.get("requiredMinutes") or 60),
        }
        technicians = body.get("technicians")
        if technicians:
            query["technicians"] = str(technicians)
        query_string = urlencode(query)
        request: dict[str, Any] = {
            "operation": operation,
            "method": "GET",
            "proxy_path": f"/availability/technicians?{query_string}" if query_string else "/availability/technicians",
            "proxy_body": {},
        }
        if bypass_cache:
            request["cache_mode"] = "bypass"
        return request
    if operation == "job_lookup":
        job_id = str(body.get("job_id") or "").strip()
        if job_id:
            request = {
                "operation": operation,
                "method": "POST",
                "proxy_path": "/jobs/search",
                "proxy_body": {"q": job_id, "allStores": True},
            }
            if bypass_cache:
                request["cache_mode"] = "bypass"
            return request
        query = _build_job_search_query(body)
        if not query:
            return None
        request = {
            "operation": operation,
            "method": "POST",
            "proxy_path": "/jobs/search",
            "proxy_body": {"q": query, "allStores": True},
        }
        if bypass_cache:
            request["cache_mode"] = "bypass"
        return request
    if operation == "job_search":
        query = _build_job_search_query(body)
        if not query:
            return None
        request = {
            "operation": operation,
            "method": "POST",
            "proxy_path": "/jobs/search",
            "proxy_body": {"q": query, "allStores": True},
        }
        if bypass_cache:
            request["cache_mode"] = "bypass"
        return request
    if operation == "job_retrieve":
        query = _build_job_retrieve_query(body)
        if not query:
            return None
        request = {
            "operation": operation,
            "method": "POST",
            "proxy_path": "/jobs/search",
            "proxy_body": {"q": query, "allStores": True},
        }
        if bypass_cache:
            request["cache_mode"] = "bypass"
        return request
    if operation == "customer_search":
        query = str(body.get("q") or body.get("phone") or body.get("mobile") or "").strip()
        if not query:
            return None
        search_type = str(body.get("type") or "phone").strip() or "phone"
        page = max(0, int(body.get("page") or 0))
        limit = max(1, min(5, int(body.get("limit") or 1)))
        query_string = urlencode({"q": query, "type": search_type, "page": page, "limit": limit})
        request = {
            "operation": operation,
            "method": "GET",
            "proxy_path": f"/customers/search?{query_string}",
            "proxy_body": {},
        }
        if bypass_cache:
            request["cache_mode"] = "bypass"
        return request
    if operation == "quote_preview":
        service_id = body.get("serviceId") or body.get("service_id") or body.get("job_id")
        search = str(body.get("search") or body.get("query") or "").strip()
        if not service_id or not search:
            return None
        request = {
            "operation": operation,
            "method": "POST",
            "proxy_path": "/quotes/find-add",
            "proxy_body": {
                "serviceId": int(service_id),
                "search": search,
                "quantity": int(body.get("quantity") or 1),
                "dryRun": True,
            },
        }
        if bypass_cache:
            request["cache_mode"] = "bypass"
        return request
    if operation == "booking_create":
        send_communication = body.pop("sendCommunication", body.pop("send_communication", None))
        proxy_path = "/bookings"
        if send_communication is not None:
            send_flag = str(send_communication).strip().lower() not in {"false", "0", "no"}
            proxy_path = f"/bookings?{urlencode({'sendCommunication': 'true' if send_flag else 'false'})}"
        if not body:
            return None
        return {
            "operation": operation,
            "method": "POST",
            "proxy_path": proxy_path,
            "proxy_body": body,
        }
    if operation == "booking_service_set":
        if not body:
            return None
        return {"operation": operation, "method": "POST", "proxy_path": "/booking/session/service", "proxy_body": body}
    if operation in {"booking_submit", "booking_finalize"}:
        send_communication = body.pop("sendCommunication", body.pop("send_communication", None))
        path_key = "/booking/session/submit" if operation == "booking_submit" else "/booking/session/finalize"
        proxy_path = path_key
        if send_communication is not None:
            send_flag = str(send_communication).strip().lower() not in {"false", "0", "no"}
            proxy_path = f"{path_key}?{urlencode({'sendCommunication': 'true' if send_flag else 'false'})}"
        if not body:
            return None
        return {
            "operation": operation,
            "method": "POST",
            "proxy_path": proxy_path,
            "proxy_body": body,
        }
    if operation == "booking_slot_hold":
        if not body:
            return None
        return {"operation": operation, "method": "POST", "proxy_path": "/booking/session/slot", "proxy_body": body}
    if operation == "booking_customer_search":
        if not body:
            return None
        return {
            "operation": operation,
            "method": "POST",
            "proxy_path": "/booking/session/customer/search",
            "proxy_body": body,
        }
    if operation == "booking_customer_confirm":
        if not body:
            return None
        return {
            "operation": operation,
            "method": "POST",
            "proxy_path": "/booking/session/customer/confirm",
            "proxy_body": body,
        }
    if operation == "booking_bike_list":
        if not body:
            return None
        return {"operation": operation, "method": "POST", "proxy_path": "/booking/session/bike/list", "proxy_body": body}
    if operation == "booking_bike_confirm":
        if not body:
            return None
        return {
            "operation": operation,
            "method": "POST",
            "proxy_path": "/booking/session/bike/confirm",
            "proxy_body": body,
        }
    if operation == "booking_update":
        send_communication = body.pop("sendCommunication", body.pop("send_communication", None))
        proxy_path = "/bookings/update"
        if send_communication is not None:
            send_flag = str(send_communication).strip().lower() not in {"false", "0", "no"}
            proxy_path = f"/bookings/update?{urlencode({'sendCommunication': 'true' if send_flag else 'false'})}"
        if not body:
            return None
        return {
            "operation": operation,
            "method": "POST",
            "proxy_path": proxy_path,
            "proxy_body": body,
        }
    if operation == "quote_add_line_item":
        service_id = body.get("serviceId") or body.get("service_id") or body.get("job_id")
        search = str(body.get("search") or body.get("query") or body.get("q") or "").strip()
        if not service_id or not search:
            return None
        return {
            "operation": operation,
            "method": "POST",
            "proxy_path": "/quotes/find-add",
            "proxy_body": {
                "serviceId": int(service_id),
                "search": search,
                "quantity": int(body.get("quantity") or 1),
                "dryRun": False,
            },
        }
    return None


def build_hubtiger_mcp_post_body(operation: str, payload: dict[str, Any] | None) -> dict[str, Any] | None:
    """Build the JSON body for hubtiger-mcp ``/execute``.

    ``availability_lookup`` must use the MCP native ``payload`` contract. Sending only
    ``proxy_path`` skips store/date on the MCP fast path and returns a false 400.
    Other operations keep the low-level proxy routing envelope.
    """
    normalized = dict(payload or {})
    if operation == "availability_lookup":
        body: dict[str, Any] = {"operation": operation, "payload": normalized}
        if _normalize_cache_mode(normalized.get("cache_mode")) == "bypass":
            body["cache_mode"] = "bypass"
        return body
    return build_hubtiger_execute_request(operation, normalized)


def hubtiger_access_mode() -> str:
    s = get_settings()
    mode = str(s.hubtiger_tool_access or "read_only").strip().lower()
    return "read_write" if mode == "read_write" else "read_only"


def hubtiger_booking_auto_execute_enabled() -> bool:
    s = get_settings()
    return bool(getattr(s, "hubtiger_booking_auto_execute", False))


def sanitize_public_hubtiger_data(value: Any) -> Any:
    """Recursively redact values whose keys may carry secrets or infrastructure details."""
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if _should_redact_key(str(k)):
                continue
            out[str(k)] = sanitize_public_hubtiger_data(v)
        return out
    if isinstance(value, list):
        return [sanitize_public_hubtiger_data(v) for v in value]
    if isinstance(value, str):
        if re.match(r"^Bearer\s+.+", value) or re.match(r"^Basic\s+.+", value):
            return "[redacted]"
        if len(value) > 200 and re.match(r"^[A-Za-z0-9+/_=-]+$", value):
            return "[redacted]"
        return value
    return value


@dataclass
class HubTigerMcpCallResult:
    success: bool
    blocked: bool
    mode: str
    operation: str
    message: str
    trace_id: str
    data: dict[str, Any]
    upstream_status_code: int | None = None


async def call_hubtiger_mcp(
    *,
    operation: str,
    payload: dict[str, Any] | None,
    trace_id: str,
) -> HubTigerMcpCallResult:
    """Call HubTiger with deterministic /execute routing and legacy /test fallback."""
    settings = get_settings()
    mode = hubtiger_access_mode()
    if mode == "read_only" and operation in HUBTIGER_WRITE_OPERATIONS and operation not in HUBTIGER_HUMAN_REVIEW_OPERATIONS:
        return HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=mode,
            operation=operation,
            message="Write operations are disabled while HubTiger runs in read-only mode.",
            trace_id=trace_id,
            data={"blocked_reason": "read_only_mode"},
        )
    base_url = str(settings.hubtiger_mcp_url or "").strip().rstrip("/")
    timeout_s = (
        int(settings.hubtiger_mutation_timeout_ms if operation in HUBTIGER_WRITE_OPERATIONS else settings.hubtiger_read_timeout_ms)
        / 1000.0
    )
    try:
        normalized_payload = _sanitize_payload_for_operation(
            operation,
            dict(payload or {}),
            max_search_chars=max(16, int(settings.hubtiger_max_search_chars)),
        )
        if operation in HUBTIGER_HUMAN_REVIEW_OPERATIONS:
            preflight_snapshot: dict[str, Any] | None = None
            needs_preflight = operation in HUBTIGER_SCHEDULE_PREFLIGHT_OPERATIONS and (
                operation == "booking_create" and _booking_create_requires_schedule_preflight(normalized_payload)
            )
            if needs_preflight:
                if not base_url:
                    return HubTigerMcpCallResult(
                        success=False,
                        blocked=True,
                        mode=mode,
                        operation=operation,
                        message="HubTiger MCP URL is not configured.",
                        trace_id=trace_id,
                        data={"configured": False, "error_code": "hubtiger_mcp_not_configured"},
                    )
                async with httpx.AsyncClient(timeout=timeout_s) as preflight_client:
                    preflight_snapshot, preflight_error = await _run_booking_schedule_preflight(
                        client=preflight_client,
                        base_url=base_url,
                        operation=operation,
                        normalized_payload=normalized_payload,
                        mode=mode,
                        trace_id=trace_id,
                    )
                if preflight_error is not None:
                    return preflight_error
            execute_request = build_hubtiger_execute_request(operation, normalized_payload)
            queued = _queue_hubtiger_write_review(
                trace_id=trace_id,
                operation=operation,
                payload=normalized_payload,
                execute_request=execute_request,
                preflight_snapshot=preflight_snapshot,
            )
            return HubTigerMcpCallResult(
                success=True,
                blocked=True,
                mode=mode,
                operation=operation,
                message=HUBTIGER_PUBLIC_PENDING_BOOKING_MESSAGE,
                trace_id=trace_id,
                data=queued,
            )
        if not base_url:
            return HubTigerMcpCallResult(
                success=False,
                blocked=False,
                mode=mode,
                operation=operation,
                message="HubTiger MCP URL is not configured.",
                trace_id=trace_id,
                data={"configured": False},
            )
        requested_store = _normalize_store(cast(str | None, normalized_payload.get("store")))
        context = _identifier_context(normalized_payload)

        if operation in {"job_lookup", "job_search"} and context.get("identifier_type") in {"name_partial", "ambiguous_numeric", "phone_fragment"}:
            clarification = _clarification_envelope(
                operation=operation,
                context=context,
                requested_store=requested_store,
            )
            return HubTigerMcpCallResult(
                success=True,
                blocked=False,
                mode=mode,
                operation=operation,
                message="Please provide one stronger identifier so I can match the correct case.",
                trace_id=trace_id,
                data=clarification,
            )

        # Optional micro-LLM cleanup for oversized free text search; keeps deterministic routing.
        if bool(settings.hubtiger_enable_local_simple_llm) and operation in {"job_lookup", "job_search", "quote_preview"}:
            query_key = "search" if operation == "quote_preview" else "query"
            fallback_key = "q" if operation == "job_lookup" else "search"
            source_query = _trim_text(normalized_payload.get(query_key) or normalized_payload.get(fallback_key), max_chars=1000)
            if len(source_query) > int(settings.hubtiger_max_search_chars):
                compact = await _maybe_compact_query_with_local_llm(
                    query=source_query,
                    timeout_ms=int(settings.hubtiger_simple_llm_timeout_ms),
                    max_tokens=int(settings.hubtiger_simple_llm_max_tokens),
                )
                compact = _trim_text(compact, max_chars=int(settings.hubtiger_max_search_chars))
                if compact:
                    normalized_payload[query_key] = compact
                    if query_key != fallback_key:
                        normalized_payload[fallback_key] = compact

        execute_request = build_hubtiger_mcp_post_body(operation, normalized_payload)
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            if execute_request:
                upstream = await client.post(
                    f"{base_url}/execute",
                    json=execute_request,
                )
            else:
                upstream = await client.post(
                    f"{base_url}/test",
                    json={"operation": operation, "payload": normalized_payload, "mode": mode, "trace_id": trace_id},
                )
        if upstream.status_code >= 400:
            error_body: dict[str, Any] = {}
            try:
                candidate_body = upstream.json() if upstream.content else {}
                if isinstance(candidate_body, dict):
                    error_body = candidate_body
            except Exception:
                error_body = {}
            if operation == "job_retrieve":
                body_data = error_body.get("data") if isinstance(error_body.get("data"), dict) else {}
                if body_data.get("business_success") is False or str(body_data.get("error_code") or "") == "hubtiger_job_retrieve_business_invalid":
                    preserved = dict(body_data)
                    preserved.setdefault("upstream_status_code", upstream.status_code)
                    return HubTigerMcpCallResult(
                        success=False,
                        blocked=False,
                        mode=mode,
                        operation=operation,
                        message=str(preserved.get("user_message") or "I could not retrieve the workshop record right now."),
                        trace_id=trace_id,
                        data=preserved,
                        upstream_status_code=upstream.status_code,
                    )
            unavailable_code = "hubtiger_unavailable"
            error_message = "HubTiger endpoint returned an unavailable response."
            if execute_request:
                error_message = "HubTiger execute endpoint returned an unavailable response."
            if operation == "availability_lookup":
                unavailable_code = "availability_lookup_unavailable_upstream"
                error_message = "Booking availability is currently unavailable from HubTiger. Please retry shortly or offer callback."
            elif operation == "quote_preview":
                unavailable_code = "quote_preview_unavailable_upstream"
                error_message = "Quote preview is currently unavailable from HubTiger. Continue safely and offer follow-up."
            return HubTigerMcpCallResult(
                success=False,
                blocked=False,
                mode=mode,
                operation=operation,
                message=error_message,
                trace_id=trace_id,
                data={"status_code": upstream.status_code, "error_code": unavailable_code},
                upstream_status_code=upstream.status_code,
            )
        body = upstream.json() if upstream.content else {}
        success = bool(body.get("success", body.get("ok", True)))
        blocked_flag = bool(body.get("blocked", False))
        message = str(
            body.get("voice_line")
            or body.get("assistant_prompt")
            or body.get("message")
            or body.get("error")
            or "HubTiger call completed."
        )
        payload_data: dict[str, Any] = {}
        raw_data = body.get("data")
        if isinstance(raw_data, dict):
            if isinstance(raw_data.get("data"), dict) and str(raw_data.get("operation") or "").strip():
                if raw_data.get("message"):
                    message = str(raw_data.get("message"))
                if raw_data.get("success") is not None:
                    success = bool(raw_data.get("success"))
                if raw_data.get("blocked") is not None:
                    blocked_flag = bool(raw_data.get("blocked"))
                op_from_envelope = str(raw_data.get("operation") or "").strip()
                if op_from_envelope:
                    operation = op_from_envelope
                payload_data = dict(raw_data.get("data") or {})
            else:
                payload_data = dict(raw_data)
        if not payload_data:
            for field in ("results", "matches", "rows", "count", "status", "latency_ms"):
                if field in body:
                    payload_data[field] = body[field]
            if "error" in body and "error" not in payload_data:
                payload_data["error"] = body["error"]
        shaped_data = _shape_public_hubtiger_data(
            dict(payload_data),
            operation=operation,
            max_rows=max(1, int(settings.hubtiger_max_rows)),
            max_matches=max(1, int(settings.hubtiger_max_matches)),
            max_chars=max(128, int(settings.hubtiger_max_field_chars)),
            requested_store=requested_store,
            identifier_context=context,
        )
        if operation == "job_retrieve":
            job_id = _extract_primary_job_id(shaped_data)
            if job_id:
                cache_mode_for_job = _normalize_cache_mode(normalized_payload.get("cache_mode"))
                if bool(normalized_payload.get("include_messages", True)):
                    messages_request: dict[str, Any] = {
                        "operation": "job_messages",
                        "method": "GET",
                        "proxy_path": f"/jobs/{job_id}/messages",
                        "proxy_body": {},
                    }
                    if cache_mode_for_job == "bypass":
                        messages_request["cache_mode"] = "bypass"
                    async with httpx.AsyncClient(timeout=timeout_s) as msg_client:
                        msg_upstream = await msg_client.post(f"{base_url}/execute", json=messages_request)
                    if msg_upstream.status_code < 400:
                        msg_body = msg_upstream.json() if msg_upstream.content else {}
                        msg_data = msg_body.get("data") if isinstance(msg_body, dict) else {}
                        if isinstance(msg_data, dict):
                            raw_messages = msg_data.get("messages")
                            shaped_messages = []
                            if isinstance(raw_messages, list):
                                shaped_messages = [
                                    _shape_message_item(item, max_chars=max(128, int(settings.hubtiger_max_field_chars)))
                                    for item in raw_messages
                                    if isinstance(item, dict)
                                ]
                            shaped_data["messages"] = shaped_messages[: max(1, int(settings.hubtiger_max_rows))]
                            shaped_data["messages_count"] = len(shaped_messages)
                            shaped_data["messages_summary"] = _summarize_messages(shaped_data["messages"])

                raw_detail: dict[str, Any] | None = None
                detail_request: dict[str, Any] = {
                    "operation": "job_get",
                    "method": "GET",
                    "proxy_path": f"/jobs/{job_id}",
                    "proxy_body": {},
                }
                if cache_mode_for_job == "bypass":
                    detail_request["cache_mode"] = "bypass"
                try:
                    async with httpx.AsyncClient(timeout=timeout_s) as detail_client:
                        detail_upstream = await detail_client.post(f"{base_url}/execute", json=detail_request)
                    if detail_upstream.status_code < 400:
                        detail_body = detail_upstream.json() if detail_upstream.content else {}
                        candidate = detail_body.get("data") if isinstance(detail_body, dict) else None
                        if isinstance(candidate, dict):
                            raw_detail = candidate
                except Exception:
                    raw_detail = None

                job_context = build_job_llm_context(
                    shaped_data,
                    raw_detail=raw_detail,
                    max_chars=max(128, int(settings.hubtiger_max_field_chars)),
                )
                shaped_data["job_context"] = job_context
                shaped_data["sms_chain"] = job_context.get("sms_chain", [])
                shaped_data["mechanic_messages"] = job_context.get("mechanic_messages", [])
                shaped_data["llm_context"] = job_context.get("llm_context", {})
                shaped_data["quote_state"] = job_context.get("quote_state", {})
                meta = job_context.get("retrieval_meta") if isinstance(job_context.get("retrieval_meta"), dict) else {}
                log_job_context_retrieval(trace_id=trace_id, operation=operation, meta=meta)
        # Hard cap to avoid oversized tool payloads in voice/chat surfaces.
        try:
            blob = json.dumps(shaped_data, ensure_ascii=True)
            max_payload_chars = max(1024, int(settings.hubtiger_max_payload_chars))
            if len(blob) > max_payload_chars:
                for key in ("rows", "results", "matches", "technicians", "samples"):
                    if key in shaped_data and isinstance(shaped_data[key], list):
                        items = cast(list[Any], shaped_data[key])
                        if len(items) > 5:
                            shaped_data[f"{key}_total"] = len(items)
                            shaped_data[key] = items[:5]
                blob = json.dumps(shaped_data, ensure_ascii=True)
                if len(blob) > max_payload_chars:
                    if operation in {"job_lookup", "job_search", "job_retrieve"}:
                        case_select = shaped_data.get("case_select") if isinstance(shaped_data, dict) else None
                        case = case_select if isinstance(case_select, dict) else {}
                        shaped_data = {
                            "truncated": True,
                            "operation": operation,
                            "message": "HubTiger result is available but was trimmed for response size.",
                            "count": int(case.get("job_card_count") or shaped_data.get("count") or 0),
                            "selection_required": bool(case.get("selection_required", True)),
                            "identified_customer": case.get("identified_customer"),
                            "assistant_prompt": case.get("assistant_prompt")
                            or "I found many matches. Ask for surname, phone, store, or job card number.",
                            "allowed_next_actions": case.get("allowed_next_actions")
                            or ["ask_for_last_name", "ask_for_phone", "ask_for_store", "ask_for_job_card"],
                            "store_requested": case.get("store_requested", ""),
                            "store_matched": case.get("store_matched", ""),
                            "store_match": case.get("store_match"),
                            "store_verification": case.get("store_verification", "unknown"),
                            "identifier_type": case.get("identifier_type", context.get("identifier_type")),
                            "identifier_confidence": case.get("identifier_confidence", context.get("identifier_confidence")),
                        }
                    else:
                        shaped_data = {
                            "truncated": True,
                            "operation": operation,
                            "message": "HubTiger result is available but was trimmed for response size.",
                        }
        except Exception:
            shaped_data = {"operation": operation}
        return HubTigerMcpCallResult(
            success=success,
            blocked=blocked_flag,
            mode=mode,
            operation=operation,
            message=message,
            trace_id=trace_id,
            data=shaped_data,
        )
    except Exception:
        return HubTigerMcpCallResult(
            success=False,
            blocked=False,
            mode=mode,
            operation=operation,
            message="HubTiger test is unavailable right now.",
            trace_id=trace_id,
            data={},
        )


def to_public_tool_result(result: HubTigerMcpCallResult) -> PublicToolResult:
    """Narrow result for ElevenLabs — no trace_id, no secret-bearing fields in data."""
    data = sanitize_public_hubtiger_data(result.data) if isinstance(result.data, dict) else {}
    if isinstance(data, dict) and str(data.get("review_status") or "") == "pending_staff_review":
        data.pop("review_queue_file", None)
        data.pop("queued_execute_request", None)
        data.setdefault("customer_outcome", "pending_staff_review")
        data.setdefault("booking_confirmed", False)
    message = result.message
    if isinstance(data, dict) and data.get("customer_outcome") == "pending_staff_review":
        message = HUBTIGER_PUBLIC_PENDING_BOOKING_MESSAGE
    success = result.success
    if result.operation == "job_retrieve" and isinstance(data, dict) and data.get("business_success") is False:
        success = False
        message = str(data.get("user_message") or message or "I could not retrieve the workshop record right now.")
    return PublicToolResult(
        success=success,
        blocked=result.blocked,
        message=message,
        operation=result.operation,
        data=data,
    )


async def approve_hubtiger_write_review(*, review_id: str, trace_id: str) -> HubTigerMcpCallResult:
    from .hubtiger_write_review import (
        HUBTIGER_WRITE_REVIEW_STATUS_APPROVED,
        HUBTIGER_WRITE_REVIEW_STATUS_EXECUTED,
        HUBTIGER_WRITE_REVIEW_STATUS_PENDING,
        append_status_event,
        get_review_entry,
    )

    entry = get_review_entry(review_id)
    if not entry:
        return HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=hubtiger_access_mode(),
            operation="write_review_approve",
            message="Write review entry was not found.",
            trace_id=trace_id,
            data={"error_code": "review_not_found", "review_id": review_id},
        )
    current_status = str(entry.get("review_status") or HUBTIGER_WRITE_REVIEW_STATUS_PENDING)
    if current_status != HUBTIGER_WRITE_REVIEW_STATUS_PENDING:
        return HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=hubtiger_access_mode(),
            operation="write_review_approve",
            message="Write review entry is not pending approval.",
            trace_id=trace_id,
            data={"error_code": "review_not_pending", "review_status": current_status},
        )
    operation = str(entry.get("operation") or "").strip()
    payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else {}
    execute_request = entry.get("execute_request") if isinstance(entry.get("execute_request"), dict) else {}
    settings = get_settings()
    base_url = str(settings.hubtiger_mcp_url or "").strip().rstrip("/")
    mode = hubtiger_access_mode()
    if operation in HUBTIGER_SCHEDULE_PREFLIGHT_OPERATIONS and (
        operation == "booking_create" or _booking_create_requires_schedule_preflight(payload)
    ):
        if not base_url:
            return HubTigerMcpCallResult(
                success=False,
                blocked=True,
                mode=mode,
                operation=operation,
                message="HubTiger MCP URL is not configured.",
                trace_id=trace_id,
                data={"configured": False},
            )
        timeout_s = int(settings.hubtiger_mutation_timeout_ms) / 1000.0
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            _, preflight_error = await _run_booking_schedule_preflight(
                client=client,
                base_url=base_url,
                operation=operation,
                normalized_payload=payload,
                mode=mode,
                trace_id=trace_id,
            )
        if preflight_error is not None:
            return preflight_error
    if hubtiger_booking_auto_execute_enabled() and mode == "read_write" and execute_request:
        result = await execute_hubtiger_mcp_request(
            execute_request=execute_request,
            trace_id=trace_id,
            operation=operation,
        )
        append_status_event(
            review_id=review_id,
            status=HUBTIGER_WRITE_REVIEW_STATUS_EXECUTED if result.success else HUBTIGER_WRITE_REVIEW_STATUS_APPROVED,
            trace_id=trace_id,
            operation=operation,
            extra={"success": result.success},
        )
        return result
    append_status_event(
        review_id=review_id,
        status=HUBTIGER_WRITE_REVIEW_STATUS_APPROVED,
        trace_id=trace_id,
        operation=operation,
    )
    return HubTigerMcpCallResult(
        success=True,
        blocked=True,
        mode=mode,
        operation=operation,
        message="Booking change approved and queued for staff replay.",
        trace_id=trace_id,
        data={
            "review_id": review_id,
            "review_status": HUBTIGER_WRITE_REVIEW_STATUS_APPROVED,
            "booking_confirmed": False,
            "customer_outcome": "approved_pending_replay",
        },
    )


async def reject_hubtiger_write_review(*, review_id: str, reason: str, trace_id: str) -> HubTigerMcpCallResult:
    from .hubtiger_write_review import (
        HUBTIGER_WRITE_REVIEW_STATUS_PENDING,
        HUBTIGER_WRITE_REVIEW_STATUS_REJECTED,
        append_status_event,
        get_review_entry,
    )

    entry = get_review_entry(review_id)
    if not entry:
        return HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=hubtiger_access_mode(),
            operation="write_review_reject",
            message="Write review entry was not found.",
            trace_id=trace_id,
            data={"error_code": "review_not_found", "review_id": review_id},
        )
    current_status = str(entry.get("review_status") or HUBTIGER_WRITE_REVIEW_STATUS_PENDING)
    if current_status != HUBTIGER_WRITE_REVIEW_STATUS_PENDING:
        return HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=hubtiger_access_mode(),
            operation="write_review_reject",
            message="Write review entry is not pending approval.",
            trace_id=trace_id,
            data={"error_code": "review_not_pending", "review_status": current_status},
        )
    operation = str(entry.get("operation") or "").strip()
    append_status_event(
        review_id=review_id,
        status=HUBTIGER_WRITE_REVIEW_STATUS_REJECTED,
        trace_id=trace_id,
        operation=operation,
        reason=reason,
    )
    return HubTigerMcpCallResult(
        success=True,
        blocked=True,
        mode=hubtiger_access_mode(),
        operation=operation,
        message="Write review request was rejected.",
        trace_id=trace_id,
        data={"review_id": review_id, "review_status": HUBTIGER_WRITE_REVIEW_STATUS_REJECTED},
    )


async def execute_hubtiger_mcp_request(
    *,
    execute_request: dict[str, Any],
    trace_id: str,
    operation: str,
) -> HubTigerMcpCallResult:
    """Replay a queued HubTiger execute request (staff approval path)."""
    settings = get_settings()
    mode = hubtiger_access_mode()
    base_url = str(settings.hubtiger_mcp_url or "").strip().rstrip("/")
    if not base_url:
        return HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=mode,
            operation=operation,
            message="HubTiger MCP URL is not configured.",
            trace_id=trace_id,
            data={"configured": False},
        )
    timeout_s = int(settings.hubtiger_mutation_timeout_ms) / 1000.0
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            upstream = await client.post(f"{base_url}/execute", json=execute_request)
        if upstream.status_code >= 400:
            return HubTigerMcpCallResult(
                success=False,
                blocked=True,
                mode=mode,
                operation=operation,
                message="HubTiger execute endpoint returned an unavailable response.",
                trace_id=trace_id,
                data={"status_code": upstream.status_code, "error_code": "hubtiger_execute_failed"},
                upstream_status_code=upstream.status_code,
            )
        body = upstream.json() if upstream.content else {}
        success = bool(body.get("success", body.get("ok", True)))
        payload_data: dict[str, Any] = {}
        raw_data = body.get("data")
        if isinstance(raw_data, dict):
            payload_data = dict(raw_data)
        return HubTigerMcpCallResult(
            success=success,
            blocked=False,
            mode=mode,
            operation=operation,
            message=str(body.get("message") or "HubTiger write completed."),
            trace_id=trace_id,
            data={
                **payload_data,
                "booking_confirmed": success,
                "customer_outcome": "booked" if success else "execute_failed",
            },
        )
    except Exception:
        return HubTigerMcpCallResult(
            success=False,
            blocked=True,
            mode=mode,
            operation=operation,
            message="HubTiger execute is unavailable right now.",
            trace_id=trace_id,
            data={"error_code": "hubtiger_execute_unavailable"},
        )


def to_hubtiger_test_response(result: HubTigerMcpCallResult) -> HubTigerTestResponse:
    return HubTigerTestResponse(
        success=result.success,
        blocked=result.blocked,
        mode=cast(Any, result.mode),
        operation=result.operation,
        message=result.message,
        trace_id=result.trace_id,
        data=result.data,
    )
