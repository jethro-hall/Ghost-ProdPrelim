import { useEffect, useId, useMemo, useRef, useState, type FocusEvent } from "react";
import { useOutletContext } from "react-router-dom";
import {
  deleteAgent,
  fetchAgentDeletionPreview,
  fetchAgentToolPolicy,
  fetchAgents,
  fetchCollections,
  fetchConnections,
  fetchRuntimeDefaults,
  fetchToolCatalog,
  saveAgent,
} from "../api";
import type {
  AgentProfile,
  AgentProfilePayload,
  AgentToolConfig,
  ChatApiMode,
  Collection,
  Connection,
  ProviderKind,
  RuntimeProfile,
  RuntimeDefaults,
  ToolCatalogEntry,
  ToolPolicy,
} from "../api";
import type { AppOutletContext } from "../components/AppLayout";
import { getModelIdOptionsForPicker, recallModelForConnection, rememberModelSelection } from "../lib/modelIdMemory";

const DEFAULT_TOOLS: AgentToolConfig[] = [
  {
    id: "kb",
    name: "Knowledge Base",
    description: "Query indexed documents.",
    enabled: true,
    allowed_urls: [],
    provider: "ghostdash",
    kind: "knowledge",
    session_toggleable: false,
  },
  {
    id: "web",
    name: "Approved Web Sources",
    description: "Fetch only the explicitly allowed websites stored on this agent.",
    enabled: false,
    allowed_urls: [],
    provider: "approved_web",
    kind: "approved_web",
    session_toggleable: false,
  },
];
const DEFAULT_EMBEDDING_MODEL = "openai/intfloat/multilingual-e5-large-instruct";
const ODOO_TOOL_ID = "odoo_primary";
const DEFAULT_BUSINESS_STRUCTURE_QUESTION_BANK = `Business structure question bank (answer once, reused until changed):
1) What is the legal entity and operating brand map for this business?
2) What business units/branches/stores/sites should be treated as distinct reporting entities?
3) Which channels are channel scopes only (for example Shopify, marketplace, wholesale), not legal entities?
4) Which entities roll up into group-level reporting, and how should group totals be interpreted?
5) Any non-negotiable accounting or scope rules (for example include/exclude tax, refunds, intercompany, or specific journals)?`;
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
const DEFAULT_DOCX_FINALIZE_REQUIRED_SECTIONS = ["facts", "inferences", "assumptions", "risks", "actions"];

