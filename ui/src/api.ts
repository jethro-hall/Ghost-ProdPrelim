import axios from "axios";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
const agentBaseUrl = import.meta.env.VITE_AGENT_BASE_URL ?? "/agent";

export const api = axios.create({
  baseURL: apiBaseUrl,
  timeout: 120_000,
});

export type ChatApiMode = "responses" | "chat_completions";
export type ConversationMode = "quick" | "board" | "working_session";
export type WorkflowMode =
  | "standard"
  | "data_collector"
  | "documenter"
  | "case_framing"
  | "evidence_retrieval"
  | "bp_mode";
export type DocxOperation = "preview" | "finalize";

export type RouteType = "direct" | "workers" | "suggest_specialist";

export type LlmExecutionStep = {
  stage: string;
  provider: string;
  connection_label?: string | null;
  model_id: string;
  api_mode: ChatApiMode;
  reason?: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimate?: boolean;
};

export type RouteDecision = {
  route_type: RouteType;
  rationale_summary: string;
  document_intent: boolean;
  tool_expectations: Record<string, unknown>;
  recommended_workers: Array<Record<string, unknown>>;
  suggested_specialist_template?: Record<string, unknown> | null;
  llm_execution?: LlmExecutionStep[];
};

/** Approximate LLM tokens (cl100k) per assistant turn; sums prompt + completion. */
export type ChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimate?: boolean;
};

export type LlmIoPayload = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_first_text: string;
  input_last_text: string;
};

export type ChatToolEvent = {
  tool_id: string;
  status: "planned" | "preview" | "executed" | "blocked" | "failed";
  operation?: string | null;
  summary?: string | null;
  blocked_reason?: string | null;
  payload: Record<string, unknown>;
  latency_ms?: number | null;
};
export type RequestedLane = "default" | "local" | "cloud";
export type ChatUploadPersistenceMode = "conversation_only" | "save_to_knowledge";
export type ProviderKind = "openai" | "anthropic" | "google_gemini" | "openai_compatible" | "amazon_bedrock";
export type ConnectionAuthStrategy = "bearer" | "x_api_key" | "x_goog_api_key" | "custom_header";
export type ToolHealth = "healthy" | "unhealthy" | "unknown";

export type ChatDocxMode = {
  enabled: boolean;
  template_id?: string | null;
  operation?: DocxOperation;
  binding_overrides?: Record<string, unknown>;
};

export type DocxArtifact = {
  kind: "docx" | "pdf" | "html";
  uri: string;
  label?: string | null;
};

export type DocxDiagnostic = {
  code: string;
  message: string;
  field?: string | null;
};

export const REQUESTED_LANE_LABELS: Record<RequestedLane, string> = {
  default: "Default (runtime policy)",
  local: "Local only",
  cloud: "Cloud only",
};

export function formatRequestedLane(lane: RequestedLane) {
  return REQUESTED_LANE_LABELS[lane];
}

export type Connection = {
  id: string;
  provider: string;
  label: string;
  provider_kind: ProviderKind;
  auth_strategy: ConnectionAuthStrategy;
  auth_header_name: string | null;
  base_url: string | null;
  enabled: boolean;
  /** Per-connection default for tests; omitted on older API builds. */
  default_model_id?: string | null;
  api_key_hint: string | null;
  has_api_key: boolean;
  aws_region?: string | null;
};

export type ConnectionDeletionPreviewImpact = {
  runtime_profile_direct_refs: number;
  runtime_profile_provider_refs: number;
  runtime_profile_fallback_refs: number;
  runtime_profile_fallback_provider_refs: number;
  agents_impacted: number;
  active_workflow_runs: number;
  active_workflow_steps: number;
  is_runtime_default_connection: boolean;
  seeded_provider_key: boolean;
};

export type ConnectionDeletionPreview = {
  connection_id: string;
  provider: string;
  can_execute: boolean;
  blocking_reasons: string[];
  impact: ConnectionDeletionPreviewImpact;
  confirmation_token: string;
};

export type ConnectionDeleteResponse = {
  id: string;
  provider: string;
  deleted: boolean;
};

export type AgentDeletionPreviewImpact = {
  conversations: number;
  messages: number;
  uploads: number;
  docx_sessions: number;
  cache_entries: number;
  workflow_step_runs: number;
  document_frames_linked: number;
  orphanable_document_frames: number;
  active_workflow_runs: number;
  active_workflow_steps: number;
  runtime_profile_peer_agents: number;
};

export type AgentDeletionPreview = {
  agent_id: string;
  scope: "chats" | "agent";
  can_execute: boolean;
  is_default_agent: boolean;
  blocking_reasons: string[];
  impact: AgentDeletionPreviewImpact;
  confirmation_token: string;
};

export type AgentDeleteResponse = {
  id: string;
  deleted: boolean;
  deleted_conversations: number;
  deleted_messages: number;
  deleted_uploads: number;
  deleted_docx_sessions: number;
  deleted_cache_entries: number;
  deleted_workflow_step_runs: number;
  deleted_document_frames: number;
};

export type ConnectionTestResult = {
  ok: boolean;
  api_mode: ChatApiMode;
  model: string;
  base_url: string;
  output: string;
};

export type CapabilityStatus = {
  available: boolean;
  configured: boolean;
  message: string;
};

export type RuntimeCapabilities = {
  parser_lanes: Record<string, CapabilityStatus>;
  chat_api_modes: Record<string, CapabilityStatus>;
  streaming: CapabilityStatus;
  vector_store: string;
  model_runtime: string;
};

export type RuntimeDefaults = {
  chat_api_mode: ChatApiMode;
  conversation_mode: ConversationMode;
  llm_model_id: string;
  llm_connection_id?: string | null;
  llm_connection_label?: string | null;
  llm_provider_key?: string | null;
  llm_provider_kind?: ProviderKind | null;
  embedding_model_id: string;
  default_corpora: string[];
  pdf_chunk_size: number;
  pdf_chunk_overlap: number;
  pdf_sentence_window: number;
  pdf_top_k: number;
  pdf_parse_lane_policy: "local_default" | "cloud_default" | "auto";
  pdf_rerank_enabled: boolean;
  runtime_profile_id?: string | null;
  runtime_profile_name?: string | null;
};

export type VoiceProviderVoice = {
  voice_id: string;
  name: string;
  provider: "elevenlabs";
  preview_available: boolean;
};

export type VoiceProviderStatus = {
  configured: boolean;
  provider: "elevenlabs";
  default_voice_id?: string | null;
  voices: VoiceProviderVoice[];
  message: string;
};

export type ElevenLabsAnalysisConversationSummary = {
  id: string;
  title: string | null;
  started_at_unix_secs: number | null;
  status: string;
  call_successful: string;
  duration_seconds: number | null;
  message_count: number | null;
  user_id: string | null;
  branch_id: string | null;
  main_language: string | null;
  channel: string | null;
  direction: string | null;
  rating: number | null;
  agent_id: string | null;
  agent_name: string | null;
};

