"""Shared ElevenLabs ConvAI HTTP client with redacted structured logging."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx
from fastapi import HTTPException

from ghostdash_api.settings import get_settings

logger = logging.getLogger(__name__)

ELEVENLABS_API_BASE = "https://api.elevenlabs.io"
WEBHOOK_SECRET_HEADER = "X-Ghost-Voice-Key"
WEBHOOK_SECRET_PLACEHOLDER = "SET_IN_ELEVENLABS_FROM_GHOSTDASH_ENV"
_REDACT_KEYS = frozenset({"xi-api-key", "authorization", WEBHOOK_SECRET_HEADER.lower()})


def _timeout_seconds() -> float:
    settings = get_settings()
    configured = getattr(settings, "elevenlabs_test_timeout_ms", None) or getattr(
        settings, "elevenlabs_analysis_timeout_ms", 120000
    )
    return max(10.0, float(configured or 120000) / 1000.0)


def _build_headers() -> dict[str, str]:
    key = str(get_settings().elevenlabs_api_key or "").strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail={"code": "elevenlabs_not_configured", "message": "ElevenLabs API key is not configured."},
        )
    return {"xi-api-key": key, "Content-Type": "application/json"}


def redact_value(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            key_lower = str(key).lower()
            if key_lower in _REDACT_KEYS or key_lower == "api_key":
                redacted[key] = "[REDACTED]"
            elif key_lower == "request_headers" and isinstance(item, list):
                redacted[key] = [_redact_header(header) for header in item]
            else:
                redacted[key] = redact_value(item)
        return redacted
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    return value


def _redact_header(header: Any) -> Any:
    if not isinstance(header, dict):
        return header
    name = str(header.get("name") or "").lower()
    if name == WEBHOOK_SECRET_HEADER.lower():
        return {**header, "value": WEBHOOK_SECRET_PLACEHOLDER}
    if name in {"authorization", "xi-api-key"}:
        return {**header, "value": "[REDACTED]"}
    return header


def _log_outbound(*, trace_id: str, route: str, method: str, start_ts: float, status: str, error: str | None = None) -> None:
    logger.info(
        json.dumps(
            {
                "trace_id": trace_id,
                "span_id": trace_id[:16],
                "service": "control-api",
                "route": route,
                "method": method,
                "start_ts": start_ts,
                "end_ts": time.time(),
                "latency_ms": round((time.time() - start_ts) * 1000, 3),
                "status": status,
                "error": error,
            }
        )
    )


def _upstream_error_message(response: httpx.Response) -> str:
    message = "ElevenLabs returned an upstream error."
    try:
        payload = response.json()
        if isinstance(payload, dict):
            detail = payload.get("detail")
            if isinstance(detail, dict):
                message = str(detail.get("message") or message)
            elif isinstance(detail, str):
                message = detail
            elif isinstance(detail, list):
                parts: list[str] = []
                for item in detail[:6]:
                    if isinstance(item, dict):
                        loc = ".".join(str(part) for part in (item.get("loc") or []))
                        msg = str(item.get("msg") or "").strip()
                        if loc and msg:
                            parts.append(f"{loc}: {msg}")
                        elif msg:
                            parts.append(msg)
                if parts:
                    message = "; ".join(parts)
    except Exception:
        pass
    return message


async def fetch_elevenlabs_json(
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    trace_id: str = "",
) -> dict[str, Any]:
    timeout = _timeout_seconds()
    headers = _build_headers()
    url = f"{ELEVENLABS_API_BASE}{path}"
    verb = method.upper()
    route = f"elevenlabs:{verb}:{path}"
    start_ts = time.time()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            if verb == "GET":
                response = await client.get(url, headers=headers, params=params or None)
            elif verb == "PATCH":
                response = await client.patch(url, headers=headers, json=body or {}, params=params or None)
            elif verb == "POST":
                response = await client.post(url, headers=headers, json=body or {}, params=params or None)
            else:
                raise HTTPException(status_code=500, detail={"code": "unsupported_method", "message": f"Unsupported method: {verb}"})
    except httpx.TimeoutException as exc:
        _log_outbound(trace_id=trace_id, route=route, method=verb, start_ts=start_ts, status="timeout", error="timeout")
        raise HTTPException(status_code=504, detail={"code": "elevenlabs_timeout", "message": "ElevenLabs request timed out."}) from exc
    except httpx.RequestError as exc:
        _log_outbound(trace_id=trace_id, route=route, method=verb, start_ts=start_ts, status="error", error=str(exc))
        raise HTTPException(status_code=503, detail={"code": "elevenlabs_request_failed", "message": "Failed to reach ElevenLabs."}) from exc

    if response.status_code in {401, 403}:
        _log_outbound(trace_id=trace_id, route=route, method=verb, start_ts=start_ts, status=str(response.status_code), error="auth")
        raise HTTPException(status_code=503, detail={"code": "elevenlabs_invalid_api_key", "message": "ElevenLabs API key invalid."})
    if response.status_code == 429:
        raise HTTPException(status_code=503, detail={"code": "elevenlabs_rate_limited", "message": "ElevenLabs rate limit reached."})
    if response.status_code >= 400:
        message = _upstream_error_message(response)
        _log_outbound(trace_id=trace_id, route=route, method=verb, start_ts=start_ts, status=str(response.status_code), error=message)
        raise HTTPException(status_code=502, detail={"code": "elevenlabs_upstream_error", "message": message})

    payload = response.json() if response.content else {}
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail={"code": "elevenlabs_invalid_payload", "message": "Unexpected response."})
    _log_outbound(trace_id=trace_id, route=route, method=verb, start_ts=start_ts, status=str(response.status_code))
    return payload
