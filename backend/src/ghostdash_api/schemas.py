from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ChatApiMode = Literal["responses", "chat_completions"]
QueryMode = Literal["semantic", "structured", "blended"]
RequestedParseLane = Literal["default", "local", "cloud"]
ParseLanePolicy = Literal["local_default", "cloud_default", "auto"]
ChatUploadPersistenceMode = Literal["conversation_only", "save_to_knowledge"]
ProviderKind = Literal["openai", "anthropic", "google_gemini", "openai_compatible"]
ConnectionAuthStrategy = Literal["bearer", "x_api_key", "x_goog_api_key", "custom_header"]
WorkflowExecutionMode = Literal["sequential"]
WorkflowRunStatus = Literal["queued", "running", "completed", "completed_with_errors", "failed", "aborted"]
WorkflowStepRunStatus = Literal["pending", "running", "completed", "failed", "aborted"]
WorkflowDefinitionFormat = Literal["json", "yaml"]
WorkflowHeadAgentSelectionMode = Literal["active_agent", "fixed_agent"]
WorkflowNodeType = Literal["child_agent", "head_agent_synthesis", "ui_grouped_results"]
ToolHealth = Literal["healthy", "unhealthy", "unknown"]
ToolAuthSource = Literal["direct_credentials"]
ChatToolEventStatus = Literal["planned", "preview", "executed", "blocked", "failed"]


class ConnectionPayload(BaseModel):
    provider: str
    label: str | None = None
    provider_kind: ProviderKind = "openai"
    auth_strategy: ConnectionAuthStrategy = "bearer"
    auth_header_name: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    enabled: bool = True


class ConnectionTestPayload(BaseModel):
    provider: str = "openai"
    label: str | None = None
    provider_kind: ProviderKind = "openai"
    auth_strategy: ConnectionAuthStrategy = "bearer"
    auth_header_name: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    api_mode: ChatApiMode = "responses"
    model_id: str | None = None
    prompt: str = "Reply with a short OK message that names the API mode used."


class ConnectionView(BaseModel):
    id: str
    provider: str
    label: str
    provider_kind: ProviderKind
    auth_strategy: ConnectionAuthStrategy
    auth_header_name: str | None
    base_url: str | None
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


class AgentToolConfig(BaseModel):
    id: str
    name: str
    description: str
    enabled: bool = True
    allowed_urls: list[str] = Field(default_factory=list, max_length=2)
    provider: str | None = None
    kind: str | None = None
    session_toggleable: bool = False


class ToolCatalogEntryView(BaseModel):
    id: str
    provider: str
    name: str
    gateway: str
    description: str | None = None
    status: ToolHealth = "unknown"
    active: bool = False
    configured: bool = False
    read_only: bool = True
    session_toggleable: bool = False


class ToolSettingsPayload(BaseModel):
    base_url: str | None = None
    database: str | None = None
    username: str | None = None
    password: str | None = None
    auth_source: ToolAuthSource = "direct_credentials"
    read_only: bool = True
    timeout_ms: int = Field(default=20000, ge=1000, le=120000)
    health_path: str = Field(default="/health", min_length=1, max_length=64)
    execute_path: str = Field(default="/tool", min_length=1, max_length=64)


class ToolSettingsView(BaseModel):
    base_url: str | None = None
    database: str | None = None
    username_hint: str | None = None
    has_password: bool = False
    auth_source: ToolAuthSource = "direct_credentials"
    read_only: bool = True
    timeout_ms: int = Field(default=20000, ge=1000, le=120000)
    health_path: str = Field(default="/health", min_length=1, max_length=64)
    execute_path: str = Field(default="/tool", min_length=1, max_length=64)
    missing_config: list[str] = Field(default_factory=list)


class ToolDetailView(ToolCatalogEntryView):
    settings: ToolSettingsView
    safe_operations: list[str] = Field(default_factory=list)


class ToolActivationPayload(BaseModel):
    active: bool


class ToolPolicyPayload(BaseModel):
    allowed_tool_ids: list[str] = Field(default_factory=list)


class ToolPolicyView(BaseModel):
    agent_id: str
    allowed_tool_ids: list[str] = Field(default_factory=list)


class ToolTestResponse(BaseModel):
    success: bool
    message: str
    trace_id: str | None = None
    latency_ms: int | None = None
    data: dict = Field(default_factory=dict)


class ToolExecutePayload(BaseModel):
    operation: str = Field(min_length=1, max_length=128)
    payload: dict = Field(default_factory=dict)


