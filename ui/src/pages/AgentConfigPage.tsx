import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  fetchAgentToolPolicy,
  fetchAgents,
  fetchCollections,
  fetchConnections,
  fetchRuntimeDefaults,
  fetchToolCatalog,
  saveAgent,
  saveAgentToolPolicy,
} from "../api";
import type {
  AgentProfile,
  AgentProfilePayload,
  AgentToolConfig,
  ChatApiMode,
  Collection,
  Connection,
  RuntimeProfile,
  RuntimeDefaults,
  ToolCatalogEntry,
  ToolPolicy,
} from "../api";
import type { AppOutletContext } from "../components/AppLayout";

const DEFAULT_TOOLS: AgentToolConfig[] = [
  {
    id: "kb",
    name: "Knowledge Base",
    description: "Query indexed documents.",
    enabled: true,
    allowed_urls: [],
    provider: "ghostdash",
    kind: "knowledge",
    session_toggleable: false,
  },
  {
    id: "web",
    name: "Approved Web Sources",
    description: "Fetch only the explicitly allowed websites stored on this agent.",
    enabled: false,
    allowed_urls: [],
    provider: "approved_web",
    kind: "approved_web",
    session_toggleable: false,
  },
];
const DEFAULT_EMBEDDING_MODEL = "openai/intfloat/multilingual-e5-large-instruct";
const ODOO_TOOL_ID = "odoo_primary";

function createRuntimeProfile(name: string, template?: RuntimeProfile, preserveIdentity = false): RuntimeProfile {
  const baseName = `${name} Runtime`;
  if (template) {
    return {
      ...template,
      id: preserveIdentity ? template.id : undefined,
      name: preserveIdentity ? template.name || baseName : baseName,
      tool_policy_config: {
        tools: template.tool_policy_config.tools.map((tool) => ({ ...tool, allowed_urls: [...(tool.allowed_urls ?? [])] })),
      },
      kb_config: {
        ...template.kb_config,
        default_corpora: [...template.kb_config.default_corpora],
      },
    };
  }
  return {
    name: baseName,
    description: "Canonical runtime profile for this agent.",
    llm_config: {
      connection_id: undefined,
      provider: "openai",
      model_id: "openai/llama31-8b",
      temperature: 0.2,
      max_tokens: 16000,
      api_mode: "responses",
    },
    guardrails_config: {
      system_prompt:
        "You answer using retrieved knowledge only. Always ground the answer in the provided context and say when the context is insufficient.",
      grounding_mode: "retrieved_only",
      insufficient_context_behavior: "Say clearly that the available context is insufficient.",
    },
    kb_config: {
      default_corpora: ["default"],
      embedding_model_id: DEFAULT_EMBEDDING_MODEL,
    },
    retrieval_config: {
      default_top_k: 6,
      pdf_chunk_size: 900,
      pdf_chunk_overlap: 120,
      pdf_sentence_window: 2,
      pdf_parse_lane_policy: "auto",
      pdf_rerank_enabled: false,
    },
    tool_policy_config: {
      tools: DEFAULT_TOOLS.map((tool) => ({ ...tool })),
    },
    is_default: false,
    enabled: true,
  };
}

function createDraft(template?: AgentProfile | null, suggestedName?: string): AgentProfilePayload {
  const name = suggestedName ?? template?.name ?? "New Agent";
  return {
    name,
    first_message: template?.first_message ?? "Hello! I am your GhostDASH assistant. How can I help you today?",
    language: template?.language ?? "en-US",
    voice_id: template?.voice_id ?? "alloy",
    runtime_profile_id: null,
    runtime_profile: createRuntimeProfile(name, template?.runtime_profile, false),
    is_default: false,
    enabled: true,
  };
}