export type ElevenLabsAnalysisConversationsResponse = {
  items: ElevenLabsAnalysisConversationSummary[];
  next_cursor: string | null;
  has_more: boolean;
  upstream_ready: boolean;
  warning_code: string | null;
  warning_message: string | null;
  filters_applied: Record<string, unknown>;
  source: "elevenlabs";
};

export type ElevenLabsAnalysisConversationDetail = {
  id: string;
  title: string | null;
  agent_id: string | null;
  agent_name: string | null;
  status: string;
  user_id: string | null;
  branch_id: string | null;
  environment: string | null;
  text_only: boolean;
  started_at_unix_secs: number | null;
  accepted_at_unix_secs: number | null;
  duration_seconds: number | null;
  cost: number | null;
  credits_llm: number | null;
  llm_cost: number | null;
  call_successful: string;
  call_status: string | null;
  call_summary_title: string | null;
  transcript_summary: string | null;
  termination_reason: string | null;
  main_language: string | null;
  has_audio: boolean;
  has_user_audio: boolean;
  has_response_audio: boolean;
  visited_agents: Array<Record<string, unknown>>;
  tag_ids: string[];
  metadata: Record<string, unknown>;
  analysis: Record<string, unknown>;
  client_data: Record<string, unknown>;
  source: "elevenlabs";
};

export type ElevenLabsAnalysisTranscriptTurn = {
  id: string;
  role: string;
  start_time_seconds: number | null;
  message: string | null;
  source_medium: string | null;
  interrupted: boolean;
  metrics: Record<string, unknown> | null;
  event_type: string | null;
  agent_metadata: Record<string, unknown>;
  tool_calls: Array<Record<string, unknown>>;
  tool_results: Array<Record<string, unknown>>;
  llm_usage: Record<string, unknown> | null;
};

export type ElevenLabsAnalysisTranscript = {
  conversation_id: string;
  turns: ElevenLabsAnalysisTranscriptTurn[];
  turn_count: number;
  source: "elevenlabs";
};

export type ElevenLabsAnalysisHealth = {
  ok: boolean;
  service: string;
  ready: boolean;
  error_code?: string;
  message: string;
  timeout_ms: number;
};

export type ElevenLabsSimulationItem = {
  file_name: string;
  conversation_id: string;
  user: string;
  brief_summary: string;
  title: string;
  duration_seconds: number | null;
  generated_path: string;
};

export type ElevenLabsSimulationListResponse = {
  items: ElevenLabsSimulationItem[];
  count: number;
  source_dir: string;
  ready: boolean;
};

export type ElevenLabsSimulationTestSummary = {
  id: string;
  name: string;
  objective: string;
  step_count: number;
  assertion_count: number;
};

export type ElevenLabsSimulationDetailResponse = {
  file_name: string;
  simulation: Record<string, unknown>;
  elevenlabs_test_payload: Record<string, unknown>;
  elevenlabs_test_payload_pretty: string;
  tests?: ElevenLabsSimulationTestSummary[];
  execution?: {
    next_reply: { runnable: boolean; phase: number };
    tool_invocation: { runnable: boolean; phase: number };
    simulation: { runnable: boolean; phase: number };
    step_debugger?: { runnable: boolean; phase: number };
  };
};

export type ElevenLabsTestTab = "next_reply" | "tool_invocation" | "simulation";

export type ElevenLabsWorkbenchTurn = {
  role: "agent" | "user";
  message: string;
  time_in_call_secs?: number;
  tool_calls?: Array<Record<string, unknown>>;
  tool_results?: Array<Record<string, unknown>>;
  latency_ms?: number | null;
  llm_override?: string | null;
};

export type ElevenLabsToolExecutionMode = "call_real_tools" | "mock_selected" | "mock_all";

export type ElevenLabsWorkbenchTool = {
  id: string;
  name: string;
  type: string;
};

export type ElevenLabsWorkbenchOptionsState = {
  tool_execution_mode: ElevenLabsToolExecutionMode;
  selected_tool_ids: string[];
  agent_tool_ids_override: string[];
  tool_direction_prompt: string;
  simulated_user_llm: string;
  simulated_user_temperature: number;
  agent_llm: string;
  agent_temperature: number | null;
  simulation_environment: string;
  evaluate_on_step: boolean;
  extra_request_json: string;
};

export type ElevenLabsWorkbenchSimulateFields = {
  agent_id?: string;
  simulated_user_prompt?: string;
  simulated_user_llm?: string;
  simulated_user_temperature?: number;
  agent_prompt_override?: string;
  agent_llm?: string;
  agent_temperature?: number | null;
  dynamic_variables?: Record<string, string>;
  tool_mock_config?: Record<string, unknown>;
  tool_execution_mode?: ElevenLabsToolExecutionMode;
  selected_tool_ids?: string[];
  agent_tool_ids_override?: string[];
  tool_direction_prompt?: string;
  extra_evaluation_criteria?: Array<Record<string, unknown>>;
  agent_config_override?: Record<string, unknown>;
  conversation_config_override?: Record<string, unknown>;
  simulation_specification_extra?: Record<string, unknown>;
  elevenlabs_request_extra?: Record<string, unknown>;
  simulation_environment?: string;
  evaluate?: boolean;
};

export type ElevenLabsSimulationRunRequest = ElevenLabsWorkbenchSimulateFields & {
  test_id?: string;
  user_scenario?: string;
  success_criteria?: string;
  max_turns?: number;
  partial_history?: ElevenLabsWorkbenchTurn[];
};

export type ElevenLabsStepRequest = ElevenLabsWorkbenchSimulateFields & {
  history: ElevenLabsWorkbenchTurn[];
  stop_index?: number;
  step_mode?: "agent" | "user" | "both";
  forced_user_message?: string;
  new_turns_limit?: number;
  success_criteria?: string;
  expected_tool_name?: string;
};

export type ElevenLabsSimulationRunResponse = {
  run_id: string | null;
  trace_id: string;
  status: "passed" | "failed" | "completed" | "error";
  latency_ms: number;
  file_name?: string;
  test_id?: string;
  test_name?: string;
  agent_id?: string;
  started_at?: string;
  call_successful?: string;
  transcript_summary?: string;
  call_summary_title?: string;
  evaluation_criteria_results?: Record<string, unknown>;
  turns?: ElevenLabsWorkbenchTurn[];
  new_turns?: ElevenLabsWorkbenchTurn[];
  merged_history?: ElevenLabsWorkbenchTurn[];
  turn_count?: number;
  step_mode?: string;
  stop_index?: number;
  partial_turn_count?: number;
  tool_check?: {
    passed: boolean;
    expected_tool_name: string;
    observed_tool_names: string[];
    message: string;
  };
  message: string;
  error_code?: string;
  artifact_path?: string;
  upstream_endpoint?: string;
  elevenlabs_request?: Record<string, unknown>;
};

