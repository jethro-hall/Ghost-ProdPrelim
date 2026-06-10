import type { ElevenLabsWorkbenchOptionsState, ElevenLabsWorkbenchSimulateFields } from "../api";

export function parseExtraRequestJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new Error("Advanced ElevenLabs JSON is invalid. Fix the JSON or clear the field.");
  }
}

export function buildWorkbenchSimulateFields(
  options: ElevenLabsWorkbenchOptionsState,
  args: {
    agentId?: string;
    simulatedUserPrompt?: string;
    agentPromptOverride?: string;
    dynamicVariables?: Record<string, string>;
    evaluate?: boolean;
  },
): ElevenLabsWorkbenchSimulateFields {
  let elevenlabs_request_extra: Record<string, unknown> | undefined;
  if (options.extra_request_json.trim()) {
    elevenlabs_request_extra = parseExtraRequestJson(options.extra_request_json);
  }

  const mergedToolIds = Array.from(
    new Set([...options.selected_tool_ids, ...options.agent_tool_ids_override].map((id) => id.trim()).filter(Boolean)),
  );

  return {
    agent_id: args.agentId?.trim() || undefined,
    simulated_user_prompt: args.simulatedUserPrompt?.trim() || undefined,
    simulated_user_llm: options.simulated_user_llm || undefined,
    simulated_user_temperature: options.simulated_user_temperature,
    agent_prompt_override: args.agentPromptOverride?.trim() || undefined,
    agent_llm: options.agent_llm.trim() || undefined,
    agent_temperature: options.agent_temperature ?? undefined,
    dynamic_variables: args.dynamicVariables,
    tool_execution_mode: options.tool_execution_mode,
    selected_tool_ids: options.selected_tool_ids,
    agent_tool_ids_override: mergedToolIds,
    tool_direction_prompt: options.tool_direction_prompt.trim() || undefined,
    simulation_environment: options.simulation_environment.trim() || undefined,
    evaluate: args.evaluate ?? options.evaluate_on_step,
    elevenlabs_request_extra,
  };
}
