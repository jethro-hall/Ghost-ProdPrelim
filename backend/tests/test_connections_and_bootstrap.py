from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ghostdash_api import control_api
from ghostdash_api.agent_memory import seed_default_agent_profiles
from ghostdash_api.database import Base, get_session
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
    assert payload["features"] == {
        "allow_mock_provider": False,
        "allow_api_mode_override": False,
        "allow_approved_web_toggle": True,
    }
    assert payload["runtime_defaults"]["llm_provider_key"] == "openai"
    assert payload["runtime_defaults"]["llm_provider_kind"] == "openai"
    assert payload["runtime_defaults"]["llm_connection_label"] == "OpenAI"
    assert len(payload["agents"]) >= 1
