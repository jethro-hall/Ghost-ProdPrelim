"""Structured JSON logging for inbound HTTP requests (GhostDASH observability standard)."""

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
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(_h)


def log_event(
    *,
    trace_id: str,
    span_id: str,
    service: str,
    route: str,
    start_ts: float,
    end_ts: float,
    status: int,
    error: str | None = None,
) -> None:
    latency_ms = (end_ts - start_ts) * 1000.0
    payload: dict[str, Any] = {
        "trace_id": trace_id,
        "span_id": span_id,
        "service": service,
        "route": route,
        "start_ts": start_ts,
        "end_ts": end_ts,
        "latency_ms": round(latency_ms, 3),
        "status": status,
        "error": error,
    }
    logger.info(json.dumps(payload, default=str))


def log_outbound(
    *,
    trace_id: str,
    span_id: str,
    service: str,
    route: str,
    start_ts: float,
    end_ts: float,
    status: str,
    error: str | None = None,
) -> None:
    latency_ms = (end_ts - start_ts) * 1000.0
    payload: dict[str, Any] = {
        "trace_id": trace_id,
        "span_id": span_id,
        "service": service,
        "route": route,
        "start_ts": start_ts,
        "end_ts": end_ts,
        "latency_ms": round(latency_ms, 3),
        "status": status,
        "error": error,
    }
    logger.info(json.dumps(payload, default=str))


def wrap_outbound_call(
    trace_id: str,
    service: str,
    route: str,
    fn: Callable[[], Any],
) -> Any:
    span_id = uuid.uuid4().hex[:16]
    t0 = time.time()
    err: str | None = None
    status = "ok"
    try:
        return fn()
    except Exception as e:
        err = repr(e)
        status = "error"
        raise
    finally:
        log_outbound(
            trace_id=trace_id,
            span_id=span_id,
            service=service,
            route=route,
            start_ts=t0,
            end_ts=time.time(),
            status=status,
            error=err,
        )
