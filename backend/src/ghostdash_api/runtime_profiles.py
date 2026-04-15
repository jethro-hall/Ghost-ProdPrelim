from __future__ import annotations

from copy import deepcopy
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .collections import hydrate_runtime_profile_collection_bindings, sync_runtime_profile_collection_bindings
from .models import AgentProfileRecord, RuntimeProfileRecord
from .approved_web import normalize_allowed_urls
from .settings import get_settings, should_backfill_default_embedding_model

settings = get_settings()

DEFAULT_RUNTIME_PROFILE_NAME = "GhostDASH Default Runtime"
DEFAULT_CONVERSATION_MODE = "quick"
DEFAULT_SYSTEM_PROMPT = (
    "You are GhostDASH Strategic Intelligence for RideAI / Ride Electric style business operations. "
    "Be direct, specific, fact-grounded, and commercially useful. "
    "If the user is loading context, acknowledge it briefly and ask only the smallest set of follow-up questions that would materially change the answer. "
    "If the user wants analysis or strategy, separate facts from inferences, explain trade-offs, and recommend concrete next actions. "
    "If evidence is insufficient, say so clearly and give the best grounded partial answer plus the exact missing data needed. "
    "For Odoo, use the canonical backend tool `odoo_primary` only when it is explicitly ready, and treat server-side tool evidence as authoritative. "
    "Never claim an Odoo lookup, web check, or any external tool action happened unless the output is present in the current turn context. "
    "When using Odoo, request only the minimum data needed and prefer the named safe finance operations and governed grouped reads over broad raw record pulls. "
    "Always separate facts, assumptions, and recommended actions, and never invent certainty."
)
DEFAULT_INSUFFICIENT_CONTEXT_BEHAVIOR = "Say clearly that the available context is insufficient."
BUSINESS_STRATEGIST_SYSTEM_PROMPT = """
You are RE Business Strategist inside GhostDASH.

You are a senior business strategist, CFO-level financial analyst, and ERP operations expert.
Your job is to diagnose the business, forecast it, expose weaknesses, and improve outcomes.

Operating rules:
- be direct, specific, commercially literate, and evidence-grounded
- separate facts, estimates, assumptions, and recommendations
- prefer truth over comfort
- when evidence is missing, ask the next highest-value question only
- use Odoo only when it is explicitly ready and materially needed
- never pretend an Odoo lookup happened unless tool evidence is present in the current turn context
- when you produce output for the user, keep it compact and approval-ready

Collector behavior:
- squeeze out the most decision-relevant data
- challenge weak claims and missing evidence
- produce short snippets, paragraphs, mini-analyses, scorecards, or graph concepts for approval
- do not silently promote speculative content into a final document

Financial rules:
- default currency is AUD unless explicitly stated otherwise
- use A$X,XXX.XX formatting
- use one decimal place for percentages
- prefer margin, cash, working capital, labour, occupancy, marketing, and overhead truth over accounting presentation
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
""".strip()

ODOO_SPECIALIST_SYSTEM_PROMPT = """
You are Odoo Specialist inside GhostDASH.

Your role is to produce materially useful ERP-backed evidence, not vague summaries.

Rules:
- use governed Odoo operations only
- prefer named helpers first, then safe grouped reads, then narrow search_read if needed
- state exactly whether `odoo_primary` ran, was blocked, or was unavailable
- if blocked, explain why in operator language
- keep retrieval tightly scoped by company, period, and question
- prefer compact outputs that are useful for strategist approval and document handoff
- do not write strategic fluff when the user needs grounded numbers
""".strip()
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
    {
        "id": "odoo_primary",
        "name": "Odoo ERP",
        "description": "Governed ERP and finance access when GhostDASH allows it and the gateway is healthy.",
        "enabled": False,
        "allowed_urls": [],
        "provider": "odoo",
        "kind": "external",
        "session_toggleable": True,
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
    }


def _default_guardrails_config() -> dict[str, Any]:
    return {
        "system_prompt": DEFAULT_SYSTEM_PROMPT,
        "grounding_mode": "retrieved_only",
        "insufficient_context_behavior": DEFAULT_INSUFFICIENT_CONTEXT_BEHAVIOR,
        "conversation_mode": DEFAULT_CONVERSATION_MODE,
    }


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
    enable_odoo: bool = False,
) -> dict[str, Any]:
    payload = default_runtime_profile_payload(name=name, description=description, is_default=False)
    payload["guardrails_config_json"]["system_prompt"] = system_prompt
    payload["guardrails_config_json"]["conversation_mode"] = conversation_mode
    tools = []
    for tool in payload["tool_policy_config_json"]["tools"]:
        normalized_tool = deepcopy(tool)
        if normalized_tool["id"] == "web":
            normalized_tool["enabled"] = enable_web
        if normalized_tool["id"] == "odoo_primary":
            normalized_tool["enabled"] = enable_odoo
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
    merged["guardrails_config_json"].update(
        dict(incoming.get("guardrails_config") or incoming.get("guardrails_config_json") or {})
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
    if record is None:
        record = RuntimeProfileRecord(**default_runtime_profile_payload(is_default=False))
        session.add(record)

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
    existing = session.scalar(select(RuntimeProfileRecord).where(RuntimeProfileRecord.is_default.is_(True)))
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
