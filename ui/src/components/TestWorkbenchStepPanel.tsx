import { useMemo, useState } from "react";

import type { ElevenLabsSimulationRunResponse, ElevenLabsWorkbenchTurn, ElevenLabsTestTab } from "../api";

export type WorkbenchChatTurn = ElevenLabsWorkbenchTurn;

type Props = {
  activeTab: ElevenLabsTestTab;
  title: string;
  busy: boolean;
  history: WorkbenchChatTurn[];
  onHistoryChange: (next: WorkbenchChatTurn[]) => void;
  stopIndex: number | null;
  onStopIndexChange: (index: number | null) => void;
  running: boolean;
  liveTurnIndex: number | null;
  voiceEnabled: boolean;
  onVoiceEnabledChange: (enabled: boolean) => void;
  runResult: ElevenLabsSimulationRunResponse | null;
  exportJson: Record<string, unknown>;
  simulatedUserPrompt: string;
  onSimulatedUserPromptChange: (value: string) => void;
  agentPromptOverride: string;
  onAgentPromptOverrideChange: (value: string) => void;
  onStep: (mode: "agent" | "user" | "both") => void;
  onRunFull?: () => void;
  showFullRun?: boolean;
};

function toolNames(turn: WorkbenchChatTurn): string[] {
  const names: string[] = [];
  for (const call of turn.tool_calls ?? []) {
    const name = String(call.tool_name || "").trim();
    if (name) names.push(name);
  }
  return names;
}

