import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { fetchAgents, saveAgent } from "../api";
import type { AgentProfile, AgentProfilePayload, AgentToolConfig, RuntimeProfile } from "../api";
import type { AppOutletContext } from "../components/AppLayout";

const DEFAULT_TOOLS: AgentToolConfig[] = [
  { id: "kb", name: "Knowledge Base", description: "Query indexed documents.", enabled: true, allowed_urls: [] },
  {
    id: "web",
    name: "Approved Web Sources",
    description: "Fetch only the explicitly allowed websites stored on this agent.",
    enabled: false,
    allowed_urls: [],
  },
];

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
      provider: "openai",
      model_id: "openai/gpt-5.4",
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
      embedding_model_id: "openai/text-embedding-3-small",
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

function createDraft(template?: AgentProfile | null): AgentProfilePayload {
  const name = template?.name ?? "GhostDASH Assistant";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentProfilePayload>(() => createDraft());
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedId) ?? null, [agents, selectedId]);
  const runtimeProfile = draft.runtime_profile;

  async function refresh() {
    const nextAgents = await fetchAgents();
    setAgents(nextAgents);
    const target = selectedId ? nextAgents.find((agent) => agent.id === selectedId) : nextAgents[0];
    if (target) {
      setSelectedId(target.id);
      setDraft(toDraft(target));
    }
  }

  useEffect(() => {
    void refresh().catch(() => null);
  }, []);

  async function save() {
    const saved = await saveAgent(draft);
    const nextAgents = await fetchAgents();
    setAgents(nextAgents);
    setSelectedId(saved.id);
    setDraft(toDraft(saved));
    if (saved.is_default) {
      await refreshRuntimeDefaults();
    }
    setSavedAt(new Date().toLocaleTimeString());
  }

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Agent Configuration</p>
            <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Persona and runtime profile</h2>
            <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
              Each agent now points at one canonical runtime profile. Model, guardrails, and tool policy live there; pipeline and retrieval defaults are edited in the Pipelines view.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setSelectedId(null);
                setDraft(createDraft(selectedAgent ?? agents.find((agent) => agent.is_default) ?? agents[0] ?? null));
              }}
            >
              New agent
            </button>
            <button type="button" className="ghost-btn-primary" onClick={() => void save()}>
              Save changes
            </button>
          </div>
        </div>
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
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="truncate text-[0.82rem] font-semibold text-slate-900">{agent.name}</div>
                  {agent.is_default && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[0.64rem] font-semibold text-emerald-700">Default</span>}
                </div>
                <div className="mt-1 truncate text-[0.72rem] text-slate-500">{agent.runtime_profile.llm_config.model_id}</div>
              </button>
            ))}
            {agents.length === 0 && <div className="text-[0.78rem] text-slate-500">No agents have been saved yet.</div>}
          </div>
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <label className="block text-[0.76rem] text-slate-500">
            Agent name
            <input
              className="ghost-input mt-1"
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
            <div className="mt-1">KB defaults: {(runtimeProfile?.kb_config.default_corpora ?? []).join(", ") || "default"}</div>
            <div className="mt-1">Embedding model: {runtimeProfile?.kb_config.embedding_model_id ?? "openai/text-embedding-3-small"}</div>
            <div className="mt-1">Pipeline retrieval defaults live in the Pipelines page to avoid duplicate edit surfaces.</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.76rem] text-slate-500">
            <div className="font-semibold text-slate-900">Enabled tools</div>
            <div className="mt-2 space-y-2">
              {(runtimeProfile?.tool_policy_config.tools ?? []).map((tool) => (
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
        </article>
      </div>
    </div>
  );
}
