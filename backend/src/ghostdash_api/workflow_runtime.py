from __future__ import annotations

import asyncio
import sys

from fastapi import FastAPI
from pydantic import BaseModel
from sqlalchemy import select

from .database import SessionLocal
from .models import IngestionRunRecord
from .runtime import seed_default_connections
from .service_common import build_app
from .telemetry import log_instant_event, new_trace_id
from .workflows import IngestionWorkflow, QueryWorkflow

ACTIVE_INGEST_TASKS: dict[str, asyncio.Task[None]] = {}
RECOVERY_SUPERSEDED_MESSAGE = "Superseded by a newer recovered run after workflow runtime restart"
RECOVERY_START_DELAY_SECONDS = 10.0


class IngestTriggerPayload(BaseModel):
    run_id: str
    trace_id: str


class QueryTriggerPayload(BaseModel):
    message: str
    current_message: str | None = None
    corpora: list[str] = []
    top_k: int = 6
    trace_id: str
    workflow_mode: str | None = None
    embedding_model_id: str | None = None
    kb_enabled: bool = True
    odoo_ready: bool = False


def split_recoverable_ingestion_runs(
    runs: list[IngestionRunRecord],
) -> tuple[list[IngestionRunRecord], list[IngestionRunRecord]]:
    latest_by_corpus: dict[str, IngestionRunRecord] = {}
    superseded: list[IngestionRunRecord] = []
    for run in runs:
        existing = latest_by_corpus.get(run.corpus)
        if existing is None:
            latest_by_corpus[run.corpus] = run
            continue
        chosen = max((existing, run), key=lambda candidate: candidate.created_at)
        displaced = run if chosen is existing else existing
        latest_by_corpus[run.corpus] = chosen
        superseded.append(displaced)
    recoverable = sorted(latest_by_corpus.values(), key=lambda run: run.created_at)
    superseded.sort(key=lambda run: run.created_at)
    return recoverable, superseded


def queue_ingestion_job(*, run_id: str, trace_id: str, source: str) -> str:
    existing = ACTIVE_INGEST_TASKS.get(run_id)
    if existing is not None and not existing.done():
        log_instant_event(
            trace_id=trace_id,
            service="workflow-runtime",
            route="ingest.job.duplicate",
            status="ok",
            details={"run_id": run_id, "source": source},
        )
        return "already_running"

    task = asyncio.create_task(_execute_ingestion_job(run_id=run_id, trace_id=trace_id))
    ACTIVE_INGEST_TASKS[run_id] = task
    log_instant_event(
        trace_id=trace_id,
        service="workflow-runtime",
        route="ingest.job.accepted",
        status="ok",
        details={"run_id": run_id, "source": source},
    )
    return "queued"


def queue_recovered_ingestion_jobs(queued_runs: list[dict[str, str]]) -> None:
    for queued in queued_runs:
        status = queue_ingestion_job(
            run_id=queued["run_id"],
            trace_id=queued["trace_id"],
            source="startup_recovery",
        )
        log_instant_event(
            trace_id=queued["trace_id"],
            service="workflow-runtime",
            route="ingest.job.recovered",
            status="ok",
            details={
                "run_id": queued["run_id"],
                "corpus": queued["corpus"],
                "previous_status": queued["status"],
                "queue_status": status,
            },
        )


def initialize_workflow_runtime_state() -> None:
    loop = asyncio.get_running_loop()
    with SessionLocal() as session:
        seed_default_connections(session)
        runs = list(
            session.scalars(
                select(IngestionRunRecord)
                .where(
                    IngestionRunRecord.run_type == "full_sync",
                    IngestionRunRecord.status.in_(("pending", "running")),
                )
                .order_by(IngestionRunRecord.created_at.asc())
            )
        )
        recoverable, superseded = split_recoverable_ingestion_runs(runs)
        queued_runs = [
            {
                "run_id": run.id,
                "trace_id": run.trace_id or new_trace_id(),
                "corpus": run.corpus,
                "status": run.status,
            }
            for run in recoverable
        ]
        for run in superseded:
            run.status = "failed"
            run.current_step = "finalize"
            run.progress = 1.0
            run.error_message = RECOVERY_SUPERSEDED_MESSAGE
        if superseded:
            session.commit()

    if queued_runs:
        loop.call_later(RECOVERY_START_DELAY_SECONDS, queue_recovered_ingestion_jobs, queued_runs)
        for queued in queued_runs:
            log_instant_event(
                trace_id=queued["trace_id"],
                service="workflow-runtime",
                route="ingest.job.recovery.scheduled",
                status="ok",
                details={
                    "run_id": queued["run_id"],
                    "corpus": queued["corpus"],
                    "previous_status": queued["status"],
                    "delay_seconds": RECOVERY_START_DELAY_SECONDS,
                },
            )


