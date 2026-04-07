from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import (
    AgentConversationRecord,
    AgentMessageRecord,
    AgentProfileRecord,
    ChatResponseCacheRecord,
)
from .settings import get_settings

settings = get_settings()
DEFAULT_AGENT_TOOLS = [
    {"id": "kb", "name": "Knowledge Base", "description": "Query indexed documents.", "enabled": True},
    {"id": "web", "name": "Web Search", "description": "Search for external context.", "enabled": False},
]


def default_agent_payload() -> dict:
    return {
        "name": "GhostDASH Assistant",
        "system_prompt": (
            "You answer using retrieved knowledge only. "
            "Always ground the answer in the provided context and say when the context is insufficient."
        ),
        "first_message": "Hello! I am your GhostDASH assistant. How can I help you today?",
        "model_id": settings.app_default_chat_model,
        "temperature": 0.2,
        "max_tokens": 2000,
        "language": "en-US",
        "voice_id": "alloy",
        "tools_json": list(DEFAULT_AGENT_TOOLS),
        "is_default": True,
        "enabled": True,
    }


def seed_default_agent_profiles(session: Session) -> None:
    existing = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.is_default.is_(True)))
    if existing is not None:
        return
    payload = default_agent_payload()
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
    record = session.get(AgentProfileRecord, payload.get("id")) if payload.get("id") else None
    if record is None and payload.get("name"):
        record = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.name == payload["name"]))
    if record is None:
        record = AgentProfileRecord(**default_agent_payload())
        session.add(record)
    for key, value in payload.items():
        if key == "id":
            continue
        if key == "tools":
            setattr(record, "tools_json", value)
            continue
        setattr(record, key, value)
    if record.is_default:
        for other in session.scalars(
            select(AgentProfileRecord).where(AgentProfileRecord.id != record.id, AgentProfileRecord.is_default.is_(True))
        ):
            other.is_default = False
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
    history_context: str,
    message: str,
    corpora: list[str],
    api_mode: str,
) -> str:
    payload = {
        "agent_id": agent.id,
        "agent_name": agent.name,
        "system_prompt": agent.system_prompt,
        "model_id": agent.model_id,
        "temperature": agent.temperature,
        "max_tokens": agent.max_tokens,
        "history_context": history_context,
        "message": message,
        "corpora": list(corpora),
        "api_mode": api_mode,
    }
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