class ToolExecuteResponse(BaseModel):
    success: bool
    message: str
    trace_id: str | None = None
    latency_ms: int | None = None
    operation: str | None = None
    read_only: bool = True
    data: dict = Field(default_factory=dict)


class ToolReadinessSummary(BaseModel):
    id: str
    status: str
    blocked_reasons: list[str] = Field(default_factory=list)
    active: bool = False
    enabled_for_agent: bool = False
    session_enabled: bool = True
    health: ToolHealth = "unknown"


class RuntimeProfileLlmConfig(BaseModel):
    connection_id: str | None = None
    provider: str = Field(default="openai", min_length=1, max_length=32)
    model_id: str = Field(min_length=1)
    temperature: float = Field(default=0.2, ge=0, le=2)
    max_tokens: int = Field(default=2048, ge=1, le=16000)
    api_mode: ChatApiMode = "responses"


class RuntimeProfileGuardrailsConfig(BaseModel):
    system_prompt: str = Field(min_length=1)
    grounding_mode: Literal["retrieved_only"] = "retrieved_only"
    insufficient_context_behavior: str = Field(min_length=1)


class RuntimeProfileKnowledgeBaseConfig(BaseModel):
    default_corpora: list[str] = Field(default_factory=list)
    embedding_model_id: str = Field(min_length=1)


class RuntimeProfileRetrievalConfig(BaseModel):
    default_top_k: int = Field(default=6, ge=1, le=20)
    text_chunk_size: int = Field(default=800, ge=400, le=1800)
    text_chunk_overlap: int = Field(default=120, ge=20, le=320)
    text_heading_aware: bool = True
    pdf_chunk_size: int = Field(default=900, ge=600, le=1400)
    pdf_chunk_overlap: int = Field(default=120, ge=50, le=220)
    pdf_sentence_window: int = Field(default=2, ge=1, le=4)
    pdf_parse_lane_policy: ParseLanePolicy = "auto"
    pdf_rerank_enabled: bool = False


class RuntimeProfileToolPolicyConfig(BaseModel):
    tools: list[AgentToolConfig] = Field(default_factory=list)


class RuntimeProfilePayload(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=128)
    description: str | None = None
    llm_config: RuntimeProfileLlmConfig
    guardrails_config: RuntimeProfileGuardrailsConfig
    kb_config: RuntimeProfileKnowledgeBaseConfig
    retrieval_config: RuntimeProfileRetrievalConfig
    tool_policy_config: RuntimeProfileToolPolicyConfig
    is_default: bool = False
    enabled: bool = True


class RuntimeProfileView(BaseModel):
    id: str
    name: str
    description: str | None = None
    llm_config: RuntimeProfileLlmConfig
    guardrails_config: RuntimeProfileGuardrailsConfig
    kb_config: RuntimeProfileKnowledgeBaseConfig
    retrieval_config: RuntimeProfileRetrievalConfig
    tool_policy_config: RuntimeProfileToolPolicyConfig
    is_default: bool
    enabled: bool
    created_at: datetime
    updated_at: datetime


class RuntimeDefaultsPayload(BaseModel):
    chat_api_mode: ChatApiMode = "responses"
    llm_model_id: str = Field(default="openai/llama31-8b", min_length=1)
    embedding_model_id: str = Field(default="openai/intfloat/multilingual-e5-large-instruct", min_length=1)
    default_corpora: list[str] = Field(default_factory=lambda: ["default"])
    text_chunk_size: int = Field(default=800, ge=400, le=1800)
    text_chunk_overlap: int = Field(default=120, ge=20, le=320)
    text_heading_aware: bool = True
    pdf_chunk_size: int = Field(default=900, ge=600, le=1400)
    pdf_chunk_overlap: int = Field(default=120, ge=50, le=220)
    pdf_sentence_window: int = Field(default=2, ge=1, le=4)
    pdf_top_k: int = Field(default=6, ge=1, le=20)
    pdf_parse_lane_policy: ParseLanePolicy = "auto"
    pdf_rerank_enabled: bool = False


class RuntimeDefaultsView(RuntimeDefaultsPayload):
    runtime_profile_id: str | None = None
    runtime_profile_name: str | None = None
    llm_connection_id: str | None = None
    llm_connection_label: str | None = None
    llm_provider_key: str | None = None
    llm_provider_kind: ProviderKind | None = None


