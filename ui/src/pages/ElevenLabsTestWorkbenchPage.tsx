import { useEffect, useMemo, useState } from "react";

import ElevenLabsWorkbenchOptionsPanel from "../components/ElevenLabsWorkbenchOptionsPanel";
import TestWorkbenchStepPanel, { type WorkbenchChatTurn } from "../components/TestWorkbenchStepPanel";
import {
  fetchElevenLabsWorkbenchAgent,
  fetchElevenLabsTestSimulation,
  fetchElevenLabsTestSimulations,
  runElevenLabsTestSimulation,
  stepElevenLabsTestSimulation,
  type ElevenLabsSimulationDetailResponse,
  type ElevenLabsSimulationItem,
  type ElevenLabsSimulationRunResponse,
  type ElevenLabsTestTab,
  type ElevenLabsWorkbenchOptionsState,
} from "../api";
import { extractApiErrorMessage } from "../lib/extractApiError";
import { buildWorkbenchSimulateFields } from "../lib/buildWorkbenchSimulatePayload";
import { DEFAULT_WORKBENCH_OPTIONS } from "../lib/elevenLabsWorkbenchDefaults";
import { chatFromSimulationDetail, mergeStepResult } from "../lib/testWorkbenchChat";
import { playWorkbenchTurns } from "../lib/testWorkbenchVoice";

type DynamicVariable = { key: string; value: string };

const TAB_LABELS: Record<ElevenLabsTestTab, string> = {
  next_reply: "Next reply test",
  tool_invocation: "Tool invocation test",
  simulation: "Simulation test",
};

