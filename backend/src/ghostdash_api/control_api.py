from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import shutil
import time
from pathlib import Path
from typing import cast
from uuid import uuid4

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import PlainTextResponse
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from .agent_memory import (
    append_document_frame_fragment,
    create_conversation,
    create_document_frame,
    get_agent,
    get_document_frame,
    list_agents,
    list_conversations,
    list_messages,
    save_agent,
    seed_default_agent_profiles,
)
from .collections import (
    collection_delete_impact,
    delete_collection_and_storage,
    ensure_collection_record,
    get_collection,
    get_collection_by_slug,
    list_collections,
)
from .database import get_session
from .database import SessionLocal
from .ingest import extract_text_local
from .models import (
    AgentConversationRecord,
    AgentMessageRecord,
    AgentProfileRecord,
    ChatResponseCacheRecord,
    ChatUploadRecord,
    CollectionRecord,
    ConnectionRecord,
    DocxSessionRecord,
    DocumentFrameRecord,
    DocumentRecord,
    IngestionRunRecord,
    RetrievalArtifactRecord,
    RuntimeProfileRecord,
    WorkflowRunEventRecord,
    RuntimeProfileCollectionRecord,
    WorkflowTaskRecord,
    WorkflowRunRecord,
    WorkflowStepRunRecord,
    WorkbookArtifactRecord,
    WorkbookRowRecord,
    WorkbookSheetRecord,
    WorkbookTableRecord,
)
from .runtime import (
    delete_connection,
    get_active_connection,
    list_connections,
    save_connection,
    seed_default_connections,
    test_provider_connection,
)
from .runtime_defaults import get_runtime_defaults, save_runtime_defaults
from .runtime_profiles import (
    get_default_runtime_profile,
    list_policy_change_audits,
    resolve_agent_runtime_profile,
    seed_default_runtime_profile,
)
from .schemas import (
    AgentDeletePayload,
    AgentDeleteResponse,
    AgentHierarchyView,
    ConnectionDeletePayload,
    ConnectionDeleteResponse,
    ConnectionDeletionPreviewView,
    AgentDeletionPreviewPayload,
    AgentDeletionPreviewView,
    AgentProfilePayload,
    AgentProfileView,
    CapabilityStatus,
    ChatBootstrapFeatures,
    ChatBootstrapView,
    ChatUploadDecisionPayload,
    ChatUploadView,
    CollectionCreatePayload,
    CollectionDeleteResponse,
    CollectionImpactView,
    CollectionView,
    ConnectionPayload,
    ConnectionTestPayload,
    ConnectionTestResponse,
    ConnectionView,
    ConversationCreatePayload,
    DocumentFrameFragmentCreatePayload,
    DocumentFrameFragmentView,
    DocumentFrameView,
    ConversationMessageView,
    ConversationSummaryView,
    DocumentArtifactView,
    DocumentIngestionView,
    RuntimeCapabilities,
    RuntimeDefaultsPayload,
    RuntimeDefaultsView,
    PolicyChangeAuditView,
    ConfigExplorerEntryView,
    RuntimeProfileView,
    RunSummaryView,
    RequestedParseLane,
    SyncRequest,
    TaskDocumentView,
    TaskStepView,
    TaskView,
    UploadView,
    VectorStatsView,
    ToolActivationPayload,
    ToolCatalogEntryView,
    ToolDetailView,
    ToolExecutePayload,
    ToolExecuteResponse,
    ToolPolicyPayload,
    ToolPolicyView,
    ToolSettingsPayload,
    ToolTestResponse,
    WorkflowDefinitionImportPayload,
    WorkflowDefinitionPayload,
    WorkflowDefinitionView,
    WorkflowRunCreatePayload,
    WorkflowRunSummaryView,
    WorkflowRunUpdatePayload,
    WorkflowRunView,
    WorkflowRunEventView,
    WorkflowTaskView,
    WorkflowStepRunUpdatePayload,
    WorkflowStepRunView,
)
from .service_common import build_app
from .settings import get_settings
from .telemetry import log_instant_event, new_span_id
from .tool_registry import (
    execute_tool_operation,
    get_agent_tool_policy,
    get_tool_detail,
    list_tool_catalog,
    run_tool_test,
    set_tool_activation,
    update_agent_tool_policy,
    update_tool_settings,
)
from .workflow_definition_io import dump_workflow_definition_text, parse_workflow_definition_text
from .workflow_run_executor import (
    cancel_workflow_run_execution,
    initialize_workflow_run_executor_state,
    schedule_workflow_run_execution,
)
from .workflow_runs import (
    create_workflow_run,
    get_workflow_run,
    get_workflow_definition,
    list_workflow_definitions,
    list_workflow_run_events,
    list_workflow_runs,
    list_workflow_steps,
    list_workflow_tasks,
    seed_workflow_definitions,
    upsert_workflow_definition,
    update_workflow_run,
    update_workflow_step_run,
)

settings = get_settings()
ACTIVE_WORKFLOW_RUN_STATUSES = {"queued", "running"}
ACTIVE_WORKFLOW_STEP_STATUSES = {"pending", "running"}


def initialize_control_runtime_state() -> None:
    with SessionLocal() as session:
        seed_default_connections(session)
        seed_default_runtime_profile(session)
        seed_default_agent_profiles(session)
        seed_workflow_definitions(session)
    initialize_workflow_run_executor_state()


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


def _map_connection_test_exception(exc: Exception) -> tuple[int, str]:
    if isinstance(exc, ValueError):
        return 400, str(exc)
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError)):
        return 503, "Connection test failed: provider is unreachable or timed out."

    response = getattr(exc, "response", None)
    status_code = getattr(exc, "status_code", None)
    if status_code is None and response is not None:
        status_code = getattr(response, "status_code", None)

    if status_code in (401, 403):
        return 401, "Connection test failed: authentication with provider was rejected."
    if status_code == 404:
        response_json = None
        if response is not None and hasattr(response, "json"):
            try:
                response_json = response.json()
            except ValueError:
                response_json = None
        error_payload = response_json.get("error") if isinstance(response_json, dict) else None
        error_code = error_payload.get("code") if isinstance(error_payload, dict) else None
        if error_code == "model_not_found":
            return 400, "Connection test failed: configured model is not available."
        return 502, "Connection test failed: provider endpoint was not found."
    if status_code == 400:
        return 400, "Connection test failed: provider rejected the request."
    if status_code == 429:
        return 503, "Connection test failed: provider rate limit exceeded. Retry shortly."
    if isinstance(status_code, int) and status_code >= 500:
        return 503, "Connection test failed: provider service is unavailable."

    return 502, "Connection test failed due to an unexpected upstream provider error."


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
                actual_parse_lane=document.actual_parse_lane,
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


def _workflow_step_to_view(step: WorkflowStepRunRecord) -> WorkflowStepRunView:
    return WorkflowStepRunView(
        id=step.id,
        sequence=step.sequence,
        node_id=step.node_id,
        node_type=step.node_type,
        status=step.status,
        agent_id=step.agent_id,
        agent_name=step.agent_name,
        conversation_id=step.conversation_id,
        output_text=step.output_text,
        citations=step.citations_json or [],
        error_message=step.error_message,
        metadata_json=step.metadata_json or {},
        started_at=step.started_at,
        completed_at=step.completed_at,
        created_at=step.created_at,
        updated_at=step.updated_at,
    )


def _workflow_definition_to_view(definition) -> WorkflowDefinitionView:
    payload = dict(definition.definition_json or {})
    return WorkflowDefinitionView(
        workflow_id=payload.get("workflow_id", definition.workflow_id),
        version=payload.get("version", definition.version),
        name=payload.get("name", definition.name),
        execution_mode=payload.get("execution_mode", definition.execution_mode),
        min_agents=payload.get("min_agents", 1),
        max_agents=payload.get("max_agents", 1),
        persist_child_conversations=payload.get("persist_child_conversations", True),
        head_agent=payload.get("head_agent"),
        nodes=payload.get("nodes", []),
        enabled=definition.enabled,
        created_at=definition.created_at,
        updated_at=definition.updated_at,
    )


