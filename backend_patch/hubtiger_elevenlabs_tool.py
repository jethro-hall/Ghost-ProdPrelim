from __future__ import annotations

import os
import re
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Request

try:
    from .hubtiger_elevenlabs_schemas import (
        ElevenLabsHubTigerToolRequest,
        HubTigerHealthResult,
        PublicToolResult,
    )
except ImportError:  # pragma: no cover - allows direct copy into app package
    from hubtiger_elevenlabs_schemas import (  # type: ignore
        ElevenLabsHubTigerToolRequest,
        HubTigerHealthResult,
        PublicToolResult,
    )

router = APIRouter(prefix="/api/elevenlabs/hubtiger", tags=["elevenlabs-hubtiger"])

FUNCTION_ALIASES = {
    "lookup_job": "job_lookup",
    "job_lookup": "job_lookup",
    "booking_availability": "availability_lookup",
    "availability_lookup": "availability_lookup",
    "quote_preview": "quote_preview",
    "preview_quote": "quote_preview",
    "booking_create": "booking_create",
    "create_booking": "booking_create",
    "quote_add_line_item": "quote_add_line_item",
    "add_quote_line_item": "quote_add_line_item",
}

READ_OPERATIONS = {"job_lookup", "availability_lookup", "quote_preview"}
WRITE_OPERATIONS = {"booking_create", "quote_add_line_item"}

SECRET_KEYS = {
    "token",
    "access_token",
    "refresh_token",
    "password",
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-ghost-voice-key",
}


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _configured_secret() -> str | None:
    value = _env("ELEVENLABS_HUBTIGER_WEBHOOK_SECRET")
    return value or None


