import axios from "axios";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
const agentBaseUrl = import.meta.env.VITE_AGENT_BASE_URL ?? "/agent";

export const api = axios.create({
  baseURL: apiBaseUrl,
  timeout: 120_000,
});

export type ChatApiMode = "responses" | "chat_completions";

/** Approximate LLM tokens (cl100k) per assistant turn; sums prompt + completion. */
export type ChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimate?: boolean;
};
export type RequestedLane = "default" | "local" | "cloud";
export type ChatUploadPersistenceMode = "conversation_only" | "save_to_knowledge";
export type ProviderKind = "openai" | "anthropic" | "google_gemini" | "openai_compatible";
export type ConnectionAuthStrategy = "bearer" | "x_api_key" | "custom_header";
export type ToolHealth = "healthy" | "unhealthy" | "unknown";

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
  api_key_hint: string | null;
  has_api_key: boolean;
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

export type RuntimeProfileLlmConfig = {
  connection_id?: string | null;
  provider: string;
  model_id: string;
  temperature: number;
  max_tokens: number;
  api_mode: ChatApiMode;
};

export type RuntimeProfileGuardrailsConfig = {
  system_prompt: string;
  grounding_mode: "retrieved_only";
  insufficient_context_behavior: string;
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
  is_default: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type ChatBootstrapFeatures = {
  allow_mock_provider: boolean;
  allow_api_mode_override: boolean;
  allow_approved_web_toggle: boolean;
};

export type ChatBootstrap = {
  surface: string;
  default_agent_id: string | null;
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
  is_default: boolean;
  enabled: boolean;
};

export type ConversationSummary = {
  id: string;
  agent_id: string;
  title: string;
  corpora: string[];
  api_mode: ChatApiMode;
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
  api_mode: ChatApiMode | null;
  created_at: string;
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

export async function fetchAgentConversations(agentId: string) {
  const { data } = await api.get<ConversationSummary[]>(`/agents/${agentId}/conversations`);
  return data;
}

export async function fetchConversationMessages(conversationId: string) {
  const { data } = await api.get<ConversationMessage[]>(`/conversations/${conversationId}/messages`);
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
  model_id?: string;
  api_mode: ChatApiMode;
  prompt?: string;
}) {
  const { data } = await api.post<ConnectionTestResult>("/connections/test", body);
  return data;
}

export async function uploadFile(file: File, corpus?: string, policyLane?: RequestedLane) {
  const form = new FormData();
  form.append("file", file);
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

export async function chat(message: string, corpora: string[] = [], apiMode: ChatApiMode = "responses") {
  const response = await fetch(`${agentBaseUrl}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      corpora,
      api_mode: apiMode,
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
  /** Per-request model id (e.g. openai/gpt-4o-mini). Omit to use the agent runtime profile model. */
  llmModelId?: string | null;
  agentId?: string;
  conversationId?: string;
  useApprovedWeb?: boolean;
  signal?: AbortSignal;
  onStart?: (payload: { citations: unknown[]; api_mode: ChatApiMode; query_mode?: string; conversation_id?: string; agent_id?: string; cached?: boolean }) => void;
  onDelta: (delta: string) => void;
  onDone?: (payload: {
    citations: unknown[];
    conversation_id?: string;
    cached?: boolean;
    usage?: ChatUsage;
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
      llm_model_id: args.llmModelId?.trim() ? args.llmModelId.trim() : null,
      agent_id: args.agentId ?? null,
      conversation_id: args.conversationId ?? null,
      use_approved_web: args.useApprovedWeb ?? false,
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
        | { type: "start"; citations: unknown[]; api_mode: ChatApiMode; query_mode?: string; conversation_id?: string; agent_id?: string; cached?: boolean }
        | { type: "delta"; delta: string }
        | { type: "done"; citations: unknown[]; conversation_id?: string; cached?: boolean; usage?: ChatUsage }
        | { type: "error"; error: string };

      if (payload.type === "start") {
        args.onStart?.({
          citations: payload.citations,
          api_mode: payload.api_mode,
          query_mode: payload.query_mode,
          conversation_id: payload.conversation_id,
          agent_id: payload.agent_id,
          cached: payload.cached,
        });
      } else if (payload.type === "delta") {
        args.onDelta(payload.delta);
      } else if (payload.type === "done") {
        args.onDone?.({
          citations: payload.citations,
          conversation_id: payload.conversation_id,
          cached: payload.cached,
          usage: payload.usage,
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
