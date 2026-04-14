from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ghostdash_api.collections import ensure_collection_record
from ghostdash_api.agent_memory import save_agent, seed_default_agent_profiles
from ghostdash_api.database import Base
from ghostdash_api.models import RuntimeProfileRecord
from ghostdash_api.runtime_defaults import get_runtime_defaults, save_runtime_defaults
from ghostdash_api.runtime_profiles import save_runtime_profile, seed_default_runtime_profile


def build_session():
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    return SessionLocal


def test_save_agent_creates_and_links_runtime_profile() -> None:
    SessionLocal = build_session()

    with SessionLocal() as session:
        default_profile = seed_default_runtime_profile(session)
        ensure_collection_record(session, slug="finance", name="Finance")
        session.commit()
        agent = save_agent(
            session,
            {
                "name": "Finance Analyst",
                "first_message": "How can I help with finance operations?",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
                "runtime_profile": {
                    "name": "Finance Analyst Runtime",
                    "description": "Finance agent runtime profile",
                    "llm_config": {
                        "provider": "openai",
                        "model_id": "openai/gpt-5.4",
                        "temperature": 0.1,
                        "max_tokens": 3000,
                        "api_mode": "responses",
                    },
                    "guardrails_config": {
                        "system_prompt": "Use retrieved finance context only.",
                        "grounding_mode": "retrieved_only",
                        "insufficient_context_behavior": "Say when finance context is missing.",
                        "conversation_mode": "quick",
                    },
                    "kb_config": {
                        "default_corpora": ["finance"],
                        "embedding_model_id": "openai/text-embedding-3-small",
                    },
                    "retrieval_config": {
                        "default_top_k": 8,
                        "pdf_chunk_size": 900,
                        "pdf_chunk_overlap": 120,
                        "pdf_sentence_window": 2,
                        "pdf_parse_lane_policy": "auto",
                        "pdf_rerank_enabled": False,
                    },
                    "tool_policy_config": {
                        "tools": [
                            {"id": "kb", "name": "Knowledge Base", "description": "Query indexed documents.", "enabled": True}
                        ]
                    },
                    "is_default": False,
                    "enabled": True,
                },
            },
        )

        linked_profile = session.get(RuntimeProfileRecord, agent.runtime_profile_id)
        default_profile_id = default_profile.id
        linked_profile_name = linked_profile.name if linked_profile is not None else None
        linked_max_tokens = linked_profile.llm_config_json["max_tokens"] if linked_profile is not None else None
        linked_corpora = linked_profile.kb_config_json["default_corpora"] if linked_profile is not None else None

    assert linked_profile is not None
    assert agent.runtime_profile_id != default_profile_id
    assert linked_profile_name == "Finance Analyst Runtime"
    assert linked_max_tokens == 3000
    assert linked_corpora == ["finance"]


def test_runtime_defaults_update_default_runtime_profile_view() -> None:
    SessionLocal = build_session()

    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        ensure_collection_record(session, slug="finance", name="Finance")
        ensure_collection_record(session, slug="ops", name="Ops")
        session.commit()
        updated = save_runtime_defaults(
            session,
            {
                "chat_api_mode": "chat_completions",
                "conversation_mode": "working_session",
                "embedding_model_id": "openai/text-embedding-3-large",
                "default_corpora": ["finance", "ops"],
                "pdf_top_k": 9,
                "pdf_chunk_size": 1000,
                "pdf_chunk_overlap": 140,
                "pdf_sentence_window": 3,
                "pdf_parse_lane_policy": "cloud_default",
                "pdf_rerank_enabled": True,
            },
        )
        runtime_defaults = get_runtime_defaults(session)
        default_profile = session.query(RuntimeProfileRecord).filter(RuntimeProfileRecord.is_default.is_(True)).one()

    assert updated["chat_api_mode"] == "chat_completions"
    assert updated["conversation_mode"] == "working_session"
    assert updated["embedding_model_id"] == "openai/text-embedding-3-large"
    assert updated["default_corpora"] == ["finance", "ops"]
    assert runtime_defaults["pdf_top_k"] == 9
    assert runtime_defaults["conversation_mode"] == "working_session"
    assert default_profile.kb_config_json["default_corpora"] == ["finance", "ops"]
    assert default_profile.guardrails_config_json["conversation_mode"] == "working_session"
    assert default_profile.retrieval_config_json["pdf_parse_lane_policy"] == "cloud_default"


def test_save_agent_rejects_duplicate_name_on_create() -> None:
    SessionLocal = build_session()

    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        ensure_collection_record(session, slug="default", name="Default")
        session.commit()
        save_agent(
            session,
            {
                "name": "Finance Analyst",
                "first_message": "How can I help?",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
            },
        )

        try:
            save_agent(
                session,
                {
                    "name": "Finance Analyst",
                    "first_message": "Another intro",
                    "language": "en-US",
                    "voice_id": "alloy",
                    "is_default": False,
                    "enabled": True,
                },
            )
        except ValueError as exc:
            duplicate_error = str(exc)
        else:
            duplicate_error = None

    assert duplicate_error == "agent 'Finance Analyst' already exists"


