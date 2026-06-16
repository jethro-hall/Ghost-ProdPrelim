from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field
from pydantic import field_validator, model_validator

ChatApiMode = Literal["responses", "chat_completions"]
ConversationMode = Literal["quick", "board", "working_session"]
WorkflowMode = Literal[
    "standard",
    "data_collector",
    "documenter",
    "odoo_specialist",
    "case_framing",
    "evidence_retrieval",
    "odoo_operations",
    "bp_mode",
]
QueryMode = Literal["semantic", "structured", "blended", "direct"]
RouteType = Literal["direct", "workers", "suggest_specialist"]
RequestedParseLane = Literal["default", "local", "cloud"]
ParseLanePolicy = Literal["local_default", "cloud_default", "auto"]
ChatUploadPersistenceMode = Literal["conversation_only", "save_to_knowledge"]
ProviderKind = Literal["openai", "anthropic", "google_gemini", "openai_compatible", "amazon_bedrock"]
ConnectionAuthStrategy = Literal["bearer", "x_api_key", "x_goog_api_key", "custom_header"]
WorkflowExecutionMode = Literal["sequential"]
WorkflowRunStatus = Literal["queued", "running", "completed", "completed_with_errors", "failed", "aborted"]
WorkflowStepRunStatus = Literal["pending", "running", "completed", "failed", "aborted"]
WorkflowTaskStatus = Literal["pending", "queued", "running", "completed", "failed", "aborted"]
WorkflowTaskKind = Literal["child_agent", "head_synthesis", "tool", "approval", "memory"]
WorkflowRunEventType = Literal[
    "RUN_CREATED",
    "PLAN_GRAPH_CREATED",
    "TASK_CREATED",
    "TASK_DISPATCHED",
    "TASK_STARTED",
    "TASK_COMPLETED",
    "TASK_FAILED",
    "TASK_ABORTED",
    "TOOL_INVOCATION_STARTED",
    "TOOL_INVOCATION_COMPLETED",
    "TOOL_INVOCATION_BLOCKED",
    "APPROVAL_REQUIRED",
    "APPROVAL_GRANTED",
    "APPROVAL_REJECTED",
    "RUN_COMPLETED",
    "RUN_FAILED",
    "RUN_ABORTED",
    "BP_AUDIT_EVALUATED",
    "BP_AUDIT_PASSED",
    "BP_AUDIT_FAILED",
]
WorkflowDefinitionFormat = Literal["json", "yaml"]
WorkflowHeadAgentSelectionMode = Literal["active_agent", "fixed_agent"]
WorkflowNodeType = Literal["child_agent", "head_agent_synthesis", "ui_grouped_results"]
ToolHealth = Literal["healthy", "unhealthy", "unknown"]
ToolAuthSource = Literal["direct_credentials"]
ChatToolEventStatus = Literal["planned", "preview", "executed", "blocked", "failed"]
DocumentFrameStatus = Literal["draft", "active", "final"]
DocumentFrameFragmentType = Literal["note", "snippet", "paragraph", "mini_analysis", "scorecard", "graph_idea"]
DocxOperation = Literal["preview", "finalize"]
DocxArtifactKind = Literal["docx", "pdf", "html"]
DeletionPreviewScope = Literal["chats", "agent"]
AgentRole = Literal["lead", "sub"]


class ConnectionPayload(BaseModel):
    provider: str
    label: str | None = None
    provider_kind: ProviderKind = "openai"
    auth_strategy: ConnectionAuthStrategy = "bearer"
    auth_header_name: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    enabled: bool = True
    default_model_id: str | None = None
    aws_region: str | None = None


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
    aws_region: str | None = None


class ConnectionView(BaseModel):
    id: str
    provider: str
    label: str
    provider_kind: ProviderKind
    auth_strategy: ConnectionAuthStrategy
    auth_header_name: str | None
    base_url: str | None
    enabled: bool
    default_model_id: str | None
    api_key_hint: str | None
    has_api_key: bool
    aws_region: str | None = None


class ConnectionDeletionPreviewImpactView(BaseModel):
    runtime_profile_direct_refs: int = 0
    runtime_profile_provider_refs: int = 0
    runtime_profile_fallback_refs: int = 0
    runtime_profile_fallback_provider_refs: int = 0
    agents_impacted: int = 0
    active_workflow_runs: int = 0
    active_workflow_steps: int = 0
    is_runtime_default_connection: bool = False
    seeded_provider_key: bool = False


