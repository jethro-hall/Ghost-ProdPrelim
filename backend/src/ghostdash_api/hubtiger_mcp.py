"""GhostDash HubTiger MCP adapter — shared by control API diagnostics and ElevenLabs ingress."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, cast

import httpx

from .schemas import HubTigerTestResponse, PublicToolResult
from .settings import get_settings

# Matches control / HubTiger MCP test console write operations.
HUBTIGER_WRITE_OPERATIONS = frozenset({"booking_create", "quote_add_line_item"})

# Public `data` must not include credential-like fields. Avoid matching business keys (e.g. "author") via careful patterns.
_REDACT_KEY = re.compile(
    r"(^|_)(password|secret|token|api_?key|bearer|authorization|cookie|credential|private_?key|accesstoken|refreshtoken|"
    r"auth_?header|mcp_?url|proxy_?url|xi[-_]api)(_|$)",
    re.IGNORECASE,
)


def _should_redact_key(key: str) -> bool:
    return bool(_REDACT_KEY.search(str(key)))


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
    """Call HubTiger via the same MCP `/test` contract as the control plane diagnostics console."""
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
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            upstream = await client.post(
                f"{base_url}/test",
                json={"operation": operation, "payload": payload or {}, "mode": mode, "trace_id": trace_id},
            )
        if upstream.status_code >= 400:
            return HubTigerMcpCallResult(
                success=False,
                blocked=False,
                mode=mode,
                operation=operation,
                message="HubTiger test endpoint returned an unavailable response.",
                trace_id=trace_id,
                data={"status_code": upstream.status_code},
                upstream_status_code=upstream.status_code,
            )
        body = upstream.json() if upstream.content else {}
        return HubTigerMcpCallResult(
            success=bool(body.get("success", True)),
            blocked=bool(body.get("blocked", False)),
            mode=mode,
            operation=operation,
            message=str(body.get("message") or "HubTiger test completed."),
            trace_id=trace_id,
            data=dict(body.get("data") or {}),
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
