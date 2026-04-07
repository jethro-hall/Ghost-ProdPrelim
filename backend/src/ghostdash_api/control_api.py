from __future__ import annotations

import hashlib
import mimetypes
import re
import time
from pathlib import Path

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .agent_memory import get_agent, list_agents, list_conversations, list_messages, save_agent, seed_default_agent_profiles
from .database import get_session
from .database import SessionLocal
from .models import (
    AgentConversationRecord,
    AgentMessageRecord,
    AgentProfileRecord,
    ConnectionRecord,
    DocumentRecord,
    IngestionRunRecord,
    RetrievalArtifactRecord,
    WorkbookArtifactRecord,
    WorkbookRowRecord,
    WorkbookSheetRecord,
    WorkbookTableRecord,
)
from .runtime import get_active_connection, list_connections, save_connection, seed_default_connections, test_provider_connection
from .runtime_defaults import get_runtime_defaults, save_runtime_defaults
from .runtime_profiles import get_default_runtime_profile, resolve_agent_runtime_profile, seed_default_runtime_profile
from .schemas import (
    AgentProfilePayload,
    AgentProfileView,
    CapabilityStatus,
    ConnectionPayload,
    ConnectionTestPayload,
    ConnectionTestResponse,
    ConnectionView,
    ConversationMessageView,
    ConversationSummaryView,
    DocumentArtifactView,
    DocumentIngestionView,
    RuntimeCapabilities,
    RuntimeDefaultsPayload,
    RuntimeDefaultsView,
    RuntimeProfileView,
    RunSummaryView,
    SyncRequest,
    TaskDocumentView,
    TaskStepView,
    TaskView,
    UploadView,
)
from .service_common import build_app
from .settings import get_settings
from .telemetry import log_instant_event, new_span_id

settings = get_settings()


def initialize_control_runtime_state() -> None:
    with SessionLocal() as session:
        seed_default_connections(session)
        seed_default_runtime_profile(session)
        seed_default_agent_profiles(session)


def _runtime_capabilities() -> RuntimeCapabilities:
    return RuntimeCapabilities(
        parser_lanes={
            "local": CapabilityStatus(
                available=True,
                configured=True,
                message="Deterministic local parsers are ready, including table-first XLSX ingestion.",
            ),
            "cloud": CapabilityStatus(
                available=bool(settings.llama_cloud_api_key),
                configured=bool(settings.llama_cloud_api_key),
                message=(
                    "LlamaParse cloud lane is ready for markdown enrichment."
                    if settings.llama_cloud_api_key
                    else "LLAMA_CLOUD_API_KEY is not set; cloud parse enrichment is blocked."
                ),
            ),
        },
        chat_api_modes={
            "responses": CapabilityStatus(
                available=True,
                configured=True,
                message="Agent ingress supports provider-backed answer generation.",
            ),
            "chat_completions": CapabilityStatus(
                available=True,
                configured=True,
                message="Chat completions-compatible generation is supported.",
            ),
        },
        streaming=CapabilityStatus(
            available=True,
            configured=True,
            message="SSE agent streaming is available through the `/agent/*` boundary.",
        ),
        vector_store="qdrant",
        model_runtime="llamaindex workflows + provider APIs",
    )

ORDERED_SYNC_STEPS = ("queued", "parse_structure", "index_retrieval", "finalize")


def _run_documents(run: IngestionRunRecord, session: Session) -> tuple[list[TaskDocumentView], int, int, str | None, str | None]:
    payload = run.payload_json or {}
    document_ids = [str(document_id) for document_id in payload.get("document_ids", [])]
    if not document_ids:
        return [], 0, 0, None, None

    rows = list(session.scalars(select(DocumentRecord).where(DocumentRecord.id.in_(document_ids))))
    row_map = {row.id: row for row in rows}
    active_document_id = (run.result_json or {}).get("current_document_id")
    active_filename = (run.result_json or {}).get("current_filename")
    completed = 0
    failed = 0
    documents: list[TaskDocumentView] = []

    for document_id in document_ids:
        document = row_map.get(document_id)
        if document is None:
            continue
        failed_document = document.parse_status == "failed" or document.index_status == "failed" or document.status == "error"
        completed_document = document.index_status == "completed" or document.status == "indexed"
        if failed_document:
            failed += 1
        elif completed_document:
            completed += 1
        documents.append(
            TaskDocumentView(
                id=document.id,
                filename=document.filename,
                requested_lane=document.requested_lane,
                parse_status=document.parse_status,
                index_status=document.index_status,
                overall_status=document.status,
                error_message=document.error_message,
                active=run.status == "running" and document.id == active_document_id,
            )
        )
        if document.id == active_document_id:
            active_filename = document.filename

    return documents, completed, failed, active_document_id, active_filename


