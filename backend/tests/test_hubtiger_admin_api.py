from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ghostdash_api import control_api, voice_ingress
from ghostdash_api.database import Base, get_session


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
    return TestClient(app)


def test_elevenlabs_hubtiger_booking_availability_requires_voice_key(monkeypatch) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    response = client.post(
        "/api/elevenlabs/hubtiger/booking_availability",
        json={"store": "brisbane", "start_date": "2026/04/29", "limit": 4},
    )
    assert response.status_code == 401


def test_elevenlabs_hubtiger_booking_availability_ok_when_unconfigured(monkeypatch) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    monkeypatch.setattr(control_api.settings, "hubtiger_mcp_url", None)
    response = client.post(
        "/api/elevenlabs/hubtiger/booking_availability",
        json={"store": "brisbane", "start_date": "2026/04/29", "limit": 4},
        headers={"X-Ghost-Voice-Key": "voice-secret"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is False
    assert payload["operation"] == "availability_lookup"
    assert "not configured" in payload["message"].lower()


def test_elevenlabs_hubtiger_tool_ok_with_canonical_inputs(monkeypatch) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    monkeypatch.setattr(control_api.settings, "hubtiger_mcp_url", None)
    response = client.post(
        "/api/elevenlabs/hubtiger/tool",
        json={
            "function": "lookup_job",
            "store": "Brisbane Newstead",
            "phone": "0412 345 678",
            "first_name": "Alex",
            "last_name": "Rider",
        },
        headers={"X-Ghost-Voice-Key": "voice-secret"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is False
    assert payload["operation"] == "job_lookup"
    assert "not configured" in payload["message"].lower()


def test_elevenlabs_hubtiger_tool_requires_minimum_for_availability(monkeypatch) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    response = client.post(
        "/api/elevenlabs/hubtiger/tool",
        json={"function": "availability_lookup", "date": "2026-04-29"},
        headers={"X-Ghost-Voice-Key": "voice-secret"},
    )
    assert response.status_code == 422
    payload = response.json()
    assert "lookup-only mode supports" in str(payload["detail"]).lower()


def test_elevenlabs_hubtiger_tool_accepts_webhook_secret(monkeypatch) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hub-secret")
    monkeypatch.setattr(control_api.settings, "hubtiger_mcp_url", None)
    response = client.post(
        "/api/elevenlabs/hubtiger/tool",
        json={"function": "lookup_job", "phone": "0412345678"},
        headers={"X-Ghost-Voice-Key": "hub-secret"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["operation"] == "job_lookup"


def test_hubtiger_root_redirects_to_status(monkeypatch) -> None:
    client = build_client(monkeypatch)
    response = client.get("/api/hubtiger", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers.get("location") == "/api/hubtiger/status"


def test_hubtiger_status_reports_unconfigured_mode(monkeypatch) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(control_api.settings, "hubtiger_tool_access", "read_only")
    monkeypatch.setattr(control_api.settings, "hubtiger_mcp_url", None)
    monkeypatch.setattr(control_api.settings, "hubtiger_proxy_url", None)

    response = client.get("/api/hubtiger/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"]["mode"] == "read_only"
    assert payload["status"]["health"] == "unconfigured"
    assert payload["status"]["mcp_url_configured"] is False
    assert len(payload["bindings"]) >= 4
    assert [binding["tool_id"] for binding in payload["bindings"]] == [
        "hubtiger_booking_availability",
        "hubtiger_job_lookup",
        "hubtiger_quote_preview",
        "hubtiger_booking_create",
        "hubtiger_quote_add_line_item",
    ]


def test_hubtiger_test_blocks_write_operation_in_read_only_mode(monkeypatch) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(control_api.settings, "hubtiger_tool_access", "read_only")
    monkeypatch.setattr(control_api.settings, "hubtiger_mcp_url", "http://hubtiger-mcp:8096")

    response = client.post(
        "/api/hubtiger/test",
        json={"operation": "booking_create", "payload": {"customer_name": "Alex"}},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is False
    assert payload["blocked"] is True
    assert payload["mode"] == "read_only"
    assert "disabled" in payload["message"].lower()


def test_hubtiger_test_reports_unconfigured_when_no_mcp_url(monkeypatch) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(control_api.settings, "hubtiger_tool_access", "read_only")
    monkeypatch.setattr(control_api.settings, "hubtiger_mcp_url", "")

    response = client.post(
        "/api/hubtiger/test",
        json={"operation": "availability_lookup", "payload": {"postcode": "4220"}},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is False
    assert payload["blocked"] is False
    assert "not configured" in payload["message"].lower()