def test_save_runtime_profile_rejects_duplicate_name_on_create() -> None:
    SessionLocal = build_session()

    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        ensure_collection_record(session, slug="default", name="Default")
        session.commit()
        save_runtime_profile(
            session,
            {
                "name": "Finance Runtime",
                "description": "Finance profile",
                "llm_config": {
                    "provider": "openai",
                    "model_id": "openai/llama31-8b",
                    "temperature": 0.2,
                    "max_tokens": 16000,
                    "api_mode": "responses",
                },
                "guardrails_config": {
                    "system_prompt": "Stay grounded.",
                    "grounding_mode": "retrieved_only",
                    "insufficient_context_behavior": "Say when context is missing.",
                },
                "kb_config": {
                    "default_corpora": ["default"],
                    "embedding_model_id": "openai/intfloat/multilingual-e5-large-instruct",
                },
                "retrieval_config": {
                    "default_top_k": 6,
                    "text_chunk_size": 800,
                    "text_chunk_overlap": 120,
                    "text_heading_aware": True,
                    "pdf_chunk_size": 900,
                    "pdf_chunk_overlap": 120,
                    "pdf_sentence_window": 2,
                    "pdf_parse_lane_policy": "auto",
                    "pdf_rerank_enabled": False,
                },
                "tool_policy_config": {
                    "tools": [],
                },
                "is_default": False,
                "enabled": True,
            },
        )

        try:
            save_runtime_profile(
                session,
                {
                    "name": "Finance Runtime",
                    "description": "Duplicate profile",
                    "llm_config": {
                        "provider": "openai",
                        "model_id": "openai/llama31-8b",
                        "temperature": 0.2,
                        "max_tokens": 16000,
                        "api_mode": "responses",
                    },
                    "guardrails_config": {
                        "system_prompt": "Stay grounded.",
                        "grounding_mode": "retrieved_only",
                        "insufficient_context_behavior": "Say when context is missing.",
                        "conversation_mode": "quick",
                    },
                    "kb_config": {
                        "default_corpora": ["default"],
                        "embedding_model_id": "openai/intfloat/multilingual-e5-large-instruct",
                    },
                    "retrieval_config": {
                        "default_top_k": 6,
                        "text_chunk_size": 800,
                        "text_chunk_overlap": 120,
                        "text_heading_aware": True,
                        "pdf_chunk_size": 900,
                        "pdf_chunk_overlap": 120,
                        "pdf_sentence_window": 2,
                        "pdf_parse_lane_policy": "auto",
                        "pdf_rerank_enabled": False,
                    },
                    "tool_policy_config": {
                        "tools": [],
                    },
                    "is_default": False,
                    "enabled": True,
                },
            )
        except ValueError as exc:
            duplicate_error = str(exc)
        else:
            duplicate_error = None

    assert duplicate_error == "runtime profile 'Finance Runtime' already exists"


def test_save_agent_can_create_unique_agent_when_default_agent_exists() -> None:
    SessionLocal = build_session()

    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        seed_default_agent_profiles(session)
        ensure_collection_record(session, slug="default", name="Default")
        session.commit()

        agent = save_agent(
            session,
            {
                "name": "MAS Browser Verify Agent",
                "first_message": "Hello from MAS verification",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
                "runtime_profile": {
                    "name": "MAS Browser Verify Agent Runtime",
                    "description": "MAS verification runtime",
                    "llm_config": {
                        "provider": "openai",
                        "model_id": "openai/llama31-8b",
                        "temperature": 0.2,
                        "max_tokens": 16000,
                        "api_mode": "chat_completions",
                    },
                    "guardrails_config": {
                        "system_prompt": "Stay grounded.",
                        "grounding_mode": "retrieved_only",
                        "insufficient_context_behavior": "Say when context is missing.",
                        "conversation_mode": "quick",
                    },
                    "kb_config": {
                        "default_corpora": ["default"],
                        "embedding_model_id": "openai/intfloat/multilingual-e5-large-instruct",
                    },
                    "retrieval_config": {
                        "default_top_k": 6,
                        "text_chunk_size": 800,
                        "text_chunk_overlap": 120,
                        "text_heading_aware": True,
                        "pdf_chunk_size": 900,
                        "pdf_chunk_overlap": 120,
                        "pdf_sentence_window": 2,
                        "pdf_parse_lane_policy": "auto",
                        "pdf_rerank_enabled": False,
                    },
                    "tool_policy_config": {
                        "tools": [],
                    },
                    "is_default": False,
                    "enabled": True,
                },
            },
        )

    assert agent.name == "MAS Browser Verify Agent"
