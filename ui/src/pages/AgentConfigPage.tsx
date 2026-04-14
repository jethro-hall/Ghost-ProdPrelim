import { useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
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

const SETTINGS_GROUPS = [
  { id: "connection", label: "Connection" },
  { id: "generation", label: "Generation" },
  { id: "voice", label: "Voice & status" },
  { id: "runtime", label: "Runtime summary" },
  { id: "collections", label: "Collections" },
  { id: "tools", label: "Tools" },
  { id: "odoo", label: "Odoo" },
] as const;

function LoadingWheel({ spinning }: { spinning: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 bg-white/80 text-slate-500 transition ${
        spinning ? "animate-spin border-ghost-orange text-ghost-orange" : ""
      }`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1 -9 -9" />
      </svg>
    </span>
  );
}

function EditGlyph() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
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
  const [isReverting, setIsReverting] = useState(false);
  const [isCreateIntent, setIsCreateIntent] = useState(false);
  const [identityEditMode, setIdentityEditMode] = useState(false);
  const [activeSectionId, setActiveSectionId] = useState<(typeof SETTINGS_GROUPS)[number]["id"]>("connection");
  const settingsPanelRef = useRef<HTMLDivElement | null>(null);
  const identityCardRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedId) ?? null, [agents, selectedId]);
  const runtimeProfile = draft.runtime_profile;
  const isCreateMode = !draft.id;
  const odooCatalogEntry = useMemo(() => toolCatalog.find((tool) => tool.id === ODOO_TOOL_ID) ?? null, [toolCatalog]);
  const odooEnabled = Boolean(toolPolicy?.allowed_tool_ids.includes(ODOO_TOOL_ID));
  const selectedConnectionId =
    runtimeProfile?.llm_config.connection_id ??
    connections.find((connection) => connection.provider === runtimeProfile?.llm_config.provider)?.id ??
    "";
  const duplicateAgent = useMemo(
    () =>
      agents.find((agent) => agent.id !== draft.id && agent.name.trim().toLowerCase() === draft.name.trim().toLowerCase()) ?? null,
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
  const isWorking = loading || isSaving || isReverting || toolPolicyLoading || toolPolicySaving;
  const statusToneClass = saveError
    ? "border-rose-200 bg-rose-50 text-rose-700"
    : validationErrors.length > 0
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : savedAt
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "";
  const statusMessage = saveError ?? validationErrors[0] ?? savedAt ?? null;

  function updateDraft(updater: (current: AgentProfilePayload) => AgentProfilePayload) {
    setDraft((current) => updater(current));
    setSaveError(null);
  }

  function updateAgentName(value: string) {
    updateDraft((current) => ({
      ...current,
      name: value,
      runtime_profile: current.runtime_profile
        ? {
            ...current.runtime_profile,
            name:
              current.runtime_profile.name === `${current.name} Runtime`
                ? `${value} Runtime`
                : current.runtime_profile.name,
          }
        : current.runtime_profile,
    }));
  }

  function selectAgent(agentId: string | null, availableAgents: AgentProfile[] = agents) {
    if (!agentId) {
      return;
    }
    const agent = availableAgents.find((entry) => entry.id === agentId) ?? null;
    if (!agent) {
      return;
    }
    setSelectedId(agent.id);
    setDraft(toDraft(agent));
    setSaveError(null);
    setSavedAt(null);
    setIsCreateIntent(false);
    setToolPolicySavedAt(null);
    setToolPolicyError(null);
    setIdentityEditMode(false);
  }

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
    setIdentityEditMode(true);
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
        selectAgent(target.id, nextAgents);
      } else if (nextAgents.length === 0) {
        startNewAgent(nextAgents, nextRuntimeDefaults);
      }
    } finally {
      setLoading(false);
    }
  }

  async function persistDraft(nextDraft: AgentProfilePayload = draft, successLabel = "Saved to GhostDASH") {
    if (validationErrors.length > 0) {
      setSaveError(validationErrors[0]);
      return false;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      const saved = await saveAgent(normalizeDraftForSave(nextDraft));
      const nextAgents = await fetchAgents();
      setAgents(nextAgents);
      selectAgent(saved.id, nextAgents);
      const refreshedSelected = nextAgents.find((agent) => agent.id === saved.id) ?? saved;
      setDraft(toDraft(refreshedSelected));
      await refreshToolPolicy(saved.id);
      setIsCreateIntent(false);
      if (saved.is_default) {
        await refreshRuntimeDefaults();
      }
      setSavedAt(`${successLabel} at ${new Date().toLocaleTimeString()}`);
      return true;
    } catch (error) {
      setSaveError(extractApiErrorMessage(error));
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function save() {
    await persistDraft(draft);
  }

  async function revertToDatabase() {
    if (!selectedId) {
      return;
    }
    setIsReverting(true);
    setSaveError(null);
    try {
      const [nextAgents, nextToolPolicy] = await Promise.all([fetchAgents(), fetchAgentToolPolicy(selectedId)]);
      setAgents(nextAgents);
      const persisted = nextAgents.find((agent) => agent.id === selectedId) ?? null;
      if (!persisted) {
        throw new Error("GhostDASH could not reload the saved agent from the database.");
      }
      setDraft(toDraft(persisted));
      setToolPolicy(nextToolPolicy);
      setSavedAt(`Reverted to database at ${new Date().toLocaleTimeString()}`);
      setToolPolicySavedAt(null);
      setIdentityEditMode(false);
    } catch (error) {
      setSaveError(extractApiErrorMessage(error));
    } finally {
      setIsReverting(false);
    }
  }

  async function toggleOdooAccess() {
    if (!selectedId || !toolPolicy) {
      return;
    }
    const nextAllowedToolIds = toolPolicy.allowed_tool_ids.includes(ODOO_TOOL_ID)
      ? toolPolicy.allowed_tool_ids.filter((toolId) => toolId !== ODOO_TOOL_ID)
      : [...toolPolicy.allowed_tool_ids, ODOO_TOOL_ID];
    const optimisticPolicy = { ...toolPolicy, allowed_tool_ids: nextAllowedToolIds };
    setToolPolicy(optimisticPolicy);
    setToolPolicySaving(true);
    setToolPolicyError(null);
    try {
      const savedPolicy = await saveAgentToolPolicy(selectedId, nextAllowedToolIds);
      setToolPolicy(savedPolicy);
      const nextAgents = await fetchAgents();
      setAgents(nextAgents);
      const refreshedAgent = nextAgents.find((agent) => agent.id === selectedId) ?? null;
      if (refreshedAgent) {
        setDraft(toDraft(refreshedAgent));
      }
      setToolPolicySavedAt(`Odoo access updated at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      setToolPolicy(toolPolicy);
      setToolPolicyError(extractApiErrorMessage(error));
    } finally {
      setToolPolicySaving(false);
    }
  }

  async function saveIdentityIfNeeded() {
    if (!selectedId || !identityEditMode) {
      return;
    }
    const ok = await persistDraft(draft, "Identity updated");
    if (ok) {
      setIdentityEditMode(false);
    }
  }

  function handleIdentityBlur(event: FocusEvent<HTMLDivElement>) {
    const nextFocused = event.relatedTarget as Node | null;
    if (nextFocused && identityCardRef.current?.contains(nextFocused)) {
      return;
    }
    void saveIdentityIfNeeded();
  }

  function scrollToSettingsGroup(groupId: (typeof SETTINGS_GROUPS)[number]["id"]) {
    const target = sectionRefs.current[groupId];
    const panel = settingsPanelRef.current;
    if (!target || !panel) {
      return;
    }
    panel.scrollTo({
      top: Math.max(0, target.offsetTop - 72),
      behavior: "smooth",
    });
  }

  useEffect(() => {
    void refresh().catch(() => null);
  }, []);

  useEffect(() => {
    void refreshToolPolicy(selectedId).catch(() => null);
  }, [selectedId]);

  useEffect(() => {
    const panel = settingsPanelRef.current;
    if (!panel) {
      return;
    }
    const updateActiveSection = () => {
      const scrollPosition = panel.scrollTop + 96;
      let nextActive: (typeof SETTINGS_GROUPS)[number]["id"] = SETTINGS_GROUPS[0].id;
      for (const group of SETTINGS_GROUPS) {
        const node = sectionRefs.current[group.id];
        if (node && node.offsetTop <= scrollPosition) {
          nextActive = group.id;
        }
      }
      setActiveSectionId(nextActive);
    };
    updateActiveSection();
    panel.addEventListener("scroll", updateActiveSection);
    return () => {
      panel.removeEventListener("scroll", updateActiveSection);
    };
  }, [selectedId, draft.id, toolPolicy, connections.length, collections.length]);

  return (
    <div className="agent-config-page flex flex-col gap-3 lg:h-[calc(100vh-92px)] lg:overflow-hidden">
      <section className="glass rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Agent Configuration</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-[1rem] font-semibold text-slate-900">Persona and runtime profile</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.16em] ${
                  isCreateMode ? "border border-blue-200 bg-blue-50 text-blue-700" : "border border-emerald-200 bg-emerald-50 text-emerald-700"
                }`}
              >
                {isCreateMode ? "Creating new agent" : "Editing saved agent"}
              </span>
            </div>
          </div>
          <div className="agent-command-bar flex flex-wrap items-center gap-2 xl:justify-end">
            <LoadingWheel spinning={isWorking} />
            <select
              className="ghost-select min-w-[190px] bg-white xl:w-[220px] xl:flex-none"
              value={selectedId ?? "__new__"}
              onChange={(event) => {
                const nextValue = event.target.value;
                if (nextValue === "__new__") {
                  startNewAgent();
                  return;
                }
                selectAgent(nextValue);
              }}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
              <option value="__new__">New agent draft</option>
            </select>
            <button type="button" className="ghost-btn" onClick={() => startNewAgent()}>
              New
            </button>
            <button
              type="button"
              className="ghost-btn disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void revertToDatabase()}
              disabled={!selectedId || isSaving || isReverting}
            >
              {isReverting ? "Reverting..." : "Revert"}
            </button>
            <button
              type="button"
              className="ghost-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void save()}
              disabled={isSaving || isReverting || validationErrors.length > 0}
            >
              {isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
        {statusMessage && <div className={`mt-2 rounded-xl border px-3 py-2 text-[0.74rem] ${statusToneClass}`}>{statusMessage}</div>}
      </section>

      <div className="grid min-h-0 gap-3 lg:flex-1 lg:grid-cols-[minmax(0,1.18fr)_minmax(320px,0.82fr)] xl:grid-cols-[minmax(0,1.3fr)_360px] 2xl:grid-cols-[minmax(0,1.45fr)_390px]">
        <div className="flex min-h-0 flex-col gap-3">
          <section
            ref={identityCardRef}
            onBlur={handleIdentityBlur}
            className="agent-config-editor glass flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200"
          >
            <div className="border-b border-slate-200/80 px-3 py-2">
              <div className="mb-2 h-1.5 w-20 rounded-full bg-amber-300" />
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {identityEditMode ? (
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px]">
                    <label className="block text-[0.68rem] font-medium uppercase tracking-[0.16em] text-slate-400">
                      Agent name
                      <input
                        className={`ghost-input mt-1 ${duplicateAgent ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100" : ""}`}
                        value={draft.name}
                        onChange={(event) => updateAgentName(event.target.value)}
                      />
                    </label>
                    <label className="block text-[0.68rem] font-medium uppercase tracking-[0.16em] text-slate-400">
                      Model
                      <input
                        className="ghost-input mt-1"
                        value={runtimeProfile?.llm_config.model_id ?? ""}
                        onChange={(event) =>
                          updateDraft((current) => ({
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
                    </div>
                  ) : (
                    <>
                      <div className="truncate text-[1.15rem] font-semibold leading-tight text-slate-950">{draft.name || "Untitled agent"}</div>
                      <div className="mt-0.5 text-[0.73rem] font-medium text-slate-400">{runtimeProfile?.llm_config.model_id ?? "No model selected"}</div>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="ghost-icon-btn mt-0.5 shrink-0 text-slate-500"
                  onClick={() => setIdentityEditMode((current) => !current)}
                  title="Edit agent name and model"
                >
                  <EditGlyph />
                </button>
              </div>
            </div>
            <div className="agent-config-primary-scroll ghost-settings-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <div className="grid gap-2.5">
              <label className="block text-[0.74rem] font-medium text-slate-600">
                First message
                <textarea
                  className="ghost-textarea mt-1 min-h-[72px] bg-white"
                  value={draft.first_message}
                  onChange={(event) => updateDraft((current) => ({ ...current, first_message: event.target.value }))}
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                System prompt
                <textarea
                  className="ghost-textarea mt-1 min-h-[320px] bg-white lg:min-h-[360px]"
                  value={runtimeProfile?.guardrails_config.system_prompt ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
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
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Insufficient context behavior
                <textarea
                  className="ghost-textarea mt-1 min-h-[96px] bg-white"
                  value={runtimeProfile?.guardrails_config.insufficient_context_behavior ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
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
              </div>
            </div>
          </section>
        </div>

        <aside className="agent-settings-rail glass relative min-h-0 overflow-hidden rounded-xl border border-slate-200">
          <div ref={settingsPanelRef} className="ghost-settings-scroll h-full overflow-y-auto px-2 py-2">
            <div className="agent-settings-nav sticky top-0 z-10 mb-2 flex flex-wrap gap-1.5 border-b border-slate-200/80 bg-[rgba(244,245,247,0.92)] px-1 pb-2 pt-1 backdrop-blur">
              {SETTINGS_GROUPS.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className="agent-settings-nav-btn"
                  data-active={activeSectionId === group.id}
                  onClick={() => scrollToSettingsGroup(group.id)}
                >
                  {group.label}
                </button>
              ))}
            </div>
            <div className="space-y-1.5">
              <section
                ref={(node) => {
                  sectionRefs.current.connection = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Connection</div>
                <label className="block text-[0.68rem] text-slate-500">
                  Provider connection
                  <select
                    className="ghost-select mt-1"
                    value={selectedConnectionId}
                    onChange={(event) =>
                      updateDraft((current) => ({
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
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.generation = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Generation</div>
                <div className="grid gap-1.5">
                  <label className="block text-[0.68rem] text-slate-500">
                    Temperature
                    <input
                      className="ghost-input mt-1"
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={runtimeProfile?.llm_config.temperature ?? 0}
                      onChange={(event) =>
                        updateDraft((current) => ({
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
                  <label className="block text-[0.68rem] text-slate-500">
                    Max tokens
                    <input
                      className="ghost-input mt-1"
                      type="number"
                      min="1"
                      value={runtimeProfile?.llm_config.max_tokens ?? 1}
                      onChange={(event) =>
                        updateDraft((current) => ({
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
                  <label className="block text-[0.68rem] text-slate-500">
                    Chat API mode (OpenAI)
                    <select
                      className="ghost-select mt-1"
                      value={runtimeProfile?.llm_config.api_mode ?? "responses"}
                      onChange={(event) =>
                        updateDraft((current) => ({
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
                  </label>
                </div>
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.voice = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Voice & status</div>
                <div className="grid gap-1.5">
                  <label className="block text-[0.68rem] text-slate-500">
                    Language
                    <input className="ghost-input mt-1" value={draft.language} onChange={(event) => updateDraft((current) => ({ ...current, language: event.target.value }))} />
                  </label>
                  <label className="block text-[0.68rem] text-slate-500">
                    Voice ID
                    <input className="ghost-input mt-1" value={draft.voice_id} onChange={(event) => updateDraft((current) => ({ ...current, voice_id: event.target.value }))} />
                  </label>
                  <label className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[0.68rem] text-slate-600">
                    <input type="checkbox" checked={draft.enabled} onChange={() => updateDraft((current) => ({ ...current, enabled: !current.enabled }))} />
                    Agent enabled
                  </label>
                  <label className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[0.68rem] text-slate-600">
                    <input
                      type="checkbox"
                      checked={draft.is_default}
                      onChange={() =>
                        updateDraft((current) => ({
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
                </div>
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.runtime = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.68rem] text-slate-500"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Runtime summary</div>
                <div className="space-y-0.5">
                  <div><span className="font-semibold text-slate-900">Profile:</span> {runtimeProfile?.name ?? "Unsaved runtime profile"}</div>
                  <div><span className="font-semibold text-slate-900">Provider:</span> {runtimeProfile?.llm_config.provider ?? "openai"}</div>
                  <div><span className="font-semibold text-slate-900">KB defaults:</span> {(runtimeProfile?.kb_config.default_corpora ?? []).join(", ") || "default"}</div>
                  <div><span className="font-semibold text-slate-900">Embedding model:</span> {runtimeProfile?.kb_config.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL}</div>
                  {selectedAgent && <div><span className="font-semibold text-slate-900">Agent id:</span> {selectedAgent.id}</div>}
                </div>
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.collections = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Collections</div>
                <div className="space-y-1">
                  {collections.map((collection) => {
                    const selected = (runtimeProfile?.kb_config.default_corpora ?? []).includes(collection.slug);
                    return (
                      <label key={collection.id} className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[0.66rem] text-slate-600">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() =>
                            updateDraft((current) => {
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
              {collections.length === 0 && <div className="text-[0.66rem] text-slate-500">No managed collections exist yet. Create them in Data Sources first.</div>}
                </div>
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.tools = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Tools</div>
                <div className="space-y-1">
                  {(runtimeProfile?.tool_policy_config.tools ?? [])
                    .filter((tool) => tool.id !== ODOO_TOOL_ID)
                    .map((tool) => (
                      <div key={tool.id} className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[0.66rem] text-slate-600">
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={tool.enabled}
                            onChange={() =>
                              updateDraft((current) => ({
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
                          <div className="mt-1.5 grid gap-1.5">
                            {[0, 1].map((idx) => (
                              <input
                                key={idx}
                                className="ghost-input"
                                placeholder={idx === 0 ? "https://example.com" : "Optional second website"}
                                value={tool.allowed_urls?.[idx] ?? ""}
                                onChange={(event) =>
                                  updateDraft((current) => ({
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
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.odoo = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.66rem] text-slate-600"
              >
                <div className="mb-1 flex items-start justify-between gap-3">
                  <div className="text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Odoo</div>
                  {odooCatalogEntry && (
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold ${
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
                <div className="space-y-1.5">
                  <label className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-1.5 py-1">
                    <input
                      type="checkbox"
                      checked={odooEnabled}
                      disabled={!selectedId || toolPolicyLoading}
                      onChange={() => void toggleOdooAccess()}
                    />
                    <span>
                      <span className="block font-semibold text-slate-900">Allow Odoo for this agent</span>
                      <span>Runtime still requires a healthy configured gateway.</span>
                    </span>
                  </label>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    <div className="rounded-md border border-slate-200 bg-white px-1.5 py-1">
                      Global state: {odooCatalogEntry ? `${odooCatalogEntry.active ? "active" : "inactive"} / ${odooCatalogEntry.status}` : "Loading..."}
                    </div>
                    <div className="rounded-md border border-slate-200 bg-white px-1.5 py-1">
                      Config readiness: {odooCatalogEntry?.configured ? "complete" : "incomplete"}
                    </div>
                  </div>
                  {toolPolicyError && <div className="rounded-md border border-rose-200 bg-rose-50 px-1.5 py-1 text-rose-700">{toolPolicyError}</div>}
                  {!selectedId && <div className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-1 text-amber-700">Save the agent first before attaching Odoo access.</div>}
                  <div className="text-[0.68rem] text-slate-400">
                    {toolPolicySaving
                      ? "Updating Odoo access..."
                      : toolPolicySavedAt
                        ? toolPolicySavedAt
                        : "Odoo access updates immediately when toggled."}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