class AgentProfilePayload(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=128)
    first_message: str = Field(min_length=1)
    language: str = Field(default="en-US", min_length=2, max_length=32)
    voice_id: str = Field(default="alloy", min_length=1, max_length=64)
    runtime_profile_id: str | None = None
    runtime_profile: RuntimeProfilePayload | None = None
    is_default: bool = False
    enabled: bool = True


class AgentProfileView(BaseModel):
    id: str
    name: str
    first_message: str
    language: str
    voice_id: str
    runtime_profile_id: str
    runtime_profile: RuntimeProfileView
    is_default: bool
    enabled: bool
    created_at: datetime
    updated_at: datetime


class ChatBootstrapFeatures(BaseModel):
    allow_mock_provider: bool = False
    allow_api_mode_override: bool = False
    allow_approved_web_toggle: bool = True


class ChatBootstrapView(BaseModel):
    surface: str
    default_agent_id: str | None = None
    runtime_defaults: RuntimeDefaultsView
    capabilities: RuntimeCapabilities
    features: ChatBootstrapFeatures
    agents: list[AgentProfileView] = Field(default_factory=list)
    tools_catalog: list[ToolCatalogEntryView] = Field(default_factory=list)


class CollectionCreatePayload(BaseModel):
    slug: str = Field(min_length=1, max_length=128)
    name: str | None = Field(default=None, max_length=128)
    description: str | None = None


class CollectionImpactView(BaseModel):
    documents: int = 0
    document_versions: int = 0
    retrieval_artifacts: int = 0
    workbook_artifacts: int = 0
    workbook_sheets: int = 0
    workbook_tables: int = 0
    workbook_rows: int = 0
    ingestion_runs: int = 0
    active_runs: int = 0
    runtime_profiles: int = 0
    agents: int = 0
    conversations: int = 0
    messages: int = 0
    cache_entries: int = 0
    vector_points: int = 0
    upload_paths: list[str] = Field(default_factory=list)


class CollectionView(BaseModel):
    id: str
    slug: str
    name: str
    description: str | None = None
    status: str
    embedding_model_id: str | None = None
    attached_runtime_profile_ids: list[str] = Field(default_factory=list)
    attached_agent_ids: list[str] = Field(default_factory=list)
    impact: CollectionImpactView | None = None
    created_at: datetime
    updated_at: datetime


class CollectionDeleteResponse(BaseModel):
    id: str
    slug: str
    deleted: bool = True
    impact: CollectionImpactView


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
    policy_lane: RequestedParseLane
    status: str


class ChatUploadDecisionPayload(BaseModel):
    persistence_mode: ChatUploadPersistenceMode
    collection_id: str | None = None
    collection_slug: str | None = None


class ChatUploadView(BaseModel):
    id: str
    conversation_id: str
    agent_id: str
    filename: str
    mime_type: str | None = None
    source_kind: str
    policy_lane: RequestedParseLane
    extracted_parse_lane: str | None = None
    extracted_char_count: int = 0
    status: str
    persistence_mode: ChatUploadPersistenceMode | None = None
    collection_id: str | None = None
    collection_slug: str | None = None
    promoted_document_id: str | None = None
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime


class DocumentArtifactView(BaseModel):
    artifact_type: str
    source: str
    status: str


class DocumentIngestionView(BaseModel):
    id: str
    corpus: str
    filename: str
    source_path: str
    requested_lane: RequestedParseLane
    actual_parse_lane: str | None
    parse_status: str
    index_status: str
    overall_status: str
    error_message: str | None
    workbook_sheet_count: int = 0
    workbook_table_count: int = 0
    workbook_row_count: int = 0
    artifacts: list[DocumentArtifactView]


class VectorStatsView(BaseModel):
    documents: int = 0
    retrieval_artifacts: int = 0
    workbook_rows: int = 0
    pdf_documents: int = 0
    xlsx_documents: int = 0
    txt_documents: int = 0
    other_documents: int = 0


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
    requested_lane: RequestedParseLane
    actual_parse_lane: str | None = None
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
    requested_lane: RequestedParseLane | None
    trace_id: str | None
    error_message: str | None
    result_json: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class WorkflowRunCreatePayload(BaseModel):
    workflow_id: str = Field(min_length=1, max_length=128)
    surface: str = Field(default="ghost_chatui", min_length=1, max_length=64)
    prompt: str = Field(min_length=1)
    agent_ids: list[str] = Field(min_length=1)
    parent_conversation_id: str | None = None
    api_mode: ChatApiMode = "responses"
    use_approved_web: bool = False
    head_agent_id: str | None = None