class ConnectionDeletionPreviewView(BaseModel):
    connection_id: str
    provider: str
    can_execute: bool
    blocking_reasons: list[str] = Field(default_factory=list)
    impact: ConnectionDeletionPreviewImpactView
    confirmation_token: str


class ConnectionDeletePayload(BaseModel):
    confirmation_token: str = Field(min_length=8, max_length=128)


class ConnectionDeleteResponse(BaseModel):
    id: str
    provider: str
    deleted: bool = True


class ConnectionTestResponse(BaseModel):
    ok: bool
    api_mode: str  # e.g. "responses", "chat_completions", "bedrock_converse"
    model: str
    base_url: str
    output: str


class BedrockModelItem(BaseModel):
    model_id: str
    model_name: str
    provider: str
    kind: str  # "foundation_model" | "inference_profile"
    input_modalities: list[str] = Field(default_factory=list)
    output_modalities: list[str] = Field(default_factory=list)
    status: str = "ACTIVE"


class BedrockModelsResponse(BaseModel):
    models: list[BedrockModelItem]
    region: str
    count: int
    error: str | None = None


class CapabilityStatus(BaseModel):
    available: bool
    configured: bool
    message: str


class RuntimeCapabilities(BaseModel):
    parser_lanes: dict[str, CapabilityStatus]
    chat_api_modes: dict[str, CapabilityStatus]
    llm_providers: dict[str, CapabilityStatus] = Field(default_factory=dict)
    streaming: CapabilityStatus
    vector_store: str
    model_runtime: str


class AgentToolConfig(BaseModel):
    id: str
    name: str
    description: str
    enabled: bool = True
    allowed_urls: list[str] = Field(default_factory=list)
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


class OdooQuerySpec(BaseModel):
    model: str = Field(min_length=1, max_length=128)
    method: Literal["search_read", "read_group"]
    domain: list = Field(default_factory=list)
    fields: list[str] = Field(default_factory=list)
    groupby: list[str] = Field(default_factory=list)
    limit: int | None = Field(default=None, ge=1, le=1000)
    offset: int | None = Field(default=None, ge=0)
    order: str | None = None
    orderby: str | None = None
    lazy: bool = False


class ToolExecutePayload(BaseModel):
    operation: str = Field(min_length=1, max_length=128)
    payload: dict = Field(default_factory=dict)
    dry_run: bool = False
    approval_token: str | None = Field(default=None, max_length=256)


class ToolExecuteResponse(BaseModel):
    success: bool
    message: str
    trace_id: str | None = None
    latency_ms: int | None = None
    operation: str | None = None
    read_only: bool = True
    risk_class: Literal["read", "write", "destructive"] = "read"
    requires_approval: bool = False
    approved: bool = False
    policy_decision_id: str | None = None
    data: dict = Field(default_factory=dict)


class HubTigerStatusView(BaseModel):
    mode: Literal["read_only", "read_write"] = "read_only"
    mcp_url_configured: bool = False
    proxy_url_configured: bool = False
    read_timeout_ms: int = 8000
    mutation_timeout_ms: int = 12000
    health: Literal["healthy", "degraded", "unconfigured"] = "unconfigured"
    message: str = "HubTiger integration is not configured."


class HubTigerToolBindingView(BaseModel):
    tool_id: str
    label: str
    category: Literal["availability", "jobs", "quotes", "booking"]
    mode: Literal["read_only", "read_write"]
    write_action: bool = False
    enabled: bool = True


class HubTigerTestRequest(BaseModel):
    operation: Literal[
        "availability_lookup",
        "job_lookup",
        "job_search",
        "job_retrieve",
        "quote_preview",
        "booking_slot_hold",
        "booking_customer_search",
        "booking_customer_confirm",
        "booking_bike_list",
        "booking_bike_confirm",
        "booking_service_set",
        "booking_submit",
        "booking_finalize",
        "booking_create",
        "booking_update",
        "quote_add_line_item",
    ]
    payload: dict = Field(default_factory=dict)


