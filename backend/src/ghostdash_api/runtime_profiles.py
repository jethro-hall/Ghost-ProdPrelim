from __future__ import annotations

from copy import deepcopy
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AgentProfileRecord, RuntimeProfileRecord
from .settings import get_settings

settings = get_settings()

DEFAULT_RUNTIME_PROFILE_NAME = "GhostDASH Default Runtime"
DEFAULT_SYSTEM_PROMPT = (
    "You are GhostDASH Strategic Intelligence, a grounded business analysis agent. "
    "Be direct, specific, deeply reasoned, no-fluff, and fact-grounded. "
    "When the user is loading context, acknowledge it briefly, note what is materially important, "
    "and only ask high-value follow-up questions if they change the business, financial, operational, or strategic outcome. "
    "When the user asks for analysis, strategy, forecasting, advice, or planning, produce executive-grade reasoning with multiple solution paths, "
    "clear trade-offs, and practical next actions. "
    "If there is insufficient data for a strong answer, say that clearly at the start and again at the end, "
    "but never stop at the problem: always provide the best grounded partial answer, multiple options, and exactly what extra data would improve confidence. "
    "If asked what is in your context, memory, or 'brain', report it honestly and in detail: active corpora, remembered conversation context, approved web sources, "
    "important loaded facts, missing facts, and confidence constraints. "
    "If approved web sources are available, use them only when explicitly requested or when checking them would clearly add value to the answer. "
    "Never pretend to have checked a site you did not actually check. "
    "Never invent certainty, and always separate facts, inferences, assumptions, and recommended actions."
)
DEFAULT_INSUFFICIENT_CONTEXT_BEHAVIOR = "Say clearly that the available context is insufficient."
DEFAULT_AGENT_TOOLS = [
    {"id": "kb", "name": "Knowledge Base", "description": "Query indexed documents.", "enabled": True, "allowed_urls": []},
    {
        "id": "web",
        "name": "Approved Web Sources",
        "description": "Fetch only the explicitly allowed websites stored on this agent.",
        "enabled": False,
        "allowed_urls": [],
    },
]


def _default_llm_config() -> dict[str, Any]:
    return {
        "provider": "openai",
        "model_id": settings.app_default_chat_model,
        "temperature": 0.2,
        "max_tokens": 16000,
        "api_mode": "responses",
    }


def _default_guardrails_config() -> dict[str, Any]:
    return {
        "system_prompt": DEFAULT_SYSTEM_PROMPT,
        "grounding_mode": "retrieved_only",
        "insufficient_context_behavior": DEFAULT_INSUFFICIENT_CONTEXT_BEHAVIOR,
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
    return {"tools": deepcopy(DEFAULT_AGENT_TOOLS)}


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
    return payload


def _unset_other_default_profiles(session: Session, runtime_profile_id: str) -> None:
    for other in session.scalars(
        select(RuntimeProfileRecord).where(
            RuntimeProfileRecord.id != runtime_profile_id,
            RuntimeProfileRecord.is_default.is_(True),
        )
    ):
        other.is_default = False


def save_runtime_profile(
    session: Session,
    payload: dict[str, Any],
    *,
    existing_record: RuntimeProfileRecord | None = None,
) -> RuntimeProfileRecord:
    merged = merge_runtime_profile_payload(payload)
    record = existing_record
    if record is None and payload.get("id"):
        record = session.get(RuntimeProfileRecord, payload["id"])
    if record is None and payload.get("name"):
        record = session.scalar(select(RuntimeProfileRecord).where(RuntimeProfileRecord.name == payload["name"]))
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
        return existing
    record = RuntimeProfileRecord(**default_runtime_profile_payload())
    session.add(record)
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
        return profile
    return get_default_runtime_profile(session)


def resolve_agent_runtime_profile(session: Session, agent: AgentProfileRecord) -> RuntimeProfileRecord:
    if agent.runtime_profile_id:
        return get_runtime_profile(session, agent.runtime_profile_id)
    return get_default_runtime_profile(session)


def runtime_defaults_view(profile: RuntimeProfileRecord) -> dict[str, Any]:
    llm_config = dict(profile.llm_config_json or {})
    kb_config = dict(profile.kb_config_json or {})
    retrieval_config = dict(profile.retrieval_config_json or {})
    return {
        "runtime_profile_id": profile.id,
        "runtime_profile_name": profile.name,
        "chat_api_mode": llm_config.get("api_mode", "responses"),
        "llm_model_id": llm_config.get("model_id", settings.app_default_chat_model),
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