function createEmptyDraft(suggestedName: string, runtimeDefaults?: RuntimeDefaults | null): AgentProfilePayload {
  return {
    name: suggestedName,
    first_message: "",
    language: "en-US",
    voice_id: "alloy",
    runtime_profile_id: null,
    runtime_profile: {
      name: `${suggestedName} Runtime`,
      description: "Canonical runtime profile for this agent.",
      llm_config: {
        connection_id: runtimeDefaults?.llm_connection_id ?? undefined,
        provider: runtimeDefaults?.llm_provider_key ?? "openai",
        model_id: runtimeDefaults?.llm_model_id ?? "openai/llama31-8b",
        temperature: 0.2,
        max_tokens: 16000,
        api_mode: runtimeDefaults?.chat_api_mode ?? "responses",
      },
      guardrails_config: {
        system_prompt: "",
        grounding_mode: "retrieved_only",
        insufficient_context_behavior: "",
      },
      kb_config: {
        default_corpora: runtimeDefaults?.default_corpora?.length ? [...runtimeDefaults.default_corpora] : ["default"],
        embedding_model_id: runtimeDefaults?.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL,
      },
      retrieval_config: {
        default_top_k: runtimeDefaults?.pdf_top_k ?? 6,
        pdf_chunk_size: runtimeDefaults?.pdf_chunk_size ?? 900,
        pdf_chunk_overlap: runtimeDefaults?.pdf_chunk_overlap ?? 120,
        pdf_sentence_window: runtimeDefaults?.pdf_sentence_window ?? 2,
        pdf_parse_lane_policy: runtimeDefaults?.pdf_parse_lane_policy ?? "auto",
        pdf_rerank_enabled: runtimeDefaults?.pdf_rerank_enabled ?? false,
      },
      tool_policy_config: {
        tools: DEFAULT_TOOLS.map((tool) => ({ ...tool })),
      },
      is_default: false,
      enabled: true,
    },
    is_default: false,
    enabled: true,
  };
}

