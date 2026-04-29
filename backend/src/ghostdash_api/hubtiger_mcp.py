"""GhostDash HubTiger MCP adapter — shared by control API diagnostics and ElevenLabs ingress."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, cast
from urllib.parse import urlencode

import httpx

from .schemas import HubTigerTestResponse, PublicToolResult
from .settings import get_settings

# Matches control / HubTiger MCP test console write operations.
HUBTIGER_WRITE_OPERATIONS = frozenset({"booking_create", "quote_add_line_item"})
HUBTIGER_READ_OPERATIONS = frozenset({"availability_lookup", "job_lookup", "quote_preview"})
HUBTIGER_ALLOWED_OPERATIONS = HUBTIGER_READ_OPERATIONS | HUBTIGER_WRITE_OPERATIONS

_HUBTIGER_FUNCTION_ALIASES = {
    "availability_lookup": "availability_lookup",
    "booking_availability": "availability_lookup",
    "availability": "availability_lookup",
    "hubtiger_booking_availability": "availability_lookup",
    "job_lookup": "job_lookup",
    "lookup_job": "job_lookup",
    "look_up_job": "job_lookup",
    "hubtiger_job_lookup": "job_lookup",
    "hubtiger_job_search": "job_lookup",
    "hubtiger_job_get": "job_lookup",
    "quote_preview": "quote_preview",
    "preview_quote": "quote_preview",
    "hubtiger_quote_preview": "quote_preview",
    "hubtiger_quote_preview_price": "quote_preview",
    "booking_create": "booking_create",
    "create_booking": "booking_create",
    "hubtiger_booking_create": "booking_create",
    "hubtiger_service_job_submit": "booking_create",
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

_HUBTIGER_ALLOWED_PAYLOAD_KEYS: dict[str, frozenset[str]] = {
    "availability_lookup": frozenset(
        {
            "store",
            "date",
            "start_date",
            "end_date",
            "requiredMinutes",
            "technicians",
            "limit",
        }
    ),
    "job_lookup": frozenset(
        {
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
        }
    ),
    "quote_preview": frozenset(
        {
            "serviceId",
            "service_id",
            "job_id",
            "search",
            "query",
            "quantity",
            "dryRun",
            "limit",
        }
    ),
}

# Public `data` must not include credential-like fields. Avoid matching business keys (e.g. "author") via careful patterns.
_REDACT_KEY = re.compile(
    r"(^|_)(password|secret|token|api_?key|bearer|authorization|cookie|credential|private_?key|accesstoken|refreshtoken|"
    r"auth_?header|mcp_?url|proxy_?url|xi[-_]api)(_|$)",
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
        if key in {"first_name", "last_name", "job_id", "job_card_no", "job_card", "store", "date", "start_date", "end_date"}:
            compact = _trim_text(value, max_chars=128)
            if compact:
                out[key] = compact
            continue
        if key in {"phone", "mobile"}:
            compact = _normalize_au_phone(_trim_text(value, max_chars=32))
            if compact:
                out[key] = compact
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


def _shape_public_hubtiger_data(data: dict[str, Any], *, operation: str, max_rows: int, max_matches: int, max_chars: int) -> dict[str, Any]:
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

    return shaped


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
) -> tuple[str, dict[str, Any]]:
    """Normalize minimal tool inputs into canonical HubTiger operation + payload."""
    requested = str(operation or function or "").strip().lower()
    canonical_operation = _HUBTIGER_FUNCTION_ALIASES.get(requested)
    if canonical_operation not in HUBTIGER_ALLOWED_OPERATIONS:
        raise ValueError(
            "Unsupported HubTiger function. Use one of: "
            "availability_lookup, job_lookup, quote_preview, booking_create, quote_add_line_item."
        )
    normalized_payload: dict[str, Any] = dict(payload or {})

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
        has_store = bool(str(normalized_payload.get("store") or "").strip())
        has_start_date = bool(str(normalized_payload.get("start_date") or "").strip())
        if not has_store or not has_start_date:
            raise ValueError("availability_lookup requires `store` and `start_date` (or `date`).")

    if canonical_operation == "job_lookup":
        lookup_keys = (
            "job_id",
            "phone",
            "mobile",
            "first_name",
            "last_name",
            "customer_id",
            "customer",
        )
        if not any(k in normalized_payload and normalized_payload.get(k) for k in lookup_keys):
            raise ValueError("job_lookup requires at least one customer or job identifier.")

    return canonical_operation, normalized_payload


def _parse_iso_date(value: str | None) -> date | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


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
    first_name = str(payload.get("first_name") or "").strip()
    last_name = str(payload.get("last_name") or "").strip()
    full_name = f"{first_name} {last_name}".strip()
    if full_name:
        return full_name
    customer = payload.get("customer")
    if isinstance(customer, dict):
        nested_phone = _normalize_search_phone(str(customer.get("phone") or "").strip())
        if nested_phone:
            return nested_phone
        nested_name = f"{str(customer.get('first_name') or '').strip()} {str(customer.get('last_name') or '').strip()}".strip()
        if nested_name:
            return nested_name
    return ""


def build_hubtiger_execute_request(operation: str, payload: dict[str, Any] | None) -> dict[str, Any] | None:
    """Map canonical operations to HubTiger MCP /execute contract for deterministic routing."""
    body = dict(payload or {})
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
        return request
    if operation == "job_lookup":
        job_id = str(body.get("job_id") or "").strip()
        if job_id:
            return {
                "operation": operation,
                "method": "GET",
                "proxy_path": f"/jobs/{job_id}",
                "proxy_body": {},
            }
        query = _build_job_search_query(body)
        if not query:
            return None
        return {
            "operation": operation,
            "method": "POST",
            "proxy_path": "/jobs/search",
            "proxy_body": {"q": query, "allStores": True},
        }
    if operation == "quote_preview":
        service_id = body.get("serviceId") or body.get("service_id") or body.get("job_id")
        search = str(body.get("search") or body.get("query") or "").strip()
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
                "dryRun": True,
            },
        }
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


def hubtiger_access_mode() -> str:
    s = get_settings()
    mode = str(s.hubtiger_tool_access or "read_only").strip().lower()
    return "read_write" if mode == "read_write" else "read_only"


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
    if mode == "read_only" and operation in HUBTIGER_WRITE_OPERATIONS:
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

        # Optional micro-LLM cleanup for oversized free text search; keeps deterministic routing.
        if bool(settings.hubtiger_enable_local_simple_llm) and operation in {"job_lookup", "quote_preview"}:
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

        execute_request = build_hubtiger_execute_request(operation, normalized_payload)
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
            error_message = "HubTiger endpoint returned an unavailable response."
            if execute_request:
                error_message = "HubTiger execute endpoint returned an unavailable response."
            return HubTigerMcpCallResult(
                success=False,
                blocked=False,
                mode=mode,
                operation=operation,
                message=error_message,
                trace_id=trace_id,
                data={"status_code": upstream.status_code},
                upstream_status_code=upstream.status_code,
            )
        body = upstream.json() if upstream.content else {}
        success = bool(body.get("success", body.get("ok", True)))
        message = str(body.get("message") or body.get("error") or "HubTiger call completed.")
        data = body.get("data")
        if not isinstance(data, dict):
            data = {}
            for field in ("results", "matches", "rows", "count", "status", "latency_ms"):
                if field in body:
                    data[field] = body[field]
            if "error" in body and "error" not in data:
                data["error"] = body["error"]
        shaped_data = _shape_public_hubtiger_data(
            dict(data),
            operation=operation,
            max_rows=max(1, int(settings.hubtiger_max_rows)),
            max_matches=max(1, int(settings.hubtiger_max_matches)),
            max_chars=max(128, int(settings.hubtiger_max_field_chars)),
        )
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
                    shaped_data = {
                        "truncated": True,
                        "operation": operation,
                        "message": "HubTiger result is available but was trimmed for response size.",
                    }
        except Exception:
            shaped_data = {"operation": operation}
        return HubTigerMcpCallResult(
            success=success,
            blocked=bool(body.get("blocked", False)),
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
    return PublicToolResult(
        success=result.success,
        blocked=result.blocked,
        message=result.message,
        operation=result.operation,
        data=sanitize_public_hubtiger_data(result.data) if isinstance(result.data, dict) else {},
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
