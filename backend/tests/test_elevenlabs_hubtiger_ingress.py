from __future__ import annotations

from fastapi.testclient import TestClient

from ghostdash_api import agent_ingress, voice_ingress


def test_elevenlabs_hubtiger_tool_requires_voice_secret(monkeypatch) -> None:
    app = agent_ingress.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "el-secret-xyz")

    response = client.post(
        "/agent/integrations/elevenlabs/hubtiger/tool",
        json={"operation": "availability_lookup", "payload": {"postcode": "4220"}},
    )
    assert response.status_code == 401

    good = client.post(
        "/agent/integrations/elevenlabs/hubtiger/tool",
        json={"operation": "availability_lookup", "payload": {"postcode": "4220"}},
        headers={"Authorization": "Bearer el-secret-xyz"},
    )
    assert good.status_code == 200
    assert "trace_id" not in good.json()


def test_elevenlabs_hubtiger_respects_read_only_for_writes(monkeypatch) -> None:
    app = agent_ingress.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "s")
    monkeypatch.setattr(agent_ingress.settings, "hubtiger_mcp_url", "http://hubtiger-mcp:8096")
    monkeypatch.setattr(agent_ingress.settings, "hubtiger_tool_access", "read_only")

    r = client.post(
        "/agent/integrations/elevenlabs/hubtiger/tool",
        json={"operation": "booking_create", "payload": {"customer_name": "Alex"}},
        headers={"Authorization": "Bearer s"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is False
    assert body["blocked"] is True
    assert "data" in body
    assert "trace_id" not in body
