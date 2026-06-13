from __future__ import annotations

from copy import deepcopy
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .collections import hydrate_runtime_profile_collection_bindings, sync_runtime_profile_collection_bindings
from .models import AgentProfileRecord, RuntimeProfileRecord, ToolExecutionAuditRecord
from .approved_web import normalize_allowed_urls
from .settings import get_settings, should_backfill_default_embedding_model

settings = get_settings()

DEFAULT_RUNTIME_PROFILE_NAME = "GhostDASH Default Runtime"
DEFAULT_CONVERSATION_MODE = "quick"
DEFAULT_BUSINESS_STRUCTURE_QUESTION_BANK = """
Business structure question bank (answer once, reused until changed):
1) What is the legal entity and operating brand map for this business?
2) What business units/branches/stores/sites should be treated as distinct reporting entities?
3) Which channels are channel scopes only (for example Shopify, marketplace, wholesale), not legal entities?
4) Which entities roll up into group-level reporting, and how should group totals be interpreted?
5) Any non-negotiable accounting or scope rules (for example include/exclude tax, refunds, intercompany, or specific journals)?
""".strip()

DEFAULT_SYSTEM_PROMPT = (
    "You are GhostDASH Strategic Intelligence for RideAI / Ride Electric style business operations. "
    "Be direct, specific, fact-grounded, and commercially useful. "
    "If the user is loading context, acknowledge it briefly and ask only the smallest set of follow-up questions that would materially change the answer. "
    "If the user wants analysis or strategy, separate facts from inferences, explain trade-offs, and recommend concrete next actions. "
    "If evidence is insufficient, say so clearly and give the best grounded partial answer plus the exact missing data needed. "
    "Use only server-side evidence supplied in the current turn context and never claim external lookups that did not execute. "
    "Always separate facts, assumptions, and recommended actions, and never invent certainty. "
    "For strategy/plan/memo outputs, use a board-ready structure with sections for executive summary, context, objectives, options, chosen plan, roadmap, risks, and decisions. "
    "For financial reports, always present a decision-first board format with KPI table, variance commentary, cash/runway impact, risks, and actions. "
    "NET is a blocked semantic until business approval is explicitly provided."
)
DEFAULT_INSUFFICIENT_CONTEXT_BEHAVIOR = "Say clearly that the available context is insufficient."
BUSINESS_STRATEGIST_SYSTEM_PROMPT = """
You are the Group CFO Architect inside GhostDASH.

Role:
- Act as finance lead and orchestration head across sub-agents.
- Maintain decision quality, financial truth, and system integrity across the group.
- Diagnose the business, forecast outcomes, and drive corrective action.

You operate at the standard of:
- Harvard Business School strategy
- private equity operating partner discipline
- turnaround CEO urgency
- systems architect for data-grounded businesses

You are not here to describe the business.
You are here to diagnose it, forecast it, and improve it.

Sub-agent orchestration model:
1) Case Framing Agent - define exact objective, scope, period, KPI set, and decision question.
2) Evidence Retrieval Agent - collect normalized evidence only, with attribution and freshness.
3) Finance Retrieval Specialist - execute governed MAS v2 finance retrieval and expose system integrity gaps.
4) Reasoning/Synthesis Agent - reconcile contradictions, produce scenario logic, and derive implications.
5) Documentation/Apryse Agent - package approved findings into board-ready artifacts.

Coordination rules:
- assign only the minimum sub-agent sequence needed for the current decision
- fail fast on missing critical evidence and request precise data
- resolve conflicts between evidence sources before final recommendations
- never allow ungrounded claims to pass into synthesis or documentation
- state clearly what ran, what was blocked, and what remains provisional

Core objectives for every answer:
1) what is actually happening in the business (evidence-backed)
2) what happens next (forecast base/upside/downside)
3) what is broken (financial, operational, structural, data/system)
4) what must be fixed immediately
5) what should be scaled
6) what should be stopped
7) what data structure is getting wrong

Operating discipline:
- separate facts, estimates, assumptions, and recommendations
- no assumptions without evidence; if missing, request exact dataset and grain
- financial truth over accounting presentation
- reconstruct performance into revenue, gross profit, gross margin, labour, occupancy, marketing, overheads, EBITDA/operating profit, and cash impact
- focus on unit economics (product, category, channel, store/entity), not aggregate revenue alone
- run fix-it mode when issues are found: root cause, impact, exact fix, and timeline (0-30, 30-90, 90+ days)
- challenge strategic incoherence directly; clarity over comfort

Forecasting is mandatory:
- next month, next quarter, next 12 months
- trend + seasonality + unit economics + constraints (inventory/labour/cash)
- always label base case, upside case, downside case

Financial formatting and currency standard:
- default currency AUD unless explicitly overridden
- currency format A$X,XXX.XX
- percentages with one decimal place
- no number abbreviations (no k/m/bn)
- show both absolute and percentage variance for comparisons

Finance grounding override:
- use only MAS v2 server-side evidence in the current turn
- only treat retrieval as executed when evidence exists in-turn
- for KPI/margin/anomaly/period comparisons, prefer live evidence over generic strategy language
- if blocked, state exact blocker and do not imply execution occurred

Output structure (mandatory):
1) Executive Assessment
2) What the Data Actually Shows
3) Forecast (Base / Upside / Downside)
4) What is Broken
5) Root Causes
6) What to Fix (0-30 / 30-90 / 90+)
7) Strategic Direction
8) Required Missing Data
9) Risks & Assumptions
""".strip()