def _step_status(step: str, run: IngestionRunRecord, documents: list[TaskDocumentView]) -> str:
    parse_failed = any(document.parse_status == "failed" for document in documents)
    index_failed = any(document.index_status == "failed" for document in documents)

    if step == "queued":
        if run.status == "pending":
            return "running"
        return "completed"

    if step == "parse_structure":
        if run.current_step == step and run.status == "running":
            return "running"
        if parse_failed:
            return "failed"
        if documents and all(document.parse_status != "pending" for document in documents):
            return "completed"
        return "pending"

    if step == "index_retrieval":
        if run.current_step == step and run.status == "running":
            return "running"
        if index_failed:
            return "failed"
        if documents and all(document.index_status != "pending" for document in documents):
            return "completed"
        return "pending"

    if step == "finalize":
        if run.current_step == step and run.status == "running":
            return "running"
        if run.status == "failed":
            return "failed"
        if run.status == "completed":
            return "completed"
        return "pending"

    return "pending"


def _run_to_view(run: IngestionRunRecord, session: Session) -> TaskView:
    documents, completed_documents, failed_documents, active_document_id, active_filename = _run_documents(run, session)
    steps = []
    for step in ORDERED_SYNC_STEPS:
        status = _step_status(step, run, documents)
        steps.append(
            TaskStepView(
                id=step,
                label=step.replace("_", " ").title(),
                done=status in {"completed", "failed"},
                active=status == "running",
                status=status,
            )
        )
    return TaskView(
        id=run.id,
        task_type=run.run_type,
        status=run.status,
        current_step=run.current_step,
        progress=run.progress,
        error_message=run.error_message,
        steps=steps,
        total_documents=len(documents),
        completed_documents=completed_documents,
        failed_documents=failed_documents,
        active_document_id=active_document_id,
        active_filename=active_filename,
        documents=documents,
    )


def _document_to_view(
    doc: DocumentRecord,
    artifact_types: list[str],
    sheet_count: int,
    table_count: int,
    row_count: int,
) -> DocumentIngestionView:
    return DocumentIngestionView(
        id=doc.id,
        corpus=doc.corpus,
        filename=doc.filename,
        source_path=doc.source_path,
        requested_lane=doc.requested_lane,
        actual_parse_lane=doc.actual_parse_lane,
        parse_status=doc.parse_status,
        index_status=doc.index_status,
        overall_status=doc.status,
        error_message=doc.error_message,
        workbook_sheet_count=sheet_count,
        workbook_table_count=table_count,
        workbook_row_count=row_count,
        artifacts=[
            DocumentArtifactView(artifact_type=artifact_type, source="workflow-runtime", status="ready")
            for artifact_type in artifact_types
        ],
    )



def _run_summary_to_view(run: IngestionRunRecord) -> RunSummaryView:
    return RunSummaryView(
        id=run.id,
        run_type=run.run_type,
        corpus=run.corpus,
        status=run.status,
        current_step=run.current_step,
        progress=run.progress,
        requested_lane=run.requested_lane,
        trace_id=run.trace_id,
        error_message=run.error_message,
        result_json=run.result_json,
        created_at=run.created_at,
        updated_at=run.updated_at,
    )


def _runtime_profile_to_view(runtime_profile) -> RuntimeProfileView:
    return RuntimeProfileView(
        id=runtime_profile.id,
        name=runtime_profile.name,
        description=runtime_profile.description,
        llm_config=runtime_profile.llm_config_json or {},
        guardrails_config=runtime_profile.guardrails_config_json or {},
        kb_config=runtime_profile.kb_config_json or {},
        retrieval_config=runtime_profile.retrieval_config_json or {},
        tool_policy_config=runtime_profile.tool_policy_config_json or {},
        is_default=runtime_profile.is_default,
        enabled=runtime_profile.enabled,
        created_at=runtime_profile.created_at,
        updated_at=runtime_profile.updated_at,
    )


