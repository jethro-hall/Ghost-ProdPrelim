from __future__ import annotations

import json

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ghostdash_api import agent_ingress, voice_ingress
from ghostdash_api.database import Base, get_session
from ghostdash_api.models import AgentMessageRecord, AgentProfileRecord, ConnectionRecord, VoiceTurnRecord
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

    monkeypatch.setattr(agent_ingress, "initialize_agent_runtime_state", lambda: None)
    monkeypatch.setattr(agent_ingress, "SessionLocal", SessionLocal)
    monkeypatch.setattr(voice_ingress, "SessionLocal", SessionLocal)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "test-secret")
    monkeypatch.setattr(
        voice_ingress,
        "resolve_llm_connection",
        lambda session, **kwargs: ConnectionRecord(
            provider="openai",
            label="OpenAI",
            provider_kind="openai",
            auth_strategy="bearer",
            api_key="test-key",
            base_url="https://api.openai.com/v1",
            enabled=True,
        ),
    )

    def override_get_session():
        with SessionLocal() as session:
            yield session

    app = agent_ingress.create_app()
    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app), SessionLocal


def seed_agent(SessionLocal) -> str:
    with SessionLocal() as session:
        runtime_profile = seed_default_runtime_profile(session)
        runtime_profile.llm_config_json = {"provider": "openai", "model_id": "openai/gpt-voice-test", "max_tokens": 120}
        agent = AgentProfileRecord(
            name="Voice Agent",
            first_message="hello",
            language="en-AU",
            voice_id="alloy",
            runtime_profile_id=runtime_profile.id,
            is_default=True,
            enabled=True,
        )
        session.add(agent)
        session.commit()
        return agent.id


def voice_payload(agent_id: str, *, content: str = "Say hello briefly.", turn_id: str = "turn-1") -> dict:
    return {
        "model": "ghostdash-default",
        "stream": True,
        "metadata": {
            "agent_id": agent_id,
            "twilio_call_sid": "CA123",
            "elevenlabs_conversation_id": "el-456",
            "turn_id": turn_id,
        },
        "messages": [{"role": "user", "content": content}],
    }


def post_voice(client: TestClient, payload: dict):
    return client.post("/agent/v1/chat/completions", json=payload, headers={"x-ghost-voice-key": "test-secret"})


def parse_openai_sse(body: str) -> tuple[list[dict], int]:
    events: list[dict] = []
    done_count = 0
    for block in body.strip().split("\n\n"):
        if not block:
            continue
        assert block.startswith("data: ")
        payload = block.removeprefix("data: ")
        if payload == "[DONE]":
            done_count += 1
        else:
            events.append(json.loads(payload))
    return events, done_count


def joined_content(events: list[dict]) -> str:
    return "".join(
        str(choice.get("delta", {}).get("content", ""))
        for event in events
        for choice in event.get("choices", [])
    )


