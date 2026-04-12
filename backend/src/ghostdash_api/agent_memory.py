from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import AgentConversationRecord, AgentMessageRecord, AgentProfileRecord, ChatResponseCacheRecord, RuntimeProfileRecord
from .runtime_profiles import (
    resolve_agent_runtime_profile,
    save_runtime_profile,
    seed_default_runtime_profile,
)
from .settings import get_settings

settings = get_settings()


def default_agent_payload(runtime_profile_id: str) -> dict:
    return {
        "name": "GhostDASH Assistant",
        "first_message": "Hello! I am your GhostDASH assistant. How can I help you today?",
        "language": "en-US",
        "voice_id": "alloy",
        "runtime_profile_id": runtime_profile_id,
        "is_default": True,
        "enabled": True,
    }


def seed_default_agent_profiles(session: Session) -> None:
    default_runtime_profile = seed_default_runtime_profile(session)
    existing = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.is_default.is_(True)))
    if existing is not None:
        if not existing.runtime_profile_id:
            existing.runtime_profile_id = default_runtime_profile.id
            session.commit()
        return
    payload = default_agent_payload(default_runtime_profile.id)
    session.add(AgentProfileRecord(**payload))
    session.commit()


def list_agents(session: Session) -> list[AgentProfileRecord]:
    seed_default_agent_profiles(session)
    return list(
        session.scalars(
            select(AgentProfileRecord).order_by(AgentProfileRecord.is_default.desc(), AgentProfileRecord.updated_at.desc())
        )
    )


def get_agent(session: Session, agent_id: str | None = None) -> AgentProfileRecord:
    seed_default_agent_profiles(session)
    if agent_id:
        agent = session.get(AgentProfileRecord, agent_id)
        if agent is None:
            raise ValueError(f"agent {agent_id} not found")
        return agent
    default = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.is_default.is_(True)))
    if default is None:
        raise ValueError("default agent profile not found")
    return default


def save_agent(session: Session, payload: dict) -> AgentProfileRecord:
    normalized_name = str(payload.get("name") or "").strip()
    if not normalized_name:
        raise ValueError("agent name is required")

    normalized_first_message = str(payload.get("first_message") or "").strip()
    if not normalized_first_message:
        raise ValueError("first message is required")

    record = session.get(AgentProfileRecord, payload.get("id")) if payload.get("id") else None
    existing_by_name = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.name == normalized_name))
    is_new_record = record is None

    if is_new_record and existing_by_name is not None:
        raise ValueError(f"agent '{normalized_name}' already exists")
    if record is not None and existing_by_name is not None and existing_by_name.id != record.id:
        raise ValueError(f"agent '{normalized_name}' already exists")

    default_runtime_profile = seed_default_runtime_profile(session)
    pending_insert = False
    if record is None:
        record = AgentProfileRecord(**default_agent_payload(default_runtime_profile.id))
        pending_insert = True

    runtime_profile_payload = payload.get("runtime_profile")
    runtime_profile_id = payload.get("runtime_profile_id") or (None if is_new_record else record.runtime_profile_id)
    if runtime_profile_payload is not None:
        runtime_profile_record = save_runtime_profile(
            session,
            {
                **runtime_profile_payload,
                "id": runtime_profile_payload.get("id") or runtime_profile_id,
                "is_default": bool(payload.get("is_default", False)),
            },
        )
        record.runtime_profile_id = runtime_profile_record.id
    elif runtime_profile_id:
        record.runtime_profile_id = runtime_profile_id
    elif not record.runtime_profile_id:
        record.runtime_profile_id = default_runtime_profile.id

    payload = {
        **payload,
        "name": normalized_name,
        "first_message": normalized_first_message,
        "language": str(payload.get("language") or record.language or "en-US").strip() or "en-US",
        "voice_id": str(payload.get("voice_id") or record.voice_id or "alloy").strip() or "alloy",
    }

    for key in ("name", "first_message", "language", "voice_id", "is_default", "enabled"):
        if key in payload:
            setattr(record, key, payload[key])

    if pending_insert:
        session.add(record)
        session.flush()

    if record.is_default:
        for other in session.scalars(
            select(AgentProfileRecord).where(AgentProfileRecord.id != record.id, AgentProfileRecord.is_default.is_(True))
        ):
            other.is_default = False
        runtime_profile = resolve_agent_runtime_profile(session, record)
        runtime_profile.is_default = True
        for other_profile in session.scalars(
            select(RuntimeProfileRecord).where(
                RuntimeProfileRecord.id != runtime_profile.id,
                RuntimeProfileRecord.is_default.is_(True),
            )
        ):
            other_profile.is_default = False
    session.commit()
    session.refresh(record)
    return record


