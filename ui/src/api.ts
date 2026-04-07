import axios from "axios";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
const agentBaseUrl = import.meta.env.VITE_AGENT_BASE_URL ?? "/agent";

export const api = axios.create({
  baseURL: apiBaseUrl,
  timeout: 120_000,
});

export type ChatApiMode = "responses" | "chat_completions";

export type Connection = {
  id: string;
  provider: string;
  label: string;
  base_url: string | null;
  chat_model: string | null;
  embedding_model: string | null;
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
};

export type AgentToolConfig = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
};

export type AgentProfile = {
  id: string;
  name: string;
  system_prompt: string;
  first_message: string;
  model_id: string;
  temperature: number;
  max_tokens: number;
  language: string;
  voice_id: string;
  tools: AgentToolConfig[];
  is_default: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type AgentProfilePayload = {
  id?: string;
  name: string;
  system_prompt: string;
  first_message: string;
  model_id: string;
  temperature: number;
  max_tokens: number;
  language: string;
  voice_id: string;
  tools: AgentToolConfig[];
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
  requested_lane: string;
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
  requested_lane: string;
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
  requested_lane: string | null;
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

export async function saveRuntimeDefaults(body: RuntimeDefaults) {
  const { data } = await api.post<RuntimeDefaults>("/runtime/defaults", body);
  return data;
}

export async function fetchAgents() {
  const { data } = await api.get<AgentProfile[]>("/agents");
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

export async function fetchDocuments(corpus?: string) {
  const { data } = await api.get<DocumentIngestion[]>("/documents", {
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

export async function saveConnection(body: Partial<Connection> & { provider: string }) {
  const { data } = await api.post<Connection>("/connections", body);
  return data;
}

export async function testConnection(body: {
  provider: string;
  api_key?: string;
  base_url?: string;
  chat_model?: string;
  api_mode: ChatApiMode;
  prompt?: string;
}) {
  const { data } = await api.post<ConnectionTestResult>("/connections/test", body);
  return data;
}

export async function uploadFile(file: File, corpus?: string, policyLane?: string) {
  const form = new FormData();
  form.append("file", file);
  if (corpus) form.append("corpus", corpus);
  if (policyLane) form.append("policy_lane", policyLane);
  const { data } = await api.post("/upload", form);
  return data as { id: string; filename: string; status: string };
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
      top_k: 6,
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
  agentId?: string;
  conversationId?: string;
  signal?: AbortSignal;
  onStart?: (payload: { citations: unknown[]; api_mode: ChatApiMode; query_mode?: string; conversation_id?: string; agent_id?: string; cached?: boolean }) => void;
  onDelta: (delta: string) => void;
  onDone?: (payload: { citations: unknown[]; conversation_id?: string; cached?: boolean }) => void;
}) {
  const response = await fetch(`${agentBaseUrl}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: args.message,
      corpora: args.corpora ?? [],
      top_k: 6,
      api_mode: args.apiMode ?? "responses",
      agent_id: args.agentId ?? null,
      conversation_id: args.conversationId ?? null,
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
        | { type: "done"; citations: unknown[]; conversation_id?: string; cached?: boolean }
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
        args.onDone?.({ citations: payload.citations, conversation_id: payload.conversation_id, cached: payload.cached });
      } else if (payload.type === "error") {
        throw new Error(payload.error);
      }
    }

    if (done) {
      break;
    }
  }
}
