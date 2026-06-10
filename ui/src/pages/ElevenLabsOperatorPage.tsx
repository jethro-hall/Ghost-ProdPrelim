import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import HubTigerBookingFlowRunner from "../components/HubTigerBookingFlowRunner";
import {
  fetchAgents,
  fetchElevenLabsOperatorHealth,
  fetchElevenLabsRepoTool,
  fetchElevenLabsRepoTools,
  fetchElevenLabsSyncPreview,
  runElevenLabsToolSync,
  type ElevenLabsSyncPreviewResponse,
  fetchElevenLabsWorkbenchAgent,
  fetchElevenLabsWorkbenchTools,
  fetchHubTigerStatus,
  saveAgent,
  type AgentProfile,
  type ElevenLabsRepoTool,
} from "../api";
import { BOOKING_WORKFLOW_STEPS, TWO_TOOL_BOOKING_STEPS } from "../lib/bookingWorkflowSimulation";

type Tab = "overview" | "tools" | "booking" | "prompts";

export default function ElevenLabsOperatorPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [health, setHealth] = useState<Awaited<ReturnType<typeof fetchElevenLabsOperatorHealth>> | null>(null);
  const [hubtigerStatus, setHubtigerStatus] = useState<string>("");
  const [repoTools, setRepoTools] = useState<ElevenLabsRepoTool[]>([]);
  const [remoteToolCount, setRemoteToolCount] = useState<number | null>(null);
  const [selectedTool, setSelectedTool] = useState("");
  const [toolJson, setToolJson] = useState("");
  const [bookingMode, setBookingMode] = useState<"two-tool" | "staged">("two-tool");
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptMsg, setPromptMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem("ghostdash:operator-admin-key") ?? "");
  const [syncPreview, setSyncPreview] = useState<ElevenLabsSyncPreviewResponse | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [attachAgent, setAttachAgent] = useState(false);
  const [confirmAttach, setConfirmAttach] = useState(false);
  const [attachAgentId, setAttachAgentId] = useState("");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [h, tools, ht, agentList] = await Promise.all([
        fetchElevenLabsOperatorHealth(),
        fetchElevenLabsRepoTools(),
        fetchHubTigerStatus(),
        fetchAgents(),
      ]);
      setHealth(h);
      setRepoTools(tools.tools);
      setHubtigerStatus(ht.status.message);
      const mike =
        agentList.find((a) => /magic\s*mike/i.test(a.name)) ??
        agentList.find((a) => /mike/i.test(a.name)) ??
        agentList[0] ??
        null;
      setAgents(agentList);
      setAgent(mike);
      if (mike && !promptDraft) {
        setPromptDraft(String(mike.runtime_profile?.guardrails_config?.system_prompt ?? ""));
      }
      if (h.capabilities.elevenlabs_remote_tool_list) {
        try {
          const remote = await fetchElevenLabsWorkbenchTools({ page_size: 50 });
          setRemoteToolCount(remote.count);
        } catch {
          setRemoteToolCount(null);
        }
      }
    } catch {
      setError("Voice Operator Console could not load. Check control-api and mounts.");
    }
  }, [promptDraft]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedTool) return;
    void fetchElevenLabsRepoTool(selectedTool)
      .then((r) => setToolJson(JSON.stringify(r.tool, null, 2)))
      .catch(() => setToolJson(""));
  }, [selectedTool]);

  async function savePromptToAgent() {
    if (!agent) return;
    setPromptBusy(true);
    setPromptMsg(null);
    try {
      const profile = agent.runtime_profile;
      await saveAgent({
        id: agent.id,
        name: agent.name,
        first_message: agent.first_message,
        language: agent.language,
        voice_id: agent.voice_id,
        runtime_profile_id: agent.runtime_profile_id,
        runtime_profile: {
          ...profile,
          guardrails_config: {
            ...profile.guardrails_config,
            system_prompt: promptDraft.trim(),
          },
        },
        agent_role: agent.agent_role,
        parent_agent_id: agent.parent_agent_id,
        position: agent.position,
        is_default: agent.is_default,
        enabled: agent.enabled,
      });
      setPromptMsg("Saved to Magic Mike runtime profile in GhostDASH.");
    } catch {
      setPromptMsg("Could not save prompt.");
    } finally {
      setPromptBusy(false);
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "tools", label: "Tool catalog" },
    { id: "booking", label: "Booking lab" },
    { id: "prompts", label: "Prompts" },
  ];

  return (
    <div className="space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-4">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Voice operations</p>
        <h2 className="mt-1 text-[1rem] font-semibold text-slate-900">Voice Operator Console</h2>
        <p className="mt-2 text-[0.82rem] text-slate-600">
          Run HubTiger booking, test tools, edit Magic Mike prompts, and open the simulator — without logging into ElevenLabs
          for day-to-day ops. ElevenLabs is only needed for production ConvAI wiring (phone numbers) or optional API sync.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1.5 text-[0.76rem] font-semibold ${
                tab === t.id ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
          <button type="button" className="glass-button rounded-md px-3 py-1.5 text-[0.76rem]" onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            type="button"
            className="glass-button-primary rounded-md px-3 py-1.5 text-[0.76rem] font-semibold"
            onClick={() => window.dispatchEvent(new CustomEvent("ghostdash:open-simulation"))}
          >
            Open simulator
          </button>
        </div>
      </section>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[0.78rem] text-rose-700">{error}</div>}

      {tab === "overview" && (
        <section className="glass rounded-xl border border-slate-200 px-4 py-4">
          <h3 className="text-[0.95rem] font-semibold text-slate-900">Capability status</h3>
          <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {health &&
              Object.entries(health.capabilities).map(([key, ok]) => (
                <div key={key} className="rounded-lg border border-slate-200 bg-white/90 px-3 py-2 text-[0.74rem]">
                  <span className={ok ? "text-emerald-700" : "text-amber-700"}>{ok ? "✓" : "○"}</span>{" "}
                  {key.replace(/_/g, " ")}
                </div>
              ))}
          </div>
          <ul className="mt-4 space-y-1 text-[0.78rem] text-slate-600">
            <li>
              Repo tools on disk: <strong>{health?.repo_tool_count ?? 0}</strong>
            </li>
            <li>HubTiger: {hubtigerStatus}</li>
            <li>
              ElevenLabs API: {health?.elevenlabs_api_configured ? "configured" : "not set (simulations disabled)"}
            </li>
            <li>
              Remote EL tools: {remoteToolCount ?? "n/a"}
            </li>
            <li>
              ConvAI agent id: <code className="text-[0.68rem]">{health?.elevenlabs_convai_agent_id ?? "—"}</code>
            </li>
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/analysis/test-workbench" className="glass-button rounded-md px-3 py-2 text-[0.78rem]">
              Test workbench
            </Link>
            <Link to="/agent" className="glass-button rounded-md px-3 py-2 text-[0.78rem]">
              Agent config
            </Link>
            <Link to="/tools" className="glass-button rounded-md px-3 py-2 text-[0.78rem]">
              HubTiger tools
            </Link>
          </div>
          <p className="mt-3 text-[0.72rem] text-slate-500">
            Parity matrix: <code>docs/GHOSTDASH_ELEVENLABS_OPERATOR_PARITY.md</code> · Two-tool map:{" "}
            <code>docs/HUBTIGER_BOOKING_TWO_TOOL_ELEVENLABS_MAP.md</code>
          </p>
        </section>
      )}

      {tab === "tools" && (
        <section className="glass grid gap-4 rounded-xl border border-slate-200 p-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div>
            <p className="text-[0.64rem] font-bold uppercase tracking-[0.18em] text-slate-400">Repo tool JSON</p>
            <div className="mt-2 max-h-[420px] space-y-1 overflow-y-auto">
              {repoTools.map((tool) => (
                <button
                  key={tool.file_name}
                  type="button"
                  onClick={() => setSelectedTool(tool.file_name)}
                  className={`w-full rounded-md border px-2 py-2 text-left text-[0.72rem] ${
                    selectedTool === tool.file_name ? "border-orange-400 bg-orange-50" : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="font-semibold text-slate-900">{tool.tool_name}</div>
                  <div className="text-slate-500">{tool.api_function ?? "—"}</div>
                  {tool.recommended_flow === "two_tool_step_1" && (
                    <span className="text-[0.65rem] text-orange-700">Two-tool step 1</span>
                  )}
                  {tool.recommended_flow === "two_tool_step_2" && (
                    <span className="text-[0.65rem] text-orange-700">Two-tool step 2</span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[0.64rem] font-bold uppercase tracking-[0.18em] text-slate-400">Import JSON (for EL production agent)</p>
            <p className="mt-1 text-[0.72rem] text-slate-600">
              GhostDASH runs tools via <code>/api/elevenlabs/hubtiger/tool</code>. Copy this JSON only when syncing the production
              ConvAI agent in ElevenLabs.
            </p>
            <pre className="ghost-scroll mt-2 max-h-[480px] overflow-auto rounded-md border border-slate-200 bg-slate-950 p-3 text-[0.68rem] text-slate-100">
              {toolJson || "Select a tool from the list."}
            </pre>
            {selectedTool && (
              <button
                type="button"
                className="glass-button mt-2 rounded-md px-3 py-1.5 text-[0.72rem]"
                onClick={() => {
                  if (toolJson) void navigator.clipboard.writeText(toolJson);
                }}
              >
                Copy JSON
              </button>
            )}
          </div>
          <div className="mt-4 rounded-lg border border-slate-200 bg-white/90 p-3 lg:col-span-2">
            <p className="text-[0.64rem] font-bold uppercase tracking-[0.18em] text-slate-400">ElevenLabs sync (admin)</p>
            <p className="mt-1 text-[0.72rem] text-slate-600">
              Voice Ops utility only — pushes the nine-tool booking allowlist to ElevenLabs. GhostDASH remains the execution boundary.
            </p>
            <label className="mt-2 block text-[0.72rem] font-semibold text-slate-700">
              Operator admin key
              <input
                type="password"
                value={adminKey}
                onChange={(e) => {
                  setAdminKey(e.target.value);
                  sessionStorage.setItem("ghostdash:operator-admin-key", e.target.value);
                }}
                className="glass-input mt-1 w-full max-w-md rounded-md px-2 py-1.5"
                placeholder="X-Operator-Admin-Key"
              />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="glass-button rounded-md px-3 py-1.5 text-[0.72rem]"
                disabled={syncBusy || !adminKey.trim()}
                onClick={() => {
                  setSyncBusy(true);
                  setSyncMsg(null);
                  void fetchElevenLabsSyncPreview(adminKey.trim())
                    .then((p) => {
                      setSyncPreview(p);
                      setSyncMsg(`Preview: ${p.tool_count} tools (${p.tools.filter((t) => t.action === "update").length} updates).`);
                    })
                    .catch(() => setSyncMsg("Preview failed — check admin key and ElevenLabs API config."))
                    .finally(() => setSyncBusy(false));
                }}
              >
                Preview sync
              </button>
              <button
                type="button"
                className="glass-button rounded-md px-3 py-1.5 text-[0.72rem]"
                disabled={syncBusy || !adminKey.trim()}
                onClick={() => {
                  setSyncBusy(true);
                  setSyncMsg(null);
                  void runElevenLabsToolSync(adminKey.trim(), { dry_run: true })
                    .then((r) => setSyncMsg(`Dry-run complete: ${String(r.tool_count ?? 0)} tools.`))
                    .catch(() => setSyncMsg("Dry-run failed."))
                    .finally(() => setSyncBusy(false));
                }}
              >
                Dry-run sync
              </button>
              <button
                type="button"
                className="glass-button-primary rounded-md px-3 py-1.5 text-[0.72rem] font-semibold"
                disabled={syncBusy || !adminKey.trim()}
                onClick={() => {
                  if (!window.confirm("Push nine booking tools to ElevenLabs workspace?")) return;
                  setSyncBusy(true);
                  setSyncMsg(null);
                  void runElevenLabsToolSync(adminKey.trim(), {
                    dry_run: false,
                    attach_to_agent: attachAgent,
                    agent_id: attachAgentId.trim() || null,
                    confirm_agent_attachment: confirmAttach,
                  })
                    .then((r) => setSyncMsg(`Live sync finished: ${String(r.tool_count ?? 0)} tools processed.`))
                    .catch(() => setSyncMsg("Live sync failed."))
                    .finally(() => setSyncBusy(false));
                }}
              >
                Live sync
              </button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[0.72rem] text-slate-700">
              <input type="checkbox" checked={attachAgent} onChange={(e) => setAttachAgent(e.target.checked)} />
              Attach synced tools to agent
            </label>
            {attachAgent && (
              <div className="mt-2 space-y-2">
                <input
                  value={attachAgentId}
                  onChange={(e) => setAttachAgentId(e.target.value)}
                  placeholder="agent_id (required for attach)"
                  className="glass-input w-full max-w-md rounded-md px-2 py-1.5 text-[0.72rem]"
                />
                <label className="flex items-center gap-2 text-[0.72rem] text-rose-700">
                  <input type="checkbox" checked={confirmAttach} onChange={(e) => setConfirmAttach(e.target.checked)} />
                  I confirm agent attachment (confirm_agent_attachment)
                </label>
              </div>
            )}
            {syncMsg && <p className="mt-2 text-[0.72rem] text-slate-600">{syncMsg}</p>}
            {syncPreview && (
              <div className="ghost-scroll mt-2 max-h-48 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2 text-[0.68rem]">
                {syncPreview.tools.map((t) => (
                  <div key={t.file_name} className="border-b border-slate-200 py-1 last:border-0">
                    <strong>{t.tool_name}</strong> — {t.action}
                    {t.remote_tool_id ? ` (${t.remote_tool_id})` : ""}
                  </div>
                ))}
              </div>
            )}
          </div>

        </section>
      )}

      {tab === "booking" && (
        <section className="glass rounded-xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.74rem] font-semibold text-slate-700">Flow</span>
            <button
              type="button"
              onClick={() => setBookingMode("two-tool")}
              className={`rounded-md px-3 py-1 text-[0.72rem] font-semibold ${
                bookingMode === "two-tool" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              Two-tool (availability + create)
            </button>
            <button
              type="button"
              onClick={() => setBookingMode("staged")}
              className={`rounded-md px-3 py-1 text-[0.72rem] font-semibold ${
                bookingMode === "staged" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              Staged (8 steps)
            </button>
          </div>
          <p className="mt-2 text-[0.72rem] text-slate-500">
            Live HubTiger calls through GhostDASH — same backend as production webhooks. No ElevenLabs login required.
          </p>
          <div className="mt-4">
            <HubTigerBookingFlowRunner steps={bookingMode === "two-tool" ? TWO_TOOL_BOOKING_STEPS : BOOKING_WORKFLOW_STEPS} />
          </div>
        </section>
      )}

      {tab === "prompts" && (
        <section className="glass rounded-xl border border-slate-200 p-4">
          <label className="block text-[0.74rem] font-semibold text-slate-700">
            Agent
            <select
              value={agent?.id ?? ""}
              onChange={(e) => {
                const next = agents.find((a) => a.id === e.target.value) ?? null;
                setAgent(next);
                setPromptDraft(String(next?.runtime_profile?.guardrails_config?.system_prompt ?? ""));
              }}
              className="glass-input mt-1 w-full max-w-md rounded-md px-2 py-1.5"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <textarea
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            rows={16}
            className="glass-input mt-3 w-full rounded-md px-2 py-2 font-mono text-[0.7rem] leading-relaxed"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={promptBusy || !agent}
              onClick={() => void savePromptToAgent()}
              className="glass-button-primary rounded-md px-4 py-2 text-[0.78rem] font-semibold disabled:opacity-50"
            >
              {promptBusy ? "Saving…" : "Save to Agent Config (Postgres)"}
            </button>
            {health?.elevenlabs_convai_agent_id && agent && (
              <button
                type="button"
                className="glass-button rounded-md px-3 py-2 text-[0.78rem]"
                onClick={() =>
                  void fetchElevenLabsWorkbenchAgent(health.elevenlabs_convai_agent_id!).then((r) => {
                    setPromptMsg(`ElevenLabs prompt excerpt (${r.agent_llm}): ${r.agent_prompt_excerpt.slice(0, 120)}…`);
                  })
                }
              >
                Peek ElevenLabs ConvAI prompt
              </button>
            )}
          </div>
          {promptMsg && <p className="mt-2 text-[0.72rem] text-slate-600">{promptMsg}</p>}
          <p className="mt-3 text-[0.72rem] text-slate-500">
            Simulator panel can override prompt per chat session without saving. Saving here updates the canonical runtime profile
            used by GhostDASH chat and ingress.
          </p>
        </section>
      )}
    </div>
  );
}
