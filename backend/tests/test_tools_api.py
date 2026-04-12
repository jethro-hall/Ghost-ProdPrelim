from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ghostdash_api import control_api, odoo_connector, tool_registry
from ghostdash_api.database import Base, get_session
from ghostdash_api.models import AgentProfileRecord, RuntimeProfileRecord, ToolRegistryRecord
from ghostdash_api.odoo_connector import ODOO_TOOL_ID
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


def seed_agents(SessionLocal) -> tuple[str, str, str]:
    with SessionLocal() as session:
        runtime_profile = seed_default_runtime_profile(session)
        primary = AgentProfileRecord(
            name="Primary Agent",
            first_message="hello",
            language="en-US",
            voice_id="alloy",
            runtime_profile_id=runtime_profile.id,
            is_default=True,
            enabled=True,
        )
        peer = AgentProfileRecord(
            name="Peer Agent",
            first_message="hello",
            language="en-US",
            voice_id="alloy",
            runtime_profile_id=runtime_profile.id,
            is_default=False,
            enabled=True,
        )
        session.add_all([primary, peer])
        session.commit()
        return primary.id, peer.id, runtime_profile.id


def test_chat_bootstrap_includes_tool_catalog_and_policy_updates_clone_shared_profile(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    primary_agent_id, peer_agent_id, default_profile_id = seed_agents(SessionLocal)

    catalog_response = client.get("/api/tools/catalog")
    assert catalog_response.status_code == 200
    catalog = catalog_response.json()
    assert catalog == [
        {
            "id": ODOO_TOOL_ID,
            "provider": "odoo",
            "name": "Odoo ERP",
            "gateway": "ghoststack-rag",
            "description": "Governed Odoo ERP access routed through the Ghost stack control plane.",
            "status": "unknown",
            "active": False,
            "configured": False,
            "read_only": True,
            "session_toggleable": True,
        }
    ]

    bootstrap_response = client.get("/api/chat/bootstrap?surface=ghost_chatui")
    assert bootstrap_response.status_code == 200
    bootstrap = bootstrap_response.json()
    assert any(tool["id"] == ODOO_TOOL_ID for tool in bootstrap["tools_catalog"])

    policy_before = client.get(f"/api/tools/policy/{peer_agent_id}")
    assert policy_before.status_code == 200
    assert policy_before.json() == {"agent_id": peer_agent_id, "allowed_tool_ids": []}

    policy_after = client.post(
        f"/api/tools/policy/{peer_agent_id}",
        json={"allowed_tool_ids": [ODOO_TOOL_ID]},
    )
    assert policy_after.status_code == 200
    assert policy_after.json() == {"agent_id": peer_agent_id, "allowed_tool_ids": [ODOO_TOOL_ID]}

    with SessionLocal() as session:
        primary = session.get(AgentProfileRecord, primary_agent_id)
        peer = session.get(AgentProfileRecord, peer_agent_id)
        assert primary is not None
        assert peer is not None
        assert primary.runtime_profile_id == default_profile_id
        assert peer.runtime_profile_id != default_profile_id

        default_profile = session.get(RuntimeProfileRecord, default_profile_id)
        peer_profile = session.get(RuntimeProfileRecord, peer.runtime_profile_id)
        assert default_profile is not None
        assert peer_profile is not None

        default_odoo = next(
            tool for tool in list(default_profile.tool_policy_config_json.get("tools") or []) if tool["id"] == ODOO_TOOL_ID
        )
        peer_odoo = next(
            tool for tool in list(peer_profile.tool_policy_config_json.get("tools") or []) if tool["id"] == ODOO_TOOL_ID
        )
        assert default_odoo["enabled"] is False
        assert peer_odoo["enabled"] is True


def test_odoo_tool_settings_test_and_execute_round_trip(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    seed_agents(SessionLocal)

    def fake_test_odoo_connection(config):
        assert config.base_url == "https://odoo.example.com"
        assert config.database == "ghost"
        assert config.username == "operator@example.com"
        return {
            "success": True,
            "message": "Odoo connection healthy.",
            "trace_id": "trace-health",
            "latency_ms": 42,
            "data": {"user_id": 7},
        }

    def fake_execute_odoo_operation(config, *, operation: str, payload: dict | None = None):
        assert config.base_url == "https://odoo.example.com"
        assert config.read_only is False
        assert operation == "odoo.rpc.execute_kw"
        assert payload == {
            "model": "res.partner",
            "method": "search_count",
            "args": [],
            "kwargs": {"domain": [["customer_rank", ">", 0]]},
        }
        return {
            "success": True,
            "message": "odoo.rpc.execute_kw completed.",
            "trace_id": "trace-execute",
            "latency_ms": 35,
            "operation": operation,
            "read_only": False,
            "data": {"model": "res.partner", "method": "search_count", "result_type": "scalar", "result": 42},
        }

    monkeypatch.setattr(tool_registry, "test_odoo_connection", fake_test_odoo_connection)
    monkeypatch.setattr(tool_registry, "execute_odoo_operation", fake_execute_odoo_operation)

    settings_response = client.post(
        f"/api/tools/{ODOO_TOOL_ID}/settings",
        json={
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": False,
            "timeout_ms": 25000,
        },
    )
    assert settings_response.status_code == 200
    settings_payload = settings_response.json()
    assert settings_payload["settings"]["base_url"] == "https://odoo.example.com"
    assert settings_payload["settings"]["database"] == "ghost"
    assert settings_payload["settings"]["has_password"] is True
    assert settings_payload["settings"]["username_hint"]
    assert settings_payload["settings"]["read_only"] is False

    test_response = client.post(f"/api/tools/{ODOO_TOOL_ID}/test")
    assert test_response.status_code == 200
    assert test_response.json()["trace_id"] == "trace-health"

    activation_response = client.post(f"/api/tools/{ODOO_TOOL_ID}/activation", json={"active": True})
    assert activation_response.status_code == 200
    assert activation_response.json()["active"] is True

    execute_response = client.post(
        f"/api/tools/{ODOO_TOOL_ID}/execute",
        json={
            "operation": "odoo.rpc.execute_kw",
            "payload": {
                "model": "res.partner",
                "method": "search_count",
                "args": [],
                "kwargs": {"domain": [["customer_rank", ">", 0]]},
            },
        },
    )
    assert execute_response.status_code == 200
    execute_payload = execute_response.json()
    assert execute_payload["success"] is True
    assert execute_payload["trace_id"] == "trace-execute"
    assert execute_payload["read_only"] is False
    assert execute_payload["data"]["result"] == 42

    with SessionLocal() as session:
        record = session.get(ToolRegistryRecord, ODOO_TOOL_ID)
        assert record is not None
        assert record.status == "healthy"
        assert record.active is True
        assert record.config_json["read_only"] is False


class _DummyClient:
    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def test_odoo_connector_blocks_mutation_in_read_only_mode(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)

    try:
        odoo_connector.execute_odoo_operation(
            {
                "base_url": "https://odoo.example.com",
                "database": "ghost",
                "username": "operator@example.com",
                "password": "super-secret",
                "read_only": True,
            },
            operation="odoo.rpc.execute_kw",
            payload={"model": "res.partner", "method": "write", "args": [[7], {"name": "Mutated"}], "kwargs": {}},
        )
    except odoo_connector.OdooConnectorError as exc:
        assert "read-only mode" in str(exc)
    else:
        raise AssertionError("Expected read-only execution to be blocked")


def test_odoo_connector_supports_quarterly_margin_summary(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)

    def fake_execute_kw(client, *, config, uid, model, method, args=None, kwargs=None):
        assert method == "read_group"
        if model == "account.move":
            return [
                {"invoice_date:quarter": "2025-Q3", "amount_untaxed_signed": 1000.0, "__domain": [["invoice_date", ">=", "2025-07-01"]]},
                {"invoice_date:quarter": "2025-Q4", "amount_untaxed_signed": 1200.0, "__domain": [["invoice_date", ">=", "2025-10-01"]]},
                {"invoice_date:quarter": "2026-Q1", "amount_untaxed_signed": 1500.0, "__domain": [["invoice_date", ">=", "2026-01-01"]]},
            ]
        if model == "account.move.line":
            return [
                {"date:quarter": "2025-Q3", "balance": 600.0, "__domain": [["date", ">=", "2025-07-01"]]},
                {"date:quarter": "2025-Q4", "balance": 700.0, "__domain": [["date", ">=", "2025-10-01"]]},
                {"date:quarter": "2026-Q1", "balance": 900.0, "__domain": [["date", ">=", "2026-01-01"]]},
            ]
        raise AssertionError(f"Unexpected model {model}")

    monkeypatch.setattr(odoo_connector, "_execute_kw", fake_execute_kw)
    monkeypatch.setattr(
        odoo_connector,
        "_quarter_ranges",
        lambda **kwargs: [
            (odoo_connector.date(2025, 7, 1), odoo_connector.date(2025, 10, 1)),
            (odoo_connector.date(2025, 10, 1), odoo_connector.date(2026, 1, 1)),
            (odoo_connector.date(2026, 1, 1), odoo_connector.date(2026, 4, 1)),
        ],
    )

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.finance.margin.quarterly_summary",
        payload={"quarters": 3, "include_current_quarter": True},
    )

    assert response["success"] is True
    assert response["read_only"] is True
    quarters = response["data"]["quarters"]
    assert quarters[0]["quarter"] == "2025-Q3"
    assert quarters[0]["gp"] == 400.0
    assert quarters[2]["running_gp"] == 1500.0