def _workflow_task_to_view(task: WorkflowTaskRecord) -> WorkflowTaskView:
    return WorkflowTaskView(
        id=task.id,
        task_key=task.task_key,
        title=task.title,
        task_kind=task.task_kind,
        status=task.status,
        sequence=task.sequence,
        depends_on_task_keys=task.depends_on_task_keys_json or [],
        assigned_agent_id=task.assigned_agent_id,
        assigned_agent_name=task.assigned_agent_name,
        step_run_id=task.step_run_id,
        metadata_json=task.metadata_json or {},
        started_at=task.started_at,
        completed_at=task.completed_at,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


def _workflow_run_event_to_view(event: WorkflowRunEventRecord) -> WorkflowRunEventView:
    return WorkflowRunEventView(
        id=event.id,
        sequence=event.sequence,
        event_type=event.event_type,
        task_key=event.task_key,
        actor_id=event.actor_id,
        metadata_json=event.metadata_json or {},
        created_at=event.created_at,
        updated_at=event.updated_at,
    )


def _workflow_run_summary_to_view(run: WorkflowRunRecord) -> WorkflowRunSummaryView:
    workflow_metadata = dict((run.result_json or {}).get("workflow", {}))
    return WorkflowRunSummaryView(
        id=run.id,
        workflow_id=run.workflow_id,
        workflow_name=workflow_metadata.get("name"),
        surface=run.surface,
        execution_mode=run.execution_mode,
        status=run.status,
        current_step=run.current_step,
        progress=run.progress,
        prompt=run.prompt,
        requested_agent_ids=run.requested_agent_ids_json or [],
        head_agent_id=workflow_metadata.get("head_agent_id"),
        head_agent_name=workflow_metadata.get("head_agent_name"),
        parent_conversation_id=run.parent_conversation_id,
        error_message=run.error_message,
        result_json=run.result_json or {},
        created_at=run.created_at,
        updated_at=run.updated_at,
    )


def _workflow_run_to_view(run: WorkflowRunRecord, session: Session) -> WorkflowRunView:
    return WorkflowRunView(
        **_workflow_run_summary_to_view(run).model_dump(),
        started_at=run.started_at,
        completed_at=run.completed_at,
        steps=[_workflow_step_to_view(step) for step in list_workflow_steps(session, run.id)],
        tasks=[_workflow_task_to_view(task) for task in list_workflow_tasks(session, run.id)],
        events=[_workflow_run_event_to_view(event) for event in list_workflow_run_events(session, run.id)],
    )


def _runtime_profile_to_view(runtime_profile) -> RuntimeProfileView:
    guardrails_config = dict(runtime_profile.guardrails_config_json or {})
    if not str(guardrails_config.get("policy_mode") or "").strip():
        guardrails_config["policy_mode"] = "admin_approval_required"
    return RuntimeProfileView(
        id=runtime_profile.id,
        name=runtime_profile.name,
        description=runtime_profile.description,
        llm_config=runtime_profile.llm_config_json or {},
        guardrails_config=guardrails_config,
        kb_config=runtime_profile.kb_config_json or {},
        retrieval_config=runtime_profile.retrieval_config_json or {},
        tool_policy_config=runtime_profile.tool_policy_config_json or {},
        is_default=runtime_profile.is_default,
        enabled=runtime_profile.enabled,
        created_at=runtime_profile.created_at,
        updated_at=runtime_profile.updated_at,
    )


def _policy_change_audit_to_view(record) -> PolicyChangeAuditView:
    payload = dict(record.payload_json or {})
    response = dict(record.response_json or {})
    return PolicyChangeAuditView(
        id=record.id,
        runtime_profile_id=str(record.policy_decision_id or payload.get("runtime_profile_id") or ""),
        actor=record.actor_agent_id or "unknown",
        action=record.operation,
        status=record.status,
        policy_mode=str(payload.get("policy_mode") or "admin_approval_required"),
        reason=payload.get("reason"),
        approval_token=record.approval_token,
        before_json=dict(payload.get("before") or {}),
        after_json=dict(response.get("after") or {}),
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _build_config_explorer_entries(session: Session) -> list[ConfigExplorerEntryView]:
    rows = list(session.scalars(select(RuntimeProfileRecord).order_by(RuntimeProfileRecord.updated_at.desc())))
    entries: list[ConfigExplorerEntryView] = []
    for row in rows:
        chunks = [
            ("guardrails", dict(row.guardrails_config_json or {})),
            ("llm", dict(row.llm_config_json or {})),
            ("kb", dict(row.kb_config_json or {})),
            ("retrieval", dict(row.retrieval_config_json or {})),
            ("tool_policy", dict(row.tool_policy_config_json or {})),
        ]
        for namespace, payload in chunks:
            entries.append(
                ConfigExplorerEntryView(
                    key=f"runtime_profile.{row.id}.{namespace}",
                    namespace=namespace,
                    source_type="runtime_profile",
                    source_id=row.id,
                    source_name=row.name,
                    value_json=payload,
                    updated_at=row.updated_at,
                )
            )
    return entries


def _compute_vector_stats(session: Session, corpus: str | None = None) -> VectorStatsView:
    document_count_stmt = select(func.count(DocumentRecord.id))
    artifact_count_stmt = select(func.count(RetrievalArtifactRecord.id))
    workbook_row_count_stmt = select(func.count(WorkbookRowRecord.id))
    filename_stmt = select(DocumentRecord.filename)

    if corpus:
        document_count_stmt = document_count_stmt.where(DocumentRecord.corpus == corpus)
        artifact_count_stmt = artifact_count_stmt.where(RetrievalArtifactRecord.corpus == corpus)
        filename_stmt = filename_stmt.where(DocumentRecord.corpus == corpus)
        workbook_row_count_stmt = workbook_row_count_stmt.join(
            WorkbookTableRecord, WorkbookTableRecord.id == WorkbookRowRecord.workbook_table_id
        ).join(
            WorkbookSheetRecord, WorkbookSheetRecord.id == WorkbookTableRecord.workbook_sheet_id
        ).join(
            WorkbookArtifactRecord, WorkbookArtifactRecord.id == WorkbookSheetRecord.workbook_artifact_id
        ).where(
            WorkbookArtifactRecord.document_id.in_(
                select(DocumentRecord.id).where(DocumentRecord.corpus == corpus)
            )
        )

    filenames = [str(name or "").lower() for name in session.scalars(filename_stmt)]

    return VectorStatsView(
        documents=int(session.scalar(document_count_stmt) or 0),
        retrieval_artifacts=int(session.scalar(artifact_count_stmt) or 0),
        workbook_rows=int(session.scalar(workbook_row_count_stmt) or 0),
        pdf_documents=sum(1 for name in filenames if name.endswith(".pdf")),
        xlsx_documents=sum(1 for name in filenames if name.endswith(".xlsx") or name.endswith(".xlsm")),
        txt_documents=sum(
            1
            for name in filenames
            if name.endswith(".txt") or name.endswith(".md") or name.endswith(".csv") or name.endswith(".json")
        ),
        other_documents=sum(
            1
            for name in filenames
            if not (
                name.endswith(".pdf")
                or name.endswith(".xlsx")
                or name.endswith(".xlsm")
                or name.endswith(".txt")
                or name.endswith(".md")
                or name.endswith(".csv")
                or name.endswith(".json")
            )
        ),
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
        agent_role=cast(str, agent.agent_role or "lead"),
        parent_agent_id=agent.parent_agent_id,
        position=int(agent.position or 0),
        is_default=agent.is_default,
        enabled=agent.enabled,
        created_at=agent.created_at,
        updated_at=agent.updated_at,
    )


def _collection_to_view(collection: CollectionRecord, session: Session, *, include_impact: bool = False) -> CollectionView:
    attached_runtime_profile_ids = list(
        session.scalars(
            select(RuntimeProfileCollectionRecord.runtime_profile_id).where(
                RuntimeProfileCollectionRecord.collection_id == collection.id
            )
        )
    )
    attached_agent_ids = list(
        session.scalars(
            select(AgentProfileRecord.id).where(AgentProfileRecord.runtime_profile_id.in_(attached_runtime_profile_ids or [""]))
        )
    )
    impact = CollectionImpactView(**collection_delete_impact(session, collection)) if include_impact else None
    return CollectionView(
        id=collection.id,
        slug=collection.slug,
        name=collection.name,
        description=collection.description,
        status=collection.status,
        embedding_model_id=collection.embedding_model_id,
        attached_runtime_profile_ids=attached_runtime_profile_ids,
        attached_agent_ids=attached_agent_ids,
        impact=impact,
        created_at=collection.created_at,
        updated_at=collection.updated_at,
    )


def _conversation_to_view(conversation: AgentConversationRecord, message_count: int) -> ConversationSummaryView:
    return ConversationSummaryView(
        id=conversation.id,
        agent_id=conversation.agent_id,
        title=conversation.title,
        corpora=conversation.corpora_json or [],
        api_mode=conversation.api_mode,
        conversation_mode=conversation.conversation_mode,
        workflow_mode=cast(str, conversation.workflow_mode or "standard"),
        document_frame_id=conversation.document_frame_id,
        message_count=message_count,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
    )


def _workflow_run_requests_agent(run: WorkflowRunRecord, agent_id: str) -> bool:
    requested = list(run.requested_agent_ids_json or [])
    for value in requested:
        if str(value) == agent_id:
            return True
    return False


def _build_agent_deletion_preview(
    session: Session,
    *,
    agent: AgentProfileRecord,
    scope: str,
) -> AgentDeletionPreviewView:
    conversation_ids = list(
        session.scalars(
            select(AgentConversationRecord.id).where(AgentConversationRecord.agent_id == agent.id)
        )
    )
    frame_ids = list(
        {
            frame_id
            for frame_id in session.scalars(
                select(AgentConversationRecord.document_frame_id).where(
                    AgentConversationRecord.agent_id == agent.id,
                    AgentConversationRecord.document_frame_id.is_not(None),
                )
            )
            if frame_id
        }
    )
    orphanable_frames = 0
    for frame_id in frame_ids:
        linked_count = int(
            session.scalar(
                select(func.count())
                .select_from(AgentConversationRecord)
                .where(AgentConversationRecord.document_frame_id == frame_id)
            )
            or 0
        )
        if linked_count <= 1:
            orphanable_frames += 1

    if conversation_ids:
        messages_count = int(
            session.scalar(
                select(func.count())
                .select_from(AgentMessageRecord)
                .where(AgentMessageRecord.conversation_id.in_(conversation_ids))
            )
            or 0
        )
        uploads_count = int(
            session.scalar(
                select(func.count())
                .select_from(ChatUploadRecord)
                .where(ChatUploadRecord.conversation_id.in_(conversation_ids))
            )
            or 0
        )
        docx_sessions_count = int(
            session.scalar(
                select(func.count())
                .select_from(DocxSessionRecord)
                .where(DocxSessionRecord.conversation_id.in_(conversation_ids))
            )
            or 0
        )
        workflow_step_runs_count = int(
            session.scalar(
                select(func.count())
                .select_from(WorkflowStepRunRecord)
                .where(
                    or_(
                        WorkflowStepRunRecord.conversation_id.in_(conversation_ids),
                        WorkflowStepRunRecord.agent_id == agent.id,
                    )
                )
            )
            or 0
        )
        active_workflow_steps_count = int(
            session.scalar(
                select(func.count())
                .select_from(WorkflowStepRunRecord)
                .join(WorkflowRunRecord, WorkflowRunRecord.id == WorkflowStepRunRecord.run_id)
                .where(
                    or_(
                        WorkflowStepRunRecord.conversation_id.in_(conversation_ids),
                        WorkflowStepRunRecord.agent_id == agent.id,
                    ),
                    WorkflowRunRecord.status.in_(tuple(ACTIVE_WORKFLOW_RUN_STATUSES)),
                    WorkflowStepRunRecord.status.in_(tuple(ACTIVE_WORKFLOW_STEP_STATUSES)),
                )
            )
            or 0
        )
    else:
        messages_count = 0
        uploads_count = 0
        docx_sessions_count = 0
        workflow_step_runs_count = int(
            session.scalar(
                select(func.count())
                .select_from(WorkflowStepRunRecord)
                .where(WorkflowStepRunRecord.agent_id == agent.id)
            )
            or 0
        )
        active_workflow_steps_count = int(
            session.scalar(
                select(func.count())
                .select_from(WorkflowStepRunRecord)
                .join(WorkflowRunRecord, WorkflowRunRecord.id == WorkflowStepRunRecord.run_id)
                .where(
                    WorkflowStepRunRecord.agent_id == agent.id,
                    WorkflowRunRecord.status.in_(tuple(ACTIVE_WORKFLOW_RUN_STATUSES)),
                    WorkflowStepRunRecord.status.in_(tuple(ACTIVE_WORKFLOW_STEP_STATUSES)),
                )
            )
            or 0
        )

    cache_entries_count = int(
        session.scalar(
            select(func.count())
            .select_from(ChatResponseCacheRecord)
            .where(ChatResponseCacheRecord.agent_id == agent.id)
        )
        or 0
    )
    active_runs = list(
        session.scalars(
            select(WorkflowRunRecord).where(WorkflowRunRecord.status.in_(tuple(ACTIVE_WORKFLOW_RUN_STATUSES)))
        )
    )
    active_workflow_runs_count = 0
    for run in active_runs:
        if _workflow_run_requests_agent(run, agent.id) or (
            run.parent_conversation_id is not None and run.parent_conversation_id in conversation_ids
        ):
            active_workflow_runs_count += 1

    runtime_profile_peer_agents = 0
    if scope == "agent" and agent.runtime_profile_id:
        runtime_profile_peer_agents = int(
            session.scalar(
                select(func.count())
                .select_from(AgentProfileRecord)
                .where(
                    AgentProfileRecord.runtime_profile_id == agent.runtime_profile_id,
                    AgentProfileRecord.id != agent.id,
                )
            )
            or 0
        )

    blocking_reasons: list[str] = []
    if scope == "agent" and agent.is_default:
        blocking_reasons.append("default_agent_protected")
    if active_workflow_runs_count > 0:
        blocking_reasons.append("active_workflow_runs")
    if active_workflow_steps_count > 0:
        blocking_reasons.append("active_workflow_steps")

    confirmation_payload = {
        "agent_id": agent.id,
        "scope": scope,
        "conversations": len(conversation_ids),
        "messages": messages_count,
        "uploads": uploads_count,
        "docx_sessions": docx_sessions_count,
        "cache_entries": cache_entries_count,
        "workflow_step_runs": workflow_step_runs_count,
        "active_workflow_runs": active_workflow_runs_count,
        "active_workflow_steps": active_workflow_steps_count,
        "runtime_profile_peer_agents": runtime_profile_peer_agents,
    }
    confirmation_token = hashlib.sha256(str(confirmation_payload).encode("utf-8")).hexdigest()[:24]

    return AgentDeletionPreviewView(
        agent_id=agent.id,
        scope=cast(str, scope),
        can_execute=not blocking_reasons,
        is_default_agent=agent.is_default,
        blocking_reasons=blocking_reasons,
        impact={
            "conversations": len(conversation_ids),
            "messages": messages_count,
            "uploads": uploads_count,
            "docx_sessions": docx_sessions_count,
            "cache_entries": cache_entries_count,
            "workflow_step_runs": workflow_step_runs_count,
            "document_frames_linked": len(frame_ids),
            "orphanable_document_frames": orphanable_frames,
            "active_workflow_runs": active_workflow_runs_count,
            "active_workflow_steps": active_workflow_steps_count,
            "runtime_profile_peer_agents": runtime_profile_peer_agents,
        },
        confirmation_token=confirmation_token,
    )


def _delete_agent_conversations(session: Session, *, agent_id: str) -> dict[str, int]:
    conversation_ids = list(
        session.scalars(
            select(AgentConversationRecord.id).where(AgentConversationRecord.agent_id == agent_id)
        )
    )
    frame_ids = list(
        {
            frame_id
            for frame_id in session.scalars(
                select(AgentConversationRecord.document_frame_id).where(
                    AgentConversationRecord.agent_id == agent_id,
                    AgentConversationRecord.document_frame_id.is_not(None),
                )
            )
            if frame_id
        }
    )
    orphanable_frame_ids: list[str] = []
    for frame_id in frame_ids:
        linked_count = int(
            session.scalar(
                select(func.count())
                .select_from(AgentConversationRecord)
                .where(AgentConversationRecord.document_frame_id == frame_id)
            )
            or 0
        )
        if linked_count <= 1:
            orphanable_frame_ids.append(frame_id)

    deleted_messages = 0
    deleted_uploads = 0
    deleted_docx_sessions = 0
    deleted_conversations = 0
    deleted_workflow_step_runs = 0
    deleted_document_frames = 0
    if conversation_ids:
        deleted_messages = int(
            session.execute(
                delete(AgentMessageRecord).where(AgentMessageRecord.conversation_id.in_(conversation_ids))
            ).rowcount
            or 0
        )
        deleted_uploads = int(
            session.execute(
                delete(ChatUploadRecord).where(ChatUploadRecord.conversation_id.in_(conversation_ids))
            ).rowcount
            or 0
        )
        deleted_docx_sessions = int(
            session.execute(
                delete(DocxSessionRecord).where(DocxSessionRecord.conversation_id.in_(conversation_ids))
            ).rowcount
            or 0
        )
        deleted_workflow_step_runs = int(
            session.execute(
                delete(WorkflowStepRunRecord).where(
                    or_(
                        WorkflowStepRunRecord.conversation_id.in_(conversation_ids),
                        WorkflowStepRunRecord.agent_id == agent_id,
                    )
                )
            ).rowcount
            or 0
        )
        deleted_conversations = int(
            session.execute(
                delete(AgentConversationRecord).where(AgentConversationRecord.id.in_(conversation_ids))
            ).rowcount
            or 0
        )
    else:
        deleted_workflow_step_runs = int(
            session.execute(
                delete(WorkflowStepRunRecord).where(WorkflowStepRunRecord.agent_id == agent_id)
            ).rowcount
            or 0
        )

    deleted_cache_entries = int(
        session.execute(
            delete(ChatResponseCacheRecord).where(ChatResponseCacheRecord.agent_id == agent_id)
        ).rowcount
        or 0
    )
    if orphanable_frame_ids:
        deleted_document_frames = int(
            session.execute(
                delete(DocumentFrameRecord).where(DocumentFrameRecord.id.in_(orphanable_frame_ids))
            ).rowcount
            or 0
        )

    session.commit()
    return {
        "deleted_conversations": deleted_conversations,
        "deleted_messages": deleted_messages,
        "deleted_uploads": deleted_uploads,
        "deleted_docx_sessions": deleted_docx_sessions,
        "deleted_cache_entries": deleted_cache_entries,
        "deleted_workflow_step_runs": deleted_workflow_step_runs,
        "deleted_document_frames": deleted_document_frames,
    }


def _build_connection_deletion_preview(
    session: Session,
    *,
    connection: ConnectionRecord,
) -> ConnectionDeletionPreviewView:
    runtime_profiles = list(session.scalars(select(RuntimeProfileRecord)))

    runtime_profile_direct_refs = 0
    runtime_profile_provider_refs = 0
    runtime_profile_fallback_refs = 0
    runtime_profile_fallback_provider_refs = 0
    impacted_runtime_profile_ids: set[str] = set()

    for profile in runtime_profiles:
        llm_config = dict(profile.llm_config_json or {})
        llm_orchestration = dict(llm_config.get("llm_orchestration") or {})
        connection_id = str(llm_config.get("connection_id") or "").strip() or None
        provider = str(llm_config.get("provider") or "").strip()
        fallback_connection_id = str(llm_orchestration.get("fallback_connection_id") or "").strip() or None
        fallback_provider = str(llm_orchestration.get("fallback_provider") or "").strip()

        profile_impacted = False
        if connection_id and connection_id == connection.id:
            runtime_profile_direct_refs += 1
            profile_impacted = True
        elif not connection_id and provider and provider == connection.provider:
            runtime_profile_provider_refs += 1
            profile_impacted = True

        if fallback_connection_id and fallback_connection_id == connection.id:
            runtime_profile_fallback_refs += 1
            profile_impacted = True
        elif not fallback_connection_id and fallback_provider and fallback_provider == connection.provider:
            runtime_profile_fallback_provider_refs += 1
            profile_impacted = True

        if profile_impacted:
            impacted_runtime_profile_ids.add(profile.id)

    impacted_agent_ids = list(
        session.scalars(
            select(AgentProfileRecord.id).where(
                AgentProfileRecord.runtime_profile_id.in_(list(impacted_runtime_profile_ids) or [""])
            )
        )
    )
    agents_impacted = len(impacted_agent_ids)

    active_workflow_runs_count = 0
    active_workflow_steps_count = 0
    if impacted_agent_ids:
        active_runs = list(
            session.scalars(
                select(WorkflowRunRecord).where(WorkflowRunRecord.status.in_(tuple(ACTIVE_WORKFLOW_RUN_STATUSES)))
            )
        )
        impacted_agent_ids_set = set(impacted_agent_ids)
        for run in active_runs:
            requested = {str(value) for value in list(run.requested_agent_ids_json or [])}
            if requested.intersection(impacted_agent_ids_set):
                active_workflow_runs_count += 1

        active_workflow_steps_count = int(
            session.scalar(
                select(func.count())
                .select_from(WorkflowStepRunRecord)
                .where(
                    WorkflowStepRunRecord.agent_id.in_(impacted_agent_ids),
                    WorkflowStepRunRecord.status.in_(tuple(ACTIVE_WORKFLOW_STEP_STATUSES)),
                )
            )
            or 0
        )

    runtime_defaults = get_runtime_defaults(session)
    is_runtime_default_connection = bool(runtime_defaults.get("llm_connection_id") == connection.id)
    seeded_provider_key = connection.provider in {"openai", "google-gemini"}

    blocking_reasons: list[str] = []
    if seeded_provider_key:
        blocking_reasons.append("seeded_provider_protected")
    if is_runtime_default_connection:
        blocking_reasons.append("runtime_defaults_reference")
    if (
        runtime_profile_direct_refs
        or runtime_profile_provider_refs
        or runtime_profile_fallback_refs
        or runtime_profile_fallback_provider_refs
    ):
        blocking_reasons.append("runtime_profile_references")
    if active_workflow_runs_count > 0:
        blocking_reasons.append("active_workflow_runs")
    if active_workflow_steps_count > 0:
        blocking_reasons.append("active_workflow_steps")

    confirmation_payload = {
        "connection_id": connection.id,
        "provider": connection.provider,
        "runtime_profile_direct_refs": runtime_profile_direct_refs,
        "runtime_profile_provider_refs": runtime_profile_provider_refs,
        "runtime_profile_fallback_refs": runtime_profile_fallback_refs,
        "runtime_profile_fallback_provider_refs": runtime_profile_fallback_provider_refs,
        "agents_impacted": agents_impacted,
        "active_workflow_runs": active_workflow_runs_count,
        "active_workflow_steps": active_workflow_steps_count,
        "is_runtime_default_connection": is_runtime_default_connection,
        "seeded_provider_key": seeded_provider_key,
    }
    confirmation_token = hashlib.sha256(str(confirmation_payload).encode("utf-8")).hexdigest()[:24]

    return ConnectionDeletionPreviewView(
        connection_id=connection.id,
        provider=connection.provider,
        can_execute=not blocking_reasons,
        blocking_reasons=blocking_reasons,
        impact={
            "runtime_profile_direct_refs": runtime_profile_direct_refs,
            "runtime_profile_provider_refs": runtime_profile_provider_refs,
            "runtime_profile_fallback_refs": runtime_profile_fallback_refs,
            "runtime_profile_fallback_provider_refs": runtime_profile_fallback_provider_refs,
            "agents_impacted": agents_impacted,
            "active_workflow_runs": active_workflow_runs_count,
            "active_workflow_steps": active_workflow_steps_count,
            "is_runtime_default_connection": is_runtime_default_connection,
            "seeded_provider_key": seeded_provider_key,
        },
        confirmation_token=confirmation_token,
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
        tool_events=message.tool_events_json or [],
        usage=message.usage_json,
        route_decision=message.route_decision_json,
        api_mode=message.api_mode,
        conversation_mode=message.conversation_mode,
        workflow_mode=cast(str | None, message.workflow_mode),
        created_at=message.created_at,
    )


def _document_frame_to_view(frame: DocumentFrameRecord) -> DocumentFrameView:
    fragments = [
        DocumentFrameFragmentView(**fragment)
        for fragment in list(frame.fragments_json or [])
        if isinstance(fragment, dict)
    ]
    return DocumentFrameView(
        id=frame.id,
        title=frame.title,
        status=cast(str, frame.status or "draft"),
        fragments=fragments,
        metadata_json=dict(frame.metadata_json or {}),
        created_at=frame.created_at,
        updated_at=frame.updated_at,
    )


def _chat_upload_to_view(upload: ChatUploadRecord, session: Session) -> ChatUploadView:
    collection_slug: str | None = None
    if upload.collection_id:
        collection = session.get(CollectionRecord, upload.collection_id)
        if collection is not None:
            collection_slug = collection.slug
    return ChatUploadView(
        id=upload.id,
        conversation_id=upload.conversation_id,
        agent_id=upload.agent_id,
        filename=upload.filename,
        mime_type=upload.mime_type,
        source_kind=upload.source_kind,
        policy_lane=cast(RequestedParseLane, upload.requested_lane or "default"),
        extracted_parse_lane=upload.extracted_parse_lane,
        extracted_char_count=upload.extracted_char_count,
        status=upload.status,
        persistence_mode=upload.persistence_mode,
        collection_id=upload.collection_id,
        collection_slug=collection_slug,
        promoted_document_id=upload.promoted_document_id,
        error_message=upload.error_message,
        created_at=upload.created_at,
        updated_at=upload.updated_at,
    )


def _safe_upload_name(filename: str | None) -> str:
    candidate = filename or "upload"
    return re.sub(r"[^a-zA-Z0-9._() -]+", "_", Path(candidate).name).strip()[:200] or "upload"


def _resolve_chat_upload_path(*, conversation_id: str, upload_id: str, safe_name: str) -> Path:
    dest_dir = settings.upload_dir / "_chat" / conversation_id / upload_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    return dest_dir / safe_name


def _resolve_promoted_document_path(*, corpus: str, upload_id: str, safe_name: str) -> Path:
    dest_dir = settings.upload_dir / corpus
    dest_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(safe_name).suffix
    stem = Path(safe_name).stem[:180] or "upload"
    return dest_dir / f"{stem}__{upload_id}{suffix}"


def _chat_upload_source_kind(path: Path) -> str:
    return "spreadsheet" if path.suffix.lower() in {".xlsx", ".xlsm"} else "document"


def _ensure_chat_upload_conversation(session: Session, *, conversation_id: str, agent_id: str) -> AgentConversationRecord:
    conversation = session.get(AgentConversationRecord, conversation_id)
    if conversation is None:
        raise HTTPException(404, "conversation not found")
    if conversation.agent_id != agent_id:
        raise HTTPException(400, "conversation does not belong to the selected agent")
    return conversation


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


def _promote_chat_upload_to_document(
    session: Session,
    *,
    upload: ChatUploadRecord,
    collection: CollectionRecord,
) -> DocumentRecord:
    staged_path = Path(upload.storage_path)
    if not staged_path.is_file():
        raise HTTPException(409, "staged upload file is missing from disk")

    safe_name = _safe_upload_name(upload.filename)
    dest = _resolve_promoted_document_path(corpus=collection.slug, upload_id=upload.id, safe_name=safe_name)
    shutil.move(str(staged_path), str(dest))
    source_path = str(dest.resolve())
    metadata_json = {
        **(upload.metadata_json or {}),
        "chat_upload_id": upload.id,
        "chat_upload_status": upload.status,
    }
    existing = session.scalar(select(DocumentRecord).where(DocumentRecord.source_path == source_path))
    if existing is None:
        existing = DocumentRecord(
            corpus=collection.slug,
            filename=safe_name,
            source_path=source_path,
            mime_type=upload.mime_type or mimetypes.guess_type(safe_name)[0],
            requested_lane=upload.requested_lane or "default",
            parse_status="pending",
            index_status="pending",
            status="uploaded",
            source_kind=_chat_upload_source_kind(dest),
            metadata_json=metadata_json,
        )
        session.add(existing)
        session.flush()
    else:
        existing.corpus = collection.slug
        existing.filename = safe_name
        existing.mime_type = upload.mime_type or mimetypes.guess_type(safe_name)[0]
        existing.requested_lane = upload.requested_lane or "default"
        existing.actual_parse_lane = None
        existing.parse_status = "pending"
        existing.index_status = "pending"
        existing.status = "uploaded"
        existing.source_kind = _chat_upload_source_kind(dest)
        existing.error_message = None
        existing.metadata_json = {**(existing.metadata_json or {}), **metadata_json}

    upload.storage_path = source_path
    upload.source_kind = existing.source_kind
    upload.collection_id = collection.id
    upload.promoted_document_id = existing.id
    upload.persistence_mode = "save_to_knowledge"
    upload.status = "approved_for_indexing"
    upload.error_message = None
    return existing


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
        try:
            return RuntimeDefaultsView(**save_runtime_defaults(session, body.model_dump()))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/config/explorer", response_model=list[ConfigExplorerEntryView])
    def api_config_explorer(
        q: str | None = Query(default=None),
        namespace: str | None = Query(default=None),
        session: Session = Depends(get_session),
    ) -> list[ConfigExplorerEntryView]:
        entries = _build_config_explorer_entries(session)
        search_term = str(q or "").strip().casefold()
        namespace_filter = str(namespace or "").strip().casefold()
        if namespace_filter:
            entries = [entry for entry in entries if entry.namespace.casefold() == namespace_filter]
        if search_term:
            filtered: list[ConfigExplorerEntryView] = []
            for entry in entries:
                haystack = " ".join(
                    [
                        entry.key,
                        entry.namespace,
                        entry.source_name,
                        json.dumps(entry.value_json, sort_keys=True),
                    ]
                ).casefold()
                if search_term in haystack:
                    filtered.append(entry)
            entries = filtered
        return entries

    @app.get("/api/connections", response_model=list[ConnectionView])
    def api_list_connections(session: Session = Depends(get_session)) -> list[ConnectionView]:
        rows = list_connections(session)
        return [
            ConnectionView(
                id=row.id,
                provider=row.provider,
                label=row.label,
                provider_kind=row.provider_kind,
                auth_strategy=row.auth_strategy,
                auth_header_name=row.auth_header_name,
                base_url=row.base_url,
                enabled=row.enabled,
                default_model_id=row.default_model_id,
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
            provider_kind=body.provider_kind,
            auth_strategy=body.auth_strategy,
            auth_header_name=body.auth_header_name,
            api_key=body.api_key,
            base_url=body.base_url,
            enabled=body.enabled,
            default_model_id=body.default_model_id,
        )
        return ConnectionView(
            id=record.id,
            provider=record.provider,
            label=record.label,
            provider_kind=record.provider_kind,
            auth_strategy=record.auth_strategy,
            auth_header_name=record.auth_header_name,
            base_url=record.base_url,
            enabled=record.enabled,
            default_model_id=record.default_model_id,
            api_key_hint=record.masked_api_key,
            has_api_key=bool(record.api_key),
        )

    @app.post("/api/connections/{connection_id}/deletion-preview", response_model=ConnectionDeletionPreviewView)
    def api_connection_deletion_preview(
        connection_id: str,
        session: Session = Depends(get_session),
    ) -> ConnectionDeletionPreviewView:
        connection = session.get(ConnectionRecord, connection_id)
        if connection is None:
            raise HTTPException(404, "connection not found")
        return _build_connection_deletion_preview(session, connection=connection)

    @app.delete("/api/connections/{connection_id}", response_model=ConnectionDeleteResponse)
    def api_delete_connection(
        connection_id: str,
        body: ConnectionDeletePayload,
        confirm: bool = Query(default=False),
        session: Session = Depends(get_session),
    ) -> ConnectionDeleteResponse:
        if not confirm:
            raise HTTPException(400, "confirm=true is required for destructive connection deletion")
        connection = session.get(ConnectionRecord, connection_id)
        if connection is None:
            raise HTTPException(404, "connection not found")

        preview = _build_connection_deletion_preview(session, connection=connection)
        if body.confirmation_token != preview.confirmation_token:
            raise HTTPException(409, "confirmation token mismatch; refresh deletion preview")
        if not preview.can_execute:
            raise HTTPException(409, f"connection deletion blocked: {', '.join(preview.blocking_reasons)}")

        deleted = delete_connection(session, connection_id)
        return ConnectionDeleteResponse(id=deleted.id, provider=deleted.provider, deleted=True)

    @app.post("/api/connections/test", response_model=ConnectionTestResponse)
    def api_test_connection(
        body: ConnectionTestPayload,
        request: Request,
        session: Session = Depends(get_session),
    ) -> ConnectionTestResponse:
        try:
            record = get_active_connection(session, body.provider)
        except ValueError:
            # Allow testing a brand-new provider key before persisting it.
            record = ConnectionRecord(
                provider=body.provider,
                label=body.label or body.provider,
                provider_kind=body.provider_kind,
                auth_strategy=body.auth_strategy,
                auth_header_name=body.auth_header_name,
                api_key=body.api_key,
                base_url=body.base_url,
                enabled=True,
            )
        try:
            result = test_provider_connection(
                record,
                api_mode=body.api_mode,
                prompt=body.prompt,
                trace_id=request.state.trace_id,
                service="control-api",
                api_key=body.api_key,
                base_url=body.base_url,
                model_id=body.model_id,
            )
        except Exception as exc:
            status_code, detail = _map_connection_test_exception(exc)
            raise HTTPException(status_code, detail) from exc
        return ConnectionTestResponse(ok=True, **result)

    @app.get("/api/tools/catalog", response_model=list[ToolCatalogEntryView])
    def api_tool_catalog(session: Session = Depends(get_session)) -> list[ToolCatalogEntryView]:
        return list_tool_catalog(session)

    @app.get("/api/tools/policy/{agent_id}", response_model=ToolPolicyView)
    def api_agent_tool_policy(agent_id: str, session: Session = Depends(get_session)) -> ToolPolicyView:
        try:
            return get_agent_tool_policy(session, agent_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.post("/api/tools/policy/{agent_id}", response_model=ToolPolicyView)
    def api_save_agent_tool_policy(
        agent_id: str,
        body: ToolPolicyPayload,
        session: Session = Depends(get_session),
    ) -> ToolPolicyView:
        try:
            return update_agent_tool_policy(session, agent_id, body.allowed_tool_ids)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/api/tools/{tool_id}", response_model=ToolDetailView)
    def api_tool_detail(tool_id: str, session: Session = Depends(get_session)) -> ToolDetailView:
        try:
            return get_tool_detail(session, tool_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.post("/api/tools/{tool_id}/settings", response_model=ToolDetailView)
    def api_save_tool_settings(
        tool_id: str,
        body: ToolSettingsPayload,
        session: Session = Depends(get_session),
    ) -> ToolDetailView:
        try:
            return update_tool_settings(session, tool_id, body.model_dump())
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.post("/api/tools/{tool_id}/test", response_model=ToolTestResponse)
    def api_test_tool(tool_id: str, session: Session = Depends(get_session)) -> ToolTestResponse:
        try:
            return run_tool_test(session, tool_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.post("/api/tools/{tool_id}/execute", response_model=ToolExecuteResponse)
    def api_execute_tool(
        tool_id: str,
        body: ToolExecutePayload,
        session: Session = Depends(get_session),
    ) -> ToolExecuteResponse:
        try:
            return execute_tool_operation(
                session,
                tool_id,
                operation=body.operation,
                payload=body.payload,
                dry_run=body.dry_run,
                approval_token=body.approval_token,
            )
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.post("/api/tools/{tool_id}/activation", response_model=ToolCatalogEntryView)
    def api_tool_activation(
        tool_id: str,
        body: ToolActivationPayload,
        session: Session = Depends(get_session),
    ) -> ToolCatalogEntryView:
        try:
            return set_tool_activation(session, tool_id, body.active)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/api/chat/bootstrap", response_model=ChatBootstrapView)
    def api_chat_bootstrap(
        surface: str = "ghostdash",
        session: Session = Depends(get_session),
    ) -> ChatBootstrapView:
        agents = [_agent_to_view(agent, resolve_agent_runtime_profile(session, agent)) for agent in list_agents(session)]
        default_agent = next((agent for agent in agents if agent.is_default), agents[0] if agents else None)
        return ChatBootstrapView(
            surface=surface,
            default_agent_id=default_agent.id if default_agent is not None else None,
            default_workflow_mode="standard",
            runtime_defaults=RuntimeDefaultsView(**get_runtime_defaults(session)),
            capabilities=_runtime_capabilities(),
            features=ChatBootstrapFeatures(
                allow_mock_provider=False,
                allow_api_mode_override=False,
                allow_conversation_mode_override=True,
                allow_approved_web_toggle=True,
                allow_workflow_launchers=True,
            ),
            agents=agents,
            tools_catalog=list_tool_catalog(session),
        )

    @app.get("/api/agents", response_model=list[AgentProfileView])
    def api_list_agents(session: Session = Depends(get_session)) -> list[AgentProfileView]:
        return [_agent_to_view(agent, resolve_agent_runtime_profile(session, agent)) for agent in list_agents(session)]

    @app.get("/api/agents/hierarchy", response_model=list[AgentHierarchyView])
    def api_list_agent_hierarchy(session: Session = Depends(get_session)) -> list[AgentHierarchyView]:
        agents = list_agents(session)
        runtime_profiles = {agent.id: resolve_agent_runtime_profile(session, agent) for agent in agents}
        leads: list[AgentProfileRecord] = []
        sub_agents_by_parent: dict[str, list[AgentProfileRecord]] = {}
        known_ids = {agent.id for agent in agents}

        for agent in agents:
            role = str(agent.agent_role or "lead")
            if role == "sub" and agent.parent_agent_id and agent.parent_agent_id in known_ids:
                sub_agents_by_parent.setdefault(agent.parent_agent_id, []).append(agent)
                continue
            leads.append(agent)

        for sub_agents in sub_agents_by_parent.values():
            sub_agents.sort(key=lambda row: (int(row.position or 0), row.updated_at), reverse=False)
        leads.sort(key=lambda row: (not bool(row.is_default), row.updated_at), reverse=False)

        return [
            AgentHierarchyView(
                lead_agent=_agent_to_view(lead, runtime_profiles[lead.id]),
                sub_agents=[_agent_to_view(sub_agent, runtime_profiles[sub_agent.id]) for sub_agent in sub_agents_by_parent.get(lead.id, [])],
            )
            for lead in leads
        ]

    @app.get("/api/agents/{agent_id}/policy-audits", response_model=list[PolicyChangeAuditView])
    def api_agent_policy_audits(
        agent_id: str,
        limit: int = Query(default=50, ge=1, le=200),
        session: Session = Depends(get_session),
    ) -> list[PolicyChangeAuditView]:
        try:
            agent = get_agent(session, agent_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        runtime_profile = resolve_agent_runtime_profile(session, agent)
        return [
            _policy_change_audit_to_view(row)
            for row in list_policy_change_audits(session, runtime_profile.id, limit=limit)
        ]

    @app.post("/api/agents", response_model=AgentProfileView)
    def api_save_agent(
        body: AgentProfilePayload,
        session: Session = Depends(get_session),
    ) -> AgentProfileView:
        try:
            agent = save_agent(session, body.model_dump())
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return _agent_to_view(agent, resolve_agent_runtime_profile(session, agent))

    @app.post("/api/agents/{agent_id}/deletion-preview", response_model=AgentDeletionPreviewView)
    def api_agent_deletion_preview(
        agent_id: str,
        body: AgentDeletionPreviewPayload,
        session: Session = Depends(get_session),
    ) -> AgentDeletionPreviewView:
        try:
            agent = get_agent(session, agent_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return _build_agent_deletion_preview(session, agent=agent, scope=body.scope)

    @app.delete("/api/agents/{agent_id}/conversations", response_model=AgentDeleteResponse)
    def api_delete_agent_conversations(
        agent_id: str,
        body: AgentDeletePayload,
        confirm: bool = Query(default=False),
        session: Session = Depends(get_session),
    ) -> AgentDeleteResponse:
        if not confirm:
            raise HTTPException(400, "confirm=true is required for destructive conversation deletion")
        try:
            agent = get_agent(session, agent_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

        preview = _build_agent_deletion_preview(session, agent=agent, scope="chats")
        if body.confirmation_token != preview.confirmation_token:
            raise HTTPException(409, "confirmation token mismatch; refresh deletion preview")
        if not preview.can_execute:
            raise HTTPException(409, f"agent conversation deletion blocked: {', '.join(preview.blocking_reasons)}")

        deletion_stats = _delete_agent_conversations(session, agent_id=agent_id)
        return AgentDeleteResponse(id=agent_id, deleted=True, **deletion_stats)

    @app.delete("/api/agents/{agent_id}", response_model=AgentDeleteResponse)
    def api_delete_agent(
        agent_id: str,
        body: AgentDeletePayload,
        confirm: bool = Query(default=False),
        session: Session = Depends(get_session),
    ) -> AgentDeleteResponse:
        if not confirm:
            raise HTTPException(400, "confirm=true is required for destructive agent deletion")
        try:
            agent = get_agent(session, agent_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

        preview = _build_agent_deletion_preview(session, agent=agent, scope="agent")
        if body.confirmation_token != preview.confirmation_token:
            raise HTTPException(409, "confirmation token mismatch; refresh deletion preview")
        if not preview.can_execute:
            raise HTTPException(409, f"agent deletion blocked: {', '.join(preview.blocking_reasons)}")

        deletion_stats = _delete_agent_conversations(session, agent_id=agent_id)
        agent_record = session.get(AgentProfileRecord, agent_id)
        if agent_record is None:
            raise HTTPException(404, "agent no longer exists")
        session.delete(agent_record)
        session.commit()
        return AgentDeleteResponse(id=agent_id, deleted=True, **deletion_stats)

    @app.get("/api/collections", response_model=list[CollectionView])
    def api_list_collections(
        include_impact: bool = False,
        session: Session = Depends(get_session),
    ) -> list[CollectionView]:
        return [
            _collection_to_view(collection, session, include_impact=include_impact)
            for collection in list_collections(session)
        ]

    @app.post("/api/collections", response_model=CollectionView)
    def api_create_collection(
        body: CollectionCreatePayload,
        session: Session = Depends(get_session),
    ) -> CollectionView:
        try:
            record = ensure_collection_record(
                session,
                slug=body.slug,
                name=body.name or body.slug,
                description=body.description,
                embedding_model_id=(get_default_runtime_profile(session).kb_config_json or {}).get("embedding_model_id"),
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        session.commit()
        session.refresh(record)
        return _collection_to_view(record, session, include_impact=True)

    @app.get("/api/collections/{collection_id}", response_model=CollectionView)
    def api_collection_detail(collection_id: str, session: Session = Depends(get_session)) -> CollectionView:
        try:
            collection = get_collection(session, collection_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return _collection_to_view(collection, session, include_impact=True)

    @app.delete("/api/collections/{collection_id}", response_model=CollectionDeleteResponse)
    def api_delete_collection(collection_id: str, session: Session = Depends(get_session)) -> CollectionDeleteResponse:
        try:
            collection = get_collection(session, collection_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        try:
            impact = CollectionImpactView(**delete_collection_and_storage(session, collection))
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return CollectionDeleteResponse(id=collection_id, slug=collection.slug, impact=impact)

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

    @app.post("/api/agents/{agent_id}/conversations", response_model=ConversationSummaryView)
    def api_create_agent_conversation(
        agent_id: str,
        body: ConversationCreatePayload,
        session: Session = Depends(get_session),
    ) -> ConversationSummaryView:
        agent = get_agent(session, agent_id)
        runtime_profile = resolve_agent_runtime_profile(session, agent)
        llm_config = dict(runtime_profile.llm_config_json or {})
        frame_id = body.document_frame_id
        if frame_id:
            get_document_frame(session, frame_id)
        elif body.source_conversation_id:
            source_conversation = session.get(AgentConversationRecord, body.source_conversation_id)
            if source_conversation is None:
                raise HTTPException(404, "source conversation not found")
            frame_id = source_conversation.document_frame_id
        if frame_id is None and body.workflow_mode != "standard":
            frame = create_document_frame(
                session,
                title=body.title or f"{agent.name} strategic document",
                metadata_json={"seed_workflow_mode": body.workflow_mode},
            )
            frame_id = frame.id
        conversation = create_conversation(
            session,
            agent_id=agent.id,
            message=body.title or "New conversation",
            title=body.title or "New conversation",
            corpora=list(body.corpora),
            api_mode=str(llm_config.get("api_mode") or "responses"),
            conversation_mode=body.conversation_mode,
            workflow_mode=body.workflow_mode,
            document_frame_id=frame_id,
        )
        session.commit()
        session.refresh(conversation)
        return _conversation_to_view(conversation, 0)

    @app.get("/api/conversations/{conversation_id}/messages", response_model=list[ConversationMessageView])
    def api_conversation_messages(
        conversation_id: str,
        session: Session = Depends(get_session),
    ) -> list[ConversationMessageView]:
        conversation = session.get(AgentConversationRecord, conversation_id)
        if conversation is None:
            raise HTTPException(404, "conversation not found")
        return [_message_to_view(message) for message in list_messages(session, conversation_id)]

    @app.get("/api/conversations/{conversation_id}/document-frame", response_model=DocumentFrameView)
    def api_conversation_document_frame(
        conversation_id: str,
        session: Session = Depends(get_session),
    ) -> DocumentFrameView:
        conversation = session.get(AgentConversationRecord, conversation_id)
        if conversation is None:
            raise HTTPException(404, "conversation not found")
        if not conversation.document_frame_id:
            raise HTTPException(404, "conversation has no document frame")
        return _document_frame_to_view(get_document_frame(session, conversation.document_frame_id))

    @app.post("/api/conversations/{conversation_id}/document-frame/fragments", response_model=DocumentFrameView)
    def api_append_document_frame_fragment(
        conversation_id: str,
        body: DocumentFrameFragmentCreatePayload,
        session: Session = Depends(get_session),
    ) -> DocumentFrameView:
        conversation = session.get(AgentConversationRecord, conversation_id)
        if conversation is None:
            raise HTTPException(404, "conversation not found")
        if not conversation.document_frame_id:
            frame = create_document_frame(
                session,
                title=f"{conversation.title} document",
                metadata_json={"seed_conversation_id": conversation.id},
            )
            conversation.document_frame_id = frame.id
        content = (body.content or "").strip()
        if body.source_message_id:
            source_message = session.get(AgentMessageRecord, body.source_message_id)
            if source_message is None or source_message.conversation_id != conversation.id:
                raise HTTPException(404, "source message not found in conversation")
            if source_message.role != "assistant":
                raise HTTPException(400, "only assistant messages can be approved into the document frame")
            if not content:
                content = source_message.content.strip()
        if not content:
            raise HTTPException(400, "fragment content is required")
        frame = append_document_frame_fragment(
            session,
            document_frame_id=conversation.document_frame_id,
            source_conversation_id=conversation.id,
            source_message_id=body.source_message_id,
            fragment_type=body.fragment_type,
            title=body.title,
            content=content,
        )
        session.commit()
        session.refresh(frame)
        return _document_frame_to_view(frame)

    @app.get("/api/conversations/{conversation_id}/uploads", response_model=list[ChatUploadView])
    def api_list_conversation_uploads(
        conversation_id: str,
        session: Session = Depends(get_session),
    ) -> list[ChatUploadView]:
        conversation = session.get(AgentConversationRecord, conversation_id)
        if conversation is None:
            raise HTTPException(404, "conversation not found")
        uploads = list(
            session.scalars(
                select(ChatUploadRecord)
                .where(ChatUploadRecord.conversation_id == conversation_id)
                .order_by(ChatUploadRecord.created_at.desc())
            )
        )
        return [_chat_upload_to_view(upload, session) for upload in uploads]

    @app.post("/api/conversations/{conversation_id}/uploads", response_model=ChatUploadView)
    async def api_stage_conversation_upload(
        conversation_id: str,
        agent_id: str = Form(...),
        policy_lane: str | None = Form(None),
        file: UploadFile = File(...),
        session: Session = Depends(get_session),
    ) -> ChatUploadView:
        get_agent(session, agent_id)
        _ensure_chat_upload_conversation(session, conversation_id=conversation_id, agent_id=agent_id)
        lane = cast(RequestedParseLane, policy_lane or "default")
        if lane not in {"default", "local", "cloud"}:
            raise HTTPException(400, "policy_lane must be default, local, or cloud")

        safe_name = _safe_upload_name(file.filename)
        upload_id = str(uuid4())
        dest = _resolve_chat_upload_path(conversation_id=conversation_id, upload_id=upload_id, safe_name=safe_name)
        upload = ChatUploadRecord(
            id=upload_id,
            conversation_id=conversation_id,
            agent_id=agent_id,
            filename=safe_name,
            storage_path=str(dest.resolve()),
            mime_type=file.content_type or mimetypes.guess_type(safe_name)[0],
            requested_lane=lane,
            source_kind="document",
            status="uploaded_pending_decision",
            metadata_json={},
        )
        session.add(upload)
        session.flush()

        size_bytes, sha256 = await _write_upload_to_disk(file, dest)
        extracted_text: str | None = None
        extracted_parse_lane: str | None = None
        extraction_error: str | None = None
        extraction_truncated = False
        try:
            extracted_text, extracted_parse_lane = extract_text_local(dest)
            if len(extracted_text) > 12000:
                extracted_text = extracted_text[:12000].rstrip() + "\n\n[truncated for chat context]"
                extraction_truncated = True
        except Exception as exc:
            extraction_error = str(exc)[:2000]

        upload.storage_path = str(dest.resolve())
        upload.source_kind = _chat_upload_source_kind(dest)
        upload.extracted_text = extracted_text
        upload.extracted_parse_lane = extracted_parse_lane
        upload.extracted_char_count = len(extracted_text or "")
        upload.error_message = extraction_error
        upload.metadata_json = {
            "size_bytes": size_bytes,
            "sha256": sha256,
            "extraction_truncated": extraction_truncated,
        }
        session.commit()
        session.refresh(upload)
        return _chat_upload_to_view(upload, session)

    @app.post("/api/chat/uploads/{upload_id}/decision", response_model=ChatUploadView)
    def api_chat_upload_decision(
        upload_id: str,
        body: ChatUploadDecisionPayload,
        session: Session = Depends(get_session),
    ) -> ChatUploadView:
        upload = session.get(ChatUploadRecord, upload_id)
        if upload is None:
            raise HTTPException(404, "chat upload not found")
        _ensure_chat_upload_conversation(
            session,
            conversation_id=upload.conversation_id,
            agent_id=upload.agent_id,
        )

        if body.persistence_mode == "conversation_only":
            upload.persistence_mode = "conversation_only"
            upload.status = "conversation_only"
            upload.collection_id = None
            upload.error_message = None
            session.commit()
            session.refresh(upload)
            return _chat_upload_to_view(upload, session)

        collection: CollectionRecord | None = None
        if body.collection_id:
            try:
                collection = get_collection(session, body.collection_id)
            except ValueError as exc:
                raise HTTPException(404, str(exc)) from exc
        elif body.collection_slug:
            collection = get_collection_by_slug(session, body.collection_slug)
            if collection is None:
                raise HTTPException(404, f"collection '{body.collection_slug}' not found")

        upload.persistence_mode = "save_to_knowledge"
        if collection is None:
            upload.status = "awaiting_collection"
            session.commit()
            session.refresh(upload)
            return _chat_upload_to_view(upload, session)

        if upload.promoted_document_id:
            session.commit()
            session.refresh(upload)
            return _chat_upload_to_view(upload, session)

        _promote_chat_upload_to_document(session, upload=upload, collection=collection)
        session.commit()
        session.refresh(upload)
        return _chat_upload_to_view(upload, session)

    @app.post("/api/upload", response_model=UploadView)
    async def api_upload(
        corpus: str | None = Form(None),
        policy_lane: str | None = Form(None),
        file: UploadFile = File(...),
        session: Session = Depends(get_session),
    ) -> UploadView:
        target_corpus = corpus or settings.app_default_corpus
        collection = get_collection_by_slug(session, target_corpus)
        if collection is None:
            raise HTTPException(404, f"collection '{target_corpus}' not found")
        lane = cast(RequestedParseLane, policy_lane or "default")
        if lane not in {"default", "local", "cloud"}:
            raise HTTPException(400, "policy_lane must be default, local, or cloud")

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
        if get_collection_by_slug(session, corpus) is None:
            raise HTTPException(404, f"collection '{corpus}' not found")
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

    @app.get("/api/workflows/definitions", response_model=list[WorkflowDefinitionView])
    def api_workflow_definitions(session: Session = Depends(get_session)) -> list[WorkflowDefinitionView]:
        return [_workflow_definition_to_view(definition) for definition in list_workflow_definitions(session)]

    @app.get("/api/workflows/definitions/{workflow_id}", response_model=WorkflowDefinitionView)
    def api_workflow_definition(workflow_id: str, session: Session = Depends(get_session)) -> WorkflowDefinitionView:
        try:
            definition = get_workflow_definition(session, workflow_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return _workflow_definition_to_view(definition)

    @app.post("/api/workflows/definitions", response_model=WorkflowDefinitionView)
    def api_upsert_workflow_definition(
        body: WorkflowDefinitionPayload,
        session: Session = Depends(get_session),
    ) -> WorkflowDefinitionView:
        try:
            definition = upsert_workflow_definition(session, body.model_dump())
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return _workflow_definition_to_view(definition)

    @app.post("/api/workflows/definitions/import", response_model=WorkflowDefinitionView)
    def api_import_workflow_definition(
        body: WorkflowDefinitionImportPayload,
        session: Session = Depends(get_session),
    ) -> WorkflowDefinitionView:
        try:
            parsed = parse_workflow_definition_text(definition_text=body.definition_text, format=body.format)
            definition = upsert_workflow_definition(session, parsed)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return _workflow_definition_to_view(definition)

    @app.get("/api/workflows/definitions/{workflow_id}/export", response_class=PlainTextResponse)
    def api_export_workflow_definition(
        workflow_id: str,
        format: str = Query(default="yaml"),
        session: Session = Depends(get_session),
    ) -> Response:
        try:
            definition = get_workflow_definition(session, workflow_id)
            body = dump_workflow_definition_text(definition=dict(definition.definition_json or {}), format=format)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return PlainTextResponse(body)

    @app.get("/api/workflows/runs", response_model=list[WorkflowRunSummaryView])
    def api_workflow_runs(
        surface: str | None = None,
        workflow_id: str | None = None,
        session: Session = Depends(get_session),
    ) -> list[WorkflowRunSummaryView]:
        return [
            _workflow_run_summary_to_view(run)
            for run in list_workflow_runs(session, surface=surface, workflow_id=workflow_id, limit=20)
        ]

    @app.get("/api/workflows/runs/{run_id}", response_model=WorkflowRunView)
    def api_workflow_run(run_id: str, session: Session = Depends(get_session)) -> WorkflowRunView:
        try:
            run = get_workflow_run(session, run_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return _workflow_run_to_view(run, session)

    @app.post("/api/workflows/runs", response_model=WorkflowRunView)
    def api_create_workflow_run(
        body: WorkflowRunCreatePayload,
        session: Session = Depends(get_session),
    ) -> WorkflowRunView:
        try:
            run = create_workflow_run(
                session,
                workflow_id=body.workflow_id,
                surface=body.surface,
                prompt=body.prompt,
                agent_ids=body.agent_ids,
                parent_conversation_id=body.parent_conversation_id,
                head_agent_id=body.head_agent_id,
                result_json={
                    "request": {
                        "api_mode": body.api_mode,
                        "conversation_mode": body.conversation_mode,
                        "workflow_mode": body.workflow_mode,
                        "use_approved_web": body.use_approved_web,
                    }
                },
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return _workflow_run_to_view(run, session)

    @app.post("/api/workflows/runs/execute", response_model=WorkflowRunView)
    async def api_execute_workflow_run(
        body: WorkflowRunCreatePayload,
        session: Session = Depends(get_session),
    ) -> WorkflowRunView:
        try:
            run = create_workflow_run(
                session,
                workflow_id=body.workflow_id,
                surface=body.surface,
                prompt=body.prompt,
                agent_ids=body.agent_ids,
                parent_conversation_id=body.parent_conversation_id,
                head_agent_id=body.head_agent_id,
                result_json={
                    "request": {
                        "api_mode": body.api_mode,
                        "conversation_mode": body.conversation_mode,
                        "workflow_mode": body.workflow_mode,
                        "use_approved_web": body.use_approved_web,
                    }
                },
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        schedule_workflow_run_execution(run.id)
        return _workflow_run_to_view(run, session)

    @app.post("/api/workflows/runs/{run_id}", response_model=WorkflowRunView)
    def api_update_workflow_run(
        run_id: str,
        body: WorkflowRunUpdatePayload,
        session: Session = Depends(get_session),
    ) -> WorkflowRunView:
        try:
            run = update_workflow_run(
                session,
                run_id=run_id,
                status=body.status,
                error_message=body.error_message,
                result_json=body.result_json or None,
            )
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return _workflow_run_to_view(run, session)

    @app.post("/api/workflows/runs/{run_id}/cancel", response_model=WorkflowRunView)
    async def api_cancel_workflow_run(
        run_id: str,
        session: Session = Depends(get_session),
    ) -> WorkflowRunView:
        try:
            await cancel_workflow_run_execution(run_id)
            session.expire_all()
            run = get_workflow_run(session, run_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return _workflow_run_to_view(run, session)

    @app.post("/api/workflows/runs/{run_id}/steps/{step_id}", response_model=WorkflowRunView)
    def api_update_workflow_step_run(
        run_id: str,
        step_id: str,
        body: WorkflowStepRunUpdatePayload,
        session: Session = Depends(get_session),
    ) -> WorkflowRunView:
        try:
            run = update_workflow_step_run(
                session,
                run_id=run_id,
                step_id=step_id,
                status=body.status,
                conversation_id=body.conversation_id,
                output_text=body.output_text,
                citations=body.citations,
                error_message=body.error_message,
                metadata_json=body.metadata_json or None,
            )
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return _workflow_run_to_view(run, session)

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

    @app.get("/api/vector-stats", response_model=VectorStatsView)
    def api_vector_stats(corpus: str | None = None, session: Session = Depends(get_session)) -> VectorStatsView:
        return _compute_vector_stats(session, corpus)

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
