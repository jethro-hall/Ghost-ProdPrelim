import type { ElevenLabsSimulationDetailResponse } from "../api";
import type { WorkbenchChatTurn } from "../components/TestWorkbenchStepPanel";

function mapToolDispatch(dispatch: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(dispatch)) return [];
  return dispatch
    .filter((row) => row && typeof row === "object")
    .map((row) => {
      const item = row as Record<string, unknown>;
      return {
        type: item.tool_type || "client",
        tool_name: item.tool_name,
        params_as_json: typeof item.params === "string" ? item.params : JSON.stringify(item.params ?? {}),
        request_id: item.request_id,
      };
    });
}

function mapToolResults(results: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(results)) return [];
  return results.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
}

export function chatFromSimulationDetail(detail: ElevenLabsSimulationDetailResponse | null): WorkbenchChatTurn[] {
  const simulation = detail?.simulation;
  const playback = simulation?.full_transcript_playback;
  if (Array.isArray(playback) && playback.length > 0) {
    const turns: WorkbenchChatTurn[] = [];
    for (const event of playback) {
      if (!event || typeof event !== "object") continue;
      const row = event as Record<string, unknown>;
      const role = String(row.role || "").toLowerCase();
      if (role !== "agent" && role !== "user") continue;
      const message = String(row.text || row.message || "").trim();
      const at = row.at_seconds;
      const tts = row.tts_ms;
      const llmSeconds = row.llm_seconds;
      let latency_ms: number | null = null;
      if (typeof tts === "number") latency_ms = tts;
      else if (typeof llmSeconds === "number") latency_ms = Math.round(llmSeconds * 1000);
      turns.push({
        role: role as "agent" | "user",
        message,
        time_in_call_secs: typeof at === "number" ? Math.max(0, Math.floor(at)) : turns.length * 3,
        tool_calls: mapToolDispatch(row.tool_dispatch),
        tool_results: mapToolResults(row.tool_results),
        latency_ms,
      });
    }
    if (turns.length > 0) return turns;
  }

  const history = detail?.elevenlabs_test_payload?.chat_history;
  if (!Array.isArray(history) || history.length === 0) {
    return [{ role: "agent", message: "Hello, how can I help you today?", time_in_call_secs: 0 }];
  }
  const turns: WorkbenchChatTurn[] = [];
  for (const row of history) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const role = String(item.role || "").toLowerCase();
    if (role !== "agent" && role !== "user") continue;
    const message = String(item.message || "").trim();
    if (!message && !(Array.isArray(item.tool_calls) && item.tool_calls.length > 0)) continue;
    turns.push({
      role: role as "agent" | "user",
      message,
      time_in_call_secs: typeof item.time_in_call_secs === "number" ? item.time_in_call_secs : turns.length * 3,
      tool_calls: Array.isArray(item.tool_calls) ? (item.tool_calls as Array<Record<string, unknown>>) : [],
      tool_results: Array.isArray(item.tool_results) ? (item.tool_results as Array<Record<string, unknown>>) : [],
    });
  }
  return turns.length > 0 ? turns : [{ role: "agent", message: "Hello, how can I help you today?", time_in_call_secs: 0 }];
}

export function mergeStepResult(
  history: WorkbenchChatTurn[],
  result: { merged_history?: WorkbenchChatTurn[]; new_turns?: WorkbenchChatTurn[] },
): WorkbenchChatTurn[] {
  if (result.merged_history && result.merged_history.length > 0) {
    return result.merged_history.map((turn, index) => ({
      role: turn.role === "user" ? "user" : "agent",
      message: turn.message || "",
      time_in_call_secs: turn.time_in_call_secs ?? index * 3,
      tool_calls: turn.tool_calls,
      tool_results: turn.tool_results,
      latency_ms: turn.latency_ms,
    }));
  }
  if (result.new_turns && result.new_turns.length > 0) {
    return [
      ...history,
      ...result.new_turns.map((turn, offset) => ({
        role: (turn.role === "user" ? "user" : "agent") as "agent" | "user",
        message: turn.message || "",
        time_in_call_secs: history.length + offset,
        tool_calls: turn.tool_calls,
        tool_results: turn.tool_results,
        latency_ms: turn.latency_ms,
      })),
    ];
  }
  return history;
}
