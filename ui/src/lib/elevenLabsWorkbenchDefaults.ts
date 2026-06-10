import type { ElevenLabsToolExecutionMode, ElevenLabsWorkbenchOptionsState } from "../api";

export const DEFAULT_WORKBENCH_OPTIONS: ElevenLabsWorkbenchOptionsState = {
  tool_execution_mode: "call_real_tools",
  selected_tool_ids: [],
  agent_tool_ids_override: [],
  tool_direction_prompt: "",
  simulated_user_llm: "gpt-4o-mini",
  simulated_user_temperature: 0.4,
  agent_llm: "",
  agent_temperature: null,
  simulation_environment: "production",
  evaluate_on_step: true,
  extra_request_json: "",
};

export const TOOL_MODE_LABELS: Record<ElevenLabsToolExecutionMode, string> = {
  call_real_tools: "Real ElevenLabs tools (same as live agent)",
  mock_selected: "Mock selected tools only",
  mock_all: "Mock all tools",
};

export const LLM_MODEL_OPTIONS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "claude-sonnet-4",
  "claude-sonnet-4.5",
  "gemini-2.0-flash",
];
