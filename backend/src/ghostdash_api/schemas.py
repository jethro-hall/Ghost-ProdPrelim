from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ChatApiMode = Literal["responses", "chat_completions"]
QueryMode = Literal["semantic", "structured", "blended"]


class ConnectionPayload(BaseModel):
    provider: str
    label: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    chat_model: str | None = None
    embedding_model: str | None = None
    enabled: bool = True


class ConnectionTestPayload(BaseModel):
    provider: str = "openai"
    label: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    chat_model: str | None = None
    api_mode: ChatApiMode = "responses"
    prompt: str = "Reply with a short OK message that names the API mode used."


class ConnectionView(BaseModel):
    id: str
    provider: str
    label: str
    base_url: str | None
    chat_model: str | None
    embedding_model: str | None
    enabled: bool
    api_key_hint: str | None
    has_api_key: bool


class ConnectionTestResponse(BaseModel):
    ok: bool
    api_mode: ChatApiMode
    model: str
    base_url: str
    output: str


class CapabilityStatus(BaseModel):
    available: bool
    configured: bool
    message: str


class RuntimeCapabilities(BaseModel):
    parser_lanes: dict[str, CapabilityStatus]
    chat_api_modes: dict[str, CapabilityStatus]
    streaming: CapabilityStatus
    vector_store: str
    model_runtime: str


class RuntimeDefaultsPayload(BaseModel):
    chat_api_mode: ChatApiMode = "responses"
    pdf_chunk_size: int = Field(default=900, ge=600, le=1400)
    pdf_chunk_overlap: int = Field(default=120, ge=50, le=220)
    pdf_sentence_window: int = Field(default=2, ge=1, le=4)
    pdf_top_k: int = Field(default=6, ge=4, le=12)
    pdf_parse_lane_policy: Literal["local_default", "cloud_default", "auto"] = "auto"
    pdf_rerank_enabled: bool = False


class RuntimeDefaultsView(BaseModel):
    chat_api_mode: ChatApiMode = "responses"
    pdf_chunk_size: int = 900
    pdf_chunk_overlap: int = 120
    pdf_sentence_window: int = 2
    pdf_top_k: int = 6
    pdf_parse_lane_policy: Literal["local_default", "cloud_default", "auto"] = "auto"
    pdf_rerank_enabled: bool = False


class AgentToolConfig(BaseModel):
    id: str
    name: str
    description: str
    enabled: bool = True


class AgentProfilePayload(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=128)
    system_prompt: str = Field(min_length=1)
    first_message: str = Field(min_length=1)
    model_id: str = Field(min_length=1)
    temperature: float = Field(default=0.2, ge=0, le=2)
    max_tokens: int = Field(default=2000, ge=1, le=16000)
    language: str = Field(default="en-US", min_length=2, max_length=32)
    voice_id: str = Field(default="alloy", min_length=1, max_length=64)
    tools: list[AgentToolConfig] = Field(default_factory=list)
    is_default: bool = False
    enabled: bool = True


class AgentProfileView(BaseModel):
    id: str
    name: str
    system_prompt: str
    first_message: str
    model_id: str
    temperature: float
    max_tokens: int
    language: str
    voice_id: str
    tools: list[AgentToolConfig]
    is_default: bool
    enabled: bool
    created_at: datetime
    updated_at: datetime


class ConversationSummaryView(BaseModel):
    id: str
    agent_id: str
    title: str
    corpora: list[str] = Field(default_factory=list)
    api_mode: ChatApiMode = "responses"
    message_count: int = 0
    created_at: datetime
    updated_at: datetime


class ConversationMessageView(BaseModel):
    id: str
    conversation_id: str
    agent_id: str
    role: Literal["user", "assistant"]
    content: str
    query_mode: QueryMode | None = None
    citations: list[dict] = Field(default_factory=list)
    api_mode: ChatApiMode | None = None
    created_at: datetime


class UploadView(BaseModel):
    id: str
    corpus: str
    filename: str
    policy_lane: str
    status: str


class DocumentArtifactView(BaseModel):
    artifact_type: str
    source: str
    status: str


class DocumentIngestionView(BaseModel):
    id: str
    corpus: str
    filename: str
    source_path: str
    requested_lane: str
    actual_parse_lane: str | None
    parse_status: str
    index_status: str
    overall_status: str
    error_message: str | None
    workbook_sheet_count: int = 0
    workbook_table_count: int = 0
    workbook_row_count: int = 0
    artifacts: list[DocumentArtifactView]


class SyncRequest(BaseModel):
    corpus: str | None = None


class TaskStepView(BaseModel):
    id: str
    label: str
    done: bool
    active: bool
    status: Literal["pending", "running", "completed", "failed"] = "pending"


class TaskDocumentView(BaseModel):
    id: str
    filename: str
    requested_lane: str
    parse_status: str
    index_status: str
    overall_status: str
    error_message: str | None
    active: bool = False


class TaskView(BaseModel):
    id: str
    task_type: str
    status: str
    current_step: str
    progress: float
    error_message: str | None
    steps: list[TaskStepView]
    total_documents: int = 0
    completed_documents: int = 0
    failed_documents: int = 0
    active_document_id: str | None = None
    active_filename: str | None = None
    documents: list[TaskDocumentView] = Field(default_factory=list)


class RunSummaryView(BaseModel):
    id: str
    run_type: str
    corpus: str
    status: str
    current_step: str
    progress: float
    requested_lane: str | None
    trace_id: str | None
    error_message: str | None
    result_json: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    corpora: list[str] = Field(default_factory=list)
    top_k: int | None = Field(default=None, ge=1, le=20)
    api_mode: ChatApiMode = "responses"
    agent_id: str | None = None
    conversation_id: str | None = None


class ChatCitation(BaseModel):
    document_id: str
    filename: str
    corpus: str
    artifact_type: str
    source_path: str
    chunk_index: int | None = None
    page_start: int | None = None
    page_end: int | None = None
    section_title: str | None = None
    parse_lane: str | None = None
    sheet_name: str | None = None
    table_name: str | None = None
    row_index: int | None = None


class ChatResponse(BaseModel):
    answer: str
    query_mode: QueryMode
    citations: list[ChatCitation]
    conversation_id: str | None = None
    agent_id: str | None = None
    cached: bool = False
