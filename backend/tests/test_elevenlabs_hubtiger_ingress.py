from __future__ import annotations

from fastapi.testclient import TestClient

from ghostdash_api import agent_ingress, voice_ingress


def test_elevenlabs_hubtiger_discovery_get() -> None:
    app = agent_ingress.create_app()
    client = TestClient(app)
    response = client.get("/agent/integrations/elevenlabs/hubtiger")
    assert response.status_code == 200
    body = response.json()
    assert body["post_path"] == "/agent/integrations/elevenlabs/hubtiger/tool"
    assert body["method"] == "POST"


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
        json={"operation": "availability_lookup", "store": "brisbane", "start_date": "2026/04/29"},
        headers={"Authorization": "Bearer el-secret-xyz"},
    )
    assert good.status_code == 200
    assert "trace_id" not in good.json()


def test_elevenlabs_hubtiger_respects_read_only_for_writes(monkeypatch) -> None:
    from datetime import datetime, timedelta
    from unittest.mock import AsyncMock, patch

    import httpx

    app = agent_ingress.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "s")
    monkeypatch.setattr(agent_ingress.settings, "hubtiger_mcp_url", "http://hubtiger-mcp:8096")
    monkeypatch.setattr(agent_ingress.settings, "hubtiger_tool_access", "read_only")
    service_dt = datetime.now() + timedelta(days=2)
    while service_dt.weekday() == 6:
        service_dt += timedelta(days=1)
    service_dt = service_dt.replace(hour=10, minute=0, second=0, microsecond=0)
    preflight_body = {
        "ok": True,
        "data": {
            "rows": [{"id": 2730, "date": service_dt.strftime("%Y%m%d"), "roundedAvailableTime": 120}],
        },
    }
    with patch("ghostdash_api.hubtiger_mcp.httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(
            return_value=httpx.Response(200, json=preflight_body)
        )
        r = client.post(
            "/agent/integrations/elevenlabs/hubtiger/tool",
            json={
                "operation": "booking_create",
                "payload": {
                    "store": "brisbane",
                    "ID": 2186,
                    "BikeID": 3566881,
                    "ServiceTypes": [19802],
                    "ServiceDate": service_dt.isoformat(),
                    "TechnicianID": 2730,
                },
            },
            headers={"Authorization": "Bearer s"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["blocked"] is True
    assert "workshop team" in body["message"].lower()
    assert body["data"]["review_status"] == "pending_staff_review"
    assert body["data"]["booking_confirmed"] is False
    assert "data" in body
    assert "trace_id" not in body


def test_elevenlabs_hubtiger_tool_accepts_canonical_function_payload(monkeypatch) -> None:
    app = agent_ingress.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "s")
    monkeypatch.setattr(agent_ingress.settings, "hubtiger_mcp_url", None)

    response = client.post(
        "/agent/integrations/elevenlabs/hubtiger/tool",
        json={
            "function": "lookup_job",
            "store": "Brisbane Newstead",
            "date": "2026-04-29",
            "customer": {"phone": "0412 345 678", "first_name": "Alex"},
        },
        headers={"Authorization": "Bearer s"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["operation"] == "job_lookup"
    assert payload["success"] is False
    assert "not configured" in payload["message"].lower()


def test_elevenlabs_hubtiger_tool_accepts_webhook_secret(monkeypatch) -> None:
    app = agent_ingress.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "s")
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hub-secret")
    monkeypatch.setattr(agent_ingress.settings, "hubtiger_mcp_url", None)
    response = client.post(
        "/agent/integrations/elevenlabs/hubtiger/tool",
        json={"function": "availability_lookup", "store": "brisbane", "date": "2026-04-29"},
        headers={"X-Ghost-Voice-Key": "hub-secret"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["operation"] == "availability_lookup"