def _agent_to_view(agent: AgentProfileRecord, runtime_profile) -> AgentProfileView:
    return AgentProfileView(
        id=agent.id,
        name=agent.name,
        first_message=agent.first_message,
        language=agent.language,
        voice_id=agent.voice_id,
        runtime_profile_id=runtime_profile.id,
        runtime_profile=_runtime_profile_to_view(runtime_profile),
        is_default=agent.is_default,
        enabled=agent.enabled,
        created_at=agent.created_at,
        updated_at=agent.updated_at,
    )


def _conversation_to_view(conversation: AgentConversationRecord, message_count: int) -> ConversationSummaryView:
    return ConversationSummaryView(
        id=conversation.id,
        agent_id=conversation.agent_id,
        title=conversation.title,
        corpora=conversation.corpora_json or [],
        api_mode=conversation.api_mode,
        message_count=message_count,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
    )


def _message_to_view(message: AgentMessageRecord) -> ConversationMessageView:
    return ConversationMessageView(
        id=message.id,
        conversation_id=message.conversation_id,
        agent_id=message.agent_id,
        role=message.role,
        content=message.content,
        query_mode=message.query_mode,
        citations=message.citations_json or [],
        api_mode=message.api_mode,
        created_at=message.created_at,
    )


async def _write_upload_to_disk(file: UploadFile, dest: Path) -> tuple[int, str]:
    hasher = hashlib.sha256()
    total_bytes = 0
    with dest.open("wb") as handle:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total_bytes += len(chunk)
            hasher.update(chunk)
            handle.write(chunk)
    await file.close()
    return total_bytes, hasher.hexdigest()



