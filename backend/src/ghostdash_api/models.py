from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class ToolRegistryRecord(TimestampMixin, Base):
    __tablename__ = "tool_registry"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    provider: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(128))
    gateway: Mapped[str] = mapped_column(String(128))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="unknown")
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    config_json: Mapped[dict] = mapped_column(JSON, default=dict)


class ToolExecutionAuditRecord(TimestampMixin, Base):
    __tablename__ = "tool_execution_audits"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    tool_id: Mapped[str] = mapped_column(String(64), index=True)
    operation: Mapped[str] = mapped_column(String(128), index=True)
    risk_class: Mapped[str] = mapped_column(String(32), default="read")
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=False)
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    approval_token: Mapped[str | None] = mapped_column(String(256), nullable=True)
    actor_agent_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    surface: Mapped[str] = mapped_column(String(64), default="control_api")
    status: Mapped[str] = mapped_column(String(32), default="blocked")
    policy_decision_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)
    response_json: Mapped[dict] = mapped_column(JSON, default=dict)


class OdooEvidenceMirrorRecord(TimestampMixin, Base):
    __tablename__ = "odoo_evidence_mirror"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    tool_audit_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    trace_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    operation: Mapped[str] = mapped_column(String(128), index=True)
    status: Mapped[str] = mapped_column(String(32), default="captured")
    source_mode: Mapped[str] = mapped_column(String(32), default="live_odoo")
    scope_json: Mapped[dict] = mapped_column(JSON, default=dict)
    request_json: Mapped[dict] = mapped_column(JSON, default=dict)
    response_json: Mapped[dict] = mapped_column(JSON, default=dict)


class ConnectionRecord(TimestampMixin, Base):
    __tablename__ = "connections"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    provider: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(64))
    provider_kind: Mapped[str] = mapped_column(String(32), default="openai")
    auth_strategy: Mapped[str] = mapped_column(String(32), default="bearer")
    auth_header_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    base_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    default_model_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    aws_region: Mapped[str | None] = mapped_column(String(64), nullable=True)

    @property
    def masked_api_key(self) -> str | None:
        if not self.api_key:
            return None
        return f"***{self.api_key[-4:]}"


class RuntimeProfileRecord(TimestampMixin, Base):
    __tablename__ = "runtime_profiles"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    llm_config_json: Mapped[dict] = mapped_column(JSON, default=dict)
    guardrails_config_json: Mapped[dict] = mapped_column(JSON, default=dict)
    kb_config_json: Mapped[dict] = mapped_column(JSON, default=dict)
    retrieval_config_json: Mapped[dict] = mapped_column(JSON, default=dict)
    tool_policy_config_json: Mapped[dict] = mapped_column(JSON, default=dict)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class CollectionRecord(TimestampMixin, Base):
    __tablename__ = "collections"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    slug: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="active")
    embedding_model_id: Mapped[str | None] = mapped_column(String(128), nullable=True)


