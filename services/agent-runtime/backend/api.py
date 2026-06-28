"""
FastAPI application — all HTTP endpoints for the agent runtime.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import pathlib
import time
import uuid
from typing import Any, AsyncGenerator

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

from .agent_orchestrator import (
    resolve_approval_decision,
    run_agent,
    subscribe_to_run,
    unsubscribe_from_run,
    update_agent_run_status,
)
from .config import get_settings
from .observability import (
    log_event,
    new_span_id,
    new_trace_id,
    parse_traceparent,
)
from .repositories import (
    get_agent_run,
    get_artifacts,
    get_run_events,
    insert_agent_run,
    run_migrations,
)
from .sandbox_runner import sandbox_root
from .tool_registry import _register_all
from . import data_connector, external_data_api, sandbox_runner

logger = logging.getLogger(__name__)
_settings = get_settings()


# ── Observability middleware ──────────────────────────────────────────────────

class ObservabilityMiddleware(BaseHTTPMiddleware):
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
                service="agent-runtime",
                route=request.url.path,
                start_ts=start_ts,
                end_ts=time.time(),
                status=status,
                error=error,
            )


app = FastAPI(title="Agent Runtime", version="1.0.0")

app.add_middleware(ObservabilityMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup() -> None:
    logging.basicConfig(level=_settings.log_level.upper())
    run_migrations()
    _register_all(
        sandbox_runner=sandbox_runner,
        data_connector=data_connector,
        external_data_api=external_data_api,
    )
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=32, thread_name_prefix="agent")
    asyncio.get_event_loop().set_default_executor(executor)
    logger.info("Agent Runtime started on port %d (thread pool: 32)", _settings.port)


# ── Request / response models ─────────────────────────────────────────────────

class CreateRunRequest(BaseModel):
    question: str
    model: str | None = None
    max_steps: int | None = None
    mode: str = "agent"


class CreateRunResponse(BaseModel):
    run_id: str
    status: str


class ApprovalRequest(BaseModel):
    decision: str   # "allow_once" | "allow_always" | "reject"


class ExternalQueryRequest(BaseModel):
    sql: str


class ExternalSearchRequest(BaseModel):
    query: str
    model: str | None = None


class ExternalCrossQueryRequest(BaseModel):
    snapshot_ids: list[str]
    sql: str


# ── GET /api/runtime-config ───────────────────────────────────────────────────

@app.get("/api/runtime-config")
async def runtime_config() -> JSONResponse:
    """Expose runtime defaults to the frontend so it does not need hard-coded values."""
    return JSONResponse({
        "default_max_steps": _settings.agent_runtime_max_steps,
        "default_model": _settings.agent_runtime_default_model,
        "external_data_api_configured": bool(_settings.external_data_api_key),
    })


# ── External Data API proxy routes ────────────────────────────────────────────
# These forward to the FDL-side analytics gateway (External Data API). The API
# key lives only in the agent-runtime container env. Browsers and the LLM
# never see it.

def _trace_id_from(request: Request) -> str:
    return getattr(request.state, "trace_id", "untraced")


def _external_data_error(exc: external_data_api.ExternalDataAPIError) -> HTTPException:
    status = exc.status_code or 502
    detail: dict[str, Any] = {"message": str(exc)}
    if exc.payload is not None:
        detail["upstream"] = exc.payload
    return HTTPException(status_code=status, detail=detail)


@app.get("/api/external-data/snapshots")
async def external_data_list_snapshots(request: Request) -> JSONResponse:
    try:
        data = external_data_api.list_snapshots(trace_id=_trace_id_from(request))
    except external_data_api.ExternalDataAPIError as exc:
        raise _external_data_error(exc)
    return JSONResponse(data)


@app.post("/api/external-data/snapshots/{snapshot_id:path}/query")
async def external_data_query(
    snapshot_id: str,
    body: ExternalQueryRequest,
    request: Request,
) -> JSONResponse:
    try:
        data = external_data_api.run_query(
            snapshot_id,
            body.sql,
            trace_id=_trace_id_from(request),
        )
    except external_data_api.ExternalDataAPIError as exc:
        raise _external_data_error(exc)
    return JSONResponse(data)


@app.post("/api/external-data/snapshots/{snapshot_id:path}/search")
async def external_data_search(
    snapshot_id: str,
    body: ExternalSearchRequest,
    request: Request,
) -> JSONResponse:
    try:
        data = external_data_api.search(
            snapshot_id,
            body.query,
            model=body.model,
            trace_id=_trace_id_from(request),
        )
    except external_data_api.ExternalDataAPIError as exc:
        raise _external_data_error(exc)
    return JSONResponse(data)


@app.get("/api/external-data/snapshots/{snapshot_id:path}/metrics")
async def external_data_metrics(snapshot_id: str, request: Request) -> JSONResponse:
    try:
        data = external_data_api.get_metrics(snapshot_id, trace_id=_trace_id_from(request))
    except external_data_api.ExternalDataAPIError as exc:
        raise _external_data_error(exc)
    return JSONResponse(data)


@app.post("/api/external-data/query")
async def external_data_cross_query(
    body: ExternalCrossQueryRequest,
    request: Request,
) -> JSONResponse:
    try:
        data = external_data_api.cross_query(
            body.snapshot_ids,
            body.sql,
            trace_id=_trace_id_from(request),
        )
    except external_data_api.ExternalDataAPIError as exc:
        raise _external_data_error(exc)
    return JSONResponse(data)


# ── POST /api/agent-runs ──────────────────────────────────────────────────────

@app.post("/api/agent-runs", response_model=CreateRunResponse)
async def create_run(body: CreateRunRequest) -> CreateRunResponse:
    run_id = str(uuid.uuid4())
    model = body.model or _settings.agent_runtime_default_model

    insert_agent_run(
        run_id=run_id,
        question=body.question,
        mode=body.mode,
        model=model,
    )

    async def _run_with_timeout():
        try:
            await asyncio.wait_for(
                run_agent(
                    run_id=run_id,
                    question=body.question,
                    model=model,
                    max_steps=body.max_steps,
                ),
                timeout=600,
            )
        except asyncio.TimeoutError:
            update_agent_run_status(run_id, "failed", error="Run exceeded 10-minute hard timeout")

    asyncio.create_task(_run_with_timeout())

    return CreateRunResponse(run_id=run_id, status="queued")


# ── GET /api/agent-runs/:id ───────────────────────────────────────────────────

@app.get("/api/agent-runs/{run_id}")
async def get_run(run_id: str) -> dict[str, Any]:
    run = get_agent_run(run_id)
    if not run:
        raise HTTPException(404, f"Run '{run_id}' not found.")
    events = get_run_events(run_id)
    artifacts = get_artifacts(run_id)
    return {**run, "events": events, "artifacts": artifacts}


# ── GET /api/agent-runs/:id/events/stream (SSE) ───────────────────────────────

@app.get("/api/agent-runs/{run_id}/events/stream")
async def stream_run_events(
    run_id: str,
    after_seq: int = Query(default=0, alias="after"),
) -> StreamingResponse:
    run = get_agent_run(run_id)
    if not run:
        raise HTTPException(404, f"Run '{run_id}' not found.")

    async def event_generator() -> AsyncGenerator[str, None]:
        existing = get_run_events(run_id, after_seq=after_seq)
        for evt in existing:
            yield _format_sse(evt)

        run_status = run.get("status", "queued")
        if run_status in ("completed", "failed"):
            yield "data: {\"type\":\"stream.end\"}\n\n"
            return

        q = subscribe_to_run(run_id)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield f": heartbeat {int(time.time())}\n\n"
                    continue

                if event is None:
                    yield "data: {\"type\":\"stream.end\"}\n\n"
                    break

                yield _format_sse(event)
        finally:
            unsubscribe_from_run(run_id, q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _format_sse(event: dict[str, Any]) -> str:
    def default_serialiser(obj: Any) -> str:
        return str(obj)
    return f"data: {json.dumps(event, default=default_serialiser)}\n\n"


# ── POST /api/agent-runs/:id/approvals/:approval_id ──────────────────────────

@app.post("/api/agent-runs/{run_id}/approvals/{approval_id}")
async def submit_approval(
    run_id: str,
    approval_id: str,
    body: ApprovalRequest,
) -> dict[str, str]:
    if body.decision not in ("allow_once", "allow_always", "reject"):
        raise HTTPException(400, "decision must be 'allow_once', 'allow_always', or 'reject'")
    resolve_approval_decision(approval_id, body.decision)
    return {"status": "ok", "decision": body.decision}


# ── POST /api/agent-runs/:id/cancel ──────────────────────────────────────────

@app.post("/api/agent-runs/{run_id}/cancel")
async def cancel_run(run_id: str) -> dict[str, str]:
    run = get_agent_run(run_id)
    if not run:
        raise HTTPException(404, f"Run '{run_id}' not found.")
    update_agent_run_status(run_id, "failed", error="Cancelled by operator")
    return {"status": "cancelled"}


# ── GET /api/agent-runs/:id/artifacts/:artifact_id ───────────────────────────

@app.get("/api/agent-runs/{run_id}/artifacts/{artifact_id}")
async def get_artifact_file(run_id: str, artifact_id: str) -> FileResponse:
    artifacts = get_artifacts(run_id)
    match = next((a for a in artifacts if a["id"] == artifact_id), None)
    if not match:
        raise HTTPException(404, f"Artifact '{artifact_id}' not found.")
    path = pathlib.Path(match["path"])
    if not path.exists():
        raise HTTPException(404, "Artifact file not found on disk.")
    return FileResponse(
        path=str(path),
        filename=match.get("name", path.name),
        media_type=match.get("mime_type", "application/octet-stream"),
    )


@app.get("/")
async def serve_ui() -> HTMLResponse:
    html_path = pathlib.Path(__file__).parent.parent / "frontend" / "index.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text(), status_code=200)
    return HTMLResponse("<h1>Agent Runtime UI not built yet</h1>", status_code=200)


# ── GET /health ───────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    import uvicorn
    uvicorn.run(
        "backend.api:app",
        host=_settings.host,
        port=_settings.port,
        log_level=_settings.log_level,
    )


if __name__ == "__main__":
    main()
