import { useEffect, useMemo, useState } from "react";

import {
  fetchElevenLabsWorkbenchAgent,
  fetchElevenLabsWorkbenchOptions,
  fetchElevenLabsWorkbenchTools,
  type ElevenLabsWorkbenchOptionsState,
  type ElevenLabsWorkbenchTool,
} from "../api";
import { LLM_MODEL_OPTIONS, TOOL_MODE_LABELS } from "../lib/elevenLabsWorkbenchDefaults";

type Props = {
  agentId: string;
  options: ElevenLabsWorkbenchOptionsState;
  onChange: (next: ElevenLabsWorkbenchOptionsState) => void;
};

export default function ElevenLabsWorkbenchOptionsPanel({ agentId, options, onChange }: Props) {
  const [toolSearch, setToolSearch] = useState("");
  const [tools, setTools] = useState<ElevenLabsWorkbenchTool[]>([]);
  const [agentToolIds, setAgentToolIds] = useState<string[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [upstreamLabel, setUpstreamLabel] = useState("ElevenLabs simulate-conversation");

  useEffect(() => {
    void fetchElevenLabsWorkbenchOptions()
      .then((payload) => setUpstreamLabel(payload.endpoint_template))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setLoadingTools(true);
    void fetchElevenLabsWorkbenchTools({ search: toolSearch.trim() || undefined, page_size: 100 })
      .then((payload) => setTools(payload.tools))
      .catch(() => setTools([]))
      .finally(() => setLoadingTools(false));
  }, [toolSearch]);

  useEffect(() => {
    const trimmed = agentId.trim();
    if (!trimmed) {
      setAgentToolIds([]);
      return;
    }
    void fetchElevenLabsWorkbenchAgent(trimmed)
      .then((payload) => setAgentToolIds(payload.tool_ids))
      .catch(() => setAgentToolIds([]));
  }, [agentId]);

  const selectedSet = useMemo(() => new Set(options.selected_tool_ids), [options.selected_tool_ids]);

  function toggleTool(toolId: string) {
    const next = new Set(selectedSet);
    if (next.has(toolId)) next.delete(toolId);
    else next.add(toolId);
    onChange({ ...options, selected_tool_ids: Array.from(next) });
  }

  function patch<K extends keyof ElevenLabsWorkbenchOptionsState>(key: K, value: ElevenLabsWorkbenchOptionsState[K]) {
    onChange({ ...options, [key]: value });
  }

  return (
    <details className="rounded-lg border border-slate-200 bg-white px-3 py-2" open>
      <summary className="cursor-pointer text-[0.74rem] font-semibold text-slate-800">
        ElevenLabs API options (every step uses {upstreamLabel})
      </summary>
      <div className="mt-3 space-y-3">
        <div>
          <p className="text-[0.68rem] text-slate-500">
            Tool execution modes apply when you add a valid <code className="text-[0.66rem]">tool_mock_config</code> in
            Advanced JSON. Otherwise ElevenLabs uses live tools (recommended).
          </p>
          <p className="text-[0.72rem] font-semibold text-slate-700">Tool execution</p>
          <div className="mt-1 space-y-1">
            {(Object.keys(TOOL_MODE_LABELS) as Array<keyof typeof TOOL_MODE_LABELS>).map((mode) => (
              <label key={mode} className="flex items-start gap-2 text-[0.72rem] text-slate-700">
                <input
                  type="radio"
                  name="tool-execution-mode"
                  checked={options.tool_execution_mode === mode}
                  onChange={() => patch("tool_execution_mode", mode)}
                />
                <span>{TOOL_MODE_LABELS[mode]}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <p className="text-[0.72rem] font-semibold text-slate-700">Workspace tools (select to steer / mock)</p>
          <input
            value={toolSearch}
            onChange={(event) => setToolSearch(event.target.value)}
            placeholder="Search ElevenLabs tools"
            className="glass-input mt-1 w-full rounded-md px-2 py-1.5 text-[0.76rem]"
          />
          <div className="mt-2 max-h-[140px] space-y-1 overflow-y-auto pr-1">
            {loadingTools && <p className="text-[0.7rem] text-slate-500">Loading tools...</p>}
            {!loadingTools &&
              tools.map((tool) => (
                <label key={tool.id || tool.name} className="flex items-center gap-2 text-[0.72rem] text-slate-700">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(tool.id)}
                    onChange={() => toggleTool(tool.id)}
                  />
                  <span>
                    {tool.name || tool.id}
                    {tool.type ? <span className="text-slate-400"> · {tool.type}</span> : null}
                  </span>
                </label>
              ))}
          </div>
          {agentToolIds.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <p className="text-[0.68rem] text-slate-500">Agent tools: {agentToolIds.join(", ")}</p>
              <button
                type="button"
                className="glass-button rounded px-2 py-0.5 text-[0.68rem]"
                onClick={() => onChange({ ...options, agent_tool_ids_override: agentToolIds })}
              >
                Apply agent tool IDs
              </button>
            </div>
          )}
        </div>

        <label className="block text-[0.72rem] font-semibold text-slate-700">
          Tool direction prompt (appended to agent override)
          <textarea
            value={options.tool_direction_prompt}
            onChange={(event) => patch("tool_direction_prompt", event.target.value)}
            rows={2}
            placeholder="e.g. After the customer gives name and phone, call hubtiger_job_search before replying."
            className="glass-input mt-1 w-full rounded-md px-2 py-1.5 text-[0.76rem]"
          />
        </label>

        <div className="grid gap-2 md:grid-cols-2">
          <label className="block text-[0.72rem] font-semibold text-slate-700">
            Simulated user LLM
            <select
              value={options.simulated_user_llm}
              onChange={(event) => patch("simulated_user_llm", event.target.value)}
              className="glass-input mt-1 w-full rounded-md px-2 py-1.5 text-[0.76rem]"
            >
              {LLM_MODEL_OPTIONS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[0.72rem] font-semibold text-slate-700">
            Agent LLM override
            <select
              value={options.agent_llm}
              onChange={(event) => patch("agent_llm", event.target.value)}
              className="glass-input mt-1 w-full rounded-md px-2 py-1.5 text-[0.76rem]"
            >
              <option value="">Use agent default</option>
              {LLM_MODEL_OPTIONS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[0.72rem] font-semibold text-slate-700">
            Simulated user temperature
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={options.simulated_user_temperature}
              onChange={(event) => patch("simulated_user_temperature", Number(event.target.value) || 0)}
              className="glass-input mt-1 w-full rounded-md px-2 py-1.5 text-[0.76rem]"
            />
          </label>
          <label className="block text-[0.72rem] font-semibold text-slate-700">
            Agent temperature override
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={options.agent_temperature ?? ""}
              onChange={(event) =>
                patch("agent_temperature", event.target.value === "" ? null : Number(event.target.value))
              }
              placeholder="Agent default"
              className="glass-input mt-1 w-full rounded-md px-2 py-1.5 text-[0.76rem]"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-[0.72rem] text-slate-700">
          <input
            type="checkbox"
            checked={options.evaluate_on_step}
            onChange={(event) => patch("evaluate_on_step", event.target.checked)}
          />
          Run ElevenLabs evaluation criteria on each step
        </label>

        <label className="block text-[0.72rem] font-semibold text-slate-700">
          Advanced: merge into ElevenLabs request JSON
          <textarea
            value={options.extra_request_json}
            onChange={(event) => patch("extra_request_json", event.target.value)}
            rows={4}
            placeholder='{"new_turns_limit": 1, "agent_config_override": { ... }}'
            className="glass-input mt-1 w-full rounded-md px-2 py-1.5 font-mono text-[0.7rem]"
          />
        </label>
      </div>
    </details>
  );
}
