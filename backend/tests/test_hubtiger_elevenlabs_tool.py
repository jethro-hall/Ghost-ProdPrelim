from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from ghostdash_api import control_api, voice_ingress
from ghostdash_api.schemas import PublicToolResult
from ghostdash_api.integrations import hubtiger_elevenlabs_tool as hubtiger_tool_mod


def test_health_requires_voice_key(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hook-secret")

    response = client.get("/api/elevenlabs/hubtiger/health")
    assert response.status_code == 401


def test_health_mcp_probe_timeout_returns_504_with_error_code(monkeypatch) -> None:
    """Clients must be able to distinguish MCP probe timeout from generic unavailable."""

    class _ProbeSettings:
        hubtiger_mcp_url = "http://hubtiger-mcp:8096"
        hubtiger_mcp_health_timeout_ms = 4000

    class _TimeoutClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url: str):
            raise httpx.ReadTimeout("timeout", request=httpx.Request("GET", url))

    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hook-secret")
    monkeypatch.setattr(hubtiger_tool_mod, "get_settings", lambda: _ProbeSettings())
    monkeypatch.setattr(hubtiger_tool_mod.httpx, "AsyncClient", _TimeoutClient)

    response = client.get("/api/elevenlabs/hubtiger/health", headers={"X-Ghost-Voice-Key": "hook-secret"})
    assert response.status_code == 504
    body = response.json()
    assert body["ready"] is False
    assert body["error_code"] == "hubtiger_mcp_health_timeout"
    assert body["timeout_ms"] == 4000
    assert "timed out" in body["message"].lower()


def test_lookup_tool_supports_phone_and_hides_internal_fields(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hook-secret")

    async def fake_shared_runner(*, body, request) -> PublicToolResult:
        assert body.function == "lookup_job"
        assert body.payload.get("phone")
        assert body.customer and body.customer.phone
        return PublicToolResult(
            success=True,
            blocked=False,
            message="Lookup completed.",
            operation="job_lookup",
            data={"results": [{"id": 123, "status": "Booked In"}]},
        )

    monkeypatch.setattr(
        "ghostdash_api.integrations.hubtiger_elevenlabs_tool.run_elevenlabs_hubtiger_tool_request",
        fake_shared_runner,
    )

    response = client.post(
        "/api/elevenlabs/hubtiger/tool",
        json={"function": "lookup_job", "phone": "0435185134"},
        headers={"X-Ghost-Voice-Key": "hook-secret"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["operation"] == "job_lookup"
    assert body["message"] == "Lookup completed."


def test_lookup_tool_accepts_job_retrieve_and_cache_bypass(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hook-secret")

    async def fake_shared_runner(*, body, request) -> PublicToolResult:
        assert body.function == "job_retrieve"
        assert body.cache_mode == "no_cache"
        assert body.payload.get("job_card_no") == "#35872"
        return PublicToolResult(
            success=True,
            blocked=False,
            message="Retrieve completed.",
            operation="job_retrieve",
            data={"count": 1},
        )

    monkeypatch.setattr(
        "ghostdash_api.integrations.hubtiger_elevenlabs_tool.run_elevenlabs_hubtiger_tool_request",
        fake_shared_runner,
    )

    response = client.post(
        "/api/elevenlabs/hubtiger/tool",
        json={"function": "job_retrieve", "store": "southport", "job_card_no": "#35872", "cache_mode": "no_cache"},
        headers={"X-Ghost-Voice-Key": "hook-secret"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["operation"] == "job_retrieve"


def test_booking_availability_tool_maps_to_shared_runner(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hook-secret")

    async def fake_shared_runner(*, body, request) -> PublicToolResult:
        assert body.function == "booking_availability"
        assert body.store == "brisbane"
        assert body.start_date == "2026-05-21"
        return PublicToolResult(
            success=True,
            blocked=False,
            message="No open slots on that date.",
            operation="availability_lookup",
            data={"slot_count": 0},
        )

    monkeypatch.setattr(
        "ghostdash_api.integrations.hubtiger_elevenlabs_tool.run_elevenlabs_hubtiger_tool_request",
        fake_shared_runner,
    )

    response = client.post(
        "/api/elevenlabs/hubtiger/tool",
        json={
            "function": "booking_availability",
            "store": "brisbane",
            "start_date": "2026-05-21",
            "payload": {},
        },
        headers={"X-Ghost-Voice-Key": "hook-secret"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["operation"] == "availability_lookup"


def test_lookup_tool_rejects_write_functions(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hook-secret")

    response = client.post(
        "/api/elevenlabs/hubtiger/tool",
        json={"function": "booking_create", "store": "southport", "payload": {"first_name": "Alex"}},
        headers={"X-Ghost-Voice-Key": "hook-secret"},
    )
    assert response.status_code == 422


def test_lookup_tool_returns_clarification_message_on_store_mismatch(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hook-secret")

    async def fake_shared_runner(*, body, request) -> PublicToolResult:
        return PublicToolResult(
            success=True,
            blocked=False,
            message="Retrieve completed.",
            operation="job_search",
            data={
                "case_select": {
                    "selection_required": True,
                    "store_verification": "mismatch",
                    "store_requested": "brisbane",
                    "store_matched": "southport",
                    "assistant_prompt": "Please confirm the correct store before I continue.",
                },
                "options": [{"job_card_no": "#35872"}],
            },
        )

    monkeypatch.setattr(
        "ghostdash_api.integrations.hubtiger_elevenlabs_tool.run_elevenlabs_hubtiger_tool_request",
        fake_shared_runner,
    )

    response = client.post(
        "/api/elevenlabs/hubtiger/tool",
        json={"function": "job_search", "store": "brisbane", "phone": "0435185134"},
        headers={"X-Ghost-Voice-Key": "hook-secret"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert "confirm the correct store" in body["message"].lower()