def test_voice_chat_completions_streams_openai_compatible_chunks(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    monkeypatch.setattr(voice_ingress, "stream_answer", lambda *args, **kwargs: iter(["Hello ", "there."]))

    response = post_voice(client, voice_payload(agent_id))

    assert response.status_code == 200
    events, done_count = parse_openai_sse(response.text)
    assert done_count == 1
    assert events[0]["object"] == "chat.completion.chunk"
    assert events[0]["choices"][0]["delta"] == {"role": "assistant"}
    assert joined_content(events) == "Hello there."
    with SessionLocal() as session:
        turn = session.scalar(select(VoiceTurnRecord))
        assert turn is not None
        assert turn.status == "completed"
        assert turn.provider_session_id == "CA123"
        assert turn.response_json["answer"] == "Hello there."
        assert session.scalar(select(AgentMessageRecord).where(AgentMessageRecord.role == "assistant")).content == "Hello there."


def test_voice_ingress_rejects_unauthorized_requests_when_secret_configured(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "secret")

    response = client.post("/agent/v1/chat/completions", json=voice_payload(agent_id))

    assert response.status_code == 401


def test_voice_turn_replay_is_idempotent(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    calls = {"count": 0}

    def fake_stream(*args, **kwargs):
        calls["count"] += 1
        return iter(["First answer."])

    monkeypatch.setattr(voice_ingress, "stream_answer", fake_stream)
    payload = voice_payload(agent_id)

    first = post_voice(client, payload)
    second = post_voice(client, payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert joined_content(parse_openai_sse(second.text)[0]) == "First answer."
    assert calls["count"] == 1
    with SessionLocal() as session:
        assert len(list(session.scalars(select(VoiceTurnRecord)))) == 1
        assert len(list(session.scalars(select(AgentMessageRecord)))) == 2


def test_pre_guard_blocks_caller_model_override_before_model_call(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    calls = {"count": 0}

    def fake_stream(*args, **kwargs):
        calls["count"] += 1
        return iter(["unsafe"])

    monkeypatch.setattr(voice_ingress, "stream_answer", fake_stream)
    payload = voice_payload(agent_id)
    payload["model"] = "caller-selected-model"

    response = post_voice(client, payload)

    assert response.status_code == 200
    assert "approved voice model" in joined_content(parse_openai_sse(response.text)[0])
    assert calls["count"] == 0
    with SessionLocal() as session:
        assert session.scalar(select(VoiceTurnRecord)).status == "blocked"


def test_streaming_guard_prevents_secret_text_from_reaching_elevenlabs(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    monkeypatch.setattr(voice_ingress, "stream_answer", lambda *args, **kwargs: iter(["The api_key is abc123."]))

    response = post_voice(client, voice_payload(agent_id, turn_id="turn-secret"))

    assert response.status_code == 200
    spoken = joined_content(parse_openai_sse(response.text)[0])
    assert "api_key" not in spoken
    assert voice_ingress.VOICE_SAFE_RECOVERY_TEXT in spoken
    with SessionLocal() as session:
        assert session.scalar(select(VoiceTurnRecord)).status == "blocked"


def test_voice_setup_failure_marks_turn_failed_and_replays_on_retry(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)

    def fail_connection(*args, **kwargs):
        raise ValueError("missing provider connection")

    monkeypatch.setattr(voice_ingress, "resolve_llm_connection", fail_connection)
    payload = voice_payload(agent_id, turn_id="turn-fail")

    first = post_voice(client, payload)
    second = post_voice(client, payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert "trouble checking" in joined_content(parse_openai_sse(first.text)[0])
    assert "trouble checking" in joined_content(parse_openai_sse(second.text)[0])
    with SessionLocal() as session:
        turn = session.scalar(select(VoiceTurnRecord))
        assert turn.status == "failed"
        assert "missing provider connection" in (turn.error_message or "")


def test_voice_provider_voices_returns_unconfigured_status(monkeypatch) -> None:
    client, _SessionLocal = build_client(monkeypatch)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_api_key", None)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_default_voice_id", "voice-default")

    response = client.get("/agent/voice/voices")

    assert response.status_code == 200
    payload = response.json()
    assert payload["configured"] is False
    assert payload["default_voice_id"] == "voice-default"
    assert payload["voices"][0]["preview_available"] is False


def test_voice_preview_fails_closed_without_elevenlabs_config(monkeypatch) -> None:
    client, _SessionLocal = build_client(monkeypatch)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_api_key", None)

    response = client.post("/agent/voice/preview", json={"voice_id": "voice-1", "text": "hello"})

    assert response.status_code == 503


def test_voice_stream_websocket_reports_unconfigured(monkeypatch) -> None:
    client, _SessionLocal = build_client(monkeypatch)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_api_key", None)

    with client.websocket_connect("/agent/voice/stream") as websocket:
        payload = websocket.receive_json()

    assert payload["type"] == "error"
    assert payload["status"] == "unconfigured"


def test_tts_stream_websocket_reports_unconfigured(monkeypatch) -> None:
    client, _SessionLocal = build_client(monkeypatch)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_api_key", None)

    with client.websocket_connect("/agent/voice/tts-stream?voice_id=voice-1") as websocket:
        payload = websocket.receive_json()

    assert payload["type"] == "error"
    assert "not configured" in payload["message"]
