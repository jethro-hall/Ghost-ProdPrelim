from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ghostdash_api import control_api
from ghostdash_api.agent_memory import seed_default_agent_profiles
from ghostdash_api.database import Base, get_session
from ghostdash_api.models import AgentMessageRecord, AgentProfileRecord
from ghostdash_api.runtime import save_connection, seed_default_connections
from ghostdash_api.runtime_profiles import seed_default_runtime_profile


def build_client(monkeypatch):
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)

    monkeypatch.setattr(control_api, "initialize_control_runtime_state", lambda: None)

    def override_get_session():
        with SessionLocal() as session:
            yield session

    app = control_api.create_app()
    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app), SessionLocal


def seed_defaults(SessionLocal) -> None:
    with SessionLocal() as session:
        seed_default_connections(session)
        seed_default_runtime_profile(session)
        seed_default_agent_profiles(session)


def test_connections_round_trip_provider_metadata(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    seed_defaults(SessionLocal)

    response = client.post(
        "/api/connections",
        json={
            "provider": "rideai-local",
            "label": "RideAI Local",
            "provider_kind": "openai_compatible",
            "auth_strategy": "custom_header",
            "auth_header_name": "X-Internal-Key",
            "api_key": "change_me_llamaindex_internal_key",
            "base_url": "https://one.rideai.com.au/api/llamaindex/v1",
            "enabled": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_kind"] == "openai_compatible"
    assert payload["auth_strategy"] == "custom_header"
    assert payload["auth_header_name"] == "X-Internal-Key"

    list_response = client.get("/api/connections")
    assert list_response.status_code == 200
    saved = {row["provider"]: row for row in list_response.json()}
    assert saved["rideai-local"]["provider_kind"] == "openai_compatible"
    assert saved["rideai-local"]["auth_strategy"] == "custom_header"
    assert saved["rideai-local"]["auth_header_name"] == "X-Internal-Key"


def test_chat_bootstrap_returns_shared_runtime_and_agents(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    seed_defaults(SessionLocal)

    with SessionLocal() as session:
        save_connection(
            session,
            "openai",
            label="OpenAI",
            provider_kind="openai",
            auth_strategy="bearer",
            base_url="https://api.openai.com/v1",
            enabled=True,
        )

    response = client.get("/api/chat/bootstrap?surface=ghost_chatui")

    assert response.status_code == 200
    payload = response.json()
    assert payload["surface"] == "ghost_chatui"
    assert payload["default_agent_id"]
    assert payload["default_workflow_mode"] == "standard"
    assert payload["features"] == {
        "allow_mock_provider": False,
        "allow_api_mode_override": False,
        "allow_conversation_mode_override": True,
        "allow_approved_web_toggle": True,
        "allow_workflow_launchers": True,
    }
    assert payload["runtime_defaults"]["llm_provider_key"] == "openai"
    assert payload["runtime_defaults"]["llm_provider_kind"] == "openai"
    assert payload["runtime_defaults"]["llm_connection_label"] == "OpenAI"
    assert len(payload["agents"]) >= 4


def test_workflow_conversation_and_document_frame_round_trip(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    seed_defaults(SessionLocal)

    with SessionLocal() as session:
        agents = list(session.scalars(select(AgentProfileRecord)))
        strategist = next(agent for agent in agents if agent.name == "Business Strategist")
        documenter = next(agent for agent in agents if agent.name == "Business Marketing & Strategy Documenter")

    create_response = client.post(
        f"/api/agents/{strategist.id}/conversations",
        json={"workflow_mode": "data_collector", "conversation_mode": "working_session", "title": "FY26 strategy"},
    )
    assert create_response.status_code == 200
    strategist_conversation = create_response.json()
    assert strategist_conversation["workflow_mode"] == "data_collector"
    assert strategist_conversation["document_frame_id"]

    with SessionLocal() as session:
        message = AgentMessageRecord(
            conversation_id=strategist_conversation["id"],
            agent_id=strategist.id,
            role="assistant",
            content="Approved strategist fragment.",
            workflow_mode="data_collector",
        )
        session.add(message)
        session.commit()
        session.refresh(message)
        message_id = message.id

    approve_response = client.post(
        f"/api/conversations/{strategist_conversation['id']}/document-frame/fragments",
        json={"source_message_id": message_id, "fragment_type": "paragraph"},
    )
    assert approve_response.status_code == 200
    frame = approve_response.json()
    assert len(frame["fragments"]) == 1
    assert frame["fragments"][0]["content"] == "Approved strategist fragment."

    documenter_response = client.post(
        f"/api/agents/{documenter.id}/conversations",
        json={
            "workflow_mode": "documenter",
            "conversation_mode": "board",
            "source_conversation_id": strategist_conversation["id"],
            "title": "FY26 board paper",
        },
    )
    assert documenter_response.status_code == 200
    documenter_conversation = documenter_response.json()
    assert documenter_conversation["workflow_mode"] == "documenter"
    assert documenter_conversation["document_frame_id"] == strategist_conversation["document_frame_id"]