export type ElevenLabsWorkbenchOptionsResponse = {
  upstream: string;
  endpoint_template: string;
  tool_execution_modes: Array<{ id: string; label: string; tool_mock_config: Record<string, unknown> }>;
  llm_models: string[];
  step_modes: string[];
};

export type ElevenLabsWorkbenchToolsResponse = {
  tools: ElevenLabsWorkbenchTool[];
  count: number;
  has_more?: boolean;
};

export type ElevenLabsWorkbenchAgentResponse = {
  agent_id: string;
  name: string;
  voice_id?: string | null;
  tool_ids: string[];
  agent_prompt_excerpt: string;
  agent_llm: string;
  agent_temperature: number | null;
};

export type ElevenLabsApplyTextNormalization = "auto" | "on" | "off";

export type ElevenLabsPronunciationDictionaryLocator = {
  pronunciation_dictionary_id: string;
  version_id: string;
};

export type ElevenLabsPronunciationReplacement = {
  key: string;
  value: string;
};

export type ElevenLabsMasteringPayload = {
  model_id: string;
  language_code: string;
  seed: number | null;
  previous_text: string;
  next_text: string;
  apply_text_normalization: ElevenLabsApplyTextNormalization;
  voice_settings: {
    stability: number;
    similarity_boost: number;
    style: number;
    use_speaker_boost: boolean;
    speed: number;
  };
  pronunciation_dictionary_locators: ElevenLabsPronunciationDictionaryLocator[];
  pronunciation_replacements: ElevenLabsPronunciationReplacement[];
};

export type CollectionImpact = {
  documents: number;
  document_versions: number;
  retrieval_artifacts: number;
  workbook_artifacts: number;
  workbook_sheets: number;
  workbook_tables: number;
  workbook_rows: number;
  ingestion_runs: number;
  active_runs: number;
  runtime_profiles: number;
  agents: number;
  conversations: number;
  messages: number;
  cache_entries: number;
  vector_points: number;
  upload_paths: string[];
};

export type Collection = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  embedding_model_id: string | null;
  attached_runtime_profile_ids: string[];
  attached_agent_ids: string[];
  impact?: CollectionImpact | null;
  created_at: string;
  updated_at: string;
};

export type VectorStats = {
  documents: number;
  retrieval_artifacts: number;
  workbook_rows: number;
  pdf_documents: number;
  xlsx_documents: number;
  txt_documents: number;
  other_documents: number;
};

export type AgentToolConfig = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  allowed_urls: string[];
  provider?: string | null;
  kind?: string | null;
  session_toggleable?: boolean;
};

export type ToolCatalogEntry = {
  id: string;
  provider: string;
  name: string;
  gateway: string;
  description?: string | null;
  status: ToolHealth;
  active: boolean;
  configured: boolean;
  read_only: boolean;
  session_toggleable: boolean;
};

export type ToolSettings = {
  base_url?: string | null;
  database?: string | null;
  username_hint?: string | null;
  has_password: boolean;
  auth_source: "direct_credentials";
  read_only: boolean;
  timeout_ms: number;
  health_path: string;
  execute_path: string;
  missing_config: string[];
};

export type ToolDetail = ToolCatalogEntry & {
  settings: ToolSettings;
  safe_operations: string[];
};

export type ToolTestResult = {
  success: boolean;
  message: string;
  trace_id?: string | null;
  latency_ms?: number | null;
  data: Record<string, unknown>;
};

export type ToolExecuteResult = {
  success: boolean;
  message: string;
  trace_id?: string | null;
  latency_ms?: number | null;
  operation?: string | null;
  read_only: boolean;
  data: Record<string, unknown>;
};

export type ToolPolicy = {
  agent_id: string;
  allowed_tool_ids: string[];
};

export type HubTigerStatus = {
  mode: "read_only" | "read_write";
  mcp_url_configured: boolean;
  proxy_url_configured: boolean;
  read_timeout_ms: number;
  mutation_timeout_ms: number;
  health: "healthy" | "degraded" | "unconfigured";
  message: string;
};

export type HubTigerBinding = {
  tool_id: string;
  label: string;
  category: "availability" | "jobs" | "quotes" | "booking";
  mode: "read_only" | "read_write";
  write_action: boolean;
  enabled: boolean;
};

export type HubTigerStatusPayload = {
  status: HubTigerStatus;
  bindings: HubTigerBinding[];
};

export type HubTigerTestPayload = {
  success: boolean;
  blocked: boolean;
  mode: "read_only" | "read_write";
  operation: string;
  message: string;
  trace_id?: string | null;
  data: Record<string, unknown>;
};

export type HubTigerTrace = {
  trace_id: string;
  operation: string;
  success: boolean;
  blocked: boolean;
  mode: "read_only" | "read_write";
  created_at: string;
  summary: string;
};

export type RuntimeProfileLlmConfig = {
  connection_id?: string | null;
  provider: string;
  model_id: string;
  temperature: number;
  max_tokens?: number | null;
  api_mode: ChatApiMode;
  llm_orchestration?: {
    enabled: boolean;
    trigger_mode: "on_prompt_overflow" | "always_second_pass";
    prompt_token_soft_limit?: number | null;
    fallback_connection_id?: string | null;
    fallback_provider: string;
    fallback_model_id?: string | null;
    include_primary_answer_context: boolean;
  };
};

export type RuntimeProfileGuardrailsConfig = {
  system_prompt: string;
  grounding_mode: "retrieved_only";
  insufficient_context_behavior: string;
  conversation_mode: ConversationMode;
  policy_mode: "locked" | "admin_approval_required" | "open";
  business_structure_required?: boolean;
  business_structure_question_bank?: string;
  business_structure_context?: string;
  business_structure_context_compact?: string;
  owner_operator_questionnaire?: string;
  owner_operator_questionnaire_compact?: string;
  board_document_format_contract?: string;
  financial_report_format_contract?: string;
  docx_finalize_required_sections?: string[];
};

export type RuntimeProfileKnowledgeBaseConfig = {
  default_corpora: string[];
  embedding_model_id: string;
};

export type RuntimeProfileRetrievalConfig = {
  default_top_k: number;
  pdf_chunk_size: number;
  pdf_chunk_overlap: number;
  pdf_sentence_window: number;
  pdf_parse_lane_policy: "local_default" | "cloud_default" | "auto";
  pdf_rerank_enabled: boolean;
};

export type RuntimeProfileToolPolicyConfig = {
  tools: AgentToolConfig[];
};

export type RuntimeProfile = {
  id?: string;
  name: string;
  description?: string | null;
  llm_config: RuntimeProfileLlmConfig;
  guardrails_config: RuntimeProfileGuardrailsConfig;
  kb_config: RuntimeProfileKnowledgeBaseConfig;
  retrieval_config: RuntimeProfileRetrievalConfig;
  tool_policy_config: RuntimeProfileToolPolicyConfig;
  policy_approval_token?: string | null;
  policy_approval_reason?: string | null;
  policy_actor?: string | null;
  is_default: boolean;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
};