function buildUniqueAgentName(baseName: string, agents: AgentProfile[], currentAgentId?: string | null) {
  const existingNames = new Set(
    agents
      .filter((agent) => agent.id !== currentAgentId)
      .map((agent) => agent.name.trim().toLowerCase()),
  );
  const normalizedBase = baseName.trim() || "New Agent";
  if (!existingNames.has(normalizedBase.toLowerCase())) {
    return normalizedBase;
  }
  let suffix = 2;
  while (existingNames.has(`${normalizedBase} ${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${normalizedBase} ${suffix}`;
}

function extractApiErrorMessage(error: unknown) {
  const responseData = (error as { response?: { data?: unknown } }).response?.data;
  if (typeof responseData === "string" && responseData.trim()) {
    return responseData;
  }
  if (responseData && typeof responseData === "object") {
    const detail = (responseData as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) {
      return detail;
    }
    if (Array.isArray(detail) && detail.length > 0) {
      return detail
        .map((item) => {
          if (!item || typeof item !== "object") {
            return String(item);
          }
          const path = Array.isArray((item as { loc?: unknown[] }).loc)
            ? (item as { loc: unknown[] }).loc.join(".")
            : "field";
          const message = typeof (item as { msg?: unknown }).msg === "string" ? (item as { msg: string }).msg : "invalid value";
          return `${path}: ${message}`;
        })
        .join(" | ");
    }
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "GhostDASH could not save the agent. Check the highlighted fields and try again.";
}

function normalizeDraftForSave(draft: AgentProfilePayload): AgentProfilePayload {
  return {
    ...draft,
    name: draft.name.trim(),
    first_message: draft.first_message.trim(),
    language: draft.language.trim(),
    voice_id: draft.voice_id.trim(),
    runtime_profile: draft.runtime_profile
      ? {
          ...draft.runtime_profile,
          name: draft.runtime_profile.name.trim(),
          description: draft.runtime_profile.description?.trim() || null,
          llm_config: {
            ...draft.runtime_profile.llm_config,
            provider: draft.runtime_profile.llm_config.provider.trim(),
            model_id: draft.runtime_profile.llm_config.model_id.trim(),
          },
          guardrails_config: {
            ...draft.runtime_profile.guardrails_config,
            system_prompt: draft.runtime_profile.guardrails_config.system_prompt.trim(),
            insufficient_context_behavior: draft.runtime_profile.guardrails_config.insufficient_context_behavior.trim(),
          },
          kb_config: {
            ...draft.runtime_profile.kb_config,
            default_corpora: draft.runtime_profile.kb_config.default_corpora
              .map((value) => value.trim())
              .filter(Boolean),
          },
          tool_policy_config: {
            tools: draft.runtime_profile.tool_policy_config.tools.map((tool) => ({
              ...tool,
              allowed_urls: (tool.allowed_urls ?? []).map((value) => value.trim()).filter(Boolean),
            })),
          },
        }
      : undefined,
  };
}

function toDraft(agent: AgentProfile): AgentProfilePayload {
  return {
    id: agent.id,
    name: agent.name,
    first_message: agent.first_message,
    language: agent.language,
    voice_id: agent.voice_id,
    runtime_profile_id: agent.runtime_profile_id,
    runtime_profile: createRuntimeProfile(agent.name, agent.runtime_profile, true),
    is_default: agent.is_default,
    enabled: agent.enabled,
  };
}

export default function AgentConfigPage() {
  const { refreshRuntimeDefaults } = useOutletContext<AppOutletContext>();
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogEntry[]>([]);
  const [toolPolicy, setToolPolicy] = useState<ToolPolicy | null>(null);
  const [toolPolicyLoading, setToolPolicyLoading] = useState(false);
  const [toolPolicySaving, setToolPolicySaving] = useState(false);
  const [toolPolicyError, setToolPolicyError] = useState<string | null>(null);
  const [toolPolicySavedAt, setToolPolicySavedAt] = useState<string | null>(null);
  const [runtimeDefaults, setRuntimeDefaults] = useState<RuntimeDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentProfilePayload>(() => createDraft());
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreateIntent, setIsCreateIntent] = useState(false);
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedId) ?? null, [agents, selectedId]);
  const runtimeProfile = draft.runtime_profile;
  const isCreateMode = !draft.id;
  const odooCatalogEntry = useMemo(
    () => toolCatalog.find((tool) => tool.id === ODOO_TOOL_ID) ?? null,
    [toolCatalog],
  );
  const odooEnabled = Boolean(toolPolicy?.allowed_tool_ids.includes(ODOO_TOOL_ID));
  const selectedConnectionId =
    runtimeProfile?.llm_config.connection_id ??
    connections.find((connection) => connection.provider === runtimeProfile?.llm_config.provider)?.id ??
    "";
  const duplicateAgent = useMemo(
    () =>
      agents.find(
        (agent) => agent.id !== draft.id && agent.name.trim().toLowerCase() === draft.name.trim().toLowerCase(),
      ) ?? null,
    [agents, draft.id, draft.name],
  );
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!draft.name.trim()) errors.push("Agent name is required.");
    if (duplicateAgent) errors.push(`Agent name '${draft.name.trim()}' already exists.`);
    if (!draft.first_message.trim()) errors.push("First message is required.");
    if (!runtimeProfile?.guardrails_config.system_prompt.trim()) errors.push("System prompt is required.");
    if (!runtimeProfile?.guardrails_config.insufficient_context_behavior.trim()) {
      errors.push("Insufficient context behavior is required.");
    }
    if (!runtimeProfile?.llm_config.model_id.trim()) errors.push("Model id is required.");
    if ((runtimeProfile?.llm_config.temperature ?? 0) < 0 || (runtimeProfile?.llm_config.temperature ?? 0) > 2) {
      errors.push("Temperature must be between 0 and 2.");
    }
    if ((runtimeProfile?.llm_config.max_tokens ?? 0) < 1 || (runtimeProfile?.llm_config.max_tokens ?? 0) > 16000) {
      errors.push("Max tokens must be between 1 and 16000.");
    }
    return errors;
  }, [draft.first_message, draft.name, duplicateAgent, runtimeProfile]);

  function startNewAgent(availableAgents: AgentProfile[] = agents, nextRuntimeDefaults: RuntimeDefaults | null = runtimeDefaults) {
    const suggestedName = buildUniqueAgentName("New Agent", availableAgents);
    setSelectedId(null);
    setDraft(createEmptyDraft(suggestedName, nextRuntimeDefaults));
    setSavedAt(null);
    setSaveError(null);
    setIsCreateIntent(true);
    setToolPolicy(null);
    setToolPolicyError(null);
    setToolPolicySavedAt(null);
  }

  async function refreshToolPolicy(agentId: string | null) {
    if (!agentId) {
      setToolPolicy(null);
      setToolPolicyError(null);
      return;
    }
    setToolPolicyLoading(true);
    setToolPolicyError(null);
    try {
      const nextPolicy = await fetchAgentToolPolicy(agentId);
      setToolPolicy(nextPolicy);
    } catch (error) {
      setToolPolicy(null);
      setToolPolicyError(extractApiErrorMessage(error));
    } finally {
      setToolPolicyLoading(false);
    }
  }

  async function refresh() {
    setLoading(true);
    try {
      const [nextAgents, nextCollections, nextConnections, nextRuntimeDefaults, nextToolCatalog] = await Promise.all([
        fetchAgents(),
        fetchCollections(),
        fetchConnections(),
        fetchRuntimeDefaults(),
        fetchToolCatalog(),
      ]);
      setAgents(nextAgents);
      setCollections(nextCollections);
      setConnections(nextConnections);
      setRuntimeDefaults(nextRuntimeDefaults);
      setToolCatalog(nextToolCatalog);
      const target = selectedId ? nextAgents.find((agent) => agent.id === selectedId) : isCreateIntent ? null : nextAgents[0];
      if (target) {
        setSelectedId(target.id);
        setDraft(toDraft(target));
        setIsCreateIntent(false);
      } else if (nextAgents.length === 0) {
        startNewAgent(nextAgents, nextRuntimeDefaults);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh().catch(() => null);
  }, []);

  useEffect(() => {
    void refreshToolPolicy(selectedId).catch(() => null);
  }, [selectedId]);

  async function save() {
    if (validationErrors.length > 0) {
      setSaveError(validationErrors[0]);
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      const saved = await saveAgent(normalizeDraftForSave(draft));
      const nextAgents = await fetchAgents();
      setAgents(nextAgents);
      setSelectedId(saved.id);
      setDraft(toDraft(saved));
      await refreshToolPolicy(saved.id);
      setIsCreateIntent(false);
      if (saved.is_default) {
        await refreshRuntimeDefaults();
      }
      setSavedAt(new Date().toLocaleTimeString());
    } catch (error) {
      setSaveError(extractApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function saveOdooAccess() {
    if (!selectedId || !toolPolicy) {
      return;
    }
    setToolPolicySaving(true);
    setToolPolicyError(null);
    try {
      const savedPolicy = await saveAgentToolPolicy(selectedId, toolPolicy.allowed_tool_ids);
      setToolPolicy(savedPolicy);
      const nextAgents = await fetchAgents();
      setAgents(nextAgents);
      const refreshedAgent = nextAgents.find((agent) => agent.id === selectedId) ?? null;
      if (refreshedAgent) {
        setDraft(toDraft(refreshedAgent));
      }
      setToolPolicySavedAt(new Date().toLocaleTimeString());
    } catch (error) {
      setToolPolicyError(extractApiErrorMessage(error));
    } finally {
      setToolPolicySaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Agent Configuration</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-[1.05rem] font-semibold text-slate-900">Persona and runtime profile</h2>
              <span className={`rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.16em] ${isCreateMode ? "border border-blue-200 bg-blue-50 text-blue-700" : "border border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
                {isCreateMode ? "Creating new agent" : "Editing saved agent"}
              </span>
            </div>
            <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
              Each agent now points at one canonical runtime profile. Model, guardrails, and tool policy live there; pipeline and retrieval defaults are edited in the Pipelines view.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => startNewAgent()}
            >
              New agent
            </button>
            <button
              type="button"
              className="ghost-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void save()}
              disabled={isSaving || validationErrors.length > 0}
            >
              {isSaving ? "Saving..." : isCreateMode ? "Create agent" : "Save changes"}
            </button>
          </div>
        </div>
        {(saveError || validationErrors.length > 0 || savedAt) && (
          <div
            className={`mt-4 rounded-xl border px-4 py-3 text-[0.78rem] ${
              saveError
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : validationErrors.length > 0
                  ? "border-amber-200 bg-amber-50 text-amber-700"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {saveError
              ? saveError
              : validationErrors.length > 0
                ? validationErrors[0]
                : `Saved to GhostDASH at ${savedAt}`}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[0.7fr_1.3fr_0.8fr]">
        <article className="glass rounded-xl border border-slate-200 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-[0.85rem] font-semibold text-slate-900">Saved agents</div>
            <button type="button" className="ghost-btn" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          <div className="space-y-2">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={`w-full rounded-xl border px-3 py-3 text-left transition ${selectedId === agent.id ? "border-orange-300 bg-orange-50/70" : "border-slate-200 bg-white/70"}`}
                onClick={() => {
                  setSelectedId(agent.id);
                  setDraft(toDraft(agent));
                  setSaveError(null);
                  setSavedAt(null);
                  setIsCreateIntent(false);
                  setToolPolicySavedAt(null);
                  setToolPolicyError(null);
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="truncate text-[0.82rem] font-semibold text-slate-900">{agent.name}</div>
                  {agent.is_default && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[0.64rem] font-semibold text-emerald-700">Default</span>}
                </div>
                <div className="mt-1 truncate text-[0.72rem] text-slate-500">{agent.runtime_profile.llm_config.model_id}</div>
              </button>
            ))}
            {loading && <div className="text-[0.78rem] text-slate-500">Loading saved agents...</div>}
            {!loading && agents.length === 0 && <div className="text-[0.78rem] text-slate-500">No agents have been saved yet.</div>}
          </div>
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <label className="block text-[0.76rem] text-slate-500">
            Agent name
            <input
              className={`ghost-input mt-1 ${duplicateAgent ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100" : ""}`}
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                  runtime_profile: current.runtime_profile
                    ? {
                        ...current.runtime_profile,
                        name:
                          current.runtime_profile.name === `${current.name} Runtime`
                            ? `${event.target.value} Runtime`
                            : current.runtime_profile.name,
                      }
                    : current.runtime_profile,
                }))
              }
            />
            {duplicateAgent && <span className="mt-1 block text-[0.68rem] text-rose-600">This name is already used by another saved agent.</span>}
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            First message
            <textarea
              className="ghost-textarea mt-1 min-h-[90px]"
              value={draft.first_message}
              onChange={(event) => setDraft((current) => ({ ...current, first_message: event.target.value }))}
            />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            System prompt
            <textarea
              className="ghost-textarea mt-1 min-h-[150px]"
              value={runtimeProfile?.guardrails_config.system_prompt ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  runtime_profile: current.runtime_profile
                    ? {
                        ...current.runtime_profile,
                        guardrails_config: {
                          ...current.runtime_profile.guardrails_config,
                          system_prompt: event.target.value,
                        },
                      }
                    : current.runtime_profile,
                }))
              }
            />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Insufficient context behavior
            <textarea
              className="ghost-textarea mt-1 min-h-[90px]"
              value={runtimeProfile?.guardrails_config.insufficient_context_behavior ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  runtime_profile: current.runtime_profile
                    ? {
                        ...current.runtime_profile,
                        guardrails_config: {
                          ...current.runtime_profile.guardrails_config,
                          insufficient_context_behavior: event.target.value,
                        },
                      }
                    : current.runtime_profile,
                }))
              }
            />
          </label>
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <label className="block text-[0.76rem] text-slate-500">
            Provider connection
            <select
              className="ghost-input mt-1"
              value={selectedConnectionId}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  runtime_profile: current.runtime_profile
                    ? (() => {
                        const selectedConnection = connections.find((connection) => connection.id === event.target.value) ?? null;
                        return {
                          ...current.runtime_profile,
                          llm_config: {
                            ...current.runtime_profile.llm_config,
                            connection_id: selectedConnection?.id ?? null,
                            provider: selectedConnection?.provider ?? current.runtime_profile.llm_config.provider,
                          },
                        };
                      })()
                    : current.runtime_profile,
                }))
              }
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.label} ({connection.provider_kind})
                </option>
              ))}
              {loading && <option value="">Loading saved connections...</option>}
              {!loading && connections.length === 0 && <option value="">No saved connections</option>}
            </select>
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Model
            <input
              className="ghost-input mt-1"
              value={runtimeProfile?.llm_config.model_id ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  runtime_profile: current.runtime_profile
                    ? {
                        ...current.runtime_profile,
                        llm_config: { ...current.runtime_profile.llm_config, model_id: event.target.value },
                      }
                    : current.runtime_profile,
                }))
              }
            />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Temperature
            <input
              className="ghost-input mt-1"
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={runtimeProfile?.llm_config.temperature ?? 0}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  runtime_profile: current.runtime_profile
                    ? {
                        ...current.runtime_profile,
                        llm_config: { ...current.runtime_profile.llm_config, temperature: Number(event.target.value) },
                      }
                    : current.runtime_profile,
                }))
              }
            />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Max tokens
            <input
              className="ghost-input mt-1"
              type="number"
              min="1"
              value={runtimeProfile?.llm_config.max_tokens ?? 1}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  runtime_profile: current.runtime_profile
                    ? {
                        ...current.runtime_profile,
                        llm_config: { ...current.runtime_profile.llm_config, max_tokens: Number(event.target.value) },
                      }
                    : current.runtime_profile,
                }))
              }
            />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Chat API mode (OpenAI)
            <select
              className="ghost-select mt-1"
              value={runtimeProfile?.llm_config.api_mode ?? "responses"}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  runtime_profile: current.runtime_profile
                    ? {
                        ...current.runtime_profile,
                        llm_config: {
                          ...current.runtime_profile.llm_config,
                          api_mode: event.target.value as ChatApiMode,
                        },
                      }
                    : current.runtime_profile,
                }))
              }
            >
              <option value="responses">Responses API</option>
              <option value="chat_completions">Chat Completions API</option>
            </select>
            <span className="mt-1 block text-[0.68rem] text-slate-500">
              Use Responses for current ChatGPT-class models on the official OpenAI API. Chat is the legacy /v1/chat/completions path.
            </span>
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Language
            <input className="ghost-input mt-1" value={draft.language} onChange={(event) => setDraft((current) => ({ ...current, language: event.target.value }))} />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Voice ID
            <input className="ghost-input mt-1" value={draft.voice_id} onChange={(event) => setDraft((current) => ({ ...current, voice_id: event.target.value }))} />
          </label>
          <label className="flex items-center gap-2 text-[0.76rem] text-slate-500">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))}
            />
            Agent enabled
          </label>
          <label className="flex items-center gap-2 text-[0.76rem] text-slate-500">
            <input
              type="checkbox"
              checked={draft.is_default}
              onChange={() =>
                setDraft((current) => ({
                  ...current,
                  is_default: !current.is_default,
                  runtime_profile: current.runtime_profile
                    ? { ...current.runtime_profile, is_default: !current.is_default }
                    : current.runtime_profile,
                }))
              }
            />
            Set as default agent
          </label>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.74rem] text-slate-500">
            <div className="font-semibold text-slate-900">Runtime profile</div>
            <div className="mt-1">{runtimeProfile?.name ?? "Unsaved runtime profile"}</div>
            <div className="mt-1">Provider connection: {runtimeProfile?.llm_config.provider ?? "openai"}</div>
            <div className="mt-1">KB defaults: {(runtimeProfile?.kb_config.default_corpora ?? []).join(", ") || "default"}</div>
            <div className="mt-1">Embedding model: {runtimeProfile?.kb_config.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL}</div>
            <div className="mt-1">Pipeline retrieval defaults live in the Pipelines page to avoid duplicate edit surfaces.</div>
            {runtimeProfile?.llm_config.provider &&
              !connections.some((connection) => connection.provider === runtimeProfile.llm_config.provider) && (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[0.7rem] text-amber-700">
                  The selected provider has no saved connection record yet. Add it in Connections before using this agent.
                </div>
              )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.76rem] text-slate-500">
            <div className="font-semibold text-slate-900">Attached collections</div>
            <div className="mt-1 text-[0.7rem] text-slate-500">
              These bindings control which managed collections this agent can use by default through its runtime profile.
            </div>
            <div className="mt-3 space-y-2">
              {collections.map((collection) => {
                const selected = (runtimeProfile?.kb_config.default_corpora ?? []).includes(collection.slug);
                return (
                  <label key={collection.id} className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white/70 p-3">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() =>
                        setDraft((current) => {
                          const currentCorpora = current.runtime_profile?.kb_config.default_corpora ?? [];
                          const nextCorpora = selected
                            ? currentCorpora.filter((value) => value !== collection.slug)
                            : [...currentCorpora, collection.slug];
                          return {
                            ...current,
                            runtime_profile: current.runtime_profile
                              ? {
                                  ...current.runtime_profile,
                                  kb_config: {
                                    ...current.runtime_profile.kb_config,
                                    default_corpora: nextCorpora,
                                  },
                                }
                              : current.runtime_profile,
                          };
                        })
                      }
                    />
                    <span>
                      <span className="block font-semibold text-slate-900">{collection.name}</span>
                      <span>{collection.slug}</span>
                    </span>
                  </label>
                );
              })}
              {collections.length === 0 && <div className="text-[0.72rem] text-slate-500">No managed collections exist yet. Create them in Data Sources first.</div>}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.76rem] text-slate-500">
            <div className="font-semibold text-slate-900">Enabled tools</div>
            <div className="mt-2 space-y-2">
              {(runtimeProfile?.tool_policy_config.tools ?? [])
                .filter((tool) => tool.id !== ODOO_TOOL_ID)
                .map((tool) => (
                <div key={tool.id} className="rounded-xl border border-slate-200 bg-white/70 p-3">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      onChange={() =>
                        setDraft((current) => ({
                          ...current,
                          runtime_profile: current.runtime_profile
                            ? {
                                ...current.runtime_profile,
                                tool_policy_config: {
                                  tools: current.runtime_profile.tool_policy_config.tools.map((entry) =>
                                    entry.id === tool.id ? { ...entry, enabled: !entry.enabled } : entry,
                                  ),
                                },
                              }
                            : current.runtime_profile,
                        }))
                      }
                    />
                    <span>
                      <span className="block font-semibold text-slate-900">{tool.name}</span>
                      <span>{tool.description}</span>
                    </span>
                  </label>
                  {tool.id === "web" && (
                    <div className="mt-3 grid gap-2">
                      <div className="text-[0.7rem] text-slate-500">
                        Approved websites for this agent. Maximum 2. The agent may only use these sources when explicitly asked or when checking them materially improves the answer.
                      </div>
                      {[0, 1].map((idx) => (
                        <input
                          key={idx}
                          className="ghost-input"
                          placeholder={idx === 0 ? "https://example.com" : "Optional second website"}
                          value={tool.allowed_urls?.[idx] ?? ""}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              runtime_profile: current.runtime_profile
                                ? {
                                    ...current.runtime_profile,
                                    tool_policy_config: {
                                      tools: current.runtime_profile.tool_policy_config.tools.map((entry) => {
                                        if (entry.id !== tool.id) return entry;
                                        const allowedUrls = [...(entry.allowed_urls ?? [])];
                                        allowedUrls[idx] = event.target.value;
                                        return {
                                          ...entry,
                                          allowed_urls: allowedUrls.map((value) => value.trim()).filter(Boolean).slice(0, 2),
                                        };
                                      }),
                                    },
                                  }
                                : current.runtime_profile,
                            }))
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {savedAt && <div className="mt-3">Last saved to GhostDASH at {savedAt}</div>}
            {selectedAgent && <div className="mt-3 text-[0.7rem] text-slate-400">Editing agent id `{selectedAgent.id}`</div>}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.76rem] text-slate-500">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-slate-900">Odoo access</div>
                <div className="mt-1 text-[0.7rem] text-slate-500">
                  This control uses the dedicated tool policy endpoint so GhostDASH can clone a shared runtime profile when needed instead of mutating another agent’s access.
                </div>
              </div>
              {odooCatalogEntry && (
                <span
                  className={`rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold ${
                    odooCatalogEntry.status === "healthy"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : odooCatalogEntry.status === "unhealthy"
                        ? "border-rose-200 bg-rose-50 text-rose-700"
                        : "border-amber-200 bg-amber-50 text-amber-700"
                  }`}
                >
                  {odooCatalogEntry.status}
                </span>
              )}
            </div>
            <div className="mt-3 space-y-3">
              <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white/70 p-3">
                <input
                  type="checkbox"
                  checked={odooEnabled}
                  disabled={!selectedId || toolPolicyLoading}
                  onChange={() =>
                    setToolPolicy((current) =>
                      current
                        ? {
                            ...current,
                            allowed_tool_ids: current.allowed_tool_ids.includes(ODOO_TOOL_ID)
                              ? current.allowed_tool_ids.filter((toolId) => toolId !== ODOO_TOOL_ID)
                              : [...current.allowed_tool_ids, ODOO_TOOL_ID],
                          }
                        : current,
                    )
                  }
                />
                <span>
                  <span className="block font-semibold text-slate-900">Allow Odoo for this agent</span>
                  <span>
                    Runtime use still requires global activation and a healthy configured gateway. ChatUI can also turn it off per session without changing this policy.
                  </span>
                </span>
              </label>
              <div className="grid gap-2 text-[0.72rem] sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white/70 p-3">
                  Global catalog state: {odooCatalogEntry ? `${odooCatalogEntry.active ? "active" : "inactive"} / ${odooCatalogEntry.status}` : "Loading..."}
                </div>
                <div className="rounded-xl border border-slate-200 bg-white/70 p-3">
                  Config readiness: {odooCatalogEntry?.configured ? "complete" : "incomplete"}
                </div>
              </div>
              {toolPolicyError && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[0.72rem] text-rose-700">
                  {toolPolicyError}
                </div>
              )}
              {!selectedId && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[0.72rem] text-amber-700">
                  Save the agent first before attaching Odoo access.
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <div className="text-[0.7rem] text-slate-400">
                  {toolPolicySavedAt ? `Saved Odoo access at ${toolPolicySavedAt}` : toolPolicyLoading ? "Loading policy..." : "Per-agent tool access is stored through the runtime profile policy owner."}
                </div>
                <button
                  type="button"
                  className="ghost-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void saveOdooAccess()}
                  disabled={!selectedId || !toolPolicy || toolPolicySaving || toolPolicyLoading}
                >
                  {toolPolicySaving ? "Saving..." : "Save Odoo access"}
                </button>
              </div>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
