from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hubtiger_elevenlabs_tool import router


def make_client(secret: str = "test-secret") -> TestClient:
    os.environ["ELEVENLABS_HUBTIGER_WEBHOOK_SECRET"] = secret
    os.environ["HUBTIGER_TOOL_ACCESS"] = "read_only"
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_health_requires_auth() -> None:
    client = make_client()
    res = client.get("/api/elevenlabs/hubtiger/health")
    assert res.status_code == 401


def test_health_ok() -> None:
    client = make_client()
    res = client.get("/api/elevenlabs/hubtiger/health", headers={"X-Ghost-Voice-Key": "test-secret"})
    assert res.status_code == 200
    assert res.json()["auth_configured"] is True


def test_lookup_requires_identifier() -> None:
    client = make_client()
    res = client.post(
        "/api/elevenlabs/hubtiger/tool",
        headers={"X-Ghost-Voice-Key": "test-secret"},
        json={"function": "lookup_job", "payload": {}},
    )
    assert res.status_code == 422


def test_write_blocked_in_read_only() -> None:
    client = make_client()
    res = client.post(
        "/api/elevenlabs/hubtiger/tool",
        headers={"X-Ghost-Voice-Key": "test-secret"},
        json={
            "function": "booking_create",
            "store": "brisbane",
            "customer": {"phone": "0435185134", "first_name": "Test", "last_name": "User"},
            "payload": {"date": "2026-04-30", "start_time": "10:00"},
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is False
    assert body["error_code"] == "hubtiger_read_only_mode"


def test_flat_fields_validate_for_lookup(monkeypatch) -> None:
    async def fake_call_mcp(operation, payload, trace_id):
        from hubtiger_elevenlabs_schemas import PublicToolResult

        assert operation == "job_lookup"
        assert payload["customer"]["phone"].startswith("+61")
        return PublicToolResult(success=True, public_message="I found the matching Ride Electric record.", data={})

    import hubtiger_elevenlabs_tool

    monkeypatch.setattr(hubtiger_elevenlabs_tool, "_call_mcp", fake_call_mcp)
    client = make_client()
    res = client.post(
        "/api/elevenlabs/hubtiger/tool",
        headers={"X-Ghost-Voice-Key": "test-secret"},
        json={"function": "lookup_job", "phone": "0435 185 134"},
    )
    assert res.status_code == 200
    assert res.json()["success"] is True