def list_conversations(session: Session, agent_id: str, *, limit: int = 20) -> list[tuple[AgentConversationRecord, int]]:
    rows = session.execute(
        select(AgentConversationRecord, func.count(AgentMessageRecord.id))
        .outerjoin(AgentMessageRecord, AgentMessageRecord.conversation_id == AgentConversationRecord.id)
        .where(AgentConversationRecord.agent_id == agent_id)
        .group_by(AgentConversationRecord.id)
        .order_by(AgentConversationRecord.updated_at.desc())
        .limit(limit)
    )
    return [(conversation, count) for conversation, count in rows]


def list_messages(session: Session, conversation_id: str, *, limit: int = 100) -> list[AgentMessageRecord]:
    rows = list(
        session.scalars(
            select(AgentMessageRecord)
            .where(AgentMessageRecord.conversation_id == conversation_id)
            .order_by(AgentMessageRecord.created_at.asc())
            .limit(limit)
        )
    )
    return rows


def create_conversation(
    session: Session,
    *,
    agent_id: str,
    message: str,
    corpora: list[str],
    api_mode: str,
) -> AgentConversationRecord:
    title = (message.strip()[:80] or "New conversation").strip()
    conversation = AgentConversationRecord(
        agent_id=agent_id,
        title=title,
        corpora_json=list(corpora),
        api_mode=api_mode,
    )
    session.add(conversation)
    session.flush()
    return conversation


def append_message(
    session: Session,
    *,
    conversation_id: str,
    agent_id: str,
    role: str,
    content: str,
    query_mode: str | None = None,
    citations: list[dict] | None = None,
    api_mode: str | None = None,
) -> AgentMessageRecord:
    message = AgentMessageRecord(
        conversation_id=conversation_id,
        agent_id=agent_id,
        role=role,
        content=content,
        query_mode=query_mode,
        citations_json=list(citations or []),
        api_mode=api_mode,
    )
    session.add(message)
    return message


def build_history_context(messages: list[AgentMessageRecord], *, window_messages: int) -> str:
    recent = messages[-window_messages:]
    if not recent:
        return ""
    lines = []
    for message in recent:
        prefix = "User" if message.role == "user" else "Assistant"
        lines.append(f"{prefix}: {message.content}")
    return "\n".join(lines)


def _cache_cutoff() -> datetime | None:
    ttl_seconds = settings.app_chat_response_cache_ttl_seconds
    if ttl_seconds <= 0:
        return None
    return datetime.now(UTC) - timedelta(seconds=ttl_seconds)


def build_response_cache_key(
    *,
    agent: AgentProfileRecord,
    runtime_profile,
    history_context: str,
    message: str,
    corpora: list[str],
    api_mode: str,
    llm_model_id_override: str | None = None,
) -> str:
    llm_config = dict(runtime_profile.llm_config_json or {})
    guardrails_config = dict(runtime_profile.guardrails_config_json or {})
    kb_config = dict(runtime_profile.kb_config_json or {})
    retrieval_config = dict(runtime_profile.retrieval_config_json or {})
    tool_policy = dict(runtime_profile.tool_policy_config_json or {})
    payload = {
        "agent_id": agent.id,
        "agent_name": agent.name,
        "runtime_profile_id": runtime_profile.id,
        "llm_config": llm_config,
        "guardrails_config": guardrails_config,
        "kb_config": kb_config,
        "retrieval_config": retrieval_config,
        "tool_policy_config": tool_policy,
        "history_context": history_context,
        "message": message,
        "corpora": list(corpora),
        "api_mode": api_mode,
    }
    stripped = (llm_model_id_override or "").strip()
    if stripped:
        payload["llm_model_id_override"] = stripped
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def lookup_cached_response(session: Session, *, agent_id: str, request_hash: str) -> ChatResponseCacheRecord | None:
    if not settings.app_chat_response_cache_enabled:
        return None
    row = session.scalar(
        select(ChatResponseCacheRecord).where(
            ChatResponseCacheRecord.agent_id == agent_id,
            ChatResponseCacheRecord.request_hash == request_hash,
        )
    )
    if row is None:
        return None
    cutoff = _cache_cutoff()
    if cutoff is not None and row.updated_at < cutoff:
        session.delete(row)
        session.commit()
        return None
    row.hit_count += 1
    session.commit()
    session.refresh(row)
    return row


def store_cached_response(
    session: Session,
    *,
    agent_id: str,
    request_hash: str,
    answer_text: str,
    query_mode: str,
    citations: list[dict],
) -> ChatResponseCacheRecord | None:
    if not settings.app_chat_response_cache_enabled:
        return None
    row = session.scalar(
        select(ChatResponseCacheRecord).where(
            ChatResponseCacheRecord.agent_id == agent_id,
            ChatResponseCacheRecord.request_hash == request_hash,
        )
    )
    if row is None:
        row = ChatResponseCacheRecord(
            agent_id=agent_id,
            request_hash=request_hash,
            answer_text=answer_text,
            query_mode=query_mode,
            citations_json=list(citations),
        )
        session.add(row)
    else:
        row.answer_text = answer_text
        row.query_mode = query_mode
        row.citations_json = list(citations)
    session.commit()
    session.refresh(row)
    return row