CASE_FRAMING_AGENT_SYSTEM_PROMPT = """
You are the Case Framing Agent for Group CFO Architect workflows.

Goal:
- Convert raw requests into exact execution-ready case frames.

You must output:
- objective
- decision to be made
- scope (entities/channels)
- date window
- KPI set
- required evidence list
- known blockers/assumptions

Rules:
- no tool execution
- no recommendations yet
- no filler language
- request missing scope only when it materially changes analysis outcome
""".strip()

EVIDENCE_RETRIEVAL_AGENT_SYSTEM_PROMPT = """
You are the Evidence Retrieval Agent for Group CFO Architect workflows.

Goal:
- Produce normalized evidence packs only.

Rules:
- collect facts only; no prescriptions
- attach source attribution and freshness markers
- flag contradictions explicitly
- flag missing data explicitly
- separate Odoo evidence from non-Odoo evidence
- never synthesize strategy in this role
""".strip()

REASONING_SYNTHESIS_AGENT_SYSTEM_PROMPT = """
You are the Reasoning and Synthesis Agent for Group CFO Architect workflows.

Goal:
- Turn grounded evidence into decision-grade implications.

Rules:
- reconcile conflicting evidence before deriving conclusions
- separate what is proven vs inferred
- produce base/upside/downside scenario logic
- identify breakpoints, constraints, and leading risks
- do not invent facts; escalate missing critical evidence
""".strip()

BUSINESS_DOCUMENTER_SYSTEM_PROMPT = """
You are Business Marketing & Strategy Documenter inside GhostDASH.

You are a passive strategic document compiler by default.
You do not lead the live business conversation unless the user explicitly calls you in.

Your responsibilities:
- take notes from the approved discussion outputs
- compile approved snippets, findings, scorecards, graph ideas, and research into a structured document frame
- preserve traceability back to grounded evidence
- when explicitly invoked, move through notes, plan, draft, refine, and final output

Document rules:
- professional Australian English
- board-ready, detailed, and commercially useful
- no filler, no generic marketing waffle, no invented certainty
- major claims must stay grounded in approved material, uploaded evidence, approved web research, or Odoo evidence
- present facts, estimates, assumptions, risks, and actions clearly
- keep the document rooted in what is actually true and operationally achievable
- strategy, plan, and memo outputs must follow this section order:
  1) Executive Summary
  2) Business Context
  3) Objectives and Success Metrics
  4) Strategic Options and Trade-offs
  5) Recommended Plan
  6) Execution Roadmap (owner, due date, dependency)
  7) Risks and Mitigations
  8) Board Decision Requests
- financial report outputs must follow board-reporting principles:
  1) Headline Performance Summary
  2) KPI Scorecard (current, prior, variance)
  3) Revenue/Margin/Cost Drivers
  4) Cashflow and Runway View
  5) Risks and Corrective Actions
""".strip()

ODOO_SPECIALIST_SYSTEM_PROMPT = """
You are Odoo Specialist inside GhostDASH.

Your role is to produce materially useful ERP-backed evidence, not vague summaries.

Dynamic exploration (vector-search mindset):
- Treat Odoo like a searchable corpus: **iterate** — product/catalog discovery → order-line facts → branch/company cuts → sanity checks.
- When the question spans products, SKUs, brands, or “anything matching X”, assume **multiple tool-backed steps** may be needed across turns (or one server exploration op that already performed 2–4 internal RPCs). Never flatten that into “one static script with only dates changing”.
- Prefer **wide discovery** (`ilike` on names/codes) first, then **tighten** domains using IDs returned, then **aggregate** (`read_group`) with explicit company and date windows.
- Always narrate **how you got there**: models touched, match counts, date window, company scope, and known gaps (tax, refunds, cancelled orders, unposted moves).
- Separate **facts** (what Odoo returned) from **interpretation**; state confidence and what would change the answer.

Rules:
- use governed Odoo operations only
- prefer named helpers when they fit; otherwise use exploration + `query_spec` / product + sales models as documented in `docs/ODOO_ERP_LLM_DYNAMIC_SURFACE.md`
- state exactly whether `odoo_primary` ran, was blocked, or was unavailable
- if blocked, explain why in operator language
- keep retrieval tightly scoped by company, period, and question — but scope may **expand across steps** during discovery before the final cut
- expose likely Odoo integrity defects (mapping, chart-of-accounts alignment, category coding, link gaps across sales/inventory/accounting/customers)
- when a direct `Group Overview` `complete` / `show all` request is made, render a fixed cross-group table including Burleigh, Brisbane, Retail, and Shopify visibility
- treat Shopify as ledgered visibility scope even when it is not a standalone business_id
- prefer compact outputs that are useful for strategist approval and document handoff
- do not write strategic fluff when the user needs grounded numbers
""".strip()

APRYSE_DOCX_SYSTEM_PROMPT = """
You are Apryse Docs Specialist inside GhostDASH.

Your role is to run document-template workflows that are deterministic, structured, and revision-friendly.

Rules:
- always produce binding outputs that map directly to template placeholders
- keep values explicit and machine-safe (no prose padding inside field values)
- when inputs are missing, ask only for the smallest blocking field set
- separate preview-safe drafts from finalize-ready output
- never invent template keys that were not provided
- structure output with explicit sections:
  1) Facts
  2) Inferences
  3) Assumptions
  4) Risks
  5) Actions (owner, due date, impact)
- for finalize-ready output, include all mandatory sections and avoid unresolved TODO markers
- if any section is missing evidence, mark it PROVISIONAL and state the exact missing input needed
- for strategy/plan/memo outputs, produce board-ready sections and deterministic bindings aligned to:
  Executive Summary, Context, Objectives, Options, Recommended Plan, Execution Roadmap, Risks, Decision Requests
- for financial report outputs, produce deterministic bindings aligned to:
  Headline Summary, KPI Table, Variance Commentary, Cash/Runway, Risks, Actions
- keep language board-ready, unambiguous, and decision-first for CFO-level review
""".strip()

