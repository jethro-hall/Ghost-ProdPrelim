"""Structured JSON logging for agent-runtime — no ghostdash_api dependency."""
from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable
from typing import Any

_logger = logging.getLogger("agent_runtime.observability")
_logger.setLevel(logging.INFO)
if not _logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(message)s"))
    _logger.addHandler(_h)


def new_trace_id() -> str:
    return uuid.uuid4().hex


def new_span_id() -> str:
    return uuid.uuid4().hex[:16]


def parse_traceparent(header: str | None) -> str | None:
    """Extract trace-id from W3C traceparent header (version-traceid-parentid-flags)."""
    if not header:
        return None
    parts = header.strip().split("-")
    if len(parts) >= 4 and parts[0] == "00" and len(parts[1]) == 32:
        return parts[1]
    return None


def log_event(
    *,
    trace_id: str,
    span_id: str,
    service: str,
    route: str,
    start_ts: float,
    end_ts: float,
    status: int | str,
    error: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "trace_id": trace_id,
        "span_id": span_id,
        "service": service,
        "route": route,
        "start_ts": start_ts,
        "end_ts": end_ts,
        "latency_ms": round((end_ts - start_ts) * 1000.0, 3),
        "status": status,
        "error": error,
    }
    if details:
        payload["details"] = details
    _logger.info(json.dumps(payload, default=str))


def wrap_outbound_call(
    *,
    trace_id: str,
    service: str,
    route: str,
    fn: Callable[[], Any],
) -> Any:
    """Call fn(), emit a structured log line, re-raise on failure."""
    span_id = new_span_id()
    start = time.time()
    error: str | None = None
    status: str = "ok"
    try:
        return fn()
    except Exception as exc:
        error = repr(exc)
        status = "error"
        raise
    finally:
        log_event(
            trace_id=trace_id,
            span_id=span_id,
            service=service,
            route=route,
            start_ts=start,
            end_ts=time.time(),
            status=status,
            error=error,
        )
