import { useEffect, useMemo, useState } from "react";
import { fetchAgents, saveAgent } from "../api";
import type { AgentProfile, AgentProfilePayload, AgentToolConfig } from "../api";

const DEFAULT_TOOLS: AgentToolConfig[] = [
  { id: "kb", name: "Knowledge Base", description: "Query indexed documents.", enabled: true },
  { id: "web", name: "Web Search", description: "Search for external context.", enabled: false },
];

function createDraft(): AgentProfilePayload {
  return {
    name: "GhostDASH Assistant",
    system_prompt:
      "You answer using retrieved knowledge only. Always ground the answer in the provided context and say when the context is insufficient.",
    first_message: "Hello! I am your GhostDASH assistant. How can I help you today?",
    model_id: "openai/gpt-5.4",
    temperature: 0.2,
    max_tokens: 2000,
    language: "en-US",
    voice_id: "alloy",
    tools: DEFAULT_TOOLS,
    is_default: false,
    enabled: true,
  };
}

function toDraft(agent: AgentProfile): AgentProfilePayload {
  return {
    id: agent.id,
    name: agent.name,
    system_prompt: agent.system_prompt,
    first_message: agent.first_message,
    model_id: agent.model_id,
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    language: agent.language,
    voice_id: agent.voice_id,
    tools: agent.tools,
    is_default: agent.is_default,
    enabled: agent.enabled,
  };
}

export default function AgentConfigPage() {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentProfilePayload>(() => createDraft());
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedId) ?? null, [agents, selectedId]);

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
    setSavedAt(new Date().toLocaleTimeString());
  }

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Agent Configuration</p>
            <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Persona, tools, and defaults</h2>
            <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
              Agent profiles are now persisted in the native stack so GhostChat can remember conversations per agent instead of resetting to a browser-only draft.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setSelectedId(null);
                setDraft(createDraft());
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
                <div className="mt-1 truncate text-[0.72rem] text-slate-500">{agent.model_id}</div>
              </button>
            ))}
            {agents.length === 0 && <div className="text-[0.78rem] text-slate-500">No agents have been saved yet.</div>}
          </div>
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <label className="block text-[0.76rem] text-slate-500">
            Agent name
            <input className="ghost-input mt-1" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            System prompt
            <textarea className="ghost-textarea mt-1 min-h-[150px]" value={draft.system_prompt} onChange={(event) => setDraft((current) => ({ ...current, system_prompt: event.target.value }))} />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            First message
            <textarea className="ghost-textarea mt-1 min-h-[90px]" value={draft.first_message} onChange={(event) => setDraft((current) => ({ ...current, first_message: event.target.value }))} />
          </label>
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <label className="block text-[0.76rem] text-slate-500">
            Model
            <input className="ghost-input mt-1" value={draft.model_id} onChange={(event) => setDraft((current) => ({ ...current, model_id: event.target.value }))} />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Temperature
            <input className="ghost-input mt-1" type="number" step="0.1" min="0" max="2" value={draft.temperature} onChange={(event) => setDraft((current) => ({ ...current, temperature: Number(event.target.value) }))} />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Max tokens
            <input className="ghost-input mt-1" type="number" min="1" value={draft.max_tokens} onChange={(event) => setDraft((current) => ({ ...current, max_tokens: Number(event.target.value) }))} />
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
              onChange={() => setDraft((current) => ({ ...current, is_default: !current.is_default }))}
            />
            Set as default agent
          </label>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.76rem] text-slate-500">
            <div className="font-semibold text-slate-900">Enabled tools</div>
            <div className="mt-2 space-y-2">
              {draft.tools.map((tool) => (
                <label key={tool.id} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={tool.enabled}
                    onChange={() =>
                      setDraft((current) => ({
                        ...current,
                        tools: current.tools.map((entry) =>
                          entry.id === tool.id ? { ...entry, enabled: !entry.enabled } : entry,
                        ),
                      }))
                    }
                  />
                  <span>
                    <span className="block font-semibold text-slate-900">{tool.name}</span>
                    <span>{tool.description}</span>
                  </span>
                </label>
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