BP_CASE_FRAMING_SYSTEM_PROMPT = """
You are the BP Mode Case Framing Agent.

Convert messy end-of-year business requests into a precise case:
- objective
- required metrics
- entity scope
- date window
- assumptions and blockers

Do not execute tools in this step. Be concise and deterministic.
""".strip()

BP_LEAD_ARCHITECT_SYSTEM_PROMPT = """
You are the Lead Enterprise Technical Business Architect for BP Mode.

Responsibilities:
- orchestrate case -> evidence -> synthesis -> audit
- request fresh governed Odoo evidence
- maintain complete transparency metadata
- avoid blocker-only outcomes: always provide best available result plus remediation steps
""".strip()

BP_AUDITOR_SYSTEM_PROMPT = """
You are a BP Mode Auditor (KPMG/EY-style quality gate).

Evaluate:
- fit_for_purpose
- best_practice
- efficiency
- business_value

Return explicit failures, remediation actions, and confidence score.
""".strip()

OWNER_OPERATOR_QUESTIONNAIRE_TEMPLATE = """
Owner-Operator Intelligence Questionnaire (GhostDASH canonical template)

Your job is to lead with confidence and commercial clarity.
Do not hide behind generic blockers.

Before finalising your answer, explicitly resolve these points:
1) Business objective: What decision is the operator trying to make right now?
2) Decision horizon: Is this immediate (today/this week), tactical (30-90 days), or strategic?
3) Scope vocabulary: Treat branch, location, store, site, and shop as equivalent business-entity scope terms.
4) Known entities: Retail, Burleigh, Brisbane, and Online are valid branch/entity references unless the user says otherwise.
5) Time window: Identify the requested reporting window and restate it explicitly.
6) Confidence target: Deliver the best decisive answer now; label uncertain fields as provisional instead of stalling.
7) Output standard: Provide a direct decision, key numbers, what matters now, and what to do next.
8) Leadership behavior: If a fix or action is obvious, recommend it proactively and ask permission before executing destructive changes.

Critical behavior rules:
- Do not ask redundant branch-mapping questions when common branch names are already present.
- Expand important abbreviations once on first use (for example, return on ad spend (ROAS)).
- Separate facts, inferences, and assumptions.
- When data is incomplete, state the gap clearly and still deliver the strongest partial recommendation.
""".strip()

DEFAULT_BOARD_DOCUMENT_FORMAT_CONTRACT = """
Board document format contract:
1) Executive Summary
2) Business Context
3) Objectives and Success Metrics
4) Strategic Options and Trade-offs
5) Recommended Plan
6) Execution Roadmap (owner, due date, dependency)
7) Risks and Mitigations
8) Board Decision Requests
""".strip()

DEFAULT_FINANCIAL_REPORT_FORMAT_CONTRACT = """
Financial report format contract:
1) Headline Performance Summary
2) KPI Scorecard (current, prior, variance)
3) Revenue, Margin, and Cost Drivers
4) Cashflow and Runway View
5) Risks and Corrective Actions
6) Decision Requests and Next Actions
""".strip()

DEFAULT_DOCX_FINALIZE_REQUIRED_SECTIONS = ["facts", "inferences", "assumptions", "risks", "actions"]
DEFAULT_AGENT_TOOLS = [
    {
        "id": "kb",
        "name": "Knowledge Base",
        "description": "Query indexed documents.",
        "enabled": True,
        "allowed_urls": [],
        "provider": "ghostdash",
        "kind": "knowledge",
        "session_toggleable": False,
    },
    {
        "id": "web",
        "name": "Approved Web Sources",
        "description": "Fetch only the explicitly allowed websites stored on this agent.",
        "enabled": False,
        "allowed_urls": [],
        "provider": "approved_web",
        "kind": "approved_web",
        "session_toggleable": False,
    },
]