function createRuntimeProfile(name: string, template?: RuntimeProfile, preserveIdentity = false): RuntimeProfile {
  const baseName = `${name} Runtime`;
  if (template) {
    return {
      ...template,
      id: preserveIdentity ? template.id : undefined,
      name: preserveIdentity ? template.name || baseName : baseName,
      llm_config: {
        ...template.llm_config,
        llm_orchestration: {
          enabled: template.llm_config.llm_orchestration?.enabled ?? false,
          trigger_mode: template.llm_config.llm_orchestration?.trigger_mode ?? "on_prompt_overflow",
          prompt_token_soft_limit: template.llm_config.llm_orchestration?.prompt_token_soft_limit ?? null,
          fallback_connection_id: template.llm_config.llm_orchestration?.fallback_connection_id ?? null,
          fallback_provider: template.llm_config.llm_orchestration?.fallback_provider ?? "openai",
          fallback_model_id: template.llm_config.llm_orchestration?.fallback_model_id ?? null,
          include_primary_answer_context: template.llm_config.llm_orchestration?.include_primary_answer_context ?? true,
        },
      },
      guardrails_config: {
        ...template.guardrails_config,
        policy_mode: template.guardrails_config.policy_mode ?? "admin_approval_required",
        business_structure_required: template.guardrails_config.business_structure_required ?? true,
        business_structure_question_bank:
          template.guardrails_config.business_structure_question_bank ?? DEFAULT_BUSINESS_STRUCTURE_QUESTION_BANK,
        business_structure_context: template.guardrails_config.business_structure_context ?? "",
        business_structure_context_compact: template.guardrails_config.business_structure_context_compact ?? "",
        owner_operator_questionnaire:
          template.guardrails_config.owner_operator_questionnaire ?? DEFAULT_OWNER_OPERATOR_QUESTIONNAIRE,
        owner_operator_questionnaire_compact: template.guardrails_config.owner_operator_questionnaire_compact ?? "",
        board_document_format_contract:
          template.guardrails_config.board_document_format_contract ?? DEFAULT_BOARD_DOCUMENT_FORMAT_CONTRACT,
        financial_report_format_contract:
          template.guardrails_config.financial_report_format_contract ?? DEFAULT_FINANCIAL_REPORT_FORMAT_CONTRACT,
        docx_finalize_required_sections:
          template.guardrails_config.docx_finalize_required_sections ?? DEFAULT_DOCX_FINALIZE_REQUIRED_SECTIONS,
      },
      tool_policy_config: {
        tools: template.tool_policy_config.tools.map((tool) => ({ ...tool, allowed_urls: [...(tool.allowed_urls ?? [])] })),
      },
      kb_config: {
        ...template.kb_config,
        default_corpora: [...template.kb_config.default_corpora],
      },
      policy_approval_token: template.policy_approval_token ?? null,
      policy_approval_reason: template.policy_approval_reason ?? null,
      policy_actor: template.policy_actor ?? null,
    };
  }
  return {
    name: baseName,
    description: "Canonical runtime profile for this agent.",
    llm_config: {
      connection_id: undefined,
      provider: "openai",
      model_id: "openai/llama31-8b",
      temperature: 0.2,
      max_tokens: null,
      api_mode: "responses",
      llm_orchestration: {
        enabled: false,
        trigger_mode: "on_prompt_overflow",
        prompt_token_soft_limit: null,
        fallback_connection_id: null,
        fallback_provider: "openai",
        fallback_model_id: null,
        include_primary_answer_context: true,
      },
    },
    guardrails_config: {
      system_prompt:
        "You answer using retrieved knowledge only. Always ground the answer in the provided context and say when the context is insufficient.",
      grounding_mode: "retrieved_only",
      insufficient_context_behavior: "Say clearly that the available context is insufficient.",
      conversation_mode: "quick",
      policy_mode: "admin_approval_required",
      business_structure_required: true,
      business_structure_question_bank: DEFAULT_BUSINESS_STRUCTURE_QUESTION_BANK,
      business_structure_context: "",
      business_structure_context_compact: "",
      owner_operator_questionnaire: DEFAULT_OWNER_OPERATOR_QUESTIONNAIRE,
      owner_operator_questionnaire_compact: "",
      board_document_format_contract: DEFAULT_BOARD_DOCUMENT_FORMAT_CONTRACT,
      financial_report_format_contract: DEFAULT_FINANCIAL_REPORT_FORMAT_CONTRACT,
      docx_finalize_required_sections: DEFAULT_DOCX_FINALIZE_REQUIRED_SECTIONS,
    },
    kb_config: {
      default_corpora: ["default"],
      embedding_model_id: DEFAULT_EMBEDDING_MODEL,
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
    policy_approval_token: null,
    policy_approval_reason: null,
    policy_actor: null,
    is_default: false,
    enabled: true,
  };
}

function createDraft(template?: AgentProfile | null, suggestedName?: string): AgentProfilePayload {
  const name = suggestedName ?? template?.name ?? "New Agent";
  return {
    name,
    first_message: template?.first_message ?? "Hello! I am your GhostDASH assistant. How can I help you today?",
    language: template?.language ?? "en-US",
    voice_id: template?.voice_id ?? "alloy",
    runtime_profile_id: null,
    runtime_profile: createRuntimeProfile(name, template?.runtime_profile, false),
    agent_role: template?.agent_role ?? "lead",
    parent_agent_id: template?.parent_agent_id ?? null,
    position: template?.position ?? 0,
    is_default: false,
    enabled: true,
  };
}

function createEmptyDraft(suggestedName: string, runtimeDefaults?: RuntimeDefaults | null): AgentProfilePayload {
  const baseRuntimeProfile = createRuntimeProfile(suggestedName);
  return {
    name: suggestedName,
    first_message: "Hello! I am your GhostDASH assistant. How can I help you today?",
    language: "en-US",
    voice_id: "alloy",
    runtime_profile_id: null,
    runtime_profile: {
      ...baseRuntimeProfile,
      llm_config: {
        ...baseRuntimeProfile.llm_config,
        connection_id: runtimeDefaults?.llm_connection_id ?? baseRuntimeProfile.llm_config.connection_id,
        provider: runtimeDefaults?.llm_provider_key ?? baseRuntimeProfile.llm_config.provider,
        model_id: runtimeDefaults?.llm_model_id ?? baseRuntimeProfile.llm_config.model_id,
        api_mode: runtimeDefaults?.chat_api_mode ?? "responses",
      },
      guardrails_config: {
        ...baseRuntimeProfile.guardrails_config,
      },
      kb_config: {
        ...baseRuntimeProfile.kb_config,
        default_corpora: runtimeDefaults?.default_corpora?.length ? [...runtimeDefaults.default_corpora] : baseRuntimeProfile.kb_config.default_corpora,
        embedding_model_id: runtimeDefaults?.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL,
      },
      retrieval_config: {
        ...baseRuntimeProfile.retrieval_config,
        default_top_k: runtimeDefaults?.pdf_top_k ?? baseRuntimeProfile.retrieval_config.default_top_k,
        pdf_chunk_size: runtimeDefaults?.pdf_chunk_size ?? baseRuntimeProfile.retrieval_config.pdf_chunk_size,
        pdf_chunk_overlap: runtimeDefaults?.pdf_chunk_overlap ?? baseRuntimeProfile.retrieval_config.pdf_chunk_overlap,
        pdf_sentence_window: runtimeDefaults?.pdf_sentence_window ?? baseRuntimeProfile.retrieval_config.pdf_sentence_window,
        pdf_parse_lane_policy: runtimeDefaults?.pdf_parse_lane_policy ?? baseRuntimeProfile.retrieval_config.pdf_parse_lane_policy,
        pdf_rerank_enabled: runtimeDefaults?.pdf_rerank_enabled ?? baseRuntimeProfile.retrieval_config.pdf_rerank_enabled,
      },
    },
    agent_role: "lead",
    parent_agent_id: null,
    position: 0,
    is_default: false,
    enabled: true,
  };
}

function buildUniqueAgentName(baseName: string, agents: AgentProfile[], currentAgentId?: string | null) {
  const existingNames = new Set(
    agents
      .filter((agent) => agent.id !== currentAgentId)
      .map((agent) => agent.name.trim().toLowerCase()),
  );
  const normalizedBase = baseName.trim() || "New Agent";
  if (!existingNames.has(normalizedBase.toLowerCase())) {
    return normalizedBase;
  }
  let suffix = 2;
  while (existingNames.has(`${normalizedBase} ${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${normalizedBase} ${suffix}`;
}

function extractApiErrorMessage(error: unknown) {
  const responseData = (error as { response?: { data?: unknown } }).response?.data;
  if (typeof responseData === "string" && responseData.trim()) {
    return responseData;
  }
  if (responseData && typeof responseData === "object") {
    const detail = (responseData as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) {
      return detail;
    }
    if (Array.isArray(detail) && detail.length > 0) {
      return detail
        .map((item) => {
          if (!item || typeof item !== "object") {
            return String(item);
          }
          const path = Array.isArray((item as { loc?: unknown[] }).loc)
            ? (item as { loc: unknown[] }).loc.join(".")
            : "field";
          const message = typeof (item as { msg?: unknown }).msg === "string" ? (item as { msg: string }).msg : "invalid value";
          return `${path}: ${message}`;
        })
        .join(" | ");
    }
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "GhostDASH could not save the agent. Check the highlighted fields and try again.";
}

function formatDeleteBlockingReason(reason: string) {
  switch (reason) {
    case "default_agent_protected":
      return "The default agent cannot be deleted.";
    case "active_workflow_runs":
      return "A workflow run is currently active for this agent.";
    case "active_workflow_steps":
      return "A workflow step is currently active for this agent.";
    default:
      return reason.replaceAll("_", " ");
  }
}

function inferModelProviderKind(modelId: string): ProviderKind | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("openai/") || normalized.startsWith("gpt-") || normalized.startsWith("o1") || normalized.startsWith("o3")) {
    return "openai";
  }
  if (normalized.startsWith("anthropic/") || normalized.startsWith("claude")) {
    return "anthropic";
  }
  if (normalized.startsWith("google/") || normalized.startsWith("gemini")) {
    return "google_gemini";
  }
  return null;
}

function describeModelProviderMismatch(connection: Connection | null, modelId: string): string | null {
  if (!connection) {
    return null;
  }
  if (connection.provider_kind === "openai_compatible") {
    return null;
  }
  const inferredProviderKind = inferModelProviderKind(modelId);
  if (!inferredProviderKind || inferredProviderKind === connection.provider_kind) {
    return null;
  }
  // Bare Gemini model ids (e.g. gemini-3.1-pro-preview) are often routed through OpenAI-shaped
  // gateways or staging connectors; do not treat as a mismatch with provider_kind "openai".
  if (inferredProviderKind === "google_gemini" && connection.provider_kind === "openai") {
    return null;
  }
  return `Current model '${modelId}' looks ${inferredProviderKind.replaceAll("_", " ")}-specific, but the selected connection is ${connection.label} (${connection.provider_kind}). Update one of them before saving.`;
}

function normalizeDraftForSave(draft: AgentProfilePayload): AgentProfilePayload {
  const agentRole = draft.agent_role === "sub" ? "sub" : "lead";
  const parentAgentId = agentRole === "sub" ? draft.parent_agent_id?.trim() || null : null;
  const parsedPosition = Number(draft.position ?? 0);
  const position = Number.isFinite(parsedPosition) && parsedPosition >= 0 ? Math.floor(parsedPosition) : 0;
  const fallbackConnectionId =
    draft.runtime_profile?.llm_config.llm_orchestration?.fallback_connection_id?.trim() || null;
  const fallbackProviderInput = draft.runtime_profile?.llm_config.llm_orchestration?.fallback_provider?.trim() || "";
  const fallbackProvider = (fallbackConnectionId
    ? draft.runtime_profile?.llm_config.provider?.trim() || "openai"
    : fallbackProviderInput || "openai"
  ).slice(0, 64);

  return {
    ...draft,
    name: draft.name.trim(),
    first_message: draft.first_message.trim(),
    language: draft.language.trim(),
    voice_id: draft.voice_id.trim(),
    agent_role: agentRole,
    parent_agent_id: parentAgentId,
    position,
    runtime_profile: draft.runtime_profile
      ? {
          ...draft.runtime_profile,
          name: draft.runtime_profile.name.trim(),
          description: draft.runtime_profile.description?.trim() || null,
          llm_config: {
            ...draft.runtime_profile.llm_config,
            provider: draft.runtime_profile.llm_config.provider.trim(),
            model_id: draft.runtime_profile.llm_config.model_id.trim(),
            llm_orchestration: {
              enabled: Boolean(draft.runtime_profile.llm_config.llm_orchestration?.enabled),
              trigger_mode:
                draft.runtime_profile.llm_config.llm_orchestration?.trigger_mode ?? "on_prompt_overflow",
              prompt_token_soft_limit:
                draft.runtime_profile.llm_config.llm_orchestration?.prompt_token_soft_limit == null
                  ? null
                  : Number(draft.runtime_profile.llm_config.llm_orchestration?.prompt_token_soft_limit),
              fallback_connection_id: fallbackConnectionId,
              fallback_provider: fallbackProvider,
              fallback_model_id:
                draft.runtime_profile.llm_config.llm_orchestration?.fallback_model_id?.trim() || null,
              include_primary_answer_context:
                draft.runtime_profile.llm_config.llm_orchestration?.include_primary_answer_context ?? true,
            },
          },
          guardrails_config: {
            ...draft.runtime_profile.guardrails_config,
            system_prompt: draft.runtime_profile.guardrails_config.system_prompt.trim(),
            insufficient_context_behavior: draft.runtime_profile.guardrails_config.insufficient_context_behavior.trim(),
            policy_mode: draft.runtime_profile.guardrails_config.policy_mode ?? "admin_approval_required",
            business_structure_required: draft.runtime_profile.guardrails_config.business_structure_required ?? true,
            business_structure_question_bank:
              draft.runtime_profile.guardrails_config.business_structure_question_bank ??
              DEFAULT_BUSINESS_STRUCTURE_QUESTION_BANK,
            business_structure_context: draft.runtime_profile.guardrails_config.business_structure_context ?? "",
            business_structure_context_compact:
              draft.runtime_profile.guardrails_config.business_structure_context_compact ?? "",
            owner_operator_questionnaire: draft.runtime_profile.guardrails_config.owner_operator_questionnaire ?? "",
            owner_operator_questionnaire_compact:
              draft.runtime_profile.guardrails_config.owner_operator_questionnaire_compact ?? "",
            board_document_format_contract:
              draft.runtime_profile.guardrails_config.board_document_format_contract ?? "",
            financial_report_format_contract:
              draft.runtime_profile.guardrails_config.financial_report_format_contract ?? "",
            docx_finalize_required_sections:
              draft.runtime_profile.guardrails_config.docx_finalize_required_sections ??
              DEFAULT_DOCX_FINALIZE_REQUIRED_SECTIONS,
          },
          kb_config: {
            ...draft.runtime_profile.kb_config,
            default_corpora: draft.runtime_profile.kb_config.default_corpora
              .map((value) => value.trim())
              .filter(Boolean),
          },
          tool_policy_config: {
            tools: draft.runtime_profile.tool_policy_config.tools.map((tool) => ({
              ...tool,
              allowed_urls: (tool.allowed_urls ?? []).map((value) => value.trim()).filter(Boolean),
            })),
          },
          policy_approval_token: draft.runtime_profile.policy_approval_token?.trim() || null,
          policy_approval_reason: draft.runtime_profile.policy_approval_reason?.trim() || null,
          policy_actor: draft.runtime_profile.policy_actor?.trim() || null,
        }
      : undefined,
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
    agent_role: agent.agent_role ?? "lead",
    parent_agent_id: agent.parent_agent_id ?? null,
    position: agent.position ?? 0,
    is_default: agent.is_default,
    enabled: agent.enabled,
  };
}

const SETTINGS_GROUPS = [
  { id: "connection", label: "Connection" },
  { id: "generation", label: "Generation" },
  { id: "voice", label: "Voice & status" },
  { id: "runtime", label: "Runtime summary" },
  { id: "collections", label: "Collections" },
  { id: "tools", label: "Tools" },
  { id: "odoo", label: "Odoo" },
] as const;

function LoadingWheel({ spinning }: { spinning: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 bg-white/80 text-slate-500 transition ${
        spinning ? "animate-spin border-ghost-orange text-ghost-orange" : ""
      }`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1 -9 -9" />
      </svg>
    </span>
  );
}

function EditGlyph() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export default function AgentConfigPage() {
  const { refreshRuntimeDefaults } = useOutletContext<AppOutletContext>();
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogEntry[]>([]);
  const [toolPolicy, setToolPolicy] = useState<ToolPolicy | null>(null);
  const [toolPolicyLoading, setToolPolicyLoading] = useState(false);
  const [toolPolicyError, setToolPolicyError] = useState<string | null>(null);
  const [toolPolicySavedAt, setToolPolicySavedAt] = useState<string | null>(null);
  const [runtimeDefaults, setRuntimeDefaults] = useState<RuntimeDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentProfilePayload>(() => createDraft());
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isReverting, setIsReverting] = useState(false);
  const [isCreateIntent, setIsCreateIntent] = useState(false);
  const [identityEditMode, setIdentityEditMode] = useState(false);
  const [activeSectionId, setActiveSectionId] = useState<(typeof SETTINGS_GROUPS)[number]["id"]>("connection");
  const settingsPanelRef = useRef<HTMLDivElement | null>(null);
  const identityCardRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedId) ?? null, [agents, selectedId]);
  const hierarchy = useMemo(() => {
    const knownIds = new Set(agents.map((agent) => agent.id));
    const leads: AgentProfile[] = [];
    const subAgentsByParent = new Map<string, AgentProfile[]>();
    for (const agent of agents) {
      const role = agent.agent_role ?? "lead";
      if (role === "sub" && agent.parent_agent_id && knownIds.has(agent.parent_agent_id)) {
        const list = subAgentsByParent.get(agent.parent_agent_id) ?? [];
        list.push(agent);
        subAgentsByParent.set(agent.parent_agent_id, list);
        continue;
      }
      leads.push(agent);
    }

    leads.sort((a, b) => {
      if (a.is_default !== b.is_default) {
        return a.is_default ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    const grouped: Array<{ lead: AgentProfile; sub_agents: AgentProfile[] }> = [];
    for (const lead of leads) {
      const subAgents = subAgentsByParent.get(lead.id) ?? [];
      subAgents.sort((a, b) => {
        const aPos = a.position ?? 0;
        const bPos = b.position ?? 0;
        if (aPos !== bPos) {
          return aPos - bPos;
        }
        return a.name.localeCompare(b.name);
      });
      grouped.push({ lead, sub_agents: subAgents });
    }
    return { leads, grouped };
  }, [agents]);
  const selectedLeadAgent = useMemo(() => {
    if (selectedAgent) {
      if ((selectedAgent.agent_role ?? "lead") === "lead") {
        return selectedAgent;
      }
      if (selectedAgent.parent_agent_id) {
        return agents.find((agent) => agent.id === selectedAgent.parent_agent_id) ?? null;
      }
      return null;
    }
    if (draft.agent_role === "sub" && draft.parent_agent_id) {
      return agents.find((agent) => agent.id === draft.parent_agent_id) ?? null;
    }
    return null;
  }, [agents, draft.agent_role, draft.parent_agent_id, selectedAgent]);
  const runtimeProfile = draft.runtime_profile;
  const isCreateMode = !draft.id;
  const odooCatalogEntry = useMemo(() => toolCatalog.find((tool) => tool.id === ODOO_TOOL_ID) ?? null, [toolCatalog]);
  const odooEnabled = Boolean(toolPolicy?.allowed_tool_ids.includes(ODOO_TOOL_ID));
  const selectedConnectionId =
    runtimeProfile?.llm_config.connection_id ??
    connections.find((connection) => connection.provider === runtimeProfile?.llm_config.provider)?.id ??
    "";
  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.id === selectedConnectionId) ?? null,
    [connections, selectedConnectionId],
  );
  const llmOrchestration = runtimeProfile?.llm_config.llm_orchestration ?? {
    enabled: false,
    trigger_mode: "on_prompt_overflow" as const,
    prompt_token_soft_limit: null,
    fallback_connection_id: null,
    fallback_provider: "openai",
    fallback_model_id: null,
    include_primary_answer_context: true,
  };
  const selectedFallbackConnection = useMemo(
    () => connections.find((connection) => connection.id === llmOrchestration.fallback_connection_id) ?? null,
    [connections, llmOrchestration.fallback_connection_id],
  );
  const connectionModelWarning = useMemo(
    () => describeModelProviderMismatch(selectedConnection, runtimeProfile?.llm_config.model_id ?? ""),
    [selectedConnection, runtimeProfile?.llm_config.model_id],
  );
  const [modelOptionsTick, setModelOptionsTick] = useState(0);
  const modelIdDatalistId = useId();
  const fallbackModelIdDatalistId = useId();
  const modelIdPickerOptions = useMemo(
    () =>
      getModelIdOptionsForPicker([
        runtimeDefaults?.llm_model_id ?? "",
        runtimeProfile?.llm_config.model_id ?? "",
      ]),
    [runtimeDefaults?.llm_model_id, runtimeProfile?.llm_config.model_id, modelOptionsTick],
  );
  const modelQuickPickValue = useMemo(() => {
    const cur = (runtimeProfile?.llm_config.model_id ?? "").trim();
    if (!cur) {
      return "";
    }
    return modelIdPickerOptions.includes(cur) ? cur : "";
  }, [modelIdPickerOptions, runtimeProfile?.llm_config.model_id]);
  const fallbackModelIdPickerOptions = useMemo(
    () =>
      getModelIdOptionsForPicker([
        runtimeDefaults?.llm_model_id ?? "",
        selectedFallbackConnection?.default_model_id ?? "",
        llmOrchestration.fallback_model_id ?? "",
      ]),
    [
      llmOrchestration.fallback_model_id,
      modelOptionsTick,
      runtimeDefaults?.llm_model_id,
      selectedFallbackConnection?.default_model_id,
    ],
  );
  const fallbackModelQuickPickValue = useMemo(() => {
    const cur = (llmOrchestration.fallback_model_id ?? "").trim();
    if (!cur) {
      return "";
    }
    return fallbackModelIdPickerOptions.includes(cur) ? cur : "";
  }, [fallbackModelIdPickerOptions, llmOrchestration.fallback_model_id]);
  const duplicateAgent = useMemo(
    () =>
      agents.find((agent) => agent.id !== draft.id && agent.name.trim().toLowerCase() === draft.name.trim().toLowerCase()) ?? null,
    [agents, draft.id, draft.name],
  );
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!draft.name.trim()) errors.push("Agent name is required.");
    if (duplicateAgent) errors.push(`Agent name '${draft.name.trim()}' already exists.`);
    if (!draft.first_message.trim()) errors.push("First message is required.");
    if ((draft.agent_role ?? "lead") === "sub" && !(draft.parent_agent_id ?? "").trim()) {
      errors.push("Sub-agent requires a parent lead agent.");
    }
    if (!runtimeProfile?.guardrails_config.system_prompt.trim()) errors.push("System prompt is required.");
    if (!runtimeProfile?.guardrails_config.insufficient_context_behavior.trim()) {
      errors.push("Insufficient context behavior is required.");
    }
    if (!(runtimeProfile?.guardrails_config.owner_operator_questionnaire ?? "").trim()) {
      errors.push("Owner-operator questionnaire template is required.");
    }
    if (
      (runtimeProfile?.guardrails_config.business_structure_required ?? true) &&
      !(runtimeProfile?.guardrails_config.business_structure_question_bank ?? "").trim()
    ) {
      errors.push("Business-structure question bank is required when structure gating is enabled.");
    }
    if (!runtimeProfile?.llm_config.model_id.trim()) errors.push("Model id is required.");
    if ((runtimeProfile?.llm_config.temperature ?? 0) < 0 || (runtimeProfile?.llm_config.temperature ?? 0) > 2) {
      errors.push("Temperature must be between 0 and 2.");
    }
    if (
      runtimeProfile?.llm_config.max_tokens != null &&
      (Number.isNaN(Number(runtimeProfile.llm_config.max_tokens)) || Number(runtimeProfile.llm_config.max_tokens) < 1)
    ) {
      errors.push("Max tokens must be blank (auto) or a number >= 1.");
    }
    return errors;
  }, [draft.first_message, draft.name, duplicateAgent, runtimeProfile]);
  const isWorking = loading || isSaving || isDeleting || isReverting || toolPolicyLoading;
  const statusToneClass = saveError
    ? "border-rose-200 bg-rose-50 text-rose-700"
    : validationErrors.length > 0
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : savedAt
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "";
  const statusMessage = saveError ?? validationErrors[0] ?? savedAt ?? null;

  function updateDraft(updater: (current: AgentProfilePayload) => AgentProfilePayload) {
    setDraft((current) => updater(current));
    setSaveError(null);
  }

  function updateAgentName(value: string) {
    updateDraft((current) => ({
      ...current,
      name: value,
      runtime_profile: current.runtime_profile
        ? {
            ...current.runtime_profile,
            name:
              current.runtime_profile.name === `${current.name} Runtime`
                ? `${value} Runtime`
                : current.runtime_profile.name,
          }
        : current.runtime_profile,
    }));
  }

  function selectAgent(agentId: string | null, availableAgents: AgentProfile[] = agents) {
    if (!agentId) {
      return;
    }
    const agent = availableAgents.find((entry) => entry.id === agentId) ?? null;
    if (!agent) {
      return;
    }
    setSelectedId(agent.id);
    setDraft(toDraft(agent));
    setSaveError(null);
    setSavedAt(null);
    setIsCreateIntent(false);
    setToolPolicySavedAt(null);
    setToolPolicyError(null);
    setIdentityEditMode(false);
  }

  function startNewAgent(availableAgents: AgentProfile[] = agents, nextRuntimeDefaults: RuntimeDefaults | null = runtimeDefaults) {
    const suggestedName = buildUniqueAgentName("New Agent", availableAgents);
    setSelectedId(null);
    setDraft(createEmptyDraft(suggestedName, nextRuntimeDefaults));
    setSavedAt(null);
    setSaveError(null);
    setIsCreateIntent(true);
    setToolPolicy(null);
    setToolPolicyError(null);
    setToolPolicySavedAt(null);
    setIdentityEditMode(true);
  }

  function startNewSubAgent(parentLead: AgentProfile) {
    const suggestedName = buildUniqueAgentName("[SA] New Sub-Agent", agents);
    const siblingCount = agents.filter((agent) => (agent.agent_role ?? "lead") === "sub" && agent.parent_agent_id === parentLead.id).length;
    setSelectedId(null);
    setDraft({
      ...createEmptyDraft(suggestedName, runtimeDefaults),
      name: suggestedName,
      agent_role: "sub",
      parent_agent_id: parentLead.id,
      position: siblingCount,
      is_default: false,
    });
    setSavedAt(null);
    setSaveError(null);
    setIsCreateIntent(true);
    setToolPolicy(null);
    setToolPolicyError(null);
    setToolPolicySavedAt(null);
    setIdentityEditMode(true);
  }

  async function refreshToolPolicy(agentId: string | null) {
    if (!agentId) {
      setToolPolicy(null);
      setToolPolicyError(null);
      return;
    }
    setToolPolicyLoading(true);
    setToolPolicyError(null);
    try {
      const nextPolicy = await fetchAgentToolPolicy(agentId);
      setToolPolicy(nextPolicy);
    } catch (error) {
      setToolPolicy(null);
      setToolPolicyError(extractApiErrorMessage(error));
    } finally {
      setToolPolicyLoading(false);
    }
  }

  async function refresh() {
    setLoading(true);
    try {
      const [nextAgents, nextCollections, nextConnections, nextRuntimeDefaults, nextToolCatalog] = await Promise.all([
        fetchAgents(),
        fetchCollections(),
        fetchConnections(),
        fetchRuntimeDefaults(),
        fetchToolCatalog(),
      ]);
      setAgents(nextAgents);
      setCollections(nextCollections);
      setConnections(nextConnections);
      setRuntimeDefaults(nextRuntimeDefaults);
      setToolCatalog(nextToolCatalog);
      const target = selectedId ? nextAgents.find((agent) => agent.id === selectedId) : isCreateIntent ? null : nextAgents[0];
      if (target) {
        selectAgent(target.id, nextAgents);
      } else if (nextAgents.length === 0) {
        startNewAgent(nextAgents, nextRuntimeDefaults);
      }
    } finally {
      setLoading(false);
    }
  }

  async function persistDraft(nextDraft: AgentProfilePayload = draft, successLabel = "Saved to GhostDASH") {
    if (validationErrors.length > 0) {
      setSaveError(validationErrors[0]);
      return false;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      const saved = await saveAgent(normalizeDraftForSave(nextDraft));
      const nextAgents = await fetchAgents();
      setAgents(nextAgents);
      selectAgent(saved.id, nextAgents);
      const refreshedSelected = nextAgents.find((agent) => agent.id === saved.id) ?? saved;
      setDraft(toDraft(refreshedSelected));
      await refreshToolPolicy(saved.id);
      setIsCreateIntent(false);
      if (saved.is_default) {
        await refreshRuntimeDefaults();
      }
      setSavedAt(`${successLabel} at ${new Date().toLocaleTimeString()}`);
      return true;
    } catch (error) {
      setSaveError(extractApiErrorMessage(error));
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function save() {
    await persistDraft(draft);
  }

  async function revertToDatabase() {
    if (!selectedId) {
      return;
    }
    setIsReverting(true);
    setSaveError(null);
    try {
      const [nextAgents, nextToolPolicy] = await Promise.all([fetchAgents(), fetchAgentToolPolicy(selectedId)]);
      setAgents(nextAgents);
      const persisted = nextAgents.find((agent) => agent.id === selectedId) ?? null;
      if (!persisted) {
        throw new Error("GhostDASH could not reload the saved agent from the database.");
      }
      setDraft(toDraft(persisted));
      setToolPolicy(nextToolPolicy);
      setSavedAt(`Reverted to database at ${new Date().toLocaleTimeString()}`);
      setToolPolicySavedAt(null);
      setIdentityEditMode(false);
    } catch (error) {
      setSaveError(extractApiErrorMessage(error));
    } finally {
      setIsReverting(false);
    }
  }

  async function deleteCurrentAgent() {
    if (!selectedId) {
      return;
    }
    setIsDeleting(true);
    setSaveError(null);
    try {
      const preview = await fetchAgentDeletionPreview(selectedId, "agent");
      if (!preview.can_execute) {
        const reasons = preview.blocking_reasons.map(formatDeleteBlockingReason).join(" ");
        setSaveError(reasons || "Agent deletion is currently blocked.");
        return;
      }
      const confirmed = window.confirm(
        [
          `Delete agent '${draft.name || "Untitled agent"}'?`,
          "This permanently removes the agent and related chat records.",
          "",
          `Conversations: ${preview.impact.conversations}`,
          `Messages: ${preview.impact.messages}`,
          `Uploads: ${preview.impact.uploads}`,
          `Docx sessions: ${preview.impact.docx_sessions}`,
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      await deleteAgent(selectedId, preview.confirmation_token);
      const nextAgents = await fetchAgents();
      setAgents(nextAgents);
      if (nextAgents.length > 0) {
        selectAgent(nextAgents[0].id, nextAgents);
      } else {
        startNewAgent(nextAgents, runtimeDefaults);
      }
      setSavedAt(`Deleted agent at ${new Date().toLocaleTimeString()}`);
      setToolPolicy(null);
      setToolPolicySavedAt(null);
      await refreshRuntimeDefaults();
    } catch (error) {
      setSaveError(extractApiErrorMessage(error));
    } finally {
      setIsDeleting(false);
    }
  }

  async function saveIdentityIfNeeded() {
    if (!selectedId || !identityEditMode) {
      return;
    }
    const ok = await persistDraft(draft, "Identity updated");
    if (ok) {
      setIdentityEditMode(false);
    }
  }

  function handleIdentityBlur(event: FocusEvent<HTMLDivElement>) {
    const nextFocused = event.relatedTarget as Node | null;
    if (nextFocused && identityCardRef.current?.contains(nextFocused)) {
      return;
    }
    void saveIdentityIfNeeded();
  }

  function scrollToSettingsGroup(groupId: (typeof SETTINGS_GROUPS)[number]["id"]) {
    const target = sectionRefs.current[groupId];
    const panel = settingsPanelRef.current;
    if (!target || !panel) {
      return;
    }
    panel.scrollTo({
      top: Math.max(0, target.offsetTop - 72),
      behavior: "smooth",
    });
  }

  useEffect(() => {
    void refresh().catch(() => null);
  }, []);

  useEffect(() => {
    void refreshToolPolicy(selectedId).catch(() => null);
  }, [selectedId]);

  useEffect(() => {
    const panel = settingsPanelRef.current;
    if (!panel) {
      return;
    }
    const updateActiveSection = () => {
      const scrollPosition = panel.scrollTop + 96;
      let nextActive: (typeof SETTINGS_GROUPS)[number]["id"] = SETTINGS_GROUPS[0].id;
      for (const group of SETTINGS_GROUPS) {
        const node = sectionRefs.current[group.id];
        if (node && node.offsetTop <= scrollPosition) {
          nextActive = group.id;
        }
      }
      setActiveSectionId(nextActive);
    };
    updateActiveSection();
    panel.addEventListener("scroll", updateActiveSection);
    return () => {
      panel.removeEventListener("scroll", updateActiveSection);
    };
  }, [selectedId, draft.id, toolPolicy, connections.length, collections.length]);

  return (
    <div className="agent-config-page flex flex-col gap-3 lg:h-[calc(100vh-92px)] lg:overflow-hidden">
      <section className="glass rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Agent Configuration</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-[1rem] font-semibold text-slate-900">Persona and runtime profile</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.16em] ${
                  isCreateMode ? "border border-blue-200 bg-blue-50 text-blue-700" : "border border-emerald-200 bg-emerald-50 text-emerald-700"
                }`}
              >
                {isCreateMode ? "Creating new agent" : "Editing saved agent"}
              </span>
            </div>
          </div>
          <div className="agent-command-bar flex flex-wrap items-center gap-2 xl:justify-end">
            <LoadingWheel spinning={isWorking} />
            <button type="button" className="ghost-btn" onClick={() => startNewAgent()}>
              New
            </button>
            <button
              type="button"
              className="ghost-btn disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => selectedLeadAgent && startNewSubAgent(selectedLeadAgent)}
              disabled={!selectedLeadAgent}
              title={selectedLeadAgent ? `Add sub-agent under ${selectedLeadAgent.name}` : "Select a lead agent first"}
            >
              Add Sub-Agent
            </button>
            <button
              type="button"
              className="ghost-btn disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void revertToDatabase()}
              disabled={!selectedId || isSaving || isDeleting || isReverting}
            >
              {isReverting ? "Reverting..." : "Revert"}
            </button>
            <button
              type="button"
              className="ghost-btn border-rose-300 text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void deleteCurrentAgent()}
              disabled={!selectedId || isSaving || isDeleting || isReverting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </button>
            <button
              type="button"
              className="ghost-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void save()}
              disabled={isSaving || isDeleting || isReverting || validationErrors.length > 0}
            >
              {isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
        {statusMessage && <div className={`mt-2 rounded-xl border px-3 py-2 text-[0.74rem] ${statusToneClass}`}>{statusMessage}</div>}
      </section>

      <div className="grid min-h-0 gap-3 lg:flex-1 lg:grid-cols-[minmax(0,1.18fr)_minmax(320px,0.82fr)] xl:grid-cols-[minmax(0,1.3fr)_360px] 2xl:grid-cols-[minmax(0,1.45fr)_390px]">
        <div className="flex min-h-0 flex-col gap-3">
          <section className="glass rounded-xl border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Lead Agents</div>
                <div className="text-[0.71rem] text-slate-500">Select an agent or create a sub-agent under a lead.</div>
              </div>
              <button
                type="button"
                className="ghost-btn text-[0.7rem] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => selectedLeadAgent && startNewSubAgent(selectedLeadAgent)}
                disabled={!selectedLeadAgent}
                title={selectedLeadAgent ? `Add sub-agent under ${selectedLeadAgent.name}` : "Select a lead agent first"}
              >
                + Sub-Agent
              </button>
            </div>
            <div className="max-h-[210px] space-y-2 overflow-y-auto pr-1">
              <button
                type="button"
                className={`w-full rounded-lg border px-2 py-2 text-left text-[0.72rem] transition ${
                  !selectedId && isCreateMode
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                }`}
                onClick={() => startNewAgent()}
              >
                <div className="font-semibold">New agent draft</div>
                <div className="text-[0.64rem] text-slate-400">Create a lead agent or add a sub-agent from a selected lead.</div>
              </button>
              {hierarchy.grouped.map(({ lead, sub_agents }) => {
                const leadSelected = selectedId === lead.id;
                return (
                  <div key={lead.id} className="rounded-lg border border-slate-200 bg-white/90 p-1.5">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-[0.72rem] ${
                          leadSelected
                            ? "border border-emerald-200 bg-emerald-50 text-emerald-800"
                            : "border border-transparent text-slate-700 hover:border-slate-200 hover:bg-slate-50"
                        }`}
                        onClick={() => selectAgent(lead.id)}
                      >
                        <div className="truncate font-semibold">{lead.name}</div>
                        <div className="mt-0.5 text-[0.61rem] uppercase tracking-[0.12em] text-emerald-700">Lead</div>
                      </button>
                      <button
                        type="button"
                        className="ghost-btn px-2 py-1 text-[0.62rem]"
                        onClick={() => startNewSubAgent(lead)}
                        title={`Add sub-agent under ${lead.name}`}
                      >
                        +Sub
                      </button>
                    </div>
                    {sub_agents.length > 0 ? (
                      <div className="mt-1 space-y-1 pl-4">
                        {sub_agents.map((subAgent) => {
                          const subSelected = selectedId === subAgent.id;
                          return (
                            <button
                              key={subAgent.id}
                              type="button"
                              className={`w-full rounded-md border px-2 py-1.5 text-left text-[0.69rem] ${
                                subSelected
                                  ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                              }`}
                              onClick={() => selectAgent(subAgent.id)}
                            >
                              <div className="truncate">{subAgent.name}</div>
                              <div className="mt-0.5 text-[0.6rem] uppercase tracking-[0.12em] text-indigo-700">Sub</div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="mt-1 pl-4 text-[0.64rem] text-slate-400">No sub-agents yet.</div>
                    )}
                  </div>
                );
              })}
              {hierarchy.grouped.length === 0 ? <div className="rounded-md border border-dashed border-slate-300 px-2 py-3 text-[0.68rem] text-slate-500">No saved agents yet. Create your first lead agent.</div> : null}
            </div>
          </section>

          <section
            ref={identityCardRef}
            onBlur={handleIdentityBlur}
            className="agent-config-editor glass flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200"
          >
            <div className="border-b border-slate-200/80 px-3 py-2">
              <div className="mb-2 h-1.5 w-20 rounded-full bg-amber-300" />
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {identityEditMode ? (
                    <div className="grid gap-2">
                    <label className="block text-[0.68rem] font-medium uppercase tracking-[0.16em] text-slate-400">
                      Agent name
                      <input
                        className={`ghost-input mt-1 ${duplicateAgent ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100" : ""}`}
                        value={draft.name}
                        onChange={(event) => updateAgentName(event.target.value)}
                      />
                    </label>
                    {(draft.agent_role ?? "lead") === "sub" && (
                      <label className="block text-[0.68rem] font-medium uppercase tracking-[0.16em] text-slate-400">
                        Parent lead agent
                        <select
                          className="ghost-select mt-1"
                          value={draft.parent_agent_id ?? ""}
                          onChange={(event) =>
                            updateDraft((current) => ({
                              ...current,
                              parent_agent_id: event.target.value || null,
                            }))
                          }
                        >
                          <option value="">Select lead</option>
                          {hierarchy.leads.map((lead) => (
                            <option key={lead.id} value={lead.id}>
                              {lead.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    </div>
                  ) : (
                    <>
                      <div className="truncate text-[1.15rem] font-semibold leading-tight text-slate-950">{draft.name || "Untitled agent"}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.64rem] font-semibold uppercase tracking-[0.12em]">
                        <span
                          className={`rounded-full px-2 py-0.5 ${
                            (draft.agent_role ?? "lead") === "sub"
                              ? "border border-indigo-200 bg-indigo-50 text-indigo-700"
                              : "border border-emerald-200 bg-emerald-50 text-emerald-700"
                          }`}
                        >
                          {(draft.agent_role ?? "lead") === "sub" ? "Sub-agent" : "Lead agent"}
                        </span>
                        {(draft.agent_role ?? "lead") === "sub" && selectedLeadAgent ? (
                          <span className="text-slate-400">Parent: {selectedLeadAgent.name}</span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[0.73rem] font-medium text-slate-400">{runtimeProfile?.llm_config.model_id ?? "No model selected"}</div>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="ghost-icon-btn mt-0.5 shrink-0 text-slate-500"
                  onClick={() => setIdentityEditMode((current) => !current)}
                  title="Edit agent name"
                >
                  <EditGlyph />
                </button>
              </div>
            </div>
            <div className="agent-config-primary-scroll ghost-settings-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <div className="grid gap-2.5">
              <label className="block text-[0.74rem] font-medium text-slate-600">
                First message
                <textarea
                  className="ghost-textarea mt-1 min-h-[72px] bg-white"
                  value={draft.first_message}
                  onChange={(event) => updateDraft((current) => ({ ...current, first_message: event.target.value }))}
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                System prompt
                <textarea
                  className="ghost-textarea mt-1 min-h-[320px] bg-white lg:min-h-[360px]"
                  value={runtimeProfile?.guardrails_config.system_prompt ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
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
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Insufficient context behavior
                <textarea
                  className="ghost-textarea mt-1 min-h-[96px] bg-white"
                  value={runtimeProfile?.guardrails_config.insufficient_context_behavior ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
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
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Require business structure before analysis
                <select
                  className="ghost-select mt-1 bg-white"
                  value={(runtimeProfile?.guardrails_config.business_structure_required ?? true) ? "true" : "false"}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            guardrails_config: {
                              ...current.runtime_profile.guardrails_config,
                              business_structure_required: event.target.value === "true",
                            },
                          }
                        : current.runtime_profile,
                    }))
                  }
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Business structure question bank
                <textarea
                  className="ghost-textarea mt-1 min-h-[180px] bg-white"
                  value={runtimeProfile?.guardrails_config.business_structure_question_bank ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            guardrails_config: {
                              ...current.runtime_profile.guardrails_config,
                              business_structure_question_bank: event.target.value,
                            },
                          }
                        : current.runtime_profile,
                    }))
                  }
                  placeholder="Question bank used when business context is missing"
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Business structure memory (editable)
                <textarea
                  className="ghost-textarea mt-1 min-h-[150px] bg-white"
                  value={runtimeProfile?.guardrails_config.business_structure_context ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            guardrails_config: {
                              ...current.runtime_profile.guardrails_config,
                              business_structure_context: event.target.value,
                            },
                          }
                        : current.runtime_profile,
                    }))
                  }
                  placeholder="Persisted business foundation used across conversations for this runtime profile"
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Business structure compact memory (derived)
                <textarea
                  className="ghost-textarea mt-1 min-h-[90px] bg-slate-50 text-slate-600"
                  value={runtimeProfile?.guardrails_config.business_structure_context_compact ?? ""}
                  readOnly
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Owner-operator questionnaire template
                <textarea
                  className="ghost-textarea mt-1 min-h-[180px] bg-white"
                  value={runtimeProfile?.guardrails_config.owner_operator_questionnaire ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            guardrails_config: {
                              ...current.runtime_profile.guardrails_config,
                              owner_operator_questionnaire: event.target.value,
                            },
                          }
                        : current.runtime_profile,
                    }))
                  }
                  placeholder="Plain-English owner/operator guidance template"
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Owner-operator compact guidance (derived)
                <textarea
                  className="ghost-textarea mt-1 min-h-[100px] bg-slate-50 text-slate-600"
                  value={runtimeProfile?.guardrails_config.owner_operator_questionnaire_compact ?? ""}
                  readOnly
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Board document format contract
                <textarea
                  className="ghost-textarea mt-1 min-h-[130px] bg-white"
                  value={runtimeProfile?.guardrails_config.board_document_format_contract ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            guardrails_config: {
                              ...current.runtime_profile.guardrails_config,
                              board_document_format_contract: event.target.value,
                            },
                          }
                        : current.runtime_profile,
                    }))
                  }
                  placeholder="Board document section contract shown to the model"
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Financial report format contract
                <textarea
                  className="ghost-textarea mt-1 min-h-[120px] bg-white"
                  value={runtimeProfile?.guardrails_config.financial_report_format_contract ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            guardrails_config: {
                              ...current.runtime_profile.guardrails_config,
                              financial_report_format_contract: event.target.value,
                            },
                          }
                        : current.runtime_profile,
                    }))
                  }
                  placeholder="Financial report section contract shown to the model"
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Doc finalize required sections (comma-separated)
                <input
                  className="ghost-input mt-1 bg-white"
                  value={(runtimeProfile?.guardrails_config.docx_finalize_required_sections ?? []).join(", ")}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            guardrails_config: {
                              ...current.runtime_profile.guardrails_config,
                              docx_finalize_required_sections: event.target.value
                                .split(",")
                                .map((part) => part.trim().toLowerCase())
                                .filter(Boolean),
                            },
                          }
                        : current.runtime_profile,
                    }))
                  }
                  placeholder="facts, inferences, assumptions, risks, actions"
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Policy mode
                <select
                  className="ghost-select mt-1 bg-white"
                  value={runtimeProfile?.guardrails_config.policy_mode ?? "admin_approval_required"}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            guardrails_config: {
                              ...current.runtime_profile.guardrails_config,
                              policy_mode: event.target.value as "locked" | "admin_approval_required" | "open",
                            },
                          }
                        : current.runtime_profile,
                    }))
                  }
                >
                  <option value="admin_approval_required">admin_approval_required</option>
                  <option value="locked">locked</option>
                  <option value="open">open</option>
                </select>
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Policy actor (for audit trail)
                <input
                  className="ghost-input mt-1 bg-white"
                  value={runtimeProfile?.policy_actor ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            policy_actor: event.target.value,
                          }
                        : current.runtime_profile,
                    }))
                  }
                  placeholder="admin@rideai.com.au"
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Approval token (required when policy mode is admin_approval_required)
                <input
                  className="ghost-input mt-1 bg-white"
                  value={runtimeProfile?.policy_approval_token ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            policy_approval_token: event.target.value,
                          }
                        : current.runtime_profile,
                    }))
                  }
                  placeholder="ADMIN_APPROVED_..."
                />
              </label>
              <label className="block text-[0.74rem] font-medium text-slate-600">
                Approval reason
                <textarea
                  className="ghost-textarea mt-1 min-h-[72px] bg-white"
                  value={runtimeProfile?.policy_approval_reason ?? ""}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      runtime_profile: current.runtime_profile
                        ? {
                            ...current.runtime_profile,
                            policy_approval_reason: event.target.value,
                          }
                        : current.runtime_profile,
                    }))
                  }
                  placeholder="Why this guardrail/tool policy change is approved"
                />
              </label>
              </div>
            </div>
          </section>
        </div>

        <aside className="agent-settings-rail glass relative min-h-0 overflow-hidden rounded-xl border border-slate-200">
          <div ref={settingsPanelRef} className="ghost-settings-scroll h-full overflow-y-auto px-2 py-2">
            <div className="agent-settings-nav sticky top-0 z-10 mb-2 flex flex-wrap gap-1.5 border-b border-slate-200/80 bg-[rgba(244,245,247,0.92)] px-1 pb-2 pt-1 backdrop-blur">
              {SETTINGS_GROUPS.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className="agent-settings-nav-btn"
                  data-active={activeSectionId === group.id}
                  onClick={() => scrollToSettingsGroup(group.id)}
                >
                  {group.label}
                </button>
              ))}
            </div>
            <div className="space-y-1.5">
              <section
                ref={(node) => {
                  sectionRefs.current.connection = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Connection</div>
                <label className="block text-[0.68rem] text-slate-500">
                  Provider connection
                  <select
                    className="ghost-select mt-1"
                    value={selectedConnectionId}
                    onChange={(event) => {
                      const nextConnectionId = event.target.value;
                      const nextConnection = connections.find((connection) => connection.id === nextConnectionId) ?? null;
                      const previousConnection = connections.find((connection) => connection.id === selectedConnectionId) ?? null;
                      const currentModelId = runtimeProfile?.llm_config.model_id?.trim() ?? "";
                      if (previousConnection && currentModelId) {
                        rememberModelSelection({
                          connectionId: previousConnection.id,
                          providerKind: previousConnection.provider_kind,
                          modelId: currentModelId,
                        });
                      }
                      const nextModelId = nextConnection
                        ? recallModelForConnection({
                            connectionId: nextConnection.id,
                            providerKind: nextConnection.provider_kind,
                            runtimeDefaultModelId: runtimeDefaults?.llm_model_id,
                          })
                        : (runtimeProfile?.llm_config.model_id ?? "");
                      updateDraft((current) => ({
                        ...current,
                        runtime_profile: current.runtime_profile
                          ? {
                              ...current.runtime_profile,
                              llm_config: {
                                ...current.runtime_profile.llm_config,
                                connection_id: nextConnection?.id ?? null,
                                provider: nextConnection?.provider ?? current.runtime_profile.llm_config.provider,
                                model_id: nextModelId,
                              },
                            }
                          : current.runtime_profile,
                      }));
                      setModelOptionsTick((tick) => tick + 1);
                    }}
                  >
                    {connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.label} ({connection.provider_kind})
                      </option>
                    ))}
                    {loading && <option value="">Loading saved connections...</option>}
                    {!loading && connections.length === 0 && <option value="">No saved connections</option>}
                  </select>
                </label>
                <div className="mt-1.5 block text-[0.68rem] text-slate-500">
                  Model id
                  <label className="mt-1 block text-[0.65rem] font-normal text-slate-500">
                    Quick pick
                    <select
                      className="ghost-select mt-1"
                      aria-label="Quick pick model id"
                      value={modelQuickPickValue}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (!value) {
                          return;
                        }
                        updateDraft((current) => ({
                          ...current,
                          runtime_profile: current.runtime_profile
                            ? {
                                ...current.runtime_profile,
                                llm_config: { ...current.runtime_profile.llm_config, model_id: value },
                              }
                            : current.runtime_profile,
                        }));
                        if (selectedConnection) {
                          rememberModelSelection({
                            connectionId: selectedConnection.id,
                            providerKind: selectedConnection.provider_kind,
                            modelId: value,
                          });
                        }
                        setModelOptionsTick((tick) => tick + 1);
                      }}
                    >
                      <option value="">— Choose model id (any provider) —</option>
                      {modelIdPickerOptions.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mt-1.5 block text-[0.65rem] font-normal text-slate-500">
                    Or type a model id
                    <input
                      className="ghost-input mt-1"
                      list={modelIdDatalistId}
                      value={runtimeProfile?.llm_config.model_id ?? ""}
                      onChange={(event) =>
                        updateDraft((current) => ({
                          ...current,
                          runtime_profile: current.runtime_profile
                            ? {
                                ...current.runtime_profile,
                                llm_config: { ...current.runtime_profile.llm_config, model_id: event.target.value },
                              }
                            : current.runtime_profile,
                        }))
                      }
                      onBlur={() => {
                        if (!selectedConnection || !runtimeProfile?.llm_config.model_id.trim()) {
                          return;
                        }
                        rememberModelSelection({
                          connectionId: selectedConnection.id,
                          providerKind: selectedConnection.provider_kind,
                          modelId: runtimeProfile.llm_config.model_id,
                        });
                        setModelOptionsTick((tick) => tick + 1);
                      }}
                      placeholder="Model used by this agent runtime"
                    />
                  </label>
                  <datalist id={modelIdDatalistId}>
                    {modelIdPickerOptions.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                </div>
                <div className="mt-1 text-[0.66rem] text-slate-400">
                  Connection stores credentials and base URL. Model id is independent: use the list for common ids and saved ones, or type any model string your gateway accepts.
                </div>
                {connectionModelWarning && (
                  <div className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[0.66rem] text-amber-800">
                    {connectionModelWarning}
                  </div>
                )}
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.generation = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Generation</div>
                <div className="grid gap-1.5">
                  <label className="block text-[0.68rem] text-slate-500">
                    Temperature
                    <input
                      className="ghost-input mt-1"
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={runtimeProfile?.llm_config.temperature ?? 0}
                      onChange={(event) =>
                        updateDraft((current) => ({
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
                  <label className="block text-[0.68rem] text-slate-500">
                    Max tokens (optional)
                    <input
                      className="ghost-input mt-1"
                      type="number"
                      min="1"
                      placeholder="auto"
                      value={runtimeProfile?.llm_config.max_tokens ?? ""}
                      onChange={(event) =>
                        updateDraft((current) => ({
                          ...current,
                          runtime_profile: current.runtime_profile
                            ? {
                                ...current.runtime_profile,
                                llm_config: {
                                  ...current.runtime_profile.llm_config,
                                  max_tokens: event.target.value === "" ? null : Number(event.target.value),
                                },
                              }
                            : current.runtime_profile,
                        }))
                      }
                    />
                  </label>
                  <label className="block text-[0.68rem] text-slate-500">
                    Chat API mode (OpenAI)
                    <select
                      className="ghost-select mt-1"
                      value={runtimeProfile?.llm_config.api_mode ?? "responses"}
                      onChange={(event) =>
                        updateDraft((current) => ({
                          ...current,
                          runtime_profile: current.runtime_profile
                            ? {
                                ...current.runtime_profile,
                                llm_config: {
                                  ...current.runtime_profile.llm_config,
                                  api_mode: event.target.value as ChatApiMode,
                                },
                              }
                            : current.runtime_profile,
                        }))
                      }
                    >
                      <option value="responses">Responses API</option>
                      <option value="chat_completions">Chat Completions API</option>
                    </select>
                  </label>
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-2 text-[0.66rem] text-slate-600">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={llmOrchestration.enabled}
                        onChange={() =>
                          updateDraft((current) => ({
                            ...current,
                            runtime_profile: current.runtime_profile
                              ? {
                                  ...current.runtime_profile,
                                  llm_config: {
                                    ...current.runtime_profile.llm_config,
                                    llm_orchestration: {
                                      ...llmOrchestration,
                                      enabled: !llmOrchestration.enabled,
                                    },
                                  },
                                }
                              : current.runtime_profile,
                          }))
                        }
                      />
                      Enable optional multi-LLM orchestration for this agent
                    </label>
                    <div className="mt-1 text-[0.62rem] text-slate-500">
                      Disabled by default. When enabled, GhostDASH can escalate oversized/complex prompts to a fallback model while keeping the same guardrails.
                    </div>
                    {llmOrchestration.enabled && (
                      <div className="mt-2 grid gap-1.5">
                        <label className="block text-[0.66rem] text-slate-500">
                          Trigger mode
                          <select
                            className="ghost-select mt-1"
                            value={llmOrchestration.trigger_mode}
                            onChange={(event) =>
                              updateDraft((current) => ({
                                ...current,
                                runtime_profile: current.runtime_profile
                                  ? {
                                      ...current.runtime_profile,
                                      llm_config: {
                                        ...current.runtime_profile.llm_config,
                                        llm_orchestration: {
                                          ...llmOrchestration,
                                          trigger_mode: event.target.value as "on_prompt_overflow" | "always_second_pass",
                                        },
                                      },
                                    }
                                  : current.runtime_profile,
                              }))
                            }
                          >
                            <option value="on_prompt_overflow">Only when prompt is too large / over limit</option>
                            <option value="always_second_pass">Always run second pass refinement</option>
                          </select>
                        </label>
                        <label className="block text-[0.66rem] text-slate-500">
                          Prompt soft limit (tokens, optional)
                          <input
                            className="ghost-input mt-1"
                            type="number"
                            min="1"
                            placeholder="auto"
                            value={llmOrchestration.prompt_token_soft_limit ?? ""}
                            onChange={(event) =>
                              updateDraft((current) => ({
                                ...current,
                                runtime_profile: current.runtime_profile
                                  ? {
                                      ...current.runtime_profile,
                                      llm_config: {
                                        ...current.runtime_profile.llm_config,
                                        llm_orchestration: {
                                          ...llmOrchestration,
                                          prompt_token_soft_limit:
                                            event.target.value === "" ? null : Number(event.target.value),
                                        },
                                      },
                                    }
                                  : current.runtime_profile,
                              }))
                            }
                          />
                        </label>
                        <label className="block text-[0.66rem] text-slate-500">
                          Fallback connection
                          <select
                            className="ghost-select mt-1"
                            value={llmOrchestration.fallback_connection_id ?? ""}
                            onChange={(event) => {
                              const nextConnection =
                                connections.find((connection) => connection.id === event.target.value) ?? null;
                              updateDraft((current) => ({
                                ...current,
                                runtime_profile: current.runtime_profile
                                  ? {
                                      ...current.runtime_profile,
                                      llm_config: {
                                        ...current.runtime_profile.llm_config,
                                        llm_orchestration: {
                                          ...llmOrchestration,
                                          fallback_connection_id: nextConnection?.id ?? null,
                                          fallback_provider:
                                            nextConnection?.provider ?? llmOrchestration.fallback_provider ?? "openai",
                                        },
                                      },
                                    }
                                  : current.runtime_profile,
                              }));
                            }}
                          >
                            <option value="">Use provider key fallback</option>
                            {connections.map((connection) => (
                              <option key={connection.id} value={connection.id}>
                                {connection.label} ({connection.provider_kind})
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="block text-[0.66rem] text-slate-500">
                          Fallback provider id (not API key)
                          <input
                            className="ghost-input mt-1"
                            autoComplete="off"
                            maxLength={64}
                            value={llmOrchestration.fallback_provider ?? "openai"}
                            onChange={(event) =>
                              updateDraft((current) => ({
                                ...current,
                                runtime_profile: current.runtime_profile
                                  ? {
                                      ...current.runtime_profile,
                                      llm_config: {
                                        ...current.runtime_profile.llm_config,
                                        llm_orchestration: {
                                          ...llmOrchestration,
                                          fallback_provider: event.target.value,
                                        },
                                      },
                                    }
                                  : current.runtime_profile,
                              }))
                            }
                            placeholder="e.g. openai"
                          />
                        </label>
                        <div className="block text-[0.66rem] text-slate-500">
                          Fallback model id (optional override)
                          <label className="mt-1 block text-[0.65rem] font-normal text-slate-500">
                            Quick pick
                            <select
                              className="ghost-select mt-1"
                              aria-label="Quick pick fallback model id"
                              value={fallbackModelQuickPickValue}
                              onChange={(event) => {
                                const value = event.target.value;
                                if (!value) {
                                  return;
                                }
                                updateDraft((current) => ({
                                  ...current,
                                  runtime_profile: current.runtime_profile
                                    ? {
                                        ...current.runtime_profile,
                                        llm_config: {
                                          ...current.runtime_profile.llm_config,
                                          llm_orchestration: {
                                            ...llmOrchestration,
                                            fallback_model_id: value,
                                          },
                                        },
                                      }
                                    : current.runtime_profile,
                                }));
                                setModelOptionsTick((tick) => tick + 1);
                              }}
                            >
                              <option value="">— Choose model id (any provider) —</option>
                              {fallbackModelIdPickerOptions.map((id) => (
                                <option key={id} value={id}>
                                  {id}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="mt-1.5 block text-[0.65rem] font-normal text-slate-500">
                            Or type a fallback model id
                          <input
                            className="ghost-input mt-1"
                            list={fallbackModelIdDatalistId}
                            value={llmOrchestration.fallback_model_id ?? ""}
                            onChange={(event) =>
                              updateDraft((current) => ({
                                ...current,
                                runtime_profile: current.runtime_profile
                                  ? {
                                      ...current.runtime_profile,
                                      llm_config: {
                                        ...current.runtime_profile.llm_config,
                                        llm_orchestration: {
                                          ...llmOrchestration,
                                          fallback_model_id: event.target.value || null,
                                        },
                                      },
                                    }
                                  : current.runtime_profile,
                              }))
                            }
                            onBlur={() => setModelOptionsTick((tick) => tick + 1)}
                            placeholder="e.g. openai/gpt-5.1-nano"
                          />
                          </label>
                          <datalist id={fallbackModelIdDatalistId}>
                            {fallbackModelIdPickerOptions.map((id) => (
                              <option key={id} value={id} />
                            ))}
                          </datalist>
                        </div>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={llmOrchestration.include_primary_answer_context}
                            onChange={() =>
                              updateDraft((current) => ({
                                ...current,
                                runtime_profile: current.runtime_profile
                                  ? {
                                      ...current.runtime_profile,
                                      llm_config: {
                                        ...current.runtime_profile.llm_config,
                                        llm_orchestration: {
                                          ...llmOrchestration,
                                          include_primary_answer_context: !llmOrchestration.include_primary_answer_context,
                                        },
                                      },
                                    }
                                  : current.runtime_profile,
                              }))
                            }
                          />
                          Include primary model draft as context in second pass
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.voice = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Voice & status</div>
                <div className="grid gap-1.5">
                  <label className="block text-[0.68rem] text-slate-500">
                    Language
                    <input className="ghost-input mt-1" value={draft.language} onChange={(event) => updateDraft((current) => ({ ...current, language: event.target.value }))} />
                  </label>
                  <label className="block text-[0.68rem] text-slate-500">
                    Voice ID
                    <input className="ghost-input mt-1" value={draft.voice_id} onChange={(event) => updateDraft((current) => ({ ...current, voice_id: event.target.value }))} />
                  </label>
                  <label className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[0.68rem] text-slate-600">
                    <input type="checkbox" checked={draft.enabled} onChange={() => updateDraft((current) => ({ ...current, enabled: !current.enabled }))} />
                    Agent enabled
                  </label>
                  <label className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[0.68rem] text-slate-600">
                    <input
                      type="checkbox"
                      checked={draft.is_default}
                      onChange={() =>
                        updateDraft((current) => ({
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
                </div>
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.runtime = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.68rem] text-slate-500"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Runtime summary</div>
                <div className="space-y-0.5">
                  <div><span className="font-semibold text-slate-900">Profile:</span> {runtimeProfile?.name ?? "Unsaved runtime profile"}</div>
                  <div><span className="font-semibold text-slate-900">Provider:</span> {runtimeProfile?.llm_config.provider ?? "openai"}</div>
                  <div><span className="font-semibold text-slate-900">KB defaults:</span> {(runtimeProfile?.kb_config.default_corpora ?? []).join(", ") || "default"}</div>
                  <div><span className="font-semibold text-slate-900">Embedding model:</span> {runtimeProfile?.kb_config.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL}</div>
                  {selectedAgent && <div><span className="font-semibold text-slate-900">Agent id:</span> {selectedAgent.id}</div>}
                </div>
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.collections = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Collections</div>
                <div className="space-y-1">
                  {collections.map((collection) => {
                    const selected = (runtimeProfile?.kb_config.default_corpora ?? []).includes(collection.slug);
                    return (
                      <label key={collection.id} className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[0.66rem] text-slate-600">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() =>
                            updateDraft((current) => {
                              const currentCorpora = current.runtime_profile?.kb_config.default_corpora ?? [];
                              const nextCorpora = selected
                                ? currentCorpora.filter((value) => value !== collection.slug)
                                : [...currentCorpora, collection.slug];
                              return {
                                ...current,
                                runtime_profile: current.runtime_profile
                                  ? {
                                      ...current.runtime_profile,
                                      kb_config: {
                                        ...current.runtime_profile.kb_config,
                                        default_corpora: nextCorpora,
                                      },
                                    }
                                  : current.runtime_profile,
                              };
                            })
                          }
                        />
                        <span>
                          <span className="block font-semibold text-slate-900">{collection.name}</span>
                          <span>{collection.slug}</span>
                        </span>
                      </label>
                    );
                  })}
              {collections.length === 0 && <div className="text-[0.66rem] text-slate-500">No managed collections exist yet. Create them in Data Sources first.</div>}
                </div>
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.tools = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="mb-1 text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Tools</div>
                <div className="space-y-1">
                  {(runtimeProfile?.tool_policy_config.tools ?? [])
                    .filter((tool) => tool.id !== ODOO_TOOL_ID)
                    .map((tool) => (
                      <div key={tool.id} className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[0.66rem] text-slate-600">
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={tool.enabled}
                            onChange={() =>
                              updateDraft((current) => ({
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
                          <div className="mt-1.5 grid gap-1.5">
                            {[...(tool.allowed_urls ?? []), ""].map((value, idx) => (
                              <div key={`${tool.id}-url-${idx}`} className="flex items-center gap-2">
                                <input
                                  className="ghost-input"
                                  placeholder={idx === 0 ? "https://example.com" : "Additional approved website"}
                                  value={value}
                                  onChange={(event) =>
                                    updateDraft((current) => ({
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
                                                  allowed_urls: allowedUrls.map((item) => item.trim()).filter(Boolean),
                                                };
                                              }),
                                            },
                                          }
                                        : current.runtime_profile,
                                    }))
                                  }
                                />
                                {idx < (tool.allowed_urls?.length ?? 0) && (
                                  <button
                                    type="button"
                                    className="ghost-btn shrink-0"
                                    onClick={() =>
                                      updateDraft((current) => ({
                                        ...current,
                                        runtime_profile: current.runtime_profile
                                          ? {
                                              ...current.runtime_profile,
                                              tool_policy_config: {
                                                tools: current.runtime_profile.tool_policy_config.tools.map((entry) => {
                                                  if (entry.id !== tool.id) return entry;
                                                  return {
                                                    ...entry,
                                                    allowed_urls: (entry.allowed_urls ?? []).filter((_item, urlIdx) => urlIdx !== idx),
                                                  };
                                                }),
                                              },
                                            }
                                          : current.runtime_profile,
                                      }))
                                    }
                                  >
                                    Remove
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
                <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-2">
                  <div className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-slate-500">HubTiger bindings</div>
                  <div className="mt-1 grid grid-cols-[1.4fr_0.9fr_0.8fr] gap-2 text-[0.66rem]">
                    <div className="font-semibold text-slate-600">Tool</div>
                    <div className="font-semibold text-slate-600">Category</div>
                    <div className="font-semibold text-slate-600">Mode</div>
                    {[
                      "hubtiger_booking_availability",
                      "hubtiger_booking_create",
                      "hubtiger_job_search",
                      "hubtiger_job_get",
                      "hubtiger_quote_preview_price",
                      "hubtiger_quote_add_line_item",
                    ].map((toolId) => (
                      <div key={toolId} className="contents">
                        <div className="text-slate-700">{toolId}</div>
                        <div className="text-slate-500">consumer_customer</div>
                        <div className="text-slate-500">read_only / env</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[0.62rem] text-slate-500">
                    Write-style HubTiger actions remain guarded when <code>HUBTIGER_TOOL_ACCESS=read_only</code>.
                  </div>
                </div>
              </section>

              <section
                ref={(node) => {
                  sectionRefs.current.odoo = node;
                }}
                className="scroll-mt-20 rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.66rem] text-slate-600"
              >
                <div className="text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Odoo</div>
                <div className="mt-1 rounded-md border border-slate-200 bg-white px-2 py-2 text-[0.7rem] text-slate-600">
                  Legacy per-agent Odoo access toggles are retired. Finance execution now runs through MAS v2 server-side routing.
                </div>
                {selectedAgent?.name?.toLowerCase() === "magic mike" && (
                  <div className="mt-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[0.68rem] text-emerald-700">
                    Magic Mike consumer mode: Odoo is hard-disabled.
                  </div>
                )}
                <div className="mt-1 text-[0.68rem] text-slate-500">
                  Legacy policy snapshot: {odooEnabled ? "enabled" : "disabled"} / {odooCatalogEntry?.status ?? "retired"}.
                </div>
                {toolPolicyError && (
                  <div className="mt-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700">
                    {toolPolicyError}
                  </div>
                )}
                {toolPolicySavedAt && <div className="mt-1 text-[0.68rem] text-slate-400">{toolPolicySavedAt}</div>}
              </section>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
