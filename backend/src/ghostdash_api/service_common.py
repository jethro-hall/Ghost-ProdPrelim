from __future__ import annotations

import time
from contextlib import asynccontextmanager
from collections.abc import Callable

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from .database import init_db
from .telemetry import log_event, new_span_id, new_trace_id


def parse_traceparent(header: str | None) -> str | None:
    if not header:
        return None
    parts = header.strip().split("-")
    if len(parts) >= 4 and parts[0] == "00" and len(parts[1]) == 32:
        return parts[1]
    return None


class ObservabilityMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, service_name: str):
        super().__init__(app)
        self.service_name = service_name

    async def dispatch(self, request: Request, call_next):
        trace_id = parse_traceparent(request.headers.get("traceparent")) or new_trace_id()
        span_id = new_span_id()
        request.state.trace_id = trace_id
        request.state.span_id = span_id
        start_ts = time.time()
        status = 500
        error: str | None = None
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Trace-Id"] = trace_id
            return response
        except Exception as exc:
            error = repr(exc)
            raise
        finally:
            log_event(
                trace_id=trace_id,
                span_id=span_id,
                service=self.service_name,
                route=request.url.path,
                start_ts=start_ts,
                end_ts=time.time(),
                status=status,
                error=error,
            )


def build_app(
    *,
    service_name: str,
    title: str,
    version: str = "0.2.0",
    docs_url: str | None = None,
    redoc_url: str | None = None,
    openapi_url: str | None = None,
    startup_hooks: list[Callable[[], None]] | None = None,
):
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_db()
        for hook in startup_hooks or []:
            hook()
        yield

    app = FastAPI(
        title=title,
        version=version,
        lifespan=lifespan,
        docs_url=docs_url,
        redoc_url=redoc_url,
        openapi_url=openapi_url,
    )
    app.add_middleware(ObservabilityMiddleware, service_name=service_name)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    return app