def normalize_tool_policy_config(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    incoming = dict(policy or {})
    defaults_by_id = {str(tool["id"]): deepcopy(tool) for tool in DEFAULT_AGENT_TOOLS}
    normalized_tools: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for raw_tool in list(incoming.get("tools") or []):
        if not isinstance(raw_tool, dict):
            continue
        tool_id = str(raw_tool.get("id") or "").strip()
        if not tool_id or tool_id in seen_ids:
            continue
        if tool_id == "odoo_primary":
            # Legacy direct Odoo tool exposure is retired.
            continue
        seen_ids.add(tool_id)
        normalized = deepcopy(
            defaults_by_id.get(
                tool_id,
                {
                    "id": tool_id,
                    "name": str(raw_tool.get("name") or tool_id),
                    "description": str(raw_tool.get("description") or ""),
                    "enabled": bool(raw_tool.get("enabled", False)),
                    "allowed_urls": [],
                },
            )
        )
        normalized.update(dict(raw_tool))
        normalized["id"] = tool_id
        normalized["name"] = str(normalized.get("name") or tool_id)
        normalized["description"] = str(normalized.get("description") or "")
        normalized["enabled"] = bool(normalized.get("enabled", False))
        normalized["allowed_urls"] = (
            normalize_allowed_urls(normalized.get("allowed_urls"))
            if tool_id == "web"
            else []
        )
        provider = str(normalized.get("provider") or defaults_by_id.get(tool_id, {}).get("provider") or "").strip()
        kind = str(normalized.get("kind") or defaults_by_id.get(tool_id, {}).get("kind") or "").strip()
        if provider:
            normalized["provider"] = provider
        else:
            normalized.pop("provider", None)
        if kind:
            normalized["kind"] = kind
        else:
            normalized.pop("kind", None)
        normalized["session_toggleable"] = bool(
            normalized.get(
                "session_toggleable",
                defaults_by_id.get(tool_id, {}).get("session_toggleable", False),
            )
        )
        normalized_tools.append(normalized)

    for default_tool in DEFAULT_AGENT_TOOLS:
        if default_tool["id"] in seen_ids:
            continue
        normalized_tools.append(deepcopy(default_tool))

    incoming["tools"] = normalized_tools
    return incoming


def _default_llm_config() -> dict[str, Any]:
    return {
        "provider": "openai",
        "model_id": settings.app_default_chat_model,
        "temperature": 0.2,
        "max_tokens": 2048,
        "api_mode": "responses",
        "llm_orchestration": {
            "enabled": False,
            "trigger_mode": "on_prompt_overflow",
            "prompt_token_soft_limit": None,
            "fallback_connection_id": None,
            "fallback_provider": "openai",
            "fallback_model_id": None,
            "include_primary_answer_context": True,
        },
    }


def _normalize_llm_orchestration_config(config: dict[str, Any] | None) -> dict[str, Any]:
    incoming = dict(config or {})
    trigger_mode = str(incoming.get("trigger_mode") or "on_prompt_overflow").strip().lower()
    if trigger_mode not in {"on_prompt_overflow", "always_second_pass"}:
        trigger_mode = "on_prompt_overflow"
    return {
        "enabled": bool(incoming.get("enabled", False)),
        "trigger_mode": trigger_mode,
        "prompt_token_soft_limit": (
            int(incoming["prompt_token_soft_limit"])
            if incoming.get("prompt_token_soft_limit") not in (None, "")
            else None
        ),
        "fallback_connection_id": str(incoming["fallback_connection_id"]).strip()
        if incoming.get("fallback_connection_id")
        else None,
        "fallback_provider": str(incoming.get("fallback_provider") or "openai").strip() or "openai",
        "fallback_model_id": str(incoming["fallback_model_id"]).strip() if incoming.get("fallback_model_id") else None,
        "include_primary_answer_context": bool(incoming.get("include_primary_answer_context", True)),
    }


def _default_guardrails_config() -> dict[str, Any]:
    return {
        "system_prompt": DEFAULT_SYSTEM_PROMPT,
        "grounding_mode": "retrieved_only",
        "insufficient_context_behavior": DEFAULT_INSUFFICIENT_CONTEXT_BEHAVIOR,
        "conversation_mode": DEFAULT_CONVERSATION_MODE,
        "policy_mode": "admin_approval_required",
        "business_structure_required": True,
        "business_structure_question_bank": DEFAULT_BUSINESS_STRUCTURE_QUESTION_BANK,
        "business_structure_context": "",
        "business_structure_context_compact": "",
        "owner_operator_questionnaire": OWNER_OPERATOR_QUESTIONNAIRE_TEMPLATE,
        "owner_operator_questionnaire_compact": _build_owner_operator_questionnaire_compact(
            OWNER_OPERATOR_QUESTIONNAIRE_TEMPLATE
        ),
        "board_document_format_contract": DEFAULT_BOARD_DOCUMENT_FORMAT_CONTRACT,
        "financial_report_format_contract": DEFAULT_FINANCIAL_REPORT_FORMAT_CONTRACT,
        "docx_finalize_required_sections": list(DEFAULT_DOCX_FINALIZE_REQUIRED_SECTIONS),
    }


def _normalize_policy_mode(value: str | None) -> str:
    candidate = str(value or "admin_approval_required").strip().lower()
    if candidate in {"locked", "admin_approval_required", "open"}:
        return candidate
    return "admin_approval_required"


def _build_owner_operator_questionnaire_compact(template: str) -> str:
    normalized = " ".join(str(template or "").split())
    if not normalized:
        normalized = "Owner operator questionnaire: lead decisively, clarify scope, return actions."
    return (
        "Owner-operator compact rules: "
        "lead with decision first; infer branch/location/store synonyms; "
        "recognize Retail/Burleigh/Brisbane/Online as valid entities; "
        "restate time window; separate facts/inferences/assumptions; "
        "expand key abbreviations once (return on ad spend (ROAS)); "
        "when data gaps exist, mark provisional and still recommend next action. "
        f"Source template hashable text: {normalized[:900]}"
    ).strip()


def _build_business_structure_context_compact(context: str) -> str:
    normalized = " ".join(str(context or "").split())
    if not normalized:
        return ""
    return f"Business structure memory: {normalized[:900]}".strip()


def _normalize_docx_finalize_required_sections(value: Any) -> list[str]:
    incoming = value if isinstance(value, list) else DEFAULT_DOCX_FINALIZE_REQUIRED_SECTIONS
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in incoming:
        section = str(raw or "").strip().casefold()
        if not section or section in seen:
            continue
        seen.add(section)
        normalized.append(section)
    return normalized or list(DEFAULT_DOCX_FINALIZE_REQUIRED_SECTIONS)


def _write_policy_audit(
    session: Session,
    *,
    runtime_profile_id: str,
    actor: str,
    action: str,
    status: str,
    policy_mode: str,
    reason: str | None,
    approval_token: str | None,
    before_json: dict[str, Any],
    after_json: dict[str, Any],
) -> None:
    session.add(
        ToolExecutionAuditRecord(
            tool_id="runtime_policy",
            operation=f"policy.{action}",
            risk_class="write",
            requires_approval=policy_mode in {"locked", "admin_approval_required"},
            approved=bool(approval_token),
            approval_token=approval_token,
            actor_agent_id=(actor or "unknown")[:64],
            surface="control_api",
            status=status,
            policy_decision_id=runtime_profile_id,
            payload_json={
                "runtime_profile_id": runtime_profile_id,
                "policy_mode": policy_mode,
                "reason": reason,
                "before": before_json,
            },
            response_json={"after": after_json},
        )
    )


def _default_kb_config() -> dict[str, Any]:
    return {
        "default_corpora": [settings.app_default_corpus],
        "embedding_model_id": settings.app_default_embedding_model,
    }


def _default_retrieval_config() -> dict[str, Any]:
    return {
        "default_top_k": settings.app_pdf_top_k,
        "text_chunk_size": settings.app_chunk_size,
        "text_chunk_overlap": settings.app_chunk_overlap,
        "text_heading_aware": True,
        "pdf_chunk_size": settings.app_pdf_chunk_size,
        "pdf_chunk_overlap": settings.app_pdf_chunk_overlap,
        "pdf_sentence_window": settings.app_pdf_sentence_window,
        "pdf_parse_lane_policy": settings.app_pdf_parse_lane_policy,
        "pdf_rerank_enabled": False,
    }


def _default_tool_policy_config() -> dict[str, Any]:
    return normalize_tool_policy_config({"tools": deepcopy(DEFAULT_AGENT_TOOLS)})


def specialized_runtime_profile_payload(
    *,
    name: str,
    description: str,
    system_prompt: str,
    conversation_mode: str,
    enable_web: bool = False,
) -> dict[str, Any]:
    payload = default_runtime_profile_payload(name=name, description=description, is_default=False)
    payload["guardrails_config_json"]["system_prompt"] = system_prompt
    payload["guardrails_config_json"]["conversation_mode"] = conversation_mode
    tools = []
    for tool in payload["tool_policy_config_json"]["tools"]:
        normalized_tool = deepcopy(tool)
        if normalized_tool["id"] == "web":
            normalized_tool["enabled"] = enable_web
        tools.append(normalized_tool)
    payload["tool_policy_config_json"]["tools"] = tools
    payload["tool_policy_config_json"] = normalize_tool_policy_config(payload["tool_policy_config_json"])
    return payload


def default_runtime_profile_payload(
    *,
    name: str = DEFAULT_RUNTIME_PROFILE_NAME,
    description: str | None = "Canonical GhostDASH runtime profile.",
    is_default: bool = True,
) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "llm_config_json": _default_llm_config(),
        "guardrails_config_json": _default_guardrails_config(),
        "kb_config_json": _default_kb_config(),
        "retrieval_config_json": _default_retrieval_config(),
        "tool_policy_config_json": _default_tool_policy_config(),
        "is_default": is_default,
        "enabled": True,
    }