async def _run_ingestion_workflow_async(*, run_id: str, trace_id: str) -> None:
    workflow = IngestionWorkflow(timeout=600, verbose=False)
    await workflow.run(ingestion_run_id=run_id, trace_id=trace_id)


def execute_ingestion_job_entrypoint(*, run_id: str, trace_id: str) -> None:
    try:
        log_instant_event(
            trace_id=trace_id,
            service="workflow-runtime",
            route="ingest.job.started",
            status="ok",
            details={"run_id": run_id},
        )
        asyncio.run(_run_ingestion_workflow_async(run_id=run_id, trace_id=trace_id))
        log_instant_event(
            trace_id=trace_id,
            service="workflow-runtime",
            route="ingest.job.completed",
            status="ok",
            details={"run_id": run_id},
        )
    except Exception as exc:
        with SessionLocal() as session:
            run = session.get(IngestionRunRecord, run_id)
            if run is not None and run.status not in {"completed", "failed"}:
                run.status = "failed"
                run.error_message = str(exc)[:2000]
                session.commit()
        log_instant_event(
            trace_id=trace_id,
            service="workflow-runtime",
            route="ingest.job.failed",
            status="error",
            error=repr(exc),
            details={"run_id": run_id},
        )


async def _execute_ingestion_job(*, run_id: str, trace_id: str) -> None:
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            (
                "import sys; "
                "from ghostdash_api.workflow_runtime import execute_ingestion_job_entrypoint as run; "
                "run(run_id=sys.argv[1], trace_id=sys.argv[2])"
            ),
            run_id,
            trace_id,
        )
        exit_code = await process.wait()
        if exit_code != 0:
            with SessionLocal() as session:
                run = session.get(IngestionRunRecord, run_id)
                if run is not None and run.status not in {"completed", "failed"}:
                    run.status = "failed"
                    run.error_message = f"workflow worker exited with code {exit_code}"
                    session.commit()
            log_instant_event(
                trace_id=trace_id,
                service="workflow-runtime",
                route="ingest.job.worker_exited",
                status="error",
                error=f"worker_exit_code={exit_code}",
                details={"run_id": run_id},
            )
    finally:
        ACTIVE_INGEST_TASKS.pop(run_id, None)


def create_app() -> FastAPI:
    app = build_app(
        service_name="workflow-runtime",
        title="GhostDASH Workflow Runtime",
        startup_hooks=[initialize_workflow_runtime_state],
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/internal/ingest")
    async def internal_ingest(body: IngestTriggerPayload) -> dict:
        status = queue_ingestion_job(run_id=body.run_id, trace_id=body.trace_id, source="internal_ingest")
        return {"accepted": True, "run_id": body.run_id, "status": status}

    @app.post("/internal/query-plan")
    async def internal_query_plan(body: QueryTriggerPayload) -> dict:
        workflow = QueryWorkflow(timeout=300, verbose=False)
        result = await workflow.run(
            message=body.message,
            current_message=body.current_message or body.message,
            corpora=body.corpora,
            top_k=body.top_k,
            trace_id=body.trace_id,
            workflow_mode=body.workflow_mode,
            embedding_model_id=body.embedding_model_id,
            kb_enabled=body.kb_enabled,
            odoo_ready=body.odoo_ready,
        )
        return result

    return app


app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run(
        "ghostdash_api.workflow_runtime:app",
        host="0.0.0.0",
        port=8100,
        reload=False,
        access_log=False,
        log_config=None,
    )


if __name__ == "__main__":
    run()
