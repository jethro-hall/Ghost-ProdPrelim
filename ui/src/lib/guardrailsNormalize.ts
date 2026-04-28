import type { ConversationMode, RuntimeProfileGuardrailsConfig } from "../api";

const DEFAULT_SYSTEM_PROMPT =
  "You answer using retrieved knowledge only. Always ground the answer in the provided context and say when the context is insufficient.";
const DEFAULT_INSUFFICIENT = "Say clearly that the available context is insufficient.";

const DEFAULT_OWNER_OPERATOR_QUESTIONNAIRE = `Owner-Operator Intelligence Questionnaire
1) What decision do you need to make right now?
2) What time window should be used?
3) Which branch/location/store scope applies (Retail, Burleigh, Brisbane, Online)?
4) What confidence threshold do you need before action?
5) What must not be hidden in the answer?
Always lead with decisive recommendations and mark missing fields as provisional instead of stalling.`;

const DEFAULT_BOARD_DOCUMENT_FORMAT_CONTRACT = `Board document format contract:
1) Executive Summary
2) Business Context
3) Objectives and Success Metrics
4) Strategic Options and Trade-offs
5) Recommended Plan
6) Execution Roadmap (owner, due date, dependency)
7) Risks and Mitigations
8) Board Decision Requests`;

const DEFAULT_FINANCIAL_REPORT_FORMAT_CONTRACT = `Financial report format contract:
1) Headline Performance Summary
2) KPI Scorecard (current, prior, variance)
3) Revenue, Margin, and Cost Drivers
4) Cashflow and Runway View
5) Risks and Corrective Actions
6) Decision Requests and Next Actions`;

const DEFAULT_DOCX_SECTIONS = ["facts", "inferences", "assumptions", "risks", "actions"];

const CONVERSATION_MODES: readonly ConversationMode[] = ["quick", "board", "working_session"];
const POLICY_MODES = ["locked", "admin_approval_required", "open"] as const;

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function asStringList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return [...fallback];
  return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

function asConversationMode(v: unknown): ConversationMode {
  const s = typeof v === "string" ? v : "";
  return CONVERSATION_MODES.includes(s as ConversationMode) ? (s as ConversationMode) : "quick";
}

function asPolicyMode(v: unknown): RuntimeProfileGuardrailsConfig["policy_mode"] {
  const s = typeof v === "string" ? v : "";
  return POLICY_MODES.includes(s as (typeof POLICY_MODES)[number])
    ? (s as RuntimeProfileGuardrailsConfig["policy_mode"])
    : "admin_approval_required";
}

/**
 * Maps API `value_json` for a guardrails namespace entry into a full guardrails config object.
 */
export function normalizeGuardrailsFromValueJson(raw: unknown): RuntimeProfileGuardrailsConfig {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    system_prompt: asString(o.system_prompt, DEFAULT_SYSTEM_PROMPT),
    grounding_mode: "retrieved_only",
    insufficient_context_behavior: asString(o.insufficient_context_behavior, DEFAULT_INSUFFICIENT),
    conversation_mode: asConversationMode(o.conversation_mode),
    policy_mode: asPolicyMode(o.policy_mode),
    owner_operator_questionnaire: asString(o.owner_operator_questionnaire, DEFAULT_OWNER_OPERATOR_QUESTIONNAIRE),
    owner_operator_questionnaire_compact: asString(o.owner_operator_questionnaire_compact, ""),
    board_document_format_contract: asString(o.board_document_format_contract, DEFAULT_BOARD_DOCUMENT_FORMAT_CONTRACT),
    financial_report_format_contract: asString(o.financial_report_format_contract, DEFAULT_FINANCIAL_REPORT_FORMAT_CONTRACT),
    docx_finalize_required_sections: asStringList(o.docx_finalize_required_sections, DEFAULT_DOCX_SECTIONS),
  };
}

export function guardrailsConfigToValueJson(config: RuntimeProfileGuardrailsConfig): Record<string, unknown> {
  return {
    system_prompt: config.system_prompt,
    grounding_mode: "retrieved_only",
    insufficient_context_behavior: config.insufficient_context_behavior,
    conversation_mode: config.conversation_mode,
    policy_mode: config.policy_mode,
    owner_operator_questionnaire: config.owner_operator_questionnaire,
    owner_operator_questionnaire_compact: config.owner_operator_questionnaire_compact,
    board_document_format_contract: config.board_document_format_contract,
    financial_report_format_contract: config.financial_report_format_contract,
    docx_finalize_required_sections: config.docx_finalize_required_sections,
  };
}
