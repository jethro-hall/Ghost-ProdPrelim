from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient

from ghostdash_api import control_api


class _FakeResponse:
    def __init__(self, *, status_code: int = 200, payload: dict | None = None, content: bytes | None = None, headers: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}
        self.content = content if content is not None else (b"{}" if payload is not None else b"")
        self.headers = headers or {}

    def json(self) -> dict:
        return self._payload


def test_elevenlabs_analysis_conversations_degrades_when_api_key_missing(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)

    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_analysis.get_settings",
        lambda: SimpleNamespace(elevenlabs_api_key=None, shopify_mcp_timeout_ms=15000),
    )

    response = client.get("/api/elevenlabs/analysis/conversations")
    assert response.status_code == 200
    body = response.json()
    assert body["upstream_ready"] is False
    assert body["warning_code"] == "elevenlabs_upstream_error"
    assert "not configured" in body["warning_message"].lower()


def test_elevenlabs_analysis_conversations_maps_payload(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    calls: list[dict] = []

    class _AsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url: str, *, headers: dict, params=None):
            calls.append({"url": url, "headers": headers, "params": params})
            return _FakeResponse(
                payload={
                    "conversations": [
                        {
                            "conversation_id": "conv_1",
                            "call_summary_title": "Workshop Booking Search",
                            "start_time_unix_secs": 1777526490,
                            "status": "done",
                            "call_successful": "success",
                            "call_duration_secs": 115,
                            "message_count": 12,
                            "user_id": "+61435185134",
                            "branch_id": "main",
                            "main_language": "en",
                            "conversation_initiation_source": "widget",
                            "direction": "inbound",
                            "rating": 5,
                            "agent_id": "agent_1",
                            "agent_name": "Magic Mike",
                        }
                    ],
                    "next_cursor": "next_123",
                    "has_more": True,
                }
            )

    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_analysis.get_settings",
        lambda: SimpleNamespace(elevenlabs_api_key="key", shopify_mcp_timeout_ms=15000),
    )
    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_analysis.httpx.AsyncClient", _AsyncClient)

    response = client.get(
        "/api/elevenlabs/analysis/conversations",
        params={"limit": 20, "search": "booking", "status": "success", "conversation_status": "done"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "elevenlabs"
    assert body["has_more"] is True
    assert body["next_cursor"] == "next_123"
    assert body["items"][0]["id"] == "conv_1"
    assert body["items"][0]["title"] == "Workshop Booking Search"
    assert body["items"][0]["status"] == "done"
    assert calls
    params = calls[0]["params"]
    assert ("call_successful", "success") in params
    assert ("exclude_statuses", "failed") in params
    assert ("search", "booking") in params


def test_elevenlabs_analysis_transcript_endpoint_maps_turns(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)

    class _AsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url: str, *, headers: dict, params=None):
            return _FakeResponse(
                payload={
                    "conversation_id": "conv_abc",
                    "transcript": [
                        {
                            "role": "agent",
                            "message": "I can help with that.",
                            "time_in_call_secs": 13,
                            "source_medium": "audio",
                            "conversation_turn_metrics": {"tts_ms": 746},
                        },
                        {
                            "role": "user",
                            "message": "How do I charge it?",
                            "time_in_call_secs": 23,
                            "source_medium": "audio",
                            "interrupted": False,
                        },
                    ],
                }
            )

    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_analysis.get_settings",
        lambda: SimpleNamespace(elevenlabs_api_key="key", shopify_mcp_timeout_ms=15000),
    )
    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_analysis.httpx.AsyncClient", _AsyncClient)

    response = client.get("/api/elevenlabs/analysis/conversations/conv_abc/transcript")
    assert response.status_code == 200
    body = response.json()
    assert body["conversation_id"] == "conv_abc"
    assert body["turn_count"] == 2
    assert body["turns"][0]["role"] == "agent"
    assert body["turns"][0]["metrics"]["tts_ms"] == 746


def test_elevenlabs_analysis_audio_unavailable_returns_safe_json(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)

    class _AsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url: str, *, headers: dict, params=None):
            return _FakeResponse(status_code=404)

    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_analysis.get_settings",
        lambda: SimpleNamespace(elevenlabs_api_key="key", shopify_mcp_timeout_ms=15000),
    )
    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_analysis.httpx.AsyncClient", _AsyncClient)

    response = client.get("/api/elevenlabs/analysis/conversations/conv_missing/audio")
    assert response.status_code == 404
    body = response.json()
    assert body["available"] is False
    assert body["code"] == "audio_unavailable"


def test_elevenlabs_analysis_health_reports_invalid_key(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)

    class _AsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url: str, *, headers: dict, params=None):
            return _FakeResponse(status_code=401, payload={"detail": {"status": "invalid_api_key"}})

    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_analysis.get_settings",
        lambda: SimpleNamespace(elevenlabs_api_key="bad", elevenlabs_analysis_timeout_ms=15000, shopify_mcp_timeout_ms=15000),
    )
    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_analysis.httpx.AsyncClient", _AsyncClient)

    response = client.get("/api/elevenlabs/analysis/health")
    assert response.status_code == 503
    body = response.json()
    assert body["ready"] is False
    assert body["error_code"] == "elevenlabs_invalid_api_key"