export default function TestWorkbenchStepPanel({
  activeTab,
  title,
  busy,
  history,
  onHistoryChange,
  stopIndex,
  onStopIndexChange,
  running,
  liveTurnIndex,
  voiceEnabled,
  onVoiceEnabledChange,
  runResult,
  exportJson,
  simulatedUserPrompt,
  onSimulatedUserPromptChange,
  agentPromptOverride,
  onAgentPromptOverrideChange,
  onStep,
  onRunFull,
  showFullRun = false,
}: Props) {
  const [jsonOpen, setJsonOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const jsonText = useMemo(() => JSON.stringify(exportJson, null, 2), [exportJson]);

  const effectiveStop = stopIndex ?? (history.length > 0 ? history.length - 1 : 0);
  const frozenCount = stopIndex === null ? history.length : stopIndex + 1;

  function updateTurn(index: number, patch: Partial<WorkbenchChatTurn>) {
    onHistoryChange(history.map((turn, idx) => (idx === index ? { ...turn, ...patch } : turn)));
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(jsonText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setJsonOpen(true);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[0.64rem] font-bold uppercase tracking-[0.2em] text-slate-400">Step debugger</p>
          <h3 className="text-[0.9rem] font-semibold text-slate-900">{title}</h3>
        </div>
        <button type="button" className="glass-button rounded-md px-3 py-1.5 text-[0.74rem]" onClick={() => void copyJson()}>
          {copied ? "Copied" : "Edit as JSON"}
        </button>
      </div>

      <div className="mb-3 grid gap-2 rounded-md border border-slate-100 bg-slate-50 p-3 md:grid-cols-2">
        <label className="block text-[0.72rem] font-semibold text-slate-700">
          Simulated user prompt override
          <textarea
            value={simulatedUserPrompt}
            onChange={(event) => onSimulatedUserPromptChange(event.target.value)}
            rows={3}
            placeholder="Override the simulated customer LLM instructions for the next step."
            className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.78rem]"
          />
        </label>
        <label className="block text-[0.72rem] font-semibold text-slate-700">
          Agent prompt override
          <textarea
            value={agentPromptOverride}
            onChange={(event) => onAgentPromptOverrideChange(event.target.value)}
            rows={3}
            placeholder="Force or refine the agent system prompt for workflow tuning."
            className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.78rem]"
          />
        </label>
      </div>

      <p className="mb-2 text-[0.72rem] text-slate-500">
        Click <span className="font-semibold">Stop here</span> on a turn (for example the user line with name and phone), edit the
        message, then step the agent to see latency, tools, and the next reply.
      </p>

      <div className="max-h-[48vh] space-y-2 overflow-y-auto pr-1">
        {busy && <p className="text-[0.76rem] text-slate-500">Loading conversation...</p>}
        {!busy &&
          history.map((turn, index) => {
            const isStop = stopIndex === index;
            const isFrozen = index <= effectiveStop && stopIndex !== null;
            const isPastStop = stopIndex !== null && index > stopIndex;
            const isLive = running && (liveTurnIndex === index || (liveTurnIndex === null && isStop));
            const isSpeaking = !running && liveTurnIndex === index;
            const tools = toolNames(turn);
            return (
              <div
                key={`${turn.role}-${index}`}
                className={`rounded-lg border px-3 py-2 transition-colors ${
                  isSpeaking
                    ? "border-emerald-400 bg-emerald-50 ring-2 ring-emerald-200"
                    : isLive
                      ? "border-sky-400 bg-sky-50 ring-2 ring-sky-200 animate-pulse"
                      : isStop
                        ? "border-ghost-orange bg-ghost-orange/5"
                        : isFrozen
                          ? "border-slate-200 bg-white"
                          : "border-transparent opacity-60"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[0.62rem] font-semibold uppercase tracking-wide text-slate-500">
                    {turn.role}
                    {typeof turn.time_in_call_secs === "number" ? ` · ${turn.time_in_call_secs}s` : ""}
                    {typeof turn.latency_ms === "number" ? ` · ${turn.latency_ms} ms` : ""}
                  </p>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      aria-label={`Stop here at turn ${index + 1}`}
                      className={`rounded px-2 py-0.5 text-[0.68rem] font-semibold ${
                        isStop ? "bg-ghost-orange text-white" : "bg-slate-100 text-slate-600"
                      }`}
                      onClick={() => onStopIndexChange(index)}
                    >
                      {isStop ? "Stop line" : "Stop here"}
                    </button>
                    {isPastStop && (
                      <button
                        type="button"
                        className="rounded bg-slate-100 px-2 py-0.5 text-[0.68rem] text-slate-600"
                        onClick={() => onHistoryChange(history.slice(0, index + 1))}
                      >
                        Truncate after
                      </button>
                    )}
                  </div>
                </div>
                {isStop || (stopIndex === null && index === history.length - 1) ? (
                  <textarea
                    value={turn.message}
                    onChange={(event) => updateTurn(index, { message: event.target.value })}
                    rows={Math.min(6, Math.max(2, Math.ceil(turn.message.length / 72)))}
                    className="glass-input mt-2 w-full rounded-md px-2 py-1.5 text-[0.78rem]"
                  />
                ) : (
                  <p className="mt-1 whitespace-pre-wrap text-[0.78rem] text-slate-800">{turn.message || <em className="text-slate-400">(tool-only turn)</em>}</p>
                )}
                {tools.length > 0 && (
                  <p className="mt-1 text-[0.7rem] text-slate-600">
                    <span className="font-semibold">Tools:</span> {tools.join(", ")}
                  </p>
                )}
                {(turn.tool_results?.length ?? 0) > 0 && (
                  <p className="mt-1 text-[0.68rem] text-slate-500">
                    {turn.tool_results?.length} tool result(s) attached
                  </p>
                )}
                {isStop && (
                  <label className="mt-2 block text-[0.7rem] font-semibold text-slate-600">
                    Per-turn LLM override (ElevenLabs llm_override)
                    <input
                      value={turn.llm_override || ""}
                      onChange={(event) => updateTurn(index, { llm_override: event.target.value })}
                      placeholder="Optional prompt override for this exact turn"
                      className="glass-input mt-1 w-full rounded-md px-2 py-1.5 text-[0.76rem]"
                    />
                  </label>
                )}
              </div>
            );
          })}
      </div>

      <label className="mb-2 flex items-center gap-2 text-[0.72rem] text-slate-700">
        <input
          type="checkbox"
          checked={voiceEnabled}
          onChange={(event) => onVoiceEnabledChange(event.target.checked)}
        />
        Play voice on new turns (agent uses ElevenLabs voice; user uses browser speech)
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={running || history.length === 0}
          onClick={() => onStep("agent")}
          className="glass-button-primary rounded-md px-3 py-1.5 text-[0.76rem] font-semibold disabled:opacity-60"
        >
          {running ? "Stepping..." : "Step agent reply"}
        </button>
        <button
          type="button"
          disabled={running || history.length === 0}
          onClick={() => onStep("user")}
          className="glass-button rounded-md px-3 py-1.5 text-[0.76rem] font-semibold disabled:opacity-60"
        >
          Step user line
        </button>
        <button
          type="button"
          disabled={running || history.length === 0}
          onClick={() => onStep("both")}
          className="glass-button rounded-md px-3 py-1.5 text-[0.76rem] font-semibold disabled:opacity-60"
        >
          Step user + agent
        </button>
        {stopIndex !== null && (
          <button
            type="button"
            className="glass-button rounded-md px-3 py-1.5 text-[0.76rem]"
            onClick={() => {
              onStopIndexChange(null);
              onHistoryChange(history.slice(0, frozenCount));
            }}
          >
            Clear stop ({frozenCount} turns)
          </button>
        )}
        {showFullRun && onRunFull && (
          <button
            type="button"
            disabled={running}
            onClick={onRunFull}
            className="glass-button rounded-md px-3 py-1.5 text-[0.76rem] font-semibold disabled:opacity-60"
          >
            Run full simulation
          </button>
        )}
      </div>

      <p className="mt-2 text-[0.72rem] text-slate-500">
        Active mode: <span className="font-semibold">{activeTab.replace("_", " ")}</span>. Agent steps use history up to the stop
        line; edit the user message before stepping when testing workshop lookup flows.
      </p>

      {runResult && (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[0.74rem] text-slate-700">
          <p>
            <span className="font-semibold">Run status:</span> {runResult.status}
          </p>
          <p>
            <span className="font-semibold">Latency:</span> {runResult.latency_ms} ms
          </p>
          {runResult.tool_check && (
            <p className="mt-1">
              <span className="font-semibold">Tool check:</span> {runResult.tool_check.message}
            </p>
          )}
          {runResult.transcript_summary && (
            <p className="mt-1">
              <span className="font-semibold">Summary:</span> {runResult.transcript_summary}
            </p>
          )}
          {(runResult.new_turns?.length ?? 0) > 0 && (
            <div className="mt-2 space-y-1">
              <p className="font-semibold">New turn(s) from last step:</p>
              {runResult.new_turns?.map((turn, index) => (
                <p key={`new-${index}`} className="whitespace-pre-wrap">
                  [{turn.role}] {turn.message || "(no message)"}
                  {toolNames(turn).length > 0 ? ` · tools: ${toolNames(turn).join(", ")}` : ""}
                </p>
              ))}
            </div>
          )}
          {runResult.upstream_endpoint && (
            <p className="mt-2 text-[0.68rem] text-slate-600">
              <span className="font-semibold">ElevenLabs path:</span> {runResult.upstream_endpoint}
            </p>
          )}
          {runResult.elevenlabs_request && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[0.72rem] font-semibold text-slate-700">
                ElevenLabs request payload (exact)
              </summary>
              <pre className="mt-1 max-h-[220px] overflow-auto rounded bg-slate-900 p-2 text-[0.68rem] text-slate-100">
                {JSON.stringify(runResult.elevenlabs_request, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      {jsonOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="glass-panel max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-xl border border-slate-200 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-[0.85rem] font-semibold text-slate-900">Test JSON (manual copy)</h4>
              <button type="button" className="glass-button rounded-md px-2 py-1 text-[0.74rem]" onClick={() => setJsonOpen(false)}>
                Close
              </button>
            </div>
            <textarea readOnly value={jsonText} className="glass-input h-[50vh] w-full rounded-md px-3 py-2 font-mono text-[0.72rem]" />
          </div>
        </div>
      )}
    </div>
  );
}