def trigger_ingestion_run(run_id: str, trace_id: str) -> None:
    try:
        last_exc: Exception | None = None
        for attempt in range(1, 4):
            try:
                with httpx.Client(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
                    response = client.post(
                        f"{settings.app_workflow_runtime_url.rstrip('/')}/internal/ingest",
                        json={"run_id": run_id, "trace_id": trace_id},
                        headers={"traceparent": f"00-{trace_id}-{new_span_id()}-01"},
                    )
                    response.raise_for_status()
                break
            except Exception as exc:  # Runtime can be briefly busy recovering or indexing during startup.
                last_exc = exc
                log_instant_event(
                    trace_id=trace_id,
                    service="control-api",
                    route="sync.trigger.retry",
                    status="error",
                    error=repr(exc),
                    details={"run_id": run_id, "attempt": attempt},
                )
                if attempt == 3:
                    raise
                time.sleep(float(attempt))
        else:
            raise last_exc or RuntimeError("failed to queue ingestion run")
        log_instant_event(
            trace_id=trace_id,
            service="control-api",
            route="sync.trigger.accepted",
            status="ok",
            details={"run_id": run_id},
        )
    except Exception as exc:
        with SessionLocal() as session:
            run = session.get(IngestionRunRecord, run_id)
            if run is not None:
                run.status = "failed"
                run.error_message = str(exc)[:2000]
                session.commit()
        log_instant_event(
            trace_id=trace_id,
            service="control-api",
            route="sync.trigger.failed",
            status="error",
            error=repr(exc),
            details={"run_id": run_id},
        )
        raise


def create_app() -> FastAPI:
    app = build_app(
        service_name="control-api",
        title="GhostDASH Control API",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
        startup_hooks=[initialize_control_runtime_state],
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/capabilities", response_model=RuntimeCapabilities)
    def api_capabilities() -> RuntimeCapabilities:
        return _runtime_capabilities()

    @app.get("/api/runtime/defaults", response_model=RuntimeDefaultsView)
    def api_runtime_defaults(session: Session = Depends(get_session)) -> RuntimeDefaultsView:
        return RuntimeDefaultsView(**get_runtime_defaults(session))

    @app.post("/api/runtime/defaults", response_model=RuntimeDefaultsView)
    def api_save_runtime_defaults(
        body: RuntimeDefaultsPayload,
        session: Session = Depends(get_session),
    ) -> RuntimeDefaultsView:
        return RuntimeDefaultsView(**save_runtime_defaults(session, body.model_dump()))

    @app.get("/api/connections", response_model=list[ConnectionView])
    def api_list_connections(session: Session = Depends(get_session)) -> list[ConnectionView]:
        rows = list_connections(session)
        return [
            ConnectionView(
                id=row.id,
                provider=row.provider,
                label=row.label,
                base_url=row.base_url,
                enabled=row.enabled,
                api_key_hint=row.masked_api_key,
                has_api_key=bool(row.api_key),
            )
            for row in rows
        ]

    @app.post("/api/connections", response_model=ConnectionView)
    def api_save_connection(
        body: ConnectionPayload,
        session: Session = Depends(get_session),
    ) -> ConnectionView:
        record = save_connection(
            session,
            body.provider,
            label=body.label or body.provider,
            api_key=body.api_key,
            base_url=body.base_url,
            enabled=body.enabled,
        )
        return ConnectionView(
            id=record.id,
            provider=record.provider,
            label=record.label,
            base_url=record.base_url,
            enabled=record.enabled,
            api_key_hint=record.masked_api_key,
            has_api_key=bool(record.api_key),
        )

    @app.post("/api/connections/test", response_model=ConnectionTestResponse)
    def api_test_connection(
        body: ConnectionTestPayload,
        request: Request,
        session: Session = Depends(get_session),
    ) -> ConnectionTestResponse:
        record = get_active_connection(session, body.provider)
        runtime_profile = get_default_runtime_profile(session)
        result = test_provider_connection(
            record,
            api_mode=body.api_mode,
            prompt=body.prompt,
            trace_id=request.state.trace_id,
            service="control-api",
            api_key=body.api_key,
            base_url=body.base_url,
            model_id=body.model_id or (runtime_profile.llm_config_json or {}).get("model_id"),
        )
        return ConnectionTestResponse(ok=True, **result)

    @app.get("/api/agents", response_model=list[AgentProfileView])
    def api_list_agents(session: Session = Depends(get_session)) -> list[AgentProfileView]:
        return [_agent_to_view(agent, resolve_agent_runtime_profile(session, agent)) for agent in list_agents(session)]

    @app.post("/api/agents", response_model=AgentProfileView)
    def api_save_agent(
        body: AgentProfilePayload,
        session: Session = Depends(get_session),
    ) -> AgentProfileView:
        agent = save_agent(session, body.model_dump())
        return _agent_to_view(agent, resolve_agent_runtime_profile(session, agent))

    @app.get("/api/agents/{agent_id}/conversations", response_model=list[ConversationSummaryView])
    def api_list_agent_conversations(
        agent_id: str,
        session: Session = Depends(get_session),
    ) -> list[ConversationSummaryView]:
        try:
            get_agent(session, agent_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return [
            _conversation_to_view(conversation, message_count)
            for conversation, message_count in list_conversations(session, agent_id)
        ]

    @app.get("/api/conversations/{conversation_id}/messages", response_model=list[ConversationMessageView])
    def api_conversation_messages(
        conversation_id: str,
        session: Session = Depends(get_session),
    ) -> list[ConversationMessageView]:
        conversation = session.get(AgentConversationRecord, conversation_id)
        if conversation is None:
            raise HTTPException(404, "conversation not found")
        return [_message_to_view(message) for message in list_messages(session, conversation_id)]

    @app.post("/api/upload", response_model=UploadView)
    async def api_upload(
        corpus: str | None = Form(None),
        policy_lane: str | None = Form(None),
        file: UploadFile = File(...),
        session: Session = Depends(get_session),
    ) -> UploadView:
        target_corpus = corpus or settings.app_default_corpus
        lane = policy_lane or settings.app_default_policy_lane
        if lane not in {"local", "cloud"}:
            raise HTTPException(400, "policy_lane must be local or cloud")

        filename = file.filename or "upload"
        safe_name = re.sub(r"[^a-zA-Z0-9._() -]+", "_", Path(filename).name).strip()[:200] or "upload"
        dest_dir = settings.upload_dir / target_corpus
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / safe_name
        size_bytes, sha256 = await _write_upload_to_disk(file, dest)

        source_path = str(dest.resolve())
        doc = session.scalar(select(DocumentRecord).where(DocumentRecord.source_path == source_path))
        source_kind = "spreadsheet" if dest.suffix.lower() in {".xlsx", ".xlsm"} else "document"
        metadata_json = {"size_bytes": size_bytes, "sha256": sha256}
        if doc is None:
            doc = DocumentRecord(
                corpus=target_corpus,
                filename=safe_name,
                source_path=source_path,
                mime_type=file.content_type or mimetypes.guess_type(safe_name)[0],
                requested_lane=lane,
                parse_status="pending",
                index_status="pending",
                status="uploaded",
                source_kind=source_kind,
                metadata_json=metadata_json,
            )
            session.add(doc)
        else:
            doc.corpus = target_corpus
            doc.filename = safe_name
            doc.mime_type = file.content_type or mimetypes.guess_type(safe_name)[0]
            doc.requested_lane = lane
            doc.parse_status = "pending"
            doc.index_status = "pending"
            doc.actual_parse_lane = None
            doc.error_message = None
            doc.status = "uploaded"
            doc.source_kind = source_kind
            doc.metadata_json = {**(doc.metadata_json or {}), **metadata_json}
        session.commit()
        session.refresh(doc)
        log_instant_event(
            trace_id="upload_" + doc.id.replace("-", ""),
            service="control-api",
            route="upload.accepted",
            status="ok",
            details={
                "document_id": doc.id,
                "corpus": target_corpus,
                "filename": safe_name,
                "policy_lane": lane,
                "source_kind": source_kind,
                "size_bytes": size_bytes,
            },
        )
        return UploadView(
            id=doc.id,
            corpus=doc.corpus,
            filename=doc.filename,
            policy_lane=doc.requested_lane,
            status=doc.status,
        )

    @app.post("/api/sync", response_model=TaskView)
    def api_sync(
        request: Request,
        background_tasks: BackgroundTasks,
        body: SyncRequest = SyncRequest(),
        session: Session = Depends(get_session),
    ) -> TaskView:
        corpus = body.corpus or settings.app_default_corpus
        existing = session.scalar(
            select(IngestionRunRecord)
            .where(
                IngestionRunRecord.corpus == corpus,
                IngestionRunRecord.status.in_(("pending", "running")),
            )
            .order_by(IngestionRunRecord.created_at.desc())
        )
        if existing is not None:
            background_tasks.add_task(trigger_ingestion_run, existing.id, request.state.trace_id)
            log_instant_event(
                trace_id=request.state.trace_id,
                service="control-api",
                route="sync.reused",
                status="ok",
                details={"run_id": existing.id, "corpus": corpus, "runtime_retriggered": True},
            )
            return _run_to_view(existing, session)

        run = IngestionRunRecord(
            run_type="full_sync",
            corpus=corpus,
            status="pending",
            current_step="queued",
            progress=0.0,
            trace_id=request.state.trace_id,
            payload_json={"corpus": corpus},
        )
        session.add(run)
        session.commit()
        session.refresh(run)
        background_tasks.add_task(trigger_ingestion_run, run.id, request.state.trace_id)
        log_instant_event(
            trace_id=request.state.trace_id,
            service="control-api",
            route="sync.queued",
            status="ok",
            details={"run_id": run.id, "corpus": corpus},
        )
        return _run_to_view(run, session)

    @app.get("/api/tasks/{task_id}", response_model=TaskView)
    def api_task(task_id: str, session: Session = Depends(get_session)) -> TaskView:
        run = session.get(IngestionRunRecord, task_id)
        if run is None:
            raise HTTPException(404, "task not found")
        return _run_to_view(run, session)

    @app.get("/api/runs", response_model=list[RunSummaryView])
    def api_runs(corpus: str | None = None, session: Session = Depends(get_session)) -> list[RunSummaryView]:
        statement = select(IngestionRunRecord).order_by(IngestionRunRecord.created_at.desc())
        if corpus:
            statement = statement.where(IngestionRunRecord.corpus == corpus)
        runs = list(session.scalars(statement.limit(20)))
        return [_run_summary_to_view(run) for run in runs]

    @app.get("/api/documents", response_model=list[DocumentIngestionView])
    def api_documents(corpus: str | None = None, session: Session = Depends(get_session)) -> list[DocumentIngestionView]:
        statement = select(DocumentRecord).order_by(DocumentRecord.updated_at.desc())
        if corpus:
            statement = statement.where(DocumentRecord.corpus == corpus)
        docs = list(session.scalars(statement.limit(50)))
        if not docs:
            return []
        doc_ids = [doc.id for doc in docs]

        artifact_map: dict[str, list[str]] = {doc_id: [] for doc_id in doc_ids}
        for row in session.scalars(
            select(RetrievalArtifactRecord).where(RetrievalArtifactRecord.document_id.in_(doc_ids))
        ):
            artifact_map.setdefault(row.document_id, [])
            if row.artifact_type not in artifact_map[row.document_id]:
                artifact_map[row.document_id].append(row.artifact_type)

        workbook_ids_by_doc = {
            row.document_id: row.id
            for row in session.scalars(
                select(WorkbookArtifactRecord).where(WorkbookArtifactRecord.document_id.in_(doc_ids))
            )
        }
        sheet_count_by_doc = {doc_id: 0 for doc_id in doc_ids}
        table_count_by_doc = {doc_id: 0 for doc_id in doc_ids}
        row_count_by_doc = {doc_id: 0 for doc_id in doc_ids}
        if workbook_ids_by_doc:
            workbook_ids = list(workbook_ids_by_doc.values())
            sheet_counts = {
                workbook_id: count
                for workbook_id, count in session.execute(
                    select(WorkbookSheetRecord.workbook_artifact_id, func.count(WorkbookSheetRecord.id)).where(
                        WorkbookSheetRecord.workbook_artifact_id.in_(workbook_ids)
                    ).group_by(WorkbookSheetRecord.workbook_artifact_id)
                )
            }
            sheet_ids = [
                row.id
                for row in session.scalars(
                    select(WorkbookSheetRecord).where(WorkbookSheetRecord.workbook_artifact_id.in_(workbook_ids))
                )
            ]
            table_counts = {
                sheet_id: count
                for sheet_id, count in session.execute(
                    select(WorkbookTableRecord.workbook_sheet_id, func.count(WorkbookTableRecord.id)).where(
                        WorkbookTableRecord.workbook_sheet_id.in_(sheet_ids or [""])
                    ).group_by(WorkbookTableRecord.workbook_sheet_id)
                )
            }
            table_ids = [
                row.id
                for row in session.scalars(
                    select(WorkbookTableRecord).where(WorkbookTableRecord.workbook_sheet_id.in_(sheet_ids or [""]))
                )
            ]
            row_counts = {
                table_id: count
                for table_id, count in session.execute(
                    select(WorkbookRowRecord.workbook_table_id, func.count(WorkbookRowRecord.id)).where(
                        WorkbookRowRecord.workbook_table_id.in_(table_ids or [""])
                    ).group_by(WorkbookRowRecord.workbook_table_id)
                )
            }
            sheets_by_id = {
                row.id: row
                for row in session.scalars(
                    select(WorkbookSheetRecord).where(WorkbookSheetRecord.id.in_(sheet_ids or [""]))
                )
            }
            tables = list(
                session.scalars(
                    select(WorkbookTableRecord).where(WorkbookTableRecord.id.in_(table_ids or [""]))
                )
            )
            for doc_id, workbook_id in workbook_ids_by_doc.items():
                sheet_count_by_doc[doc_id] = sheet_counts.get(workbook_id, 0)
            for table in tables:
                sheet = sheets_by_id.get(table.workbook_sheet_id)
                if not sheet:
                    continue
                doc_id = next(
                    (document_id for document_id, workbook_id in workbook_ids_by_doc.items() if workbook_id == sheet.workbook_artifact_id),
                    None,
                )
                if not doc_id:
                    continue
                table_count_by_doc[doc_id] += table_counts.get(sheet.id, 0)
                row_count_by_doc[doc_id] += row_counts.get(table.id, 0)

        return [
            _document_to_view(
                doc,
                artifact_map.get(doc.id, []),
                sheet_count_by_doc.get(doc.id, 0),
                table_count_by_doc.get(doc.id, 0),
                row_count_by_doc.get(doc.id, 0),
            )
            for doc in docs
        ]

    return app


app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run(
        "ghostdash_api.control_api:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        access_log=False,
        log_config=None,
    )


if __name__ == "__main__":
    run()