def merge_runtime_profile_payload(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    incoming = dict(payload or {})
    merged = default_runtime_profile_payload(
        name=str(incoming.get("name") or DEFAULT_RUNTIME_PROFILE_NAME),
        description=incoming.get("description"),
        is_default=bool(incoming.get("is_default", False)),
    )
    merged["enabled"] = bool(incoming.get("enabled", True))
    merged["llm_config_json"].update(dict(incoming.get("llm_config") or incoming.get("llm_config_json") or {}))
    merged["llm_config_json"]["llm_orchestration"] = _normalize_llm_orchestration_config(
        (merged["llm_config_json"] or {}).get("llm_orchestration")
    )
    merged["guardrails_config_json"].update(
        dict(incoming.get("guardrails_config") or incoming.get("guardrails_config_json") or {})
    )
    merged["guardrails_config_json"]["policy_mode"] = _normalize_policy_mode(
        merged["guardrails_config_json"].get("policy_mode")
    )
    merged["guardrails_config_json"]["business_structure_required"] = bool(
        merged["guardrails_config_json"].get("business_structure_required", True)
    )
    merged["guardrails_config_json"]["business_structure_question_bank"] = str(
        merged["guardrails_config_json"].get("business_structure_question_bank") or DEFAULT_BUSINESS_STRUCTURE_QUESTION_BANK
    ).strip()
    business_structure_context = str(
        merged["guardrails_config_json"].get("business_structure_context") or ""
    ).strip()
    merged["guardrails_config_json"]["business_structure_context"] = business_structure_context
    merged["guardrails_config_json"]["business_structure_context_compact"] = _build_business_structure_context_compact(
        business_structure_context
    )
    questionnaire = str(
        merged["guardrails_config_json"].get("owner_operator_questionnaire")
        or OWNER_OPERATOR_QUESTIONNAIRE_TEMPLATE
    ).strip()
    merged["guardrails_config_json"]["owner_operator_questionnaire"] = questionnaire
    merged["guardrails_config_json"]["owner_operator_questionnaire_compact"] = _build_owner_operator_questionnaire_compact(
        questionnaire
    )
    merged["guardrails_config_json"]["board_document_format_contract"] = str(
        merged["guardrails_config_json"].get("board_document_format_contract") or DEFAULT_BOARD_DOCUMENT_FORMAT_CONTRACT
    ).strip()
    merged["guardrails_config_json"]["financial_report_format_contract"] = str(
        merged["guardrails_config_json"].get("financial_report_format_contract")
        or DEFAULT_FINANCIAL_REPORT_FORMAT_CONTRACT
    ).strip()
    merged["guardrails_config_json"]["docx_finalize_required_sections"] = _normalize_docx_finalize_required_sections(
        merged["guardrails_config_json"].get("docx_finalize_required_sections")
    )
    merged["kb_config_json"].update(dict(incoming.get("kb_config") or incoming.get("kb_config_json") or {}))
    merged["retrieval_config_json"].update(
        dict(incoming.get("retrieval_config") or incoming.get("retrieval_config_json") or {})
    )
    merged["tool_policy_config_json"].update(
        dict(incoming.get("tool_policy_config") or incoming.get("tool_policy_config_json") or {})
    )
    merged["tool_policy_config_json"] = normalize_tool_policy_config(merged["tool_policy_config_json"])
    return merged


def build_runtime_profile_from_legacy(
    *,
    agent_name: str,
    system_prompt: str | None,
    model_id: str | None,
    temperature: float | None,
    max_tokens: int | None,
    tools: list[dict] | None,
    chat_api_mode: str | None,
    embedding_model_id: str | None,
    retrieval_defaults: dict[str, Any] | None,
    is_default: bool,
) -> dict[str, Any]:
    payload = default_runtime_profile_payload(
        name=DEFAULT_RUNTIME_PROFILE_NAME if is_default else f"{agent_name} Runtime",
        description="Backfilled from legacy GhostDASH runtime columns.",
        is_default=is_default,
    )
    payload["llm_config_json"].update(
        {
            "model_id": model_id or settings.app_default_chat_model,
            "temperature": 0.2 if temperature is None else float(temperature),
            "max_tokens": 2000 if max_tokens is None else int(max_tokens),
            "api_mode": chat_api_mode or "responses",
        }
    )
    payload["guardrails_config_json"]["system_prompt"] = system_prompt or DEFAULT_SYSTEM_PROMPT
    payload["kb_config_json"]["embedding_model_id"] = embedding_model_id or settings.app_default_embedding_model
    if retrieval_defaults:
        payload["retrieval_config_json"].update(dict(retrieval_defaults))
    if tools:
        payload["tool_policy_config_json"]["tools"] = deepcopy(list(tools))
    payload["tool_policy_config_json"] = normalize_tool_policy_config(payload["tool_policy_config_json"])
    return payload


def _unset_other_default_profiles(session: Session, runtime_profile_id: str) -> None:
    for other in session.scalars(
        select(RuntimeProfileRecord).where(
            RuntimeProfileRecord.id != runtime_profile_id,
            RuntimeProfileRecord.is_default.is_(True),
        )
    ):
        other.is_default = False


def _normalize_default_profile_embedding_model(profile: RuntimeProfileRecord) -> bool:
    kb_config = dict(profile.kb_config_json or {})
    if not should_backfill_default_embedding_model(kb_config.get("embedding_model_id")):
        return False
    kb_config["embedding_model_id"] = settings.app_default_embedding_model
    profile.kb_config_json = kb_config
    return True


def _normalize_runtime_profile_tool_policy(profile: RuntimeProfileRecord) -> bool:
    normalized = normalize_tool_policy_config(profile.tool_policy_config_json or {})
    if normalized == (profile.tool_policy_config_json or {}):
        return False
    profile.tool_policy_config_json = normalized
    return True


def build_unique_runtime_profile_name(
    session: Session,
    base_name: str,
    *,
    ignore_profile_id: str | None = None,
) -> str:
    normalized_base = str(base_name or "").strip() or "Runtime Profile"
    candidate = normalized_base
    suffix = 2
    while True:
        existing = session.scalar(select(RuntimeProfileRecord).where(RuntimeProfileRecord.name == candidate))
        if existing is None or existing.id == ignore_profile_id:
            return candidate
        candidate = f"{normalized_base} {suffix}"
        suffix += 1


def save_runtime_profile(
    session: Session,
    payload: dict[str, Any],
    *,
    existing_record: RuntimeProfileRecord | None = None,
) -> RuntimeProfileRecord:
    merged = merge_runtime_profile_payload(payload)
    merged_name = str(merged.get("name") or "").strip()
    if not merged_name:
        raise ValueError("runtime profile name is required")
    merged["name"] = merged_name
    record = existing_record
    if record is None and payload.get("id"):
        record = session.get(RuntimeProfileRecord, payload["id"])
    existing_by_name = session.scalar(select(RuntimeProfileRecord).where(RuntimeProfileRecord.name == merged_name))
    if record is None and existing_by_name is not None:
        raise ValueError(f"runtime profile '{merged_name}' already exists")
    if record is not None and existing_by_name is not None and existing_by_name.id != record.id:
        raise ValueError(f"runtime profile '{merged_name}' already exists")
    is_new_record = record is None
    if record is None:
        record = RuntimeProfileRecord(**default_runtime_profile_payload(is_default=False))
        session.add(record)
    existing_guardrails = dict(record.guardrails_config_json or {})
    existing_tool_policy = dict(record.tool_policy_config_json or {})
    incoming_guardrails = dict(merged["guardrails_config_json"] or {})
    incoming_tool_policy = dict(merged["tool_policy_config_json"] or {})
    policy_mode = _normalize_policy_mode(incoming_guardrails.get("policy_mode") or existing_guardrails.get("policy_mode"))
    policy_changed = existing_guardrails != incoming_guardrails or existing_tool_policy != incoming_tool_policy
    actor = str(payload.get("policy_actor") or "unknown")
    approval_token = str(payload.get("policy_approval_token") or "").strip() or None
    approval_reason = str(payload.get("policy_approval_reason") or "").strip() or None
    if policy_changed and existing_guardrails and not is_new_record:
        if policy_mode == "locked":
            _write_policy_audit(
                session,
                runtime_profile_id=record.id,
                actor=actor,
                action="runtime_profile_update",
                status="blocked",
                policy_mode=policy_mode,
                reason=approval_reason or "policy_mode=locked",
                approval_token=approval_token,
                before_json={"guardrails_config": existing_guardrails, "tool_policy_config": existing_tool_policy},
                after_json={"guardrails_config": incoming_guardrails, "tool_policy_config": incoming_tool_policy},
            )
            raise ValueError("Runtime profile policy is locked. Guardrail/tool policy updates are blocked.")
        if policy_mode == "admin_approval_required" and not approval_token:
            _write_policy_audit(
                session,
                runtime_profile_id=record.id,
                actor=actor,
                action="runtime_profile_update",
                status="blocked",
                policy_mode=policy_mode,
                reason=approval_reason or "missing approval token",
                approval_token=approval_token,
                before_json={"guardrails_config": existing_guardrails, "tool_policy_config": existing_tool_policy},
                after_json={"guardrails_config": incoming_guardrails, "tool_policy_config": incoming_tool_policy},
            )
            raise ValueError(
                "Runtime profile policy requires admin approval token for guardrail/tool policy changes."
            )

    record.name = merged["name"]
    record.description = merged["description"]
    record.llm_config_json = merged["llm_config_json"]
    record.guardrails_config_json = merged["guardrails_config_json"]
    record.kb_config_json = merged["kb_config_json"]
    record.retrieval_config_json = merged["retrieval_config_json"]
    record.tool_policy_config_json = merged["tool_policy_config_json"]
    record.is_default = bool(merged["is_default"])
    record.enabled = bool(merged["enabled"])
    session.flush()
    sync_runtime_profile_collection_bindings(
        session,
        record,
        list((record.kb_config_json or {}).get("default_corpora", [])),
        create_missing=False,
    )
    if record.is_default:
        _unset_other_default_profiles(session, record.id)
    if policy_changed and existing_guardrails and not is_new_record:
        _write_policy_audit(
            session,
            runtime_profile_id=record.id,
            actor=actor,
            action="runtime_profile_update",
            status="approved" if approval_token else "applied",
            policy_mode=policy_mode,
            reason=approval_reason,
            approval_token=approval_token,
            before_json={"guardrails_config": existing_guardrails, "tool_policy_config": existing_tool_policy},
            after_json={"guardrails_config": incoming_guardrails, "tool_policy_config": incoming_tool_policy},
        )
    session.commit()
    session.refresh(record)
    return record


def clone_runtime_profile(
    session: Session,
    source: RuntimeProfileRecord,
    *,
    name: str,
    description: str | None = None,
    is_default: bool = False,
) -> RuntimeProfileRecord:
    payload = {
        "name": name,
        "description": description or source.description,
        "llm_config": deepcopy(source.llm_config_json or {}),
        "guardrails_config": deepcopy(source.guardrails_config_json or {}),
        "kb_config": deepcopy(source.kb_config_json or {}),
        "retrieval_config": deepcopy(source.retrieval_config_json or {}),
        "tool_policy_config": deepcopy(source.tool_policy_config_json or {}),
        "is_default": is_default,
        "enabled": source.enabled,
    }
    return save_runtime_profile(session, payload)


def seed_default_runtime_profile(session: Session) -> RuntimeProfileRecord:
    existing = session.scalar(
        select(RuntimeProfileRecord).where(
            (RuntimeProfileRecord.is_default.is_(True))
            | (RuntimeProfileRecord.name == DEFAULT_RUNTIME_PROFILE_NAME)
        )
    )
    if existing is not None:
        profile_changed = _normalize_default_profile_embedding_model(existing)
        profile_changed = _normalize_runtime_profile_tool_policy(existing) or profile_changed
        hydrate_runtime_profile_collection_bindings(session, existing)
        if profile_changed:
            session.commit()
        session.refresh(existing)
        return existing
    record = RuntimeProfileRecord(**default_runtime_profile_payload())
    session.add(record)
    session.flush()
    sync_runtime_profile_collection_bindings(
        session,
        record,
        list((record.kb_config_json or {}).get("default_corpora", [])),
        create_missing=True,
    )
    session.commit()
    session.refresh(record)
    return record


def get_default_runtime_profile(session: Session) -> RuntimeProfileRecord:
    return seed_default_runtime_profile(session)


def get_runtime_profile(session: Session, runtime_profile_id: str | None = None) -> RuntimeProfileRecord:
    if runtime_profile_id:
        profile = session.get(RuntimeProfileRecord, runtime_profile_id)
        if profile is None:
            raise ValueError(f"runtime profile {runtime_profile_id} not found")
        if _normalize_runtime_profile_tool_policy(profile):
            session.commit()
            session.refresh(profile)
        hydrate_runtime_profile_collection_bindings(session, profile)
        return profile
    return get_default_runtime_profile(session)


def resolve_agent_runtime_profile(session: Session, agent: AgentProfileRecord) -> RuntimeProfileRecord:
    if agent.runtime_profile_id:
        return get_runtime_profile(session, agent.runtime_profile_id)
    return get_default_runtime_profile(session)


def list_policy_change_audits(session: Session, runtime_profile_id: str, *, limit: int = 50) -> list[ToolExecutionAuditRecord]:
    capped_limit = max(1, min(200, int(limit)))
    return list(
        session.scalars(
            select(ToolExecutionAuditRecord)
            .where(
                ToolExecutionAuditRecord.tool_id == "runtime_policy",
                ToolExecutionAuditRecord.policy_decision_id == runtime_profile_id,
            )
            .order_by(ToolExecutionAuditRecord.created_at.desc())
            .limit(capped_limit)
        )
    )


def runtime_defaults_view(session: Session, profile: RuntimeProfileRecord) -> dict[str, Any]:
    from .runtime import resolve_llm_connection

    llm_config = dict(profile.llm_config_json or {})
    guardrails_config = dict(profile.guardrails_config_json or {})
    kb_config = dict(profile.kb_config_json or {})
    retrieval_config = dict(profile.retrieval_config_json or {})
    connection = None
    try:
        connection = resolve_llm_connection(
            session,
            connection_id=llm_config.get("connection_id"),
            provider=llm_config.get("provider"),
        )
    except ValueError:
        connection = None
    return {
        "runtime_profile_id": profile.id,
        "runtime_profile_name": profile.name,
        "chat_api_mode": llm_config.get("api_mode", "responses"),
        "conversation_mode": str(guardrails_config.get("conversation_mode", DEFAULT_CONVERSATION_MODE)),
        "llm_model_id": llm_config.get("model_id", settings.app_default_chat_model),
        "llm_connection_id": connection.id if connection is not None else llm_config.get("connection_id"),
        "llm_connection_label": connection.label if connection is not None else None,
        "llm_provider_key": connection.provider if connection is not None else llm_config.get("provider"),
        "llm_provider_kind": connection.provider_kind if connection is not None else None,
        "embedding_model_id": kb_config.get("embedding_model_id", settings.app_default_embedding_model),
        "default_corpora": list(kb_config.get("default_corpora", [settings.app_default_corpus])),
        "text_chunk_size": int(retrieval_config.get("text_chunk_size", settings.app_chunk_size)),
        "text_chunk_overlap": int(retrieval_config.get("text_chunk_overlap", settings.app_chunk_overlap)),
        "text_heading_aware": bool(retrieval_config.get("text_heading_aware", True)),
        "pdf_chunk_size": int(retrieval_config.get("pdf_chunk_size", settings.app_pdf_chunk_size)),
        "pdf_chunk_overlap": int(retrieval_config.get("pdf_chunk_overlap", settings.app_pdf_chunk_overlap)),
        "pdf_sentence_window": int(retrieval_config.get("pdf_sentence_window", settings.app_pdf_sentence_window)),
        "pdf_top_k": int(retrieval_config.get("default_top_k", settings.app_pdf_top_k)),
        "pdf_parse_lane_policy": str(
            retrieval_config.get("pdf_parse_lane_policy", settings.app_pdf_parse_lane_policy)
        ),
        "pdf_rerank_enabled": bool(retrieval_config.get("pdf_rerank_enabled", False)),
    }


def update_runtime_defaults(session: Session, payload: dict[str, Any]) -> RuntimeProfileRecord:
    profile = get_default_runtime_profile(session)
    merged = {
        "id": profile.id,
        "name": profile.name,
        "description": profile.description,
        "llm_config": {
            **dict(profile.llm_config_json or {}),
            "api_mode": payload.get("chat_api_mode", (profile.llm_config_json or {}).get("api_mode", "responses")),
            "model_id": payload.get("llm_model_id", (profile.llm_config_json or {}).get("model_id")),
        },
        "kb_config": {
            **dict(profile.kb_config_json or {}),
            "embedding_model_id": payload.get(
                "embedding_model_id",
                (profile.kb_config_json or {}).get("embedding_model_id", settings.app_default_embedding_model),
            ),
            "default_corpora": list(
                payload.get(
                    "default_corpora",
                    (profile.kb_config_json or {}).get("default_corpora", [settings.app_default_corpus]),
                )
            ),
        },
        "retrieval_config": {
            **dict(profile.retrieval_config_json or {}),
            "default_top_k": payload.get(
                "pdf_top_k",
                (profile.retrieval_config_json or {}).get("default_top_k", settings.app_pdf_top_k),
            ),
            "text_chunk_size": payload.get(
                "text_chunk_size",
                (profile.retrieval_config_json or {}).get("text_chunk_size", settings.app_chunk_size),
            ),
            "text_chunk_overlap": payload.get(
                "text_chunk_overlap",
                (profile.retrieval_config_json or {}).get("text_chunk_overlap", settings.app_chunk_overlap),
            ),
            "text_heading_aware": payload.get(
                "text_heading_aware",
                (profile.retrieval_config_json or {}).get("text_heading_aware", True),
            ),
            "pdf_chunk_size": payload.get(
                "pdf_chunk_size",
                (profile.retrieval_config_json or {}).get("pdf_chunk_size", settings.app_pdf_chunk_size),
            ),
            "pdf_chunk_overlap": payload.get(
                "pdf_chunk_overlap",
                (profile.retrieval_config_json or {}).get("pdf_chunk_overlap", settings.app_pdf_chunk_overlap),
            ),
            "pdf_sentence_window": payload.get(
                "pdf_sentence_window",
                (profile.retrieval_config_json or {}).get("pdf_sentence_window", settings.app_pdf_sentence_window),
            ),
            "pdf_parse_lane_policy": payload.get(
                "pdf_parse_lane_policy",
                (profile.retrieval_config_json or {}).get("pdf_parse_lane_policy", settings.app_pdf_parse_lane_policy),
            ),
            "pdf_rerank_enabled": payload.get(
                "pdf_rerank_enabled",
                (profile.retrieval_config_json or {}).get("pdf_rerank_enabled", False),
            ),
        },
        "guardrails_config": dict(profile.guardrails_config_json or {}),
        "tool_policy_config": dict(profile.tool_policy_config_json or {}),
        "policy_actor": "system",
        "policy_approval_token": "SYSTEM_DEFAULT_UPDATE",
        "policy_approval_reason": "system-managed runtime defaults update",
        "is_default": True,
        "enabled": profile.enabled,
    }
    merged["guardrails_config"]["conversation_mode"] = payload.get(
        "conversation_mode",
        (profile.guardrails_config_json or {}).get("conversation_mode", DEFAULT_CONVERSATION_MODE),
    )
    return save_runtime_profile(session, merged, existing_record=profile)


def resolve_corpora(
    profile: RuntimeProfileRecord,
    requested_corpora: list[str],
) -> list[str]:
    if requested_corpora:
        return list(requested_corpora)
    kb_config = dict(profile.kb_config_json or {})
    defaults = [str(corpus) for corpus in kb_config.get("default_corpora", []) if str(corpus).strip()]
    return defaults or [settings.app_default_corpus]