export type AgentProfile = {
  id: string;
  name: string;
  first_message: string;
  language: string;
  voice_id: string;
  runtime_profile_id: string;
  runtime_profile: RuntimeProfile;
  agent_role?: "lead" | "sub";
  parent_agent_id?: string | null;
  position?: number;
  is_default: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type ChatBootstrapFeatures = {
  allow_mock_provider: boolean;
  allow_api_mode_override: boolean;
  allow_conversation_mode_override: boolean;
  allow_approved_web_toggle: boolean;
  allow_workflow_launchers: boolean;
};

export type ChatBootstrap = {
  surface: string;
  default_agent_id: string | null;
  default_workflow_mode: WorkflowMode;
  runtime_defaults: RuntimeDefaults;
  capabilities: RuntimeCapabilities;
  features: ChatBootstrapFeatures;
  agents: AgentProfile[];
  tools_catalog?: ToolCatalogEntry[];
};

export type AgentProfilePayload = {
  id?: string;
  name: string;
  first_message: string;
  language: string;
  voice_id: string;
  runtime_profile_id?: string | null;
  runtime_profile?: RuntimeProfile;
  agent_role?: "lead" | "sub";
  parent_agent_id?: string | null;
  position?: number;
  is_default: boolean;
  enabled: boolean;
};

export type ConversationSummary = {
  id: string;
  agent_id: string;
  title: string;
  corpora: string[];
  api_mode: ChatApiMode;
  conversation_mode: ConversationMode;
  workflow_mode: WorkflowMode;
  document_frame_id: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
};

export type ConversationMessage = {
  id: string;
  conversation_id: string;
  agent_id: string;
  role: "user" | "assistant";
  content: string;
  query_mode: string | null;
  citations: unknown[];
  tool_events?: ChatToolEvent[];
  usage?: ChatUsage | null;
  route_decision?: RouteDecision | null;
  api_mode: ChatApiMode | null;
  conversation_mode: ConversationMode | null;
  workflow_mode: WorkflowMode | null;
  created_at: string;
};

export type DocumentFrameFragmentType =
  | "note"
  | "snippet"
  | "paragraph"
  | "mini_analysis"
  | "scorecard"
  | "graph_idea";

export type DocumentFrameFragment = {
  id: string;
  source_conversation_id: string;
  source_message_id: string | null;
  fragment_type: DocumentFrameFragmentType;
  title: string | null;
  content: string;
  approved: boolean;
  created_at: string;
  updated_at: string;
};

export type DocumentFrame = {
  id: string;
  title: string;
  status: "draft" | "active" | "final";
  fragments: DocumentFrameFragment[];
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ChatUpload = {
  id: string;
  conversation_id: string;
  agent_id: string;
  filename: string;
  mime_type: string | null;
  source_kind: string;
  policy_lane: RequestedLane;
  extracted_parse_lane: string | null;
  extracted_char_count: number;
  status: string;
  persistence_mode: ChatUploadPersistenceMode | null;
  collection_id: string | null;
  collection_slug: string | null;
  promoted_document_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type DocumentArtifact = {
  artifact_type: string;
  source: string;
  status: string;
};

export type DocumentIngestion = {
  id: string;
  corpus: string;
  filename: string;
  source_path: string;
  requested_lane: RequestedLane;
  actual_parse_lane: string | null;
  parse_status: string;
  index_status: string;
  overall_status: string;
  error_message: string | null;
  workbook_sheet_count: number;
  workbook_table_count: number;
  workbook_row_count: number;
  artifacts: DocumentArtifact[];
};

export type TaskStep = {
  id: string;
  label: string;
  done: boolean;
  active: boolean;
  status: "pending" | "running" | "completed" | "failed";
};

export type TaskDocument = {
  id: string;
  filename: string;
  requested_lane: RequestedLane;
  actual_parse_lane: string | null;
  parse_status: string;
  index_status: string;
  overall_status: string;
  error_message: string | null;
  active: boolean;
};

export type Task = {
  id: string;
  task_type: string;
  status: string;
  current_step: string;
  progress: number;
  error_message: string | null;
  steps: TaskStep[];
  total_documents: number;
  completed_documents: number;
  failed_documents: number;
  active_document_id: string | null;
  active_filename: string | null;
  documents: TaskDocument[];
};

export type RunSummary = {
  id: string;
  run_type: string;
  corpus: string;
  status: string;
  current_step: string;
  progress: number;
  requested_lane: RequestedLane | null;
  trace_id: string | null;
  error_message: string | null;
  result_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ConfigExplorerEntry = {
  key: string;
  namespace: string;
  source_type: "runtime_profile";
  source_id: string;
  source_name: string;
  value_json: Record<string, unknown>;
  updated_at: string;
};

export type PolicyChangeAuditView = {
  id: string;
  runtime_profile_id: string;
  actor: string;
  action: string;
  status: string;
  policy_mode: string;
  reason?: string | null;
  approval_token?: string | null;
  before_json: Record<string, unknown>;
  after_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ConfigExplorerEditRequest = {
  expected_updated_at: string;
  value_json: Record<string, unknown>;
  policy_actor?: string;
  policy_approval_token?: string | null;
  policy_approval_reason?: string | null;
};

export type ConfigExplorerRollbackRequest = {
  policy_actor?: string;
  policy_approval_token?: string | null;
  policy_approval_reason?: string | null;
};

export async function fetchConnections() {
  const { data } = await api.get<Connection[]>("/connections");
  return data;
}

export async function fetchCapabilities() {
  const { data } = await api.get<RuntimeCapabilities>("/capabilities");
  return data;
}

export async function fetchRuntimeDefaults() {
  const { data } = await api.get<RuntimeDefaults>("/runtime/defaults");
  return data;
}

export async function fetchChatBootstrap(surface = "ghostdash") {
  const { data } = await api.get<ChatBootstrap>("/chat/bootstrap", {
    params: { surface },
  });
  return data;
}

export async function saveRuntimeDefaults(body: RuntimeDefaults) {
  const { data } = await api.post<RuntimeDefaults>("/runtime/defaults", body);
  return data;
}

export async function fetchAgents() {
  const { data } = await api.get<AgentProfile[]>("/agents");
  return data;
}

export async function fetchConfigExplorer(params?: { q?: string; namespace?: string }) {
  const { data } = await api.get<ConfigExplorerEntry[]>("/config/explorer", { params });
  return data;
}

export async function patchConfigExplorer(key: string, body: ConfigExplorerEditRequest) {
  const { data } = await api.patch<ConfigExplorerEntry>(`/config/explorer/${encodeURIComponent(key)}`, body);
  return data;
}

export async function rollbackConfigExplorerAudit(auditId: string, body: ConfigExplorerRollbackRequest) {
  const { data } = await api.post<ConfigExplorerEntry>(`/config/explorer/rollback/${encodeURIComponent(auditId)}`, body);
  return data;
}

export async function fetchRuntimeProfilePolicyAudits(runtimeProfileId: string, limit = 10) {
  const { data } = await api.get<PolicyChangeAuditView[]>(`/runtime-profiles/${runtimeProfileId}/policy-audits`, {
    params: { limit },
  });
  return data;
}

export async function fetchToolCatalog() {
  const { data } = await api.get<ToolCatalogEntry[]>("/tools/catalog");
  return data;
}

export async function fetchToolDetail(toolId: string) {
  const { data } = await api.get<ToolDetail>(`/tools/${toolId}`);
  return data;
}

export async function saveToolSettings(
  toolId: string,
  body: {
    base_url?: string | null;
    database?: string | null;
    username?: string | null;
    password?: string | null;
    timeout_ms?: number;
  },
) {
  const { data } = await api.post<ToolDetail>(`/tools/${toolId}/settings`, body);
  return data;
}

export async function testTool(toolId: string) {
  const { data } = await api.post<ToolTestResult>(`/tools/${toolId}/test`);
  return data;
}

export async function executeTool(toolId: string, body: { operation: string; payload?: Record<string, unknown> }) {
  const { data } = await api.post<ToolExecuteResult>(`/tools/${toolId}/execute`, body);
  return data;
}

export async function setToolActivation(toolId: string, active: boolean) {
  const { data } = await api.post<ToolCatalogEntry>(`/tools/${toolId}/activation`, { active });
  return data;
}

export async function fetchAgentToolPolicy(agentId: string) {
  const { data } = await api.get<ToolPolicy>(`/tools/policy/${agentId}`);
  return data;
}

export async function saveAgentToolPolicy(agentId: string, allowedToolIds: string[]) {
  const { data } = await api.post<ToolPolicy>(`/tools/policy/${agentId}`, { allowed_tool_ids: allowedToolIds });
  return data;
}

export async function fetchHubTigerStatus() {
  const { data } = await api.get<HubTigerStatusPayload>("/hubtiger/status");
  return data;
}

export type HubTigerTestOperation =
  | "availability_lookup"
  | "job_lookup"
  | "job_search"
  | "job_retrieve"
  | "quote_preview"
  | "booking_slot_hold"
  | "booking_customer_search"
  | "booking_customer_confirm"
  | "booking_bike_list"
  | "booking_bike_confirm"
  | "booking_service_set"
  | "booking_submit"
  | "booking_finalize"
  | "booking_create"
  | "booking_update"
  | "quote_add_line_item";

export async function runHubTigerTest(body: {
  operation: HubTigerTestOperation;
  payload?: Record<string, unknown>;
}) {
  const { data } = await api.post<HubTigerTestPayload>("/hubtiger/test", body);
  return data;
}

export async function fetchHubTigerTraces(limit = 20) {
  const { data } = await api.get<HubTigerTrace[]>("/hubtiger/traces", { params: { limit } });
  return data;
}

export async function fetchCollections(includeImpact = false) {
  const { data } = await api.get<Collection[]>("/collections", {
    params: includeImpact ? { include_impact: true } : undefined,
  });
  return data;
}

export async function createCollection(body: { slug: string; name?: string; description?: string }) {
  const { data } = await api.post<Collection>("/collections", body);
  return data;
}

export async function deleteCollection(collectionId: string) {
  const { data } = await api.delete<{ id: string; slug: string; deleted: boolean; impact: CollectionImpact }>(
    `/collections/${collectionId}`,
  );
  return data;
}

export async function saveAgent(body: AgentProfilePayload) {
  const { data } = await api.post<AgentProfile>("/agents", body);
  return data;
}

export async function fetchAgentDeletionPreview(agentId: string, scope: "chats" | "agent" = "agent") {
  const { data } = await api.post<AgentDeletionPreview>(`/agents/${agentId}/deletion-preview`, { scope });
  return data;
}

export async function deleteAgent(agentId: string, confirmationToken: string) {
  const { data } = await api.delete<AgentDeleteResponse>(`/agents/${agentId}`, {
    params: { confirm: true },
    data: { confirmation_token: confirmationToken },
  });
  return data;
}

export async function fetchAgentConversations(agentId: string) {
  const { data } = await api.get<ConversationSummary[]>(`/agents/${agentId}/conversations`);
  return data;
}

export async function createConversation(args: {
  agentId: string;
  workflowMode?: WorkflowMode;
  conversationMode?: ConversationMode;
  title?: string | null;
  corpora?: string[];
  documentFrameId?: string | null;
  sourceConversationId?: string | null;
}) {
  const { data } = await api.post<ConversationSummary>(`/agents/${args.agentId}/conversations`, {
    workflow_mode: args.workflowMode ?? "standard",
    conversation_mode: args.conversationMode ?? "quick",
    title: args.title ?? null,
    corpora: args.corpora ?? [],
    document_frame_id: args.documentFrameId ?? null,
    source_conversation_id: args.sourceConversationId ?? null,
  });
  return data;
}

export async function fetchConversationMessages(conversationId: string) {
  const { data } = await api.get<ConversationMessage[]>(`/conversations/${conversationId}/messages`);
  return data;
}

export async function fetchConversationDocumentFrame(conversationId: string) {
  const { data } = await api.get<DocumentFrame>(`/conversations/${conversationId}/document-frame`);
  return data;
}

export async function approveConversationFragment(args: {
  conversationId: string;
  sourceMessageId?: string | null;
  fragmentType?: DocumentFrameFragmentType;
  title?: string | null;
  content?: string | null;
}) {
  const { data } = await api.post<DocumentFrame>(`/conversations/${args.conversationId}/document-frame/fragments`, {
    source_message_id: args.sourceMessageId ?? null,
    fragment_type: args.fragmentType ?? "snippet",
    title: args.title ?? null,
    content: args.content ?? null,
  });
  return data;
}

export async function fetchConversationUploads(conversationId: string) {
  const { data } = await api.get<ChatUpload[]>(`/conversations/${conversationId}/uploads`);
  return data;
}

export async function fetchDocuments(corpus?: string) {
  const { data } = await api.get<DocumentIngestion[]>("/documents", {
    params: corpus ? { corpus } : undefined,
  });
  return data;
}

export async function fetchVectorStats(corpus?: string) {
  const { data } = await api.get<VectorStats>("/vector-stats", {
    params: corpus ? { corpus } : undefined,
  });
  return data;
}

export async function fetchRuns(corpus?: string) {
  const { data } = await api.get<RunSummary[]>("/runs", {
    params: corpus ? { corpus } : undefined,
  });
  return data;
}

export async function saveConnection(
  body: Partial<Connection> & {
    provider: string;
    provider_kind?: ProviderKind;
    auth_strategy?: ConnectionAuthStrategy;
    auth_header_name?: string | null;
  },
) {
  const { data } = await api.post<Connection>("/connections", body);
  return data;
}

export async function testConnection(body: {
  provider: string;
  label?: string;
  provider_kind?: ProviderKind;
  auth_strategy?: ConnectionAuthStrategy;
  auth_header_name?: string | null;
  api_key?: string;
  base_url?: string;
  aws_region?: string | null;
  model_id?: string;
  api_mode: ChatApiMode;
  prompt?: string;
}) {
  const { data } = await api.post<ConnectionTestResult>("/connections/test", body);
  return data;
}

export async function fetchConnectionDeletionPreview(connectionId: string) {
  const { data } = await api.post<ConnectionDeletionPreview>(`/connections/${connectionId}/deletion-preview`);
  return data;
}

export async function deleteConnection(connectionId: string, confirmationToken: string) {
  const { data } = await api.delete<ConnectionDeleteResponse>(`/connections/${connectionId}`, {
    params: { confirm: true },
    data: { confirmation_token: confirmationToken },
  });
  return data;
}

export async function uploadFile(file: File, corpus?: string, policyLane?: RequestedLane, relativePath?: string) {
  const form = new FormData();
  const uploadName = relativePath || file.webkitRelativePath || file.name;
  form.append("file", file, uploadName);
  if (corpus) form.append("corpus", corpus);
  if (policyLane) form.append("policy_lane", policyLane);
  const { data } = await api.post("/upload", form);
  return data as { id: string; filename: string; status: string };
}

export async function stageConversationUpload(args: {
  conversationId: string;
  agentId: string;
  file: File;
  policyLane?: RequestedLane;
}) {
  const form = new FormData();
  form.append("agent_id", args.agentId);
  form.append("file", args.file);
  if (args.policyLane) form.append("policy_lane", args.policyLane);
  const { data } = await api.post<ChatUpload>(`/conversations/${args.conversationId}/uploads`, form);
  return data;
}

export async function decideChatUpload(args: {
  uploadId: string;
  persistenceMode: ChatUploadPersistenceMode;
  collectionId?: string | null;
  collectionSlug?: string | null;
}) {
  const { data } = await api.post<ChatUpload>(`/chat/uploads/${args.uploadId}/decision`, {
    persistence_mode: args.persistenceMode,
    collection_id: args.collectionId ?? null,
    collection_slug: args.collectionSlug ?? null,
  });
  return data;
}

export async function startSync(corpus?: string) {
  const { data } = await api.post<Task>("/sync", { corpus: corpus ?? null });
  return data;
}

export async function getTask(id: string) {
  const { data } = await api.get<Task>(`/tasks/${id}`);
  return data;
}

export async function chat(
  message: string,
  corpora: string[] = [],
  apiMode: ChatApiMode = "responses",
  conversationMode: ConversationMode = "quick",
  workflowMode: WorkflowMode = "standard",
) {
  const response = await fetch(`${agentBaseUrl}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      corpora,
      api_mode: apiMode,
      conversation_mode: conversationMode,
      workflow_mode: workflowMode,
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as { answer: string; query_mode: string; citations: unknown[]; conversation_id?: string; agent_id?: string; cached?: boolean };
}

export async function streamChat(args: {
  message: string;
  corpora?: string[];
  apiMode?: ChatApiMode;
  conversationMode?: ConversationMode;
  workflowMode?: WorkflowMode;
  /** Per-request model id (e.g. openai/gpt-4o-mini). Omit to use the agent runtime profile model. */
  llmModelId?: string | null;
  agentId?: string;
  conversationId?: string;
  useApprovedWeb?: boolean;
  toolOverrides?: Record<string, boolean>;
  docxMode?: ChatDocxMode;
  /** When set, replaces the agent profile system prompt for this request (simulator / workbench). */
  systemPromptOverride?: string | null;
  signal?: AbortSignal;
  onStart?: (payload: {
    citations: unknown[];
    api_mode: ChatApiMode;
    conversation_mode: ConversationMode;
    workflow_mode: WorkflowMode;
    query_mode?: string;
    conversation_id?: string;
    agent_id?: string;
    cached?: boolean;
    tool_events?: ChatToolEvent[];
    route_decision?: RouteDecision | null;
    docx_artifacts?: DocxArtifact[];
    docx_diagnostics?: DocxDiagnostic[];
  }) => void;
  onToolEvent?: (payload: { tool_event: ChatToolEvent }) => void;
  onDelta: (delta: string) => void;
  onDone?: (payload: {
    citations: unknown[];
    conversation_mode: ConversationMode;
    workflow_mode: WorkflowMode;
    conversation_id?: string;
    cached?: boolean;
    usage?: ChatUsage;
    llm_io?: LlmIoPayload;
    tool_events?: ChatToolEvent[];
    route_decision?: RouteDecision | null;
    docx_artifacts?: DocxArtifact[];
    docx_diagnostics?: DocxDiagnostic[];
  }) => void;
}) {
  const response = await fetch(`${agentBaseUrl}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: args.message,
      corpora: args.corpora ?? [],
      api_mode: args.apiMode ?? "responses",
      conversation_mode: args.conversationMode ?? "quick",
      workflow_mode: args.workflowMode ?? "standard",
      llm_model_id: args.llmModelId?.trim() ? args.llmModelId.trim() : null,
      agent_id: args.agentId ?? null,
      conversation_id: args.conversationId ?? null,
      use_approved_web: args.useApprovedWeb ?? false,
      tool_overrides: args.toolOverrides ?? {},
      ...(args.docxMode
        ? {
            docx_mode: {
              enabled: args.docxMode.enabled,
              template_id: args.docxMode.template_id ?? null,
              operation: args.docxMode.operation ?? "preview",
              binding_overrides: args.docxMode.binding_overrides ?? {},
            },
          }
        : {}),
      ...(args.systemPromptOverride?.trim()
        ? { system_prompt_override: args.systemPromptOverride.trim() }
        : {}),
    }),
    signal: args.signal,
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(errorText || `Chat stream failed with ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const eventBlock of events) {
      const line = eventBlock
        .split("\n")
        .find((candidate) => candidate.startsWith("data: "));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6)) as
        | { type: "start"; citations: unknown[]; api_mode: ChatApiMode; conversation_mode: ConversationMode; workflow_mode: WorkflowMode; query_mode?: string; conversation_id?: string; agent_id?: string; cached?: boolean; tool_events?: ChatToolEvent[]; route_decision?: RouteDecision | null; docx_artifacts?: DocxArtifact[]; docx_diagnostics?: DocxDiagnostic[] }
        | { type: "tool_result"; tool_event: ChatToolEvent }
        | { type: "delta"; delta: string }
        | { type: "done"; citations: unknown[]; conversation_mode: ConversationMode; workflow_mode: WorkflowMode; conversation_id?: string; cached?: boolean; usage?: ChatUsage; llm_io?: LlmIoPayload; tool_events?: ChatToolEvent[]; route_decision?: RouteDecision | null; docx_artifacts?: DocxArtifact[]; docx_diagnostics?: DocxDiagnostic[] }
        | { type: "error"; error: string };

      if (payload.type === "start") {
        args.onStart?.({
          citations: payload.citations,
          api_mode: payload.api_mode,
          conversation_mode: payload.conversation_mode,
          workflow_mode: payload.workflow_mode,
          query_mode: payload.query_mode,
          conversation_id: payload.conversation_id,
          agent_id: payload.agent_id,
          cached: payload.cached,
          tool_events: payload.tool_events,
          route_decision: payload.route_decision ?? null,
          docx_artifacts: payload.docx_artifacts ?? [],
          docx_diagnostics: payload.docx_diagnostics ?? [],
        });
      } else if (payload.type === "tool_result") {
        args.onToolEvent?.({ tool_event: payload.tool_event });
      } else if (payload.type === "delta") {
        args.onDelta(payload.delta);
      } else if (payload.type === "done") {
        args.onDone?.({
          citations: payload.citations,
          conversation_mode: payload.conversation_mode,
          workflow_mode: payload.workflow_mode,
          conversation_id: payload.conversation_id,
          cached: payload.cached,
          usage: payload.usage,
          llm_io: payload.llm_io,
          tool_events: payload.tool_events,
          route_decision: payload.route_decision ?? null,
          docx_artifacts: payload.docx_artifacts ?? [],
          docx_diagnostics: payload.docx_diagnostics ?? [],
        });
      } else if (payload.type === "error") {
        throw new Error(payload.error);
      }
    }

    if (done) {
      break;
    }
  }
}

export async function fetchVoiceProviderVoices() {
  const response = await fetch(`${agentBaseUrl}/voice/voices`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as VoiceProviderStatus;
}

/** Returns MPEG audio from the agent-ingress ElevenLabs preview route. */
export async function fetchElevenLabsPreviewMpeg(args: {
  voiceId: string;
  text: string;
  mastering?: ElevenLabsMasteringPayload | null;
}): Promise<Blob> {
  const body = {
    voice_id: args.voiceId,
    text: args.text,
    ...(args.mastering
      ? {
          model_id: args.mastering.model_id,
          language_code: args.mastering.language_code,
          seed: args.mastering.seed,
          previous_text: args.mastering.previous_text,
          next_text: args.mastering.next_text,
          apply_text_normalization: args.mastering.apply_text_normalization,
          voice_settings: args.mastering.voice_settings,
          pronunciation_dictionary_locators: args.mastering.pronunciation_dictionary_locators,
          pronunciation_replacements: args.mastering.pronunciation_replacements,
        }
      : {}),
  };
  const response = await fetch(`${agentBaseUrl}/voice/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.blob();
}

export function buildVoiceStreamUrl(args: {
  agentId?: string | null;
  conversationId?: string | null;
  voiceId?: string | null;
  mastering?: ElevenLabsMasteringPayload | null;
}) {
  const base = agentBaseUrl.startsWith("http")
    ? agentBaseUrl
    : `${window.location.origin}${agentBaseUrl.startsWith("/") ? agentBaseUrl : `/${agentBaseUrl}`}`;
  const url = new URL(`${base.replace(/\/$/, "")}/voice/stream`);
  if (args.agentId) url.searchParams.set("agent_id", args.agentId);
  if (args.conversationId) url.searchParams.set("conversation_id", args.conversationId);
  if (args.voiceId) url.searchParams.set("voice_id", args.voiceId);
  if (args.mastering) {
    url.searchParams.set("model_id", args.mastering.model_id);
    url.searchParams.set("language_code", args.mastering.language_code);
    if (typeof args.mastering.seed === "number") url.searchParams.set("seed", String(args.mastering.seed));
    url.searchParams.set("stability", String(args.mastering.voice_settings.stability));
    url.searchParams.set("similarity_boost", String(args.mastering.voice_settings.similarity_boost));
    url.searchParams.set("style", String(args.mastering.voice_settings.style));
    url.searchParams.set("use_speaker_boost", args.mastering.voice_settings.use_speaker_boost ? "1" : "0");
    url.searchParams.set("speed", String(args.mastering.voice_settings.speed));
    url.searchParams.set("apply_text_normalization", args.mastering.apply_text_normalization);
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function buildVoiceTtsStreamUrl(args: {
  voiceId?: string | null;
  mastering?: ElevenLabsMasteringPayload | null;
}) {
  const base = agentBaseUrl.startsWith("http")
    ? agentBaseUrl
    : `${window.location.origin}${agentBaseUrl.startsWith("/") ? agentBaseUrl : `/${agentBaseUrl}`}`;
  const url = new URL(`${base.replace(/\/$/, "")}/voice/tts-stream`);
  if (args.voiceId) url.searchParams.set("voice_id", args.voiceId);
  if (args.mastering) {
    url.searchParams.set("model_id", args.mastering.model_id);
    url.searchParams.set("language_code", args.mastering.language_code);
    if (typeof args.mastering.seed === "number") url.searchParams.set("seed", String(args.mastering.seed));
    url.searchParams.set("stability", String(args.mastering.voice_settings.stability));
    url.searchParams.set("similarity_boost", String(args.mastering.voice_settings.similarity_boost));
    url.searchParams.set("style", String(args.mastering.voice_settings.style));
    url.searchParams.set("use_speaker_boost", args.mastering.voice_settings.use_speaker_boost ? "1" : "0");
    url.searchParams.set("speed", String(args.mastering.voice_settings.speed));
    url.searchParams.set("apply_text_normalization", args.mastering.apply_text_normalization);
    if (args.mastering.previous_text.trim()) url.searchParams.set("previous_text", args.mastering.previous_text.trim());
    if (args.mastering.next_text.trim()) url.searchParams.set("next_text", args.mastering.next_text.trim());
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function fetchElevenLabsAnalysisHealth() {
  const { data } = await api.get<ElevenLabsAnalysisHealth>("/elevenlabs/analysis/health");
  return data;
}

export async function fetchElevenLabsAnalysisConversations(args?: {
  limit?: number;
  cursor?: string | null;
  search?: string | null;
  status?: string | null;
  conversation_status?: string | null;
  date_after_unix?: number | null;
  date_before_unix?: number | null;
  user_id?: string | null;
  branch_id?: string | null;
}) {
  const params: Record<string, string | number> = {};
  if (args?.limit) params.limit = args.limit;
  if (args?.cursor) params.cursor = args.cursor;
  if (args?.search) params.search = args.search;
  if (args?.status) params.status = args.status;
  if (args?.conversation_status) params.conversation_status = args.conversation_status;
  if (typeof args?.date_after_unix === "number") params.date_after_unix = args.date_after_unix;
  if (typeof args?.date_before_unix === "number") params.date_before_unix = args.date_before_unix;
  if (args?.user_id) params.user_id = args.user_id;
  if (args?.branch_id) params.branch_id = args.branch_id;
  const { data } = await api.get<ElevenLabsAnalysisConversationsResponse>("/elevenlabs/analysis/conversations", { params });
  return data;
}

export async function fetchElevenLabsAnalysisConversation(conversationId: string) {
  const { data } = await api.get<ElevenLabsAnalysisConversationDetail>(`/elevenlabs/analysis/conversations/${conversationId}`);
  return data;
}

export async function fetchElevenLabsAnalysisTranscript(conversationId: string) {
  const { data } = await api.get<ElevenLabsAnalysisTranscript>(`/elevenlabs/analysis/conversations/${conversationId}/transcript`);
  return data;
}

export async function fetchElevenLabsSimulations(args?: { search?: string; limit?: number }) {
  const params: Record<string, string | number> = {};
  if (args?.search) params.search = args.search;
  if (args?.limit) params.limit = args.limit;
  const { data } = await api.get<ElevenLabsSimulationListResponse>("/elevenlabs/analysis/simulations", { params });
  return data;
}

export async function fetchElevenLabsSimulation(fileName: string) {
  const { data } = await api.get<ElevenLabsSimulationDetailResponse>(
    `/elevenlabs/analysis/simulations/${encodeURIComponent(fileName)}`,
  );
  return data;
}

export async function fetchElevenLabsTestSimulations(args?: { search?: string; limit?: number }) {
  const params: Record<string, string | number> = {};
  if (args?.search) params.search = args.search;
  if (args?.limit) params.limit = args.limit;
  const { data } = await api.get<ElevenLabsSimulationListResponse>("/elevenlabs/tests/simulations", { params });
  return data;
}

export async function fetchElevenLabsTestSimulation(fileName: string) {
  const { data } = await api.get<ElevenLabsSimulationDetailResponse>(
    `/elevenlabs/tests/simulations/${encodeURIComponent(fileName)}`,
  );
  return data;
}

export async function runElevenLabsTestSimulation(fileName: string, body: ElevenLabsSimulationRunRequest) {
  const { data } = await api.post<ElevenLabsSimulationRunResponse>(
    `/elevenlabs/tests/simulations/${encodeURIComponent(fileName)}/run`,
    body,
    { timeout: 180_000 },
  );
  return data;
}

export async function stepElevenLabsTestSimulation(fileName: string, body: ElevenLabsStepRequest) {
  const { data } = await api.post<ElevenLabsSimulationRunResponse>(
    `/elevenlabs/tests/simulations/${encodeURIComponent(fileName)}/step`,
    body,
    { timeout: 180_000 },
  );
  return data;
}

export async function fetchElevenLabsWorkbenchOptions() {
  const { data } = await api.get<ElevenLabsWorkbenchOptionsResponse>("/elevenlabs/tests/options");
  return data;
}

export async function fetchElevenLabsWorkbenchTools(args?: { search?: string; page_size?: number }) {
  const params: Record<string, string | number> = { page_size: args?.page_size ?? 100 };
  if (args?.search) params.search = args.search;
  const { data } = await api.get<ElevenLabsWorkbenchToolsResponse>("/elevenlabs/tests/tools", { params });
  return data;
}

export async function fetchElevenLabsWorkbenchAgent(agentId: string) {
  const { data } = await api.get<ElevenLabsWorkbenchAgentResponse>(
    `/elevenlabs/tests/agents/${encodeURIComponent(agentId)}`,
  );
  return data;
}

export type ElevenLabsOperatorHealth = {
  ok: boolean;
  service: string;
  elevenlabs_api_configured: boolean;
  elevenlabs_convai_agent_id: string | null;
  repo_tool_count: number;
  repo_tool_roots: string[];
  ghostdash_webhook: string;
  capabilities: Record<string, boolean>;
};

export type ElevenLabsRepoTool = {
  file_name: string;
  path: string;
  tool_name: string;
  api_function: string | null;
  description: string;
  timeout_secs?: number;
  is_booking: boolean;
  recommended_flow: string | null;
};

export async function fetchElevenLabsOperatorHealth() {
  const { data } = await api.get<ElevenLabsOperatorHealth>("/elevenlabs/operator/health");
  return data;
}

export async function fetchElevenLabsRepoTools() {
  const { data } = await api.get<{ tools: ElevenLabsRepoTool[]; count: number }>("/elevenlabs/operator/tools");
  return data;
}

export async function fetchElevenLabsRepoTool(fileName: string) {
  const { data } = await api.get<{ file_name: string; path: string; tool: Record<string, unknown> }>(
    `/elevenlabs/operator/tools/${encodeURIComponent(fileName)}`,
  );
  return data;
}


export type ElevenLabsSyncToolPreview = {
  file_name: string;
  tool_name: string;
  action: "create" | "update" | "unchanged" | "error";
  remote_tool_id?: string | null;
  api_url?: string;
  timeout_secs?: number | null;
  message?: string;
};

export type ElevenLabsSyncPreviewResponse = {
  dry_run: boolean;
  tool_count: number;
  remote_tool_count: number;
  tools: ElevenLabsSyncToolPreview[];
};

export type ElevenLabsSyncRequest = {
  dry_run?: boolean;
  attach_to_agent?: boolean;
  agent_id?: string | null;
  confirm_agent_attachment?: boolean;
  tool_files?: string[] | null;
};

function operatorAdminHeaders(adminKey: string) {
  return { headers: { "X-Operator-Admin-Key": adminKey } };
}

export async function fetchElevenLabsSyncPreview(adminKey: string) {
  const { data } = await api.get<ElevenLabsSyncPreviewResponse>(
    "/elevenlabs/operator/tools/sync/preview",
    operatorAdminHeaders(adminKey),
  );
  return data;
}

export async function runElevenLabsToolSync(adminKey: string, body: ElevenLabsSyncRequest) {
  const { data } = await api.post<Record<string, unknown>>(
    "/elevenlabs/operator/tools/sync",
    body,
    operatorAdminHeaders(adminKey),
  );
  return data;
}

export async function fetchElevenLabsWorkflowMap() {
  const { data } = await api.get<Record<string, unknown>>("/elevenlabs/operator/workflow-map");
  return data;
}

export function buildElevenLabsAnalysisAudioUrl(conversationId: string) {
  const base = apiBaseUrl.startsWith("http")
    ? apiBaseUrl
    : `${window.location.origin}${apiBaseUrl.startsWith("/") ? apiBaseUrl : `/${apiBaseUrl}`}`;
  return `${base.replace(/\/$/, "")}/elevenlabs/analysis/conversations/${encodeURIComponent(conversationId)}/audio`;
}