def _bearer_value(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if value.lower().startswith("bearer "):
        return value[7:].strip()
    return None


def _require_auth(
    x_ghost_voice_key: str | None = Header(default=None, alias="X-Ghost-Voice-Key"),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> None:
    expected = _configured_secret()
    if not expected:
        raise HTTPException(status_code=503, detail="ElevenLabs HubTiger webhook secret is not configured.")
    supplied = (x_ghost_voice_key or "").strip() or _bearer_value(authorization)
    if supplied != expected:
        raise HTTPException(status_code=401, detail="Unauthorised")


def _access_mode() -> str:
    return _env("HUBTIGER_TOOL_ACCESS", "read_only").lower() or "read_only"


def _read_timeout_seconds() -> float:
    raw = _env("HUBTIGER_READ_TIMEOUT_MS", "2500")
    try:
        return max(0.5, min(10.0, int(raw) / 1000.0))
    except ValueError:
        return 2.5


def _mcp_url() -> str:
    return _env("HUBTIGER_MCP_URL", "http://hubtiger-mcp:8000").rstrip("/")


def _normalise_phone(value: str | None) -> str | None:
    if not value:
        return None
    digits = re.sub(r"\D+", "", value)
    if not digits:
        return None
    if digits.startswith("61") and len(digits) >= 10:
        return "+" + digits
    if digits.startswith("0") and len(digits) == 10:
        return "+61" + digits[1:]
    if len(digits) == 9 and digits.startswith("4"):
        return "+61" + digits
    return value.strip()


def _safe_str(value: Any, max_len: int = 600) -> str:
    if value is None:
        return ""
    text = str(value)
    if len(text) > max_len:
        return text[: max_len - 1] + "..."
    return text


def _redact(value: Any, max_field_chars: int | None = None) -> Any:
    if max_field_chars is None:
        try:
            max_field_chars = int(_env("HUBTIGER_MAX_FIELD_CHARS", "600"))
        except ValueError:
            max_field_chars = 600

    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            key_str = str(key)
            if key_str.lower() in SECRET_KEYS or "token" in key_str.lower() or "password" in key_str.lower():
                out[key_str] = "[redacted]"
            else:
                out[key_str] = _redact(item, max_field_chars=max_field_chars)
        return out
    if isinstance(value, list):
        try:
            max_rows = int(_env("HUBTIGER_MAX_ROWS", "5"))
        except ValueError:
            max_rows = 5
        return [_redact(item, max_field_chars=max_field_chars) for item in value[:max_rows]]
    if isinstance(value, str):
        return _safe_str(value, max_field_chars)
    return value


def _safe_result(
    *,
    success: bool,
    public_message: str,
    data: dict[str, Any] | None = None,
    error_code: str | None = None,
    retryable: bool = False,
) -> PublicToolResult:
    return PublicToolResult(
        success=success,
        public_message=public_message,
        data=_redact(data or {}),
        error_code=error_code,
        retryable=retryable,
    )


def _normalise_request(req: ElevenLabsHubTigerToolRequest) -> tuple[str, dict[str, Any]]:
    requested = (req.function or req.operation or "").strip().lower()
    operation = FUNCTION_ALIASES.get(requested)
    if not operation:
        raise HTTPException(status_code=422, detail=f"Unsupported HubTiger function: {requested}")

    if operation in WRITE_OPERATIONS and _access_mode() != "read_write":
        raise HTTPException(status_code=403, detail="hubtiger_read_only_mode")

    customer = req.customer.model_dump(exclude_none=True)
    if customer.get("phone"):
        customer["phone"] = _normalise_phone(customer["phone"])

    payload = dict(req.payload or {})
    if req.store:
        payload.setdefault("store", req.store.strip().lower())
    if req.date:
        payload.setdefault("date", req.date)
    if req.start_date:
        payload.setdefault("start_date", req.start_date)
    if req.end_date:
        payload.setdefault("end_date", req.end_date)
    if customer:
        payload.setdefault("customer", customer)
        for key, val in customer.items():
            payload.setdefault(key, val)

    if operation == "job_lookup":
        has_identifier = bool(payload.get("job_id") or customer.get("phone") or (customer.get("first_name") and customer.get("last_name")))
        if not has_identifier:
            raise HTTPException(status_code=422, detail="lookup_job requires phone, job_id, or first_name and last_name")

    if operation == "availability_lookup":
        if not req.store:
            raise HTTPException(status_code=422, detail="booking_availability requires store")
        if not (req.start_date or req.date or payload.get("start_date") or payload.get("date")):
            raise HTTPException(status_code=422, detail="booking_availability requires start_date or date")

    if operation == "quote_preview":
        if not (payload.get("job_id") or payload.get("service_id")):
            raise HTTPException(status_code=422, detail="quote_preview requires job_id or service_id")
        if not payload.get("search"):
            raise HTTPException(status_code=422, detail="quote_preview requires search")

    return operation, payload


def _build_execute_payload(operation: str, payload: dict[str, Any], trace_id: str) -> dict[str, Any]:
    return {
        "operation": operation,
        "payload": payload,
        "trace_id": trace_id,
        "source": "elevenlabs_magic_mike",
    }


def _shape_lookup_response(raw: dict[str, Any]) -> PublicToolResult:
    data = _redact(raw)

    # Prefer upstream public message if present and safe.
    msg = raw.get("public_message") or raw.get("message")
    if isinstance(msg, str) and msg.strip():
        return _safe_result(success=True, public_message=_safe_str(msg, 300), data=data)

    # Generic message lookup phrasing for Magic Mike.
    return _safe_result(
        success=True,
        public_message="I found the matching Ride Electric record.",
        data=data,
    )


async def _call_mcp(operation: str, payload: dict[str, Any], trace_id: str) -> PublicToolResult:
    execute_payload = _build_execute_payload(operation, payload, trace_id)
    base = _mcp_url()
    timeout = _read_timeout_seconds()

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            res = await client.post(f"{base}/execute", json=execute_payload, headers={"X-Trace-Id": trace_id})
            if res.status_code == 404:
                res = await client.post(f"{base}/test", json=execute_payload, headers={"X-Trace-Id": trace_id})
            res.raise_for_status()
            raw = res.json()
        except httpx.TimeoutException:
            return _safe_result(
                success=False,
                public_message="I could not check that just now. I can put you through to the store so they can look it up directly.",
                error_code="hubtiger_timeout",
                retryable=True,
            )
        except Exception:
            return _safe_result(
                success=False,
                public_message="I could not check that just now. I can put you through to the store so they can look it up directly.",
                error_code="hubtiger_unavailable",
                retryable=True,
            )

    success = bool(raw.get("success", True))
    if not success:
        return _safe_result(
            success=False,
            public_message=_safe_str(raw.get("public_message") or "I could not check that just now. I can put you through to the store so they can look it up directly.", 300),
            data=raw,
            error_code=str(raw.get("error_code") or "hubtiger_lookup_failed"),
            retryable=bool(raw.get("retryable", True)),
        )

    if operation == "job_lookup":
        return _shape_lookup_response(raw)

    return _safe_result(
        success=True,
        public_message=_safe_str(raw.get("public_message") or raw.get("message") or "I found the matching Ride Electric information.", 300),
        data=raw,
    )


@router.get("/health", response_model=HubTigerHealthResult)
async def health(
    x_ghost_voice_key: str | None = Header(default=None, alias="X-Ghost-Voice-Key"),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> HubTigerHealthResult:
    _require_auth(x_ghost_voice_key=x_ghost_voice_key, authorization=authorization)
    return HubTigerHealthResult(
        ok=True,
        service="elevenlabs_hubtiger_tool",
        access_mode=_access_mode(),
        auth_configured=bool(_configured_secret()),
    )


@router.post("/tool", response_model=PublicToolResult)
async def hubtiger_tool(
    request: Request,
    body: ElevenLabsHubTigerToolRequest,
    x_ghost_voice_key: str | None = Header(default=None, alias="X-Ghost-Voice-Key"),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> PublicToolResult:
    start = time.perf_counter()
    _require_auth(x_ghost_voice_key=x_ghost_voice_key, authorization=authorization)
    trace_id = request.headers.get("X-Trace-Id") or uuid.uuid4().hex

    try:
        operation, payload = _normalise_request(body)
    except HTTPException as exc:
        if exc.status_code == 403 and exc.detail == "hubtiger_read_only_mode":
            return _safe_result(
                success=False,
                public_message="I can check that for you, but booking or changes are not enabled yet.",
                error_code="hubtiger_read_only_mode",
                retryable=False,
            )
        raise

    result = await _call_mcp(operation, payload, trace_id)
    result.data.setdefault("trace_id", trace_id)
    result.data.setdefault("operation", operation)
    result.data.setdefault("latency_ms", round((time.perf_counter() - start) * 1000, 1))
    return result
