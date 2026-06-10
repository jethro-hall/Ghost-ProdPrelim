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
    assert "requires `store`" in str(payload["detail"]).lower()


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
    binding_ids = [binding["tool_id"] for binding in payload["bindings"]]
    for required in (
        "hubtiger_booking_availability",
        "hubtiger_job_lookup",
        "hubtiger_booking_create",
        "hubtiger_booking_update",
        "hubtiger_quote_add_line_item",
    ):
        assert required in binding_ids


def test_hubtiger_test_blocks_write_operation_in_read_only_mode(monkeypatch) -> None:
    from datetime import datetime, timedelta
    from unittest.mock import AsyncMock, patch

    import httpx

    client = build_client(monkeypatch)
    monkeypatch.setattr(control_api.settings, "hubtiger_tool_access", "read_only")
    monkeypatch.setattr(control_api.settings, "hubtiger_mcp_url", "http://hubtiger-mcp:8096")
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
        response = client.post(
            "/api/hubtiger/test",
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
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["blocked"] is True
    assert payload["mode"] == "read_only"
    assert payload["data"]["review_status"] == "pending_staff_review"
    assert payload["data"]["booking_confirmed"] is False


def test_hubtiger_write_reviews_list_empty(monkeypatch, tmp_path) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(control_api.settings, "app_data_dir", str(tmp_path))
    response = client.get("/api/hubtiger/write-reviews")
    assert response.status_code == 200
    assert response.json() == []


def test_hubtiger_write_review_approve_not_found(monkeypatch, tmp_path) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(control_api.settings, "app_data_dir", str(tmp_path))
    response = client.post("/api/hubtiger/write-reviews/ht_review_missing/approve")
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is False
    assert payload["data"]["error_code"] == "review_not_found"


def test_hubtiger_write_review_approve_queues_replay_without_auto_execute(monkeypatch, tmp_path) -> None:
    from datetime import datetime, timedelta
    from unittest.mock import AsyncMock, patch

    import httpx

    from ghostdash_api.hubtiger_write_review import append_pending_review

    client = build_client(monkeypatch)
    monkeypatch.setattr(control_api.settings, "app_data_dir", str(tmp_path))
    monkeypatch.setattr(control_api.settings, "hubtiger_tool_access", "read_write")
    monkeypatch.setattr(control_api.settings, "hubtiger_booking_auto_execute", False)
    monkeypatch.setattr(control_api.settings, "hubtiger_mcp_url", "http://hubtiger-mcp:8096")
    service_dt = datetime.now() + timedelta(days=2)
    while service_dt.weekday() == 6:
        service_dt += timedelta(days=1)
    service_dt = service_dt.replace(hour=10, minute=0, second=0, microsecond=0)
    append_pending_review(
        {
            "review_id": "ht_review_test123",
            "created_at": service_dt.isoformat(),
            "trace_id": "trace-approve",
            "status": "pending_staff_review",
            "operation": "booking_create",
            "execute_request": {"operation": "booking_create", "method": "POST", "proxy_path": "/bookings", "proxy_body": {}},
            "payload": {
                "store": "brisbane",
                "ServiceDate": service_dt.isoformat(),
                "TechnicianID": 2730,
            },
            "preflight_snapshot": {"slot_available": True},
        }
    )
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
        response = client.post("/api/hubtiger/write-reviews/ht_review_test123/approve")
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["data"]["review_status"] == "approved_pending_replay"
    assert mock_client.return_value.__aenter__.return_value.post.call_count == 1


def test_elevenlabs_hubtiger_booking_create_requires_voice_key(monkeypatch) -> None:
    client = build_client(monkeypatch)
    monkeypatch.setattr(voice_ingress.settings, "app_voice_ingress_secret", "voice-secret")
    response = client.post(
        "/api/elevenlabs/hubtiger/booking_create",
        json={"function": "booking_create", "store": "brisbane", "payload": {}},
    )
    assert response.status_code == 401


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