export default function ElevenLabsTestWorkbenchPage() {
  const [activeTab, setActiveTab] = useState<ElevenLabsTestTab>("simulation");
  const [loading, setLoading] = useState(true);
  const [busyDetail, setBusyDetail] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ElevenLabsSimulationItem[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [detail, setDetail] = useState<ElevenLabsSimulationDetailResponse | null>(null);
  const [runResult, setRunResult] = useState<ElevenLabsSimulationRunResponse | null>(null);
  const [stopIndex, setStopIndex] = useState<number | null>(null);
  const [chatPreview, setChatPreview] = useState<WorkbenchChatTurn[]>([{ role: "agent", message: "Hello, how can I help you today?", time_in_call_secs: 0 }]);
  const [simulatedUserPrompt, setSimulatedUserPrompt] = useState("");
  const [agentPromptOverride, setAgentPromptOverride] = useState("");
  const [workbenchOptions, setWorkbenchOptions] = useState<ElevenLabsWorkbenchOptionsState>(DEFAULT_WORKBENCH_OPTIONS);
  const [agentVoiceId, setAgentVoiceId] = useState<string | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [liveTurnIndex, setLiveTurnIndex] = useState<number | null>(null);

  const [testName, setTestName] = useState("Your test name");
  const [expectedMessage, setExpectedMessage] = useState("");
  const [successExamples, setSuccessExamples] = useState<string[]>([]);
  const [failureExamples, setFailureExamples] = useState<string[]>([]);
  const [dynamicVariables, setDynamicVariables] = useState<DynamicVariable[]>([]);

  const [toolName, setToolName] = useState("");
  const [passIfAnyToolMatches, setPassIfAnyToolMatches] = useState(true);

  const [userScenario, setUserScenario] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  const [maxTurns, setMaxTurns] = useState(5);
  const [agentId, setAgentId] = useState("");
  const [selectedTestId, setSelectedTestId] = useState("");

  async function loadList(query?: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchElevenLabsTestSimulations({ search: query, limit: 500 });
      setItems(response.items);
      if (!selectedFile && response.items.length > 0) {
        setSelectedFile(response.items[0].file_name);
      }
    } catch {
      setError("Simulation pack list is unavailable right now.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(fileName: string) {
    setBusyDetail(true);
    setError(null);
    setStopIndex(null);
    setRunResult(null);
    try {
      const response = await fetchElevenLabsTestSimulation(fileName);
      setDetail(response);
      setChatPreview(chatFromSimulationDetail(response));
      const tests = response.tests ?? [];
      const firstTest = tests[0];
      if (firstTest) {
        setSelectedTestId(firstTest.id);
        setTestName(firstTest.name || response.elevenlabs_test_payload?.name?.toString() || "Simulation test");
        setUserScenario(firstTest.objective || "");
        setSuccessCriteria(
          firstTest.assertion_count > 0
            ? "Agent remains concise, customer-safe, and completes the caller request."
            : firstTest.objective || "",
        );
      } else {
        setTestName(String(response.elevenlabs_test_payload?.name || "Simulation test"));
      }
      const payload = response.elevenlabs_test_payload as Record<string, unknown> | undefined;
      const meta = payload?.from_conversation_metadata as Record<string, unknown> | undefined;
      const resolvedAgentId = String(meta?.agent_id || "").trim();
      if (resolvedAgentId) {
        setAgentId(resolvedAgentId);
      }
    } catch {
      setError("Selected simulation could not be loaded.");
      setDetail(null);
    } finally {
      setBusyDetail(false);
    }
  }

  useEffect(() => {
    void loadList();
  }, []);

  useEffect(() => {
    if (!selectedFile) return;
    void loadDetail(selectedFile);
  }, [selectedFile]);

  useEffect(() => {
    const trimmed = agentId.trim();
    if (!trimmed) {
      setAgentVoiceId(null);
      return;
    }
    void fetchElevenLabsWorkbenchAgent(trimmed)
      .then((payload) => setAgentVoiceId(payload.voice_id?.trim() || null))
      .catch(() => setAgentVoiceId(null));
  }, [agentId]);

  const selectedMeta = useMemo(() => items.find((item) => item.file_name === selectedFile) ?? null, [items, selectedFile]);

  const dynamicVariablesMap = useMemo(() => {
    const out: Record<string, string> = {};
    for (const entry of dynamicVariables) {
      const key = entry.key.trim();
      if (!key) continue;
      out[key] = entry.value;
    }
    return out;
  }, [dynamicVariables]);

  const exportJson = useMemo(() => {
    const base = {
      name: testName,
      chat_history: chatPreview,
      dynamic_variables: dynamicVariables,
      stop_index: stopIndex,
      simulated_user_prompt: simulatedUserPrompt,
      agent_prompt_override: agentPromptOverride,
    };
    if (activeTab === "simulation") {
      return { ...base, type: "simulation", user_scenario: userScenario, success_criteria: successCriteria, max_turns: maxTurns };
    }
    if (activeTab === "tool_invocation") {
      return { ...base, type: "tool", tool_name: toolName, pass_if_any_tool_matches: passIfAnyToolMatches };
    }
    return {
      ...base,
      type: "llm",
      success_condition: expectedMessage,
      success_examples: successExamples,
      failure_examples: failureExamples,
    };
  }, [
    activeTab,
    testName,
    chatPreview,
    dynamicVariables,
    stopIndex,
    simulatedUserPrompt,
    agentPromptOverride,
    userScenario,
    successCriteria,
    maxTurns,
    toolName,
    passIfAnyToolMatches,
    expectedMessage,
    successExamples,
    failureExamples,
  ]);

  function buildSimulateFields(evaluate: boolean) {
    return buildWorkbenchSimulateFields(workbenchOptions, {
      agentId,
      simulatedUserPrompt: simulatedUserPrompt.trim() || userScenario.trim(),
      agentPromptOverride: agentPromptOverride.trim(),
      dynamicVariables: Object.keys(dynamicVariablesMap).length > 0 ? dynamicVariablesMap : undefined,
      evaluate,
    });
  }

  function buildStepPayload(mode: "agent" | "user" | "both") {
    const effectiveStop = stopIndex ?? Math.max(0, chatPreview.length - 1);
    const forcedUser =
      chatPreview[effectiveStop]?.role === "user" ? chatPreview[effectiveStop]?.message?.trim() : undefined;
    return {
      ...buildSimulateFields(activeTab === "next_reply" || activeTab === "simulation" ? workbenchOptions.evaluate_on_step : false),
      history: chatPreview,
      stop_index: effectiveStop,
      step_mode: mode,
      forced_user_message: forcedUser,
      success_criteria:
        activeTab === "next_reply"
          ? expectedMessage.trim() || successCriteria.trim() || undefined
          : successCriteria.trim() || undefined,
      expected_tool_name: activeTab === "tool_invocation" ? toolName.trim() || undefined : undefined,
    };
  }

  async function handleStep(mode: "agent" | "user" | "both") {
    if (!selectedFile) return;
    setRunning(true);
    setError(null);
    setRunResult(null);
    const activeIndex = stopIndex ?? Math.max(0, chatPreview.length - 1);
    setLiveTurnIndex(activeIndex);
    try {
      const result = await stepElevenLabsTestSimulation(selectedFile, buildStepPayload(mode));
      if (result.status === "error") {
        setError(result.message || "Step run failed.");
        return;
      }
      setRunResult(result);
      const merged = mergeStepResult(chatPreview, result);
      setChatPreview(merged);
      if (stopIndex !== null) {
        const added = (result.new_turns?.length ?? 0) + stopIndex + 1;
        setStopIndex(Math.max(0, added - 1));
      }
      if (voiceEnabled && result.new_turns && result.new_turns.length > 0) {
        const start = merged.length - result.new_turns.length;
        await playWorkbenchTurns({
          turns: result.new_turns.map((turn, offset) => ({
            role: turn.role === "user" ? "user" : "agent",
            message: turn.message || "",
            time_in_call_secs: start + offset,
            tool_calls: turn.tool_calls,
            tool_results: turn.tool_results,
            latency_ms: turn.latency_ms,
          })),
          agentVoiceId,
          onHighlight: setLiveTurnIndex,
        });
      }
    } catch (stepError) {
      setError(
        extractApiErrorMessage(stepError, "Step run failed. Check ElevenLabs configuration and try again."),
      );
    } finally {
      setRunning(false);
      setLiveTurnIndex(null);
    }
  }

  async function handleRunSimulation() {
    if (!selectedFile) return;
    setRunning(true);
    setError(null);
    setRunResult(null);
    setLiveTurnIndex(stopIndex ?? Math.max(0, chatPreview.length - 1));
    try {
      const partial =
        stopIndex !== null ? chatPreview.slice(0, stopIndex + 1) : chatPreview.length > 0 ? chatPreview : undefined;
      const result = await runElevenLabsTestSimulation(selectedFile, {
        ...buildSimulateFields(true),
        test_id: selectedTestId || undefined,
        user_scenario: userScenario.trim() || undefined,
        success_criteria: successCriteria.trim() || undefined,
        max_turns: maxTurns,
        partial_history: partial,
      });
      if (result.status === "error") {
        setError(result.message || "Simulation run failed.");
        return;
      }
      setRunResult(result);
      let nextPreview = chatPreview;
      if (result.merged_history && result.merged_history.length > 0) {
        nextPreview = mergeStepResult([], result);
        setChatPreview(nextPreview);
      } else if (result.turns && result.turns.length > 0) {
        nextPreview = result.turns.map((turn, index) => ({
          role: turn.role === "user" ? "user" : "agent",
          message: turn.message,
          time_in_call_secs: index,
          tool_calls: turn.tool_calls,
          tool_results: turn.tool_results,
          latency_ms: turn.latency_ms,
        }));
        setChatPreview(nextPreview);
      }
      if (voiceEnabled && result.new_turns && result.new_turns.length > 0) {
        await playWorkbenchTurns({
          turns: result.new_turns.map((turn, index) => ({
            role: turn.role === "user" ? "user" : "agent",
            message: turn.message || "",
            time_in_call_secs: index,
            tool_calls: turn.tool_calls,
            tool_results: turn.tool_results,
            latency_ms: turn.latency_ms,
          })),
          agentVoiceId,
          onHighlight: setLiveTurnIndex,
        });
      } else if (voiceEnabled && nextPreview.length > (partial?.length ?? 0)) {
        const delta = nextPreview.slice(partial?.length ?? 0);
        await playWorkbenchTurns({ turns: delta, agentVoiceId, onHighlight: setLiveTurnIndex });
      }
    } catch (runError) {
      setError(
        extractApiErrorMessage(runError, "Simulation run failed. Check ElevenLabs configuration and try again."),
      );
    } finally {
      setRunning(false);
      setLiveTurnIndex(null);
    }
  }

  function addExample(setter: (values: string[]) => void, values: string[]) {
    setter([...values, ""]);
  }

  function updateExample(setter: (values: string[]) => void, values: string[], index: number, value: string) {
    const next = [...values];
    next[index] = value;
    setter(next);
  }

  function addDynamicVariable() {
    setDynamicVariables((current) => [...current, { key: "", value: "" }]);
  }

  function updateDynamicVariable(index: number, field: "key" | "value", value: string) {
    setDynamicVariables((current) => {
      const next = [...current];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-4">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Quality Assurance</p>
        <h2 className="mt-1 text-[1rem] font-semibold text-slate-900">Agent Test Workbench</h2>
        <p className="mt-2 text-[0.82rem] text-slate-600">
          Phase 2: step through calls turn-by-turn, edit user lines, force agent prompts, inspect tool calls and latency, then run
          full simulations via ElevenLabs.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-orange-200 bg-orange-50/80 px-3 py-2">
          <button
            type="button"
            className="glass-button-primary rounded-md px-4 py-2 text-[0.78rem] font-semibold"
            onClick={() => window.dispatchEvent(new CustomEvent("ghostdash:open-simulation"))}
          >
            Open simulator panel →
          </button>
          <span className="text-[0.72rem] text-slate-700">
            Slides in from the right (Magic Mike chat + HubTiger booking steps). Also use header <strong>Simulator</strong> or the orange bubble bottom-right.
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <span className="self-center text-[0.72rem] text-slate-500">
            Checklist: <code className="text-[0.68rem]">docs/HUBTIGER_ELEVENLABS_WORKFLOW_SETUP_CHECKLIST.md</code>
          </span>
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void loadList(search.trim() || undefined);
          }}
        >
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by user, summary, or conversation id"
            className="glass-input w-full rounded-md px-3 py-2 text-[0.8rem]"
          />
          <button type="submit" className="glass-button rounded-md px-3 py-2 text-[0.78rem] font-semibold">
            Search
          </button>
          <button type="button" className="glass-button rounded-md px-3 py-2 text-[0.78rem]" onClick={() => void loadList()}>
            Reset
          </button>
        </form>
      </section>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[0.78rem] text-rose-700">{error}</div>}

      <section className="glass rounded-xl border border-slate-200 p-3">
        <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
          {(Object.keys(TAB_LABELS) as ElevenLabsTestTab[]).map((tab) => {
            const active = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`rounded-md px-3 py-1.5 text-[0.76rem] font-semibold transition ${
                  active ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {TAB_LABELS[tab]}
              </button>
            );
          })}
        </div>

        <div className="mt-3 grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="space-y-3">
            {activeTab === "simulation" && (
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-[0.64rem] font-bold uppercase tracking-[0.2em] text-slate-400">Simulation Files</p>
                <div className="mt-2 max-h-[220px] space-y-2 overflow-y-auto pr-1">
                  {loading && <p className="text-[0.76rem] text-slate-500">Loading simulation packs...</p>}
                  {!loading &&
                    items.map((item) => {
                      const active = item.file_name === selectedFile;
                      return (
                        <button
                          key={item.file_name}
                          type="button"
                          onClick={() => setSelectedFile(item.file_name)}
                          className={`w-full rounded-md border px-2 py-2 text-left transition ${
                            active
                              ? "border-ghost-orange bg-white text-slate-900"
                              : "border-slate-200 bg-white/80 text-slate-700 hover:border-slate-300"
                          }`}
                        >
                          <div className="truncate text-[0.73rem] font-semibold">{item.brief_summary || item.file_name}</div>
                          <div className="mt-1 text-[0.7rem] text-slate-500">{item.user}</div>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}

            <label className="block text-[0.72rem] font-semibold text-slate-700">
              Test name
              <input
                value={testName}
                onChange={(event) => setTestName(event.target.value)}
                className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.8rem]"
              />
            </label>

            {activeTab === "next_reply" && (
              <>
                <label className="block text-[0.72rem] font-semibold text-slate-700">
                  Describe expected next message
                  <textarea
                    value={expectedMessage}
                    onChange={(event) => setExpectedMessage(event.target.value)}
                    rows={4}
                    placeholder="Describe the ideal response or behavior the agent should exhibit to pass this test."
                    className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.8rem]"
                  />
                </label>
                <div>
                  <p className="text-[0.72rem] font-semibold text-slate-700">Success examples (optional)</p>
                  {successExamples.map((value, index) => (
                    <input
                      key={`success-${index}`}
                      value={value}
                      onChange={(event) => updateExample(setSuccessExamples, successExamples, index, event.target.value)}
                      className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.8rem]"
                    />
                  ))}
                  <button
                    type="button"
                    className="glass-button mt-2 rounded-md px-3 py-1.5 text-[0.74rem]"
                    onClick={() => addExample(setSuccessExamples, successExamples)}
                  >
                    + Add Example
                  </button>
                </div>
                <div>
                  <p className="text-[0.72rem] font-semibold text-slate-700">Failure examples (optional)</p>
                  {failureExamples.map((value, index) => (
                    <input
                      key={`failure-${index}`}
                      value={value}
                      onChange={(event) => updateExample(setFailureExamples, failureExamples, index, event.target.value)}
                      className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.8rem]"
                    />
                  ))}
                  <button
                    type="button"
                    className="glass-button mt-2 rounded-md px-3 py-1.5 text-[0.74rem]"
                    onClick={() => addExample(setFailureExamples, failureExamples)}
                  >
                    + Add Example
                  </button>
                </div>
              </>
            )}

            {activeTab === "tool_invocation" && (
              <>
                <div>
                  <p className="text-[0.72rem] font-semibold text-slate-700">Tool to test</p>
                  <input
                    value={toolName}
                    onChange={(event) => setToolName(event.target.value)}
                    placeholder="e.g. hubtiger_job_search (leave empty to assert no tool call)"
                    className="glass-input mt-2 w-full rounded-md px-3 py-2 text-[0.8rem]"
                  />
                </div>
                <label className="flex items-center gap-2 text-[0.74rem] text-slate-700">
                  <input
                    type="checkbox"
                    checked={passIfAnyToolMatches}
                    onChange={(event) => setPassIfAnyToolMatches(event.target.checked)}
                  />
                  Pass test if any tool matches
                </label>
              </>
            )}

            {activeTab === "simulation" && (
              <>
                <label className="block text-[0.72rem] font-semibold text-slate-700">
                  Repeatable test
                  <select
                    value={selectedTestId}
                    onChange={(event) => setSelectedTestId(event.target.value)}
                    className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.8rem]"
                  >
                    {(detail?.tests ?? []).map((test) => (
                      <option key={test.id} value={test.id}>
                        {test.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-[0.72rem] font-semibold text-slate-700">
                  Describe simulated user scenario
                  <textarea
                    value={userScenario}
                    onChange={(event) => setUserScenario(event.target.value)}
                    rows={4}
                    className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.8rem]"
                  />
                </label>
                <label className="block text-[0.72rem] font-semibold text-slate-700">
                  Describe success criteria
                  <textarea
                    value={successCriteria}
                    onChange={(event) => setSuccessCriteria(event.target.value)}
                    rows={3}
                    className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.8rem]"
                  />
                </label>
                <label className="block text-[0.72rem] font-semibold text-slate-700">
                  Maximum conversation turns (full run)
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={maxTurns}
                    onChange={(event) => setMaxTurns(Number(event.target.value) || 5)}
                    className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.8rem]"
                  />
                </label>
                <label className="block text-[0.72rem] font-semibold text-slate-700">
                  Agent ID (optional override)
                  <input
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value)}
                    placeholder="Uses ELEVENLABS_CONVAI_AGENT_ID or source conversation agent"
                    className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.8rem]"
                  />
                </label>
              </>
            )}

            {activeTab !== "simulation" && (
              <label className="block text-[0.72rem] font-semibold text-slate-700">
                Agent ID (optional override)
                <input
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                  placeholder="Uses ELEVENLABS_CONVAI_AGENT_ID or source conversation agent"
                  className="glass-input mt-1 w-full rounded-md px-3 py-2 text-[0.8rem]"
                />
              </label>
            )}

            <ElevenLabsWorkbenchOptionsPanel
              agentId={agentId}
              options={workbenchOptions}
              onChange={setWorkbenchOptions}
            />

            <details className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <summary className="cursor-pointer text-[0.74rem] font-semibold text-slate-700">
                Dynamic variables to use in the test run (optional)
              </summary>
              <div className="mt-2 space-y-2">
                {dynamicVariables.map((entry, index) => (
                  <div key={`var-${index}`} className="grid grid-cols-2 gap-2">
                    <input
                      value={entry.key}
                      onChange={(event) => updateDynamicVariable(index, "key", event.target.value)}
                      placeholder="Key"
                      className="glass-input rounded-md px-2 py-1.5 text-[0.76rem]"
                    />
                    <input
                      value={entry.value}
                      onChange={(event) => updateDynamicVariable(index, "value", event.target.value)}
                      placeholder="Value"
                      className="glass-input rounded-md px-2 py-1.5 text-[0.76rem]"
                    />
                  </div>
                ))}
                <button type="button" className="glass-button rounded-md px-3 py-1.5 text-[0.74rem]" onClick={addDynamicVariable}>
                  Add New
                </button>
              </div>
            </details>
          </div>

          <TestWorkbenchStepPanel
            activeTab={activeTab}
            title={selectedMeta?.brief_summary || "Conversation"}
            busy={busyDetail}
            history={chatPreview}
            onHistoryChange={setChatPreview}
            stopIndex={stopIndex}
            onStopIndexChange={setStopIndex}
            running={running}
            liveTurnIndex={liveTurnIndex}
            voiceEnabled={voiceEnabled}
            onVoiceEnabledChange={setVoiceEnabled}
            runResult={runResult}
            exportJson={exportJson}
            simulatedUserPrompt={simulatedUserPrompt}
            onSimulatedUserPromptChange={setSimulatedUserPrompt}
            agentPromptOverride={agentPromptOverride}
            onAgentPromptOverrideChange={setAgentPromptOverride}
            onStep={(mode) => void handleStep(mode)}
            onRunFull={activeTab === "simulation" ? () => void handleRunSimulation() : undefined}
            showFullRun={activeTab === "simulation"}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
          <div className="text-[0.72rem] text-slate-500">{selectedMeta?.conversation_id || ""}</div>
          <div className="flex items-center gap-2">
            {activeTab !== "simulation" && (
              <button
                type="button"
                disabled={!selectedFile || running}
                onClick={() => void handleStep("agent")}
                className="glass-button-primary rounded-md px-4 py-2 text-[0.78rem] font-semibold disabled:cursor-not-allowed disabled:opacity-60"
              >
                {running ? "Running..." : "Evaluate next reply"}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