class WorkflowHeadAgentPayload(BaseModel):
    selection_mode: WorkflowHeadAgentSelectionMode = "active_agent"
    agent_id: str | None = None
    prompt_template: str | None = None


class WorkflowDefinitionNodePayload(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    type: WorkflowNodeType
    description: str = Field(min_length=1)
    prompt_template: str | None = None


class WorkflowDefinitionPayload(BaseModel):
    workflow_id: str = Field(min_length=1, max_length=128)
    version: int = Field(default=1, ge=1)
    name: str = Field(min_length=1, max_length=128)
    execution_mode: WorkflowExecutionMode = "sequential"
    min_agents: int = Field(default=2, ge=1, le=8)
    max_agents: int = Field(default=3, ge=1, le=8)
    persist_child_conversations: bool = True
    head_agent: WorkflowHeadAgentPayload | None = None
    nodes: list[WorkflowDefinitionNodePayload] = Field(default_factory=list, min_length=1)


class WorkflowDefinitionImportPayload(BaseModel):
    format: WorkflowDefinitionFormat
    definition_text: str = Field(min_length=1)


class WorkflowDefinitionView(WorkflowDefinitionPayload):
    enabled: bool
    created_at: datetime
    updated_at: datetime


class WorkflowRunUpdatePayload(BaseModel):
    status: WorkflowRunStatus | None = None
    error_message: str | None = None
    result_json: dict = Field(default_factory=dict)


class WorkflowStepRunUpdatePayload(BaseModel):
    status: WorkflowStepRunStatus | None = None
    conversation_id: str | None = None
    output_text: str | None = None
    citations: list[dict] = Field(default_factory=list)
    error_message: str | None = None
    metadata_json: dict = Field(default_factory=dict)


class WorkflowStepRunView(BaseModel):
    id: str
    sequence: int
    node_id: str
    node_type: str
    status: WorkflowStepRunStatus
    agent_id: str | None = None
    agent_name: str | None = None
    conversation_id: str | None = None
    output_text: str | None = None
    citations: list[dict] = Field(default_factory=list)
    error_message: str | None = None
    metadata_json: dict = Field(default_factory=dict)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class WorkflowRunSummaryView(BaseModel):
    id: str
    workflow_id: str
    workflow_name: str | None = None
    surface: str
    execution_mode: WorkflowExecutionMode
    status: WorkflowRunStatus
    current_step: str
    progress: float
    prompt: str
    requested_agent_ids: list[str] = Field(default_factory=list)
    head_agent_id: str | None = None
    head_agent_name: str | None = None
    parent_conversation_id: str | None = None
    error_message: str | None = None
    result_json: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class WorkflowRunView(WorkflowRunSummaryView):
    started_at: datetime | None = None
    completed_at: datetime | None = None
    steps: list[WorkflowStepRunView] = Field(default_factory=list)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    corpora: list[str] = Field(default_factory=list)
    top_k: int | None = Field(default=None, ge=1, le=20)
    api_mode: ChatApiMode = "responses"
    llm_model_id: str | None = Field(
        default=None,
        max_length=256,
        description="Per-message model id (e.g. openai/gpt-4o). Omit to use the agent runtime profile model.",
    )
    agent_id: str | None = None
    conversation_id: str | None = None
    use_approved_web: bool = False
    tool_overrides: dict[str, bool] = Field(default_factory=dict)


class ChatUsage(BaseModel):
    """Approximate token counts (cl100k) for cost awareness; not identical to provider billing."""

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    estimate: bool = True


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
    section_path: str | None = None
    heading_level: int | None = None
    parse_lane: str | None = None
    sheet_name: str | None = None
    table_name: str | None = None
    row_index: int | None = None
    source_type: str | None = None
    title: str | None = None


class ChatToolEvent(BaseModel):
    tool_id: str
    status: ChatToolEventStatus
    operation: str | None = None
    summary: str | None = None
    blocked_reason: str | None = None
    payload: dict = Field(default_factory=dict)
    latency_ms: int | None = None


class ChatResponse(BaseModel):
    answer: str
    query_mode: QueryMode
    citations: list[ChatCitation]
    conversation_id: str | None = None
    agent_id: str | None = None
    cached: bool = False
    usage: ChatUsage | None = None
    effective_snapshot_id: str | None = None
    tool_summary: list[ToolReadinessSummary] = Field(default_factory=list)
    tool_events: list[ChatToolEvent] = Field(default_factory=list)