class RuntimeProfileCollectionRecord(TimestampMixin, Base):
    __tablename__ = "runtime_profile_collections"
    __table_args__ = (
        UniqueConstraint("runtime_profile_id", "collection_id", name="uq_runtime_profile_collection"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    runtime_profile_id: Mapped[str] = mapped_column(String(64), index=True)
    collection_id: Mapped[str] = mapped_column(String(64), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)


class EmbeddingCacheRecord(TimestampMixin, Base):
    __tablename__ = "embedding_cache"
    __table_args__ = (
        UniqueConstraint("provider", "base_url", "embedding_model", "text_hash", name="uq_embedding_cache_key"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    provider: Mapped[str] = mapped_column(String(32), index=True)
    base_url: Mapped[str] = mapped_column(Text)
    embedding_model: Mapped[str] = mapped_column(String(128), index=True)
    text_hash: Mapped[str] = mapped_column(String(64), index=True)
    text_length: Mapped[int] = mapped_column(Integer, default=0)
    vector_json: Mapped[list[float]] = mapped_column(JSON, default=list)
    hit_count: Mapped[int] = mapped_column(Integer, default=0)


class AgentProfileRecord(TimestampMixin, Base):
    __tablename__ = "agent_profiles"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    first_message: Mapped[str] = mapped_column(Text)
    language: Mapped[str] = mapped_column(String(32), default="en-US")
    voice_id: Mapped[str] = mapped_column(String(64), default="alloy")
    runtime_profile_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    agent_role: Mapped[str] = mapped_column(String(16), default="lead")
    parent_agent_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class DocumentFrameRecord(TimestampMixin, Base):
    __tablename__ = "document_frames"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    title: Mapped[str] = mapped_column(String(256), default="Strategic document")
    status: Mapped[str] = mapped_column(String(32), default="draft")
    fragments_json: Mapped[list[dict]] = mapped_column(JSON, default=list)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class AgentConversationRecord(TimestampMixin, Base):
    __tablename__ = "agent_conversations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    agent_id: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(256), default="New conversation")
    corpora_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    api_mode: Mapped[str] = mapped_column(String(32), default="responses")
    conversation_mode: Mapped[str] = mapped_column(String(32), default="quick")
    workflow_mode: Mapped[str] = mapped_column(String(32), default="standard")
    document_frame_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    # Last OpenAI Responses API response id for this thread (previous_response_id); not used for chat_completions path.
    openai_last_response_id: Mapped[str | None] = mapped_column(String(128), nullable=True)


class AgentMessageRecord(TimestampMixin, Base):
    __tablename__ = "agent_messages"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    conversation_id: Mapped[str] = mapped_column(String(64), index=True)
    agent_id: Mapped[str] = mapped_column(String(64), index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    query_mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    citations_json: Mapped[list[dict]] = mapped_column(JSON, default=list)
    tool_events_json: Mapped[list[dict]] = mapped_column(JSON, default=list)
    usage_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    route_decision_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    api_mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    conversation_mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    workflow_mode: Mapped[str | None] = mapped_column(String(32), nullable=True)


class VoiceTurnRecord(TimestampMixin, Base):
    __tablename__ = "voice_turns"
    __table_args__ = (
        UniqueConstraint("provider", "provider_session_id", "turn_id", name="uq_voice_turn_provider_session_turn"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    provider: Mapped[str] = mapped_column(String(64), default="elevenlabs", index=True)
    provider_session_id: Mapped[str] = mapped_column(String(128), index=True)
    turn_id: Mapped[str] = mapped_column(String(128), index=True)
    conversation_id: Mapped[str] = mapped_column(String(64), index=True)
    agent_id: Mapped[str] = mapped_column(String(64), index=True)
    trace_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(32), default="received", index=True)
    request_json: Mapped[dict] = mapped_column(JSON, default=dict)
    response_json: Mapped[dict] = mapped_column(JSON, default=dict)
    audit_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DocxSessionRecord(TimestampMixin, Base):
    __tablename__ = "docx_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    conversation_id: Mapped[str] = mapped_column(String(64), index=True)
    agent_id: Mapped[str] = mapped_column(String(64), index=True)
    template_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    operation: Mapped[str] = mapped_column(String(32), default="preview")
    status: Mapped[str] = mapped_column(String(32), default="draft")
    binding_json: Mapped[dict] = mapped_column(JSON, default=dict)
    artifacts_json: Mapped[list[dict]] = mapped_column(JSON, default=list)
    diagnostics_json: Mapped[list[dict]] = mapped_column(JSON, default=list)


class ChatResponseCacheRecord(TimestampMixin, Base):
    __tablename__ = "chat_response_cache"
    __table_args__ = (
        UniqueConstraint("agent_id", "request_hash", name="uq_chat_response_cache_key"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    agent_id: Mapped[str] = mapped_column(String(64), index=True)
    request_hash: Mapped[str] = mapped_column(String(64), index=True)
    answer_text: Mapped[str] = mapped_column(Text)
    query_mode: Mapped[str] = mapped_column(String(32), default="semantic")
    citations_json: Mapped[list[dict]] = mapped_column(JSON, default=list)
    hit_count: Mapped[int] = mapped_column(Integer, default=0)


class ChatUploadRecord(TimestampMixin, Base):
    __tablename__ = "chat_uploads"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    conversation_id: Mapped[str] = mapped_column(String(64), index=True)
    agent_id: Mapped[str] = mapped_column(String(64), index=True)
    filename: Mapped[str] = mapped_column(String(256))
    storage_path: Mapped[str] = mapped_column(Text, unique=True)
    mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source_kind: Mapped[str] = mapped_column(String(32), default="document")
    requested_lane: Mapped[str] = mapped_column(String(32), default="default")
    extracted_parse_lane: Mapped[str | None] = mapped_column(String(64), nullable=True)
    extracted_char_count: Mapped[int] = mapped_column(Integer, default=0)
    extracted_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(64), default="uploaded_pending_decision")
    persistence_mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    collection_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    promoted_document_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class WorkflowDefinitionRecord(TimestampMixin, Base):
    __tablename__ = "workflow_definitions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    workflow_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    name: Mapped[str] = mapped_column(String(128))
    execution_mode: Mapped[str] = mapped_column(String(32), default="sequential")
    definition_json: Mapped[dict] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class WorkflowRunRecord(TimestampMixin, Base):
    __tablename__ = "workflow_runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    workflow_definition_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    workflow_id: Mapped[str] = mapped_column(String(128), index=True)
    surface: Mapped[str] = mapped_column(String(64), default="ghost_chatui")
    execution_mode: Mapped[str] = mapped_column(String(32), default="sequential")
    status: Mapped[str] = mapped_column(String(32), default="queued")
    current_step: Mapped[str] = mapped_column(String(128), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    prompt: Mapped[str] = mapped_column(Text)
    requested_agent_ids_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    parent_conversation_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WorkflowStepRunRecord(TimestampMixin, Base):
    __tablename__ = "workflow_step_runs"
    __table_args__ = (
        UniqueConstraint("run_id", "sequence", name="uq_workflow_step_run_sequence"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    run_id: Mapped[str] = mapped_column(String(64), index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    node_id: Mapped[str] = mapped_column(String(128))
    node_type: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), default="pending")
    agent_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    agent_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    conversation_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    output_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    citations_json: Mapped[list[dict]] = mapped_column(JSON, default=list)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WorkflowTaskRecord(TimestampMixin, Base):
    __tablename__ = "workflow_tasks"
    __table_args__ = (
        UniqueConstraint("run_id", "task_key", name="uq_workflow_task_key"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    run_id: Mapped[str] = mapped_column(String(64), index=True)
    task_key: Mapped[str] = mapped_column(String(128))
    title: Mapped[str] = mapped_column(String(256))
    task_kind: Mapped[str] = mapped_column(String(64), default="child_agent")
    status: Mapped[str] = mapped_column(String(32), default="pending")
    sequence: Mapped[int] = mapped_column(Integer, default=1)
    depends_on_task_keys_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    assigned_agent_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    assigned_agent_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    step_run_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WorkflowRunEventRecord(TimestampMixin, Base):
    __tablename__ = "workflow_run_events"
    __table_args__ = (
        UniqueConstraint("run_id", "sequence", name="uq_workflow_run_event_sequence"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    run_id: Mapped[str] = mapped_column(String(64), index=True)
    sequence: Mapped[int] = mapped_column(Integer, default=1)
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    task_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    actor_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class DocumentRecord(TimestampMixin, Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    corpus: Mapped[str] = mapped_column(String(128), index=True)
    filename: Mapped[str] = mapped_column(String(256))
    source_path: Mapped[str] = mapped_column(Text, unique=True)
    mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source_kind: Mapped[str] = mapped_column(String(32), default="document")
    requested_lane: Mapped[str] = mapped_column(String(32), default="default")
    actual_parse_lane: Mapped[str | None] = mapped_column(String(64), nullable=True)
    parse_status: Mapped[str] = mapped_column(String(32), default="pending")
    index_status: Mapped[str] = mapped_column(String(32), default="pending")
    content_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    latest_version_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="uploaded")
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class DocumentVersionRecord(TimestampMixin, Base):
    __tablename__ = "document_versions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    document_id: Mapped[str] = mapped_column(String(64), index=True)
    version_hash: Mapped[str] = mapped_column(String(128), index=True)
    storage_path: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source_kind: Mapped[str] = mapped_column(String(32), default="document")
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class IngestionRunRecord(TimestampMixin, Base):
    __tablename__ = "ingestion_runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    run_type: Mapped[str] = mapped_column(String(64), default="full_sync")
    corpus: Mapped[str] = mapped_column(String(128), index=True)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    current_step: Mapped[str] = mapped_column(String(64), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    requested_lane: Mapped[str | None] = mapped_column(String(32), nullable=True)
    trace_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)
    result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class WorkbookArtifactRecord(TimestampMixin, Base):
    __tablename__ = "workbook_artifacts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    document_id: Mapped[str] = mapped_column(String(64), index=True)
    document_version_id: Mapped[str] = mapped_column(String(64), index=True)
    filename: Mapped[str] = mapped_column(String(256))
    sheet_count: Mapped[int] = mapped_column(Integer, default=0)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class WorkbookSheetRecord(TimestampMixin, Base):
    __tablename__ = "workbook_sheets"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    workbook_artifact_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(256))
    ordinal: Mapped[int] = mapped_column(Integer)
    row_count: Mapped[int] = mapped_column(Integer, default=0)


class WorkbookTableRecord(TimestampMixin, Base):
    __tablename__ = "workbook_tables"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    workbook_sheet_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(256))
    ordinal: Mapped[int] = mapped_column(Integer)
    header_json: Mapped[list] = mapped_column(JSON, default=list)
    row_count: Mapped[int] = mapped_column(Integer, default=0)


class WorkbookRowRecord(TimestampMixin, Base):
    __tablename__ = "workbook_rows"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    document_id: Mapped[str] = mapped_column(String(64), index=True)
    workbook_table_id: Mapped[str] = mapped_column(String(64), index=True)
    row_index: Mapped[int] = mapped_column(Integer)
    row_json: Mapped[dict] = mapped_column(JSON, default=dict)
    search_text: Mapped[str] = mapped_column(Text, default="")


class RetrievalArtifactRecord(TimestampMixin, Base):
    __tablename__ = "retrieval_artifacts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    document_id: Mapped[str] = mapped_column(String(64), index=True)
    corpus: Mapped[str] = mapped_column(String(128), index=True)
    artifact_type: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    qdrant_point_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
