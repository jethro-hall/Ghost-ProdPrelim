from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ghostdash_api import control_api
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
