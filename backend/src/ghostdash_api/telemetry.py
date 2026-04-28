"""Structured JSON logging for GhostDASH observability."""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable
from typing import Any

logger = logging.getLogger("ghostdash.observability")
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)


def new_trace_id() -> str:
    return uuid.uuid4().hex


def new_span_id() -> str:
    return uuid.uuid4().hex[:16]


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
    logger.info(json.dumps(payload, default=str))


def log_instant_event(
    *,
    trace_id: str,
    service: str,
    route: str,
    status: int | str,
    error: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    now = time.time()
    log_event(
        trace_id=trace_id,
        span_id=new_span_id(),
        service=service,
        route=route,
        start_ts=now,
        end_ts=now,
        status=status,
        error=error,
        details=details,
    )


def wrap_outbound_call(
    *,
    trace_id: str,
    service: str,
    route: str,
    fn: Callable[[], Any],
) -> Any:
    span_id = new_span_id()
    start = time.time()
    error: str | None = None
    status: str = "ok"
    try:
        return fn()
    except Exception as exc:  # pragma: no cover - passthrough behavior
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