class HubTigerCustomerIdentifier(BaseModel):
    phone: str | None = Field(default=None, max_length=64)
    first_name: str | None = Field(default=None, max_length=128)
    last_name: str | None = Field(default=None, max_length=128)

    @field_validator("phone", "first_name", "last_name", mode="before")
    @classmethod
    def _trim_optional_customer_fields(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = str(value).strip()
        return trimmed or None


class ElevenLabsHubTigerToolRequest(BaseModel):
    """Canonical ElevenLabs HubTiger input with backward-compatible legacy fields."""

    function: str | None = Field(default=None, max_length=128)
    operation: str | None = Field(default=None, max_length=128)
    cache_mode: str | None = Field(default=None, max_length=32)
    date: str | None = Field(default=None, max_length=64)
    start_date: str | None = Field(default=None, max_length=64)
    end_date: str | None = Field(default=None, max_length=64)
    store: str | None = Field(default=None, max_length=128)
    customer: HubTigerCustomerIdentifier | None = None
    payload: dict = Field(default_factory=dict)

    @field_validator("function", "operation", "cache_mode", "date", "start_date", "end_date", "store", mode="before")
    @classmethod
    def _trim_optional_fields(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = str(value).strip()
        return trimmed or None

    @field_validator("payload", mode="before")
    @classmethod
    def _validate_payload_shape(cls, value: Any) -> dict[str, Any]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("`payload` must be an object.")
        if len(value) > 24:
            raise ValueError("`payload` has too many fields; keep it to 24 or fewer keys.")
        for key, item in value.items():
            if len(str(key)) > 64:
                raise ValueError("`payload` keys must be <=64 chars.")
            if isinstance(item, str) and len(item) > 512:
                raise ValueError("`payload` string values must be <=512 chars.")
        return value

    @model_validator(mode="after")
    def _validate_selector(self) -> "ElevenLabsHubTigerToolRequest":
        if not self.function and not self.operation:
            raise ValueError("Either `function` or `operation` is required.")
        return self


class ElevenLabsHubTigerBookingAvailabilityRequest(BaseModel):
    """Body for POST /api/elevenlabs/hubtiger/booking_availability — maps to MCP availability_lookup."""

    store: str = Field(min_length=1, max_length=128)
    start_date: str = Field(min_length=1, max_length=64)
    limit: int = Field(default=4, ge=1, le=50)


class HubTigerWriteReviewRejectRequest(BaseModel):
    reason: str = Field(default="", max_length=512)


class HubTigerWriteReviewListView(BaseModel):
    review_id: str
    created_at: str | None = None
    operation: str | None = None
    review_status: str
    store: str | None = None
    preflight_passed_at: str | None = None


class HubTigerTestResponse(BaseModel):
    success: bool
    blocked: bool = False
    mode: Literal["read_only", "read_write"] = "read_only"
    operation: str
    message: str
    trace_id: str | None = None
    data: dict = Field(default_factory=dict)


class PublicToolResult(BaseModel):
    """Safe tool payload for external surfaces (e.g. ElevenLabs). Omits internal trace ids and redacts `data` server-side."""

    success: bool
    message: str
    operation: str
    blocked: bool = False
    data: dict = Field(default_factory=dict)


class HubTigerCustomerByPhoneResponse(BaseModel):
    """Fast cyclist lookup by phone for voice/IVR surfaces."""

    success: bool
    found: bool
    message: str
    phone: str = ""
    first_name: str | None = None
    last_name: str | None = None
    customer_id: str | None = None
    model: str | None = None
    jobcard: str | None = None
    date_checked_in: str | None = None
    location: str | None = None
    # PascalCase duplicates for ElevenLabs dynamic variable assignment.
    name: str | None = None
    Name: str | None = None
    Jobcard: str | None = None
    Model: str | None = None
    Workshop: str | None = None
    Location: str | None = None
    DateCheckedIn: str | None = None
    error_code: str | None = None


ElevenLabsConversationStatus = Literal["initiated", "in-progress", "processing", "done", "failed"]
ElevenLabsCallOutcome = Literal["success", "failure", "unknown"]


class ElevenLabsAnalysisConversationSummaryView(BaseModel):
    id: str
    title: str | None = None
    started_at_unix_secs: int | None = None
    status: ElevenLabsConversationStatus | str = "processing"
    call_successful: ElevenLabsCallOutcome | str = "unknown"
    duration_seconds: int | None = None
    message_count: int | None = None
    user_id: str | None = None
    branch_id: str | None = None
    main_language: str | None = None
    channel: str | None = None
    direction: str | None = None
    rating: float | None = None
    agent_id: str | None = None
    agent_name: str | None = None


class ElevenLabsAnalysisConversationsListView(BaseModel):
    items: list[ElevenLabsAnalysisConversationSummaryView] = Field(default_factory=list)
    next_cursor: str | None = None
    has_more: bool = False
    upstream_ready: bool = True
    warning_code: str | None = None
    warning_message: str | None = None
    filters_applied: dict[str, Any] = Field(default_factory=dict)
    source: Literal["elevenlabs"] = "elevenlabs"


class ElevenLabsAnalysisConversationDetailView(BaseModel):
    id: str
    title: str | None = None
    agent_id: str | None = None
    agent_name: str | None = None
    status: ElevenLabsConversationStatus | str = "processing"
    user_id: str | None = None
    branch_id: str | None = None
    environment: str | None = None
    text_only: bool = False
    started_at_unix_secs: int | None = None
    accepted_at_unix_secs: int | None = None
    duration_seconds: int | None = None
    cost: int | None = None
    credits_llm: int | None = None
    llm_cost: float | None = None
    call_successful: ElevenLabsCallOutcome | str = "unknown"
    call_status: str | None = None
    call_summary_title: str | None = None
    transcript_summary: str | None = None
    termination_reason: str | None = None
    main_language: str | None = None
    has_audio: bool = False
    has_user_audio: bool = False
    has_response_audio: bool = False
    visited_agents: list[dict[str, Any]] = Field(default_factory=list)
    tag_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    analysis: dict[str, Any] = Field(default_factory=dict)
    client_data: dict[str, Any] = Field(default_factory=dict)
    source: Literal["elevenlabs"] = "elevenlabs"


class ElevenLabsAnalysisTranscriptTurnView(BaseModel):
    id: str
    role: str
    start_time_seconds: int | None = None
    message: str | None = None
    source_medium: str | None = None
    interrupted: bool = False
    metrics: dict[str, Any] | None = None
    event_type: str | None = None
    agent_metadata: dict[str, Any] = Field(default_factory=dict)
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    tool_results: list[dict[str, Any]] = Field(default_factory=list)
    llm_usage: dict[str, Any] | None = None


class ElevenLabsAnalysisTranscriptView(BaseModel):
    conversation_id: str
    turns: list[ElevenLabsAnalysisTranscriptTurnView] = Field(default_factory=list)
    turn_count: int = 0
    source: Literal["elevenlabs"] = "elevenlabs"


class ElevenLabsAnalysisAudioUnavailableView(BaseModel):
    available: Literal[False] = False
    code: str
    message: str
    retryable: bool = False


class HubTigerRecentTraceView(BaseModel):
    trace_id: str
    operation: str
    success: bool
    blocked: bool
    mode: Literal["read_only", "read_write"]
    created_at: datetime
    summary: str


class OdooEvidenceMirrorCreatePayload(BaseModel):
    operation: str = Field(min_length=1, max_length=128)
    trace_id: str | None = Field(default=None, max_length=64)
    source_mode: Literal["live_odoo", "cached_mirror"] = "live_odoo"
    tool_audit_id: str | None = Field(default=None, max_length=64)
    scope_json: dict = Field(default_factory=dict)
    request_json: dict = Field(default_factory=dict)
    response_json: dict = Field(default_factory=dict)
    status: str = Field(default="captured", max_length=32)


class OdooEvidenceMirrorView(BaseModel):
    id: str
    tool_audit_id: str | None = None
    trace_id: str | None = None
    operation: str
    status: str
    source_mode: str
    scope_json: dict = Field(default_factory=dict)
    request_json: dict = Field(default_factory=dict)
    response_json: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


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
    temperature: float | None = Field(default=None, ge=0, le=2)
    # Optional: when omitted/null, provider defaults apply and we do not force a cap.
    max_tokens: int | None = Field(default=None)
    api_mode: ChatApiMode = "responses"
    llm_orchestration: "RuntimeProfileLlmOrchestrationConfig" = Field(
        default_factory=lambda: RuntimeProfileLlmOrchestrationConfig()
    )

    @field_validator("max_tokens")
    @classmethod
    def _validate_max_tokens(cls, value: int | None) -> int | None:
        if value is None:
            return None
        if int(value) < 1:
            raise ValueError("max_tokens must be >= 1")
        return int(value)


class RuntimeProfileGuardrailsConfig(BaseModel):
    system_prompt: str = Field(min_length=1)
    grounding_mode: Literal["retrieved_only", "general", "tool_grounded", "script_audit"] = "retrieved_only"
    # Relaxed 2026-06-16: legacy field, no longer injected into prompts. Allow empty so new agents can be created without it.
    insufficient_context_behavior: str = ""
    conversation_mode: ConversationMode = "quick"
    policy_mode: Literal["locked", "admin_approval_required", "open"] = "admin_approval_required"
    business_structure_required: bool = True
    business_structure_question_bank: str = ""
    business_structure_context: str = ""
    business_structure_context_compact: str = ""
    owner_operator_questionnaire: str = ""
    owner_operator_questionnaire_compact: str = ""
    agent_category: str | None = None
    route_mode: str | None = None
    public_presenter_required: bool = False
    retail_output_guard_required: bool = False
    diagnostics_visible: bool = True
    board_document_format_contract: str = ""
    financial_report_format_contract: str = ""
    docx_finalize_required_sections: list[str] = Field(
        default_factory=lambda: ["facts", "inferences", "assumptions", "risks", "actions"]
    )
    # Audit / script execution fields
    thinking_mode: Literal["disabled", "adaptive", "manual"] = "disabled"
    thinking_effort: Literal["low", "medium", "high", "max"] = "high"
    thinking_budget_tokens: int | None = Field(default=None, ge=1024, le=32000)
    preserve_thinking_blocks: bool = True
    audit_memory_enabled: bool = False
    allow_mirror_script_execution: bool = False
    audit_max_iterations: int | None = Field(default=None, ge=1, le=20)


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
    policy_approval_token: str | None = None
    policy_approval_reason: str | None = None
    policy_actor: str | None = None
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


class PolicyChangeAuditView(BaseModel):
    id: str
    runtime_profile_id: str
    actor: str
    action: str
    status: str
    policy_mode: str
    reason: str | None = None
    approval_token: str | None = None
    before_json: dict = Field(default_factory=dict)
    after_json: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class ConfigExplorerEntryView(BaseModel):
    key: str
    namespace: str
    source_type: Literal["runtime_profile"]
    source_id: str
    source_name: str
    value_json: dict = Field(default_factory=dict)
    updated_at: datetime


class ConfigExplorerEditRequest(BaseModel):
    expected_updated_at: datetime
    value_json: dict = Field(default_factory=dict)
    policy_actor: str = "operator"
    policy_approval_token: str | None = None
    policy_approval_reason: str | None = None


class ConfigExplorerRollbackRequest(BaseModel):
    policy_actor: str = "operator"
    policy_approval_token: str | None = None
    policy_approval_reason: str | None = None


class RuntimeDefaultsPayload(BaseModel):
    chat_api_mode: ChatApiMode = "responses"
    conversation_mode: ConversationMode = "quick"
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
    agent_role: AgentRole = "lead"
    parent_agent_id: str | None = None
    position: int = Field(default=0, ge=0)
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
    agent_role: AgentRole = "lead"
    parent_agent_id: str | None = None
    position: int = 0
    is_default: bool
    enabled: bool
    created_at: datetime
    updated_at: datetime


class AgentHierarchyView(BaseModel):
    lead_agent: AgentProfileView
    sub_agents: list[AgentProfileView] = Field(default_factory=list)


class ChatBootstrapFeatures(BaseModel):
    allow_mock_provider: bool = False
    allow_api_mode_override: bool = False
    allow_conversation_mode_override: bool = True
    allow_approved_web_toggle: bool = True
    allow_workflow_launchers: bool = True


class ChatBootstrapView(BaseModel):
    surface: str
    default_agent_id: str | None = None
    default_workflow_mode: WorkflowMode = "standard"
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


class AgentDeletionPreviewImpactView(BaseModel):
    conversations: int = 0
    messages: int = 0
    uploads: int = 0
    docx_sessions: int = 0
    cache_entries: int = 0
    workflow_step_runs: int = 0
    document_frames_linked: int = 0
    orphanable_document_frames: int = 0
    active_workflow_runs: int = 0
    active_workflow_steps: int = 0
    runtime_profile_peer_agents: int = 0


class AgentDeletionPreviewPayload(BaseModel):
    scope: DeletionPreviewScope = "chats"


class AgentDeletionPreviewView(BaseModel):
    agent_id: str
    scope: DeletionPreviewScope
    can_execute: bool
    is_default_agent: bool
    blocking_reasons: list[str] = Field(default_factory=list)
    impact: AgentDeletionPreviewImpactView
    confirmation_token: str


class AgentDeletePayload(BaseModel):
    confirmation_token: str = Field(min_length=8, max_length=128)


class AgentDeleteResponse(BaseModel):
    id: str
    deleted: bool = True
    deleted_conversations: int = 0
    deleted_messages: int = 0
    deleted_uploads: int = 0
    deleted_docx_sessions: int = 0
    deleted_cache_entries: int = 0
    deleted_workflow_step_runs: int = 0
    deleted_document_frames: int = 0


class ConversationSummaryView(BaseModel):
    id: str
    agent_id: str
    title: str
    corpora: list[str] = Field(default_factory=list)
    api_mode: ChatApiMode = "responses"
    conversation_mode: ConversationMode = "quick"
    workflow_mode: WorkflowMode = "standard"
    document_frame_id: str | None = None
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
    tool_events: list["ChatToolEvent"] = Field(default_factory=list)
    usage: "ChatUsage | None" = None
    route_decision: "RouteDecision | None" = None
    api_mode: ChatApiMode | None = None
    conversation_mode: ConversationMode | None = None
    workflow_mode: WorkflowMode | None = None
    created_at: datetime


class DocumentFrameFragmentView(BaseModel):
    id: str
    source_conversation_id: str
    source_message_id: str | None = None
    fragment_type: DocumentFrameFragmentType = "snippet"
    title: str | None = None
    content: str
    approved: bool = True
    created_at: datetime
    updated_at: datetime


class DocumentFrameView(BaseModel):
    id: str
    title: str
    status: DocumentFrameStatus = "draft"
    fragments: list[DocumentFrameFragmentView] = Field(default_factory=list)
    metadata_json: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class ConversationCreatePayload(BaseModel):
    workflow_mode: WorkflowMode = "standard"
    conversation_mode: ConversationMode = "quick"
    title: str | None = Field(default=None, max_length=256)
    corpora: list[str] = Field(default_factory=list)
    document_frame_id: str | None = None
    source_conversation_id: str | None = None


class DocumentFrameFragmentCreatePayload(BaseModel):
    source_message_id: str | None = None
    fragment_type: DocumentFrameFragmentType = "snippet"
    title: str | None = Field(default=None, max_length=256)
    content: str | None = None


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
    conversation_mode: ConversationMode = "quick"
    workflow_mode: WorkflowMode = "standard"
    use_approved_web: bool = False
    head_agent_id: str | None = None
    tool_overrides: dict[str, bool] = Field(default_factory=dict)


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


class WorkflowTaskView(BaseModel):
    id: str
    task_key: str
    title: str
    task_kind: WorkflowTaskKind
    status: WorkflowTaskStatus
    sequence: int
    depends_on_task_keys: list[str] = Field(default_factory=list)
    assigned_agent_id: str | None = None
    assigned_agent_name: str | None = None
    step_run_id: str | None = None
    metadata_json: dict = Field(default_factory=dict)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class WorkflowRunEventView(BaseModel):
    id: str
    sequence: int
    event_type: WorkflowRunEventType
    task_key: str | None = None
    actor_id: str | None = None
    metadata_json: dict = Field(default_factory=dict)
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
    tasks: list[WorkflowTaskView] = Field(default_factory=list)
    events: list[WorkflowRunEventView] = Field(default_factory=list)


class ChatDocxMode(BaseModel):
    enabled: bool = False
    template_id: str | None = Field(default=None, max_length=256)
    operation: DocxOperation = "preview"
    binding_overrides: dict = Field(default_factory=dict)


class DocxArtifact(BaseModel):
    kind: DocxArtifactKind
    uri: str = Field(min_length=1, max_length=2048)
    label: str | None = None


class DocxDiagnostic(BaseModel):
    code: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=2000)
    field: str | None = None


class ChatCallInitCallerContext(BaseModel):
    source: str = Field(default="ghostdash_preview", max_length=128)
    known_customer: bool | None = None


class ChatCallInit(BaseModel):
    enabled: bool = False
    route_mode: str = Field(default="production_chat", max_length=64)
    channel: str = Field(default="phone_call", max_length=64)
    local_time: str = Field(default="", max_length=128)
    timezone: str = Field(default="Australia/Brisbane", max_length=64)
    caller_context: ChatCallInitCallerContext | None = None


class ChatTurnMeta(BaseModel):
    turn_id: str = Field(default="", max_length=128)
    turn_type: str = Field(default="user", max_length=32)
    utterance_key: str | None = Field(default=None, max_length=256)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    corpora: list[str] = Field(default_factory=list)
    top_k: int | None = Field(default=None, ge=1, le=20)
    api_mode: ChatApiMode = "responses"
    surface: str | None = Field(default=None, max_length=64)
    route_mode: str | None = Field(default=None, max_length=64)
    agent_category: str | None = Field(default=None, max_length=64)
    public_presenter_required: bool = False
    retail_output_guard_required: bool = False
    diagnostics_visible: bool = True
    call_init: ChatCallInit = Field(default_factory=ChatCallInit)
    turn_meta: ChatTurnMeta = Field(default_factory=ChatTurnMeta)
    conversation_mode: ConversationMode | None = None
    workflow_mode: WorkflowMode | None = None
    llm_model_id: str | None = Field(
        default=None,
        max_length=256,
        description="Per-message model id (e.g. openai/gpt-4o). Omit to use the agent runtime profile model.",
    )
    agent_id: str | None = None
    conversation_id: str | None = None
    use_approved_web: bool = False
    tool_overrides: dict[str, bool] = Field(default_factory=dict)
    docx_mode: ChatDocxMode = Field(default_factory=ChatDocxMode)
    system_prompt_override: str | None = Field(
        default=None,
        max_length=32000,
        description="When set, replaces the agent runtime profile system prompt for this request only.",
    )
    odoo_agentic: bool | None = Field(
        default=None,
        description="When true, odoo_specialist uses a multi-step chat.completions tool loop (odoo_execute). "
        "False disables it; None uses server default (app_odoo_agentic_enabled).",
    )


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


class RuntimeProfileLlmOrchestrationConfig(BaseModel):
    enabled: bool = False
    trigger_mode: Literal["on_prompt_overflow", "always_second_pass"] = "on_prompt_overflow"
    prompt_token_soft_limit: int | None = Field(default=None, ge=1)
    fallback_connection_id: str | None = None
    fallback_provider: str = Field(default="openai", min_length=1, max_length=64)
    fallback_model_id: str | None = Field(default=None, max_length=256)
    include_primary_answer_context: bool = True


class LlmExecutionStep(BaseModel):
    stage: str = Field(min_length=1, max_length=64)
    provider: str = Field(min_length=1, max_length=64)
    connection_label: str | None = None
    model_id: str = Field(min_length=1, max_length=256)
    api_mode: ChatApiMode
    reason: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    estimate: bool = True


class RouteDecision(BaseModel):
    route_type: RouteType
    rationale_summary: str = Field(min_length=1, max_length=800)
    document_intent: bool = False
    tool_expectations: dict = Field(default_factory=dict)
    recommended_workers: list[dict] = Field(default_factory=list)
    suggested_specialist_template: dict | None = None
    llm_execution: list[LlmExecutionStep] = Field(default_factory=list)
    generation_path: str | None = None
    backend_trace: list[dict[str, Any]] = Field(default_factory=list)


class ChatResponse(BaseModel):
    answer: str
    query_mode: QueryMode
    citations: list[ChatCitation]
    conversation_mode: ConversationMode = "quick"
    workflow_mode: WorkflowMode = "standard"
    conversation_id: str | None = None
    agent_id: str | None = None
    cached: bool = False
    usage: ChatUsage | None = None
    effective_snapshot_id: str | None = None
    tool_summary: list[ToolReadinessSummary] = Field(default_factory=list)
    tool_events: list[ChatToolEvent] = Field(default_factory=list)
    route_decision: RouteDecision | None = None
    docx_artifacts: list[DocxArtifact] = Field(default_factory=list)
    docx_diagnostics: list[DocxDiagnostic] = Field(default_factory=list)
