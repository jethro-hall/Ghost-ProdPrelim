from __future__ import annotations

from sqlalchemy import select

from ghostdash_api.agent_memory import seed_default_agent_profiles
from ghostdash_api.magic_mike import MAGIC_MIKE_AGENT_NAME, MAGIC_MIKE_CORPUS, MAGIC_MIKE_RUNTIME_NAME, RIDE_ELECTRIC_FAT_TYRE_URL
from ghostdash_api.models import AgentProfileRecord, RuntimeProfileRecord

from test_connections_and_bootstrap import build_client, seed_defaults


def test_seed_does_not_resurrect_deleted_special_agent(monkeypatch) -> None:
    _client, SessionLocal = build_client(monkeypatch)
    seed_defaults(SessionLocal)

    with SessionLocal() as session:
        strategist = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.name == "Business Strategist"))
        assert strategist is not None
        strategist_runtime_profile_id = strategist.runtime_profile_id
        session.delete(strategist)
        session.commit()

    with SessionLocal() as session:
        runtime_profile = session.get(RuntimeProfileRecord, strategist_runtime_profile_id)
        assert runtime_profile is not None

    with SessionLocal() as session:
        seed_default_agent_profiles(session)

    with SessionLocal() as session:
        strategist = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.name == "Business Strategist"))
        assert strategist is None


def test_seed_creates_llama_architect_and_three_sub_agents(monkeypatch) -> None:
    _client, SessionLocal = build_client(monkeypatch)
    seed_defaults(SessionLocal)

    with SessionLocal() as session:
        head = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.name == "Llama Architect"))
        assert head is not None
        assert head.agent_role == "lead"
        assert head.is_default is True

        sub_agents = list(
            session.scalars(
                select(AgentProfileRecord).where(
                    AgentProfileRecord.parent_agent_id == head.id,
                    AgentProfileRecord.agent_role == "sub",
                )
            )
        )
        names = {agent.name for agent in sub_agents}
        assert names == {
            "[SA] Programming Agent 1",
            "[SA] Programming Agent 2",
            "[SA] Testing Agent",
        }


def test_seed_creates_magic_mike_voice_agent_with_truth_sources(monkeypatch) -> None:
    _client, SessionLocal = build_client(monkeypatch)
    seed_defaults(SessionLocal)

    with SessionLocal() as session:
        mike = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.name == MAGIC_MIKE_AGENT_NAME))
        assert mike is not None
        assert mike.enabled is True
        assert mike.agent_role == "lead"
        profile = session.get(RuntimeProfileRecord, mike.runtime_profile_id)
        assert profile is not None
        assert profile.name == MAGIC_MIKE_RUNTIME_NAME
        assert profile.llm_config_json["temperature"] == 0.1
        assert profile.llm_config_json["max_tokens"] == 120
        assert profile.llm_config_json["llm_orchestration"]["enabled"] is True
        assert profile.llm_config_json["llm_orchestration"]["fallback_model_id"] == "gemini-3-pro"
        assert profile.guardrails_config_json["voice_enabled"] is True
        assert profile.guardrails_config_json["tools_required_for_claims"] is True
        assert profile.kb_config_json["default_corpora"] == [MAGIC_MIKE_CORPUS]
        web_tool = next(tool for tool in profile.tool_policy_config_json["tools"] if tool["id"] == "web")
        assert web_tool["enabled"] is True
        assert web_tool["allowed_urls"] == [RIDE_ELECTRIC_FAT_TYRE_URL]


def test_seed_recreates_magic_mike_when_agent_deleted_but_runtime_remains(monkeypatch) -> None:
    _client, SessionLocal = build_client(monkeypatch)
    seed_defaults(SessionLocal)

    with SessionLocal() as session:
        mike = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.name == MAGIC_MIKE_AGENT_NAME))
        assert mike is not None
        runtime_profile_id = mike.runtime_profile_id
        session.delete(mike)
        session.commit()

    with SessionLocal() as session:
        assert session.get(RuntimeProfileRecord, runtime_profile_id) is not None
        seed_default_agent_profiles(session)

    with SessionLocal() as session:
        recreated = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.name == MAGIC_MIKE_AGENT_NAME))
        assert recreated is not None
        assert recreated.runtime_profile_id == runtime_profile_id
