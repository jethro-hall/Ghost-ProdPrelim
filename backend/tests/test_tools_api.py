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
    assert catalog == []

    bootstrap_response = client.get("/api/chat/bootstrap?surface=ghost_chatui")
    assert bootstrap_response.status_code == 200
    bootstrap = bootstrap_response.json()
    assert bootstrap["tools_catalog"] == []
    assert bootstrap["runtime_defaults"]["conversation_mode"] == "quick"
    assert bootstrap["features"]["allow_conversation_mode_override"] is True

    policy_before = client.get(f"/api/tools/policy/{peer_agent_id}")
    assert policy_before.status_code == 200
    policy_before_payload = policy_before.json()
    assert policy_before_payload["agent_id"] == peer_agent_id
    assert ODOO_TOOL_ID not in set(policy_before_payload["allowed_tool_ids"])

    policy_after = client.post(
        f"/api/tools/policy/{peer_agent_id}",
        json={"allowed_tool_ids": [ODOO_TOOL_ID]},
    )
    assert policy_after.status_code == 200
    policy_after_payload = policy_after.json()
    assert policy_after_payload["agent_id"] == peer_agent_id
    assert ODOO_TOOL_ID not in set(policy_after_payload["allowed_tool_ids"])

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

        assert all(
            tool.get("id") != ODOO_TOOL_ID for tool in list(default_profile.tool_policy_config_json.get("tools") or [])
        )
        assert all(tool.get("id") != ODOO_TOOL_ID for tool in list(peer_profile.tool_policy_config_json.get("tools") or []))


def test_execute_tool_operation_for_agent_handles_retired_catalog_without_crashing(monkeypatch) -> None:
    _client, SessionLocal = build_client(monkeypatch)
    primary_agent_id, _peer_agent_id, _default_profile_id = seed_agents(SessionLocal)

    with SessionLocal() as session:
        response, readiness = tool_registry.execute_tool_operation_for_agent(
            session,
            agent_id=primary_agent_id,
            operation="odoo.meta.current_user",
            payload={},
        )

    assert response.success is False
    assert response.data.get("tool_status") == "blocked"
    assert "legacy_odoo_public_surface_retired" in (response.data.get("blocked_reasons") or [])
    assert readiness.status == "blocked"
    assert "legacy_odoo_public_surface_retired" in readiness.blocked_reasons


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
            # `odoo.rpc.execute_kw` is governed as destructive; provide approval token.
            "approval_token": "test-approval-token",
        },
    )
    assert execute_response.status_code == 200
    execute_payload = execute_response.json()
    assert execute_payload["success"] is True
    assert execute_payload["trace_id"] == "trace-execute"
    assert execute_payload["read_only"] is False
    assert execute_payload["data"]["result"] == 42

    mirror_response = client.get("/api/odoo/evidence/mirror")
    assert mirror_response.status_code == 200
    mirror_rows = mirror_response.json()
    assert mirror_rows
    latest = mirror_rows[0]
    assert latest["operation"] == "odoo.rpc.execute_kw"
    assert latest["source_mode"] == "live_odoo"
    assert latest["response_json"]["trace_id"] == "trace-execute"

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


def test_odoo_connector_supports_period_margin_summary(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)
    monkeypatch.setattr(odoo_connector, "_company_name_map", lambda client, *, config, uid, company_ids: {5: "Ride Electric Burleigh"})
    monkeypatch.setattr(
        odoo_connector,
        "_account_identity_map",
        lambda client, *, config, uid, account_ids: {
            401: {"code": "401", "name": "Sales"},
            510: {"code": "510", "name": "Cost of Goods"},
        },
    )

    def fake_execute_kw(client, *, config, uid, model, method, args=None, kwargs=None):
        assert method == "read_group"
        assert model == "account.move.line"
        domain = list((kwargs or {}).get("domain") or [])
        if any(clause == ["account_id.account_type", "in", ["income", "income_other"]] for clause in domain):
            return [{"company_id": [5, "Ride Electric Burleigh"], "account_id": [401, "Sales"], "balance": -24000.0}]
        if any(clause == ["account_id.account_type", "=", "expense_direct_cost"] for clause in domain):
            return [{"company_id": [5, "Ride Electric Burleigh"], "account_id": [510, "Cost of Goods"], "balance": 14000.0}]
        raise AssertionError(f"Unexpected model {model}")

    monkeypatch.setattr(odoo_connector, "_execute_kw", fake_execute_kw)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.finance.margin.period_summary",
        payload={"company_id": 5, "date_from": "2026-03-01", "date_to": "2026-04-01"},
    )

    assert response["success"] is True
    assert response["data"]["revenue"] == 24000.0
    assert response["data"]["cogs"] == 14000.0
    assert response["data"]["gp"] == 10000.0
    assert round(response["data"]["gp_pct"], 4) == round(10000.0 / 24000.0, 4)
    assert response["data"]["lookup_basis"] == "posted_ledger_lines"
    assert response["data"]["revenue_source"]["model"] == "account.move.line"
    assert response["data"]["revenue_source"]["account_type_scope"] == ["income", "income_other"]
    assert response["data"]["cogs_source"]["account_type_scope"] == ["expense_direct_cost"]


def test_odoo_connector_resolves_single_company_name_terms_for_period_summary(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)
    monkeypatch.setattr(odoo_connector, "_company_name_map", lambda client, *, config, uid, company_ids: {5: "Ride Electric Burleigh"})
    monkeypatch.setattr(
        odoo_connector,
        "_account_identity_map",
        lambda client, *, config, uid, account_ids: {
            401: {"code": "401", "name": "Sales"},
            510: {"code": "510", "name": "Cost of Goods"},
        },
    )

    def fake_search_read(client, *, config, uid, model, domain=None, fields=None, limit=20, offset=0, order=None):
        assert model == "res.company"
        return [{"id": 5, "name": "Ride Electric Burleigh"}]

    def fake_execute_kw(client, *, config, uid, model, method, args=None, kwargs=None):
        assert method == "read_group"
        assert model == "account.move.line"
        domain = list((kwargs or {}).get("domain") or [])
        if any(clause == ["account_id.account_type", "in", ["income", "income_other"]] for clause in domain):
            return [{"company_id": [5, "Ride Electric Burleigh"], "account_id": [401, "Sales"], "balance": -18000.0}]
        if any(clause == ["account_id.account_type", "=", "expense_direct_cost"] for clause in domain):
            return [{"company_id": [5, "Ride Electric Burleigh"], "account_id": [510, "Cost of Goods"], "balance": 9000.0}]
        raise AssertionError(f"Unexpected model {model}")

    monkeypatch.setattr(odoo_connector, "_search_read", fake_search_read)
    monkeypatch.setattr(odoo_connector, "_execute_kw", fake_execute_kw)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.finance.margin.period_summary",
        payload={"company_name_terms": ["burleigh"], "date_from": "2026-04-18", "date_to": "2026-04-20"},
    )

    assert response["success"] is True
    assert response["data"]["company_id"] == 5
    assert response["data"]["company_name_terms"] == ["burleigh"]
    assert response["data"]["revenue"] == 18000.0
    assert response["data"]["cogs"] == 9000.0
    assert response["data"]["gp"] == 9000.0


def test_odoo_connector_supports_revenue_period_from_posted_ledger_lines(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)
    monkeypatch.setattr(odoo_connector, "_company_name_map", lambda client, *, config, uid, company_ids: {5: "Ride Electric Burleigh"})
    monkeypatch.setattr(
        odoo_connector,
        "_account_identity_map",
        lambda client, *, config, uid, account_ids: {
            401: {"code": "401", "name": "Sales"},
            402: {"code": "402", "name": "Other Income"},
        },
    )

    def fake_execute_kw(client, *, config, uid, model, method, args=None, kwargs=None):
        assert model == "account.move.line"
        assert method == "read_group"
        domain = list((kwargs or {}).get("domain") or [])
        assert ["parent_state", "=", "posted"] in domain
        assert ["date", ">=", "2026-04-01"] in domain
        assert ["date", "<", "2026-05-01"] in domain
        assert ["company_id", "=", 5] in domain
        assert ["account_id.account_type", "in", ["income", "income_other"]] in domain
        return [
            {"company_id": [5, "Ride Electric Burleigh"], "account_id": [401, "Sales"], "balance": -22000.0},
            {"company_id": [5, "Ride Electric Burleigh"], "account_id": [402, "Other Income"], "balance": -500.0},
        ]

    monkeypatch.setattr(odoo_connector, "_execute_kw", fake_execute_kw)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.finance.revenue.period",
        payload={"company_id": 5, "date_from": "2026-04-01", "date_to": "2026-05-01"},
    )

    assert response["success"] is True
    assert response["data"]["model"] == "account.move.line"
    assert response["data"]["basis"] == "posted_ledger_lines"
    assert response["data"]["total"] == 22500.0
    assert response["data"]["account_type_scope"] == ["income", "income_other"]
    assert response["data"]["rows"][0]["account_code"] == "401"


def test_odoo_connector_supports_cash_runway_summary(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)
    monkeypatch.setattr(
        odoo_connector,
        "_resolve_company_ids_from_name_terms",
        lambda client, *, config, uid, company_name_terms: [5],
    )

    def fake_execute_kw(client, *, config, uid, model, method, args=None, kwargs=None):
        assert method == "read_group"
        domain = list((kwargs or {}).get("domain") or [])
        if model == "account.move":
            return [{"company_id": [5, "Ride Electric Burleigh"], "amount_untaxed_signed": 22000.0}]
        if model == "account.move.line":
            if any(clause == ["account_id.account_type", "=", "asset_cash"] for clause in domain):
                return [{"company_id": [5, "Ride Electric Burleigh"], "balance": 100000.0}]
            if any(
                clause == ["account_id.account_type", "in", ["expense", "expense_direct_cost", "expense_depreciation"]]
                for clause in domain
            ):
                return [{"company_id": [5, "Ride Electric Burleigh"], "balance": 20000.0}]
            return [{"company_id": [5, "Ride Electric Burleigh"], "balance": 13000.0}]
        raise AssertionError(f"Unexpected model {model}")

    monkeypatch.setattr(odoo_connector, "_execute_kw", fake_execute_kw)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.finance.cash.runway_summary",
        payload={"company_name_terms": ["burleigh"], "date_from": "2026-04-18", "date_to": "2026-04-20"},
    )

    assert response["success"] is True
    assert response["data"]["result_type"] == "cash_runway_summary"
    assert response["data"]["company_id"] == 5
    assert isinstance(response["data"]["revenue"], (int, float))
    assert isinstance(response["data"]["cogs"], (int, float))
    assert isinstance(response["data"]["gp"], (int, float))
    assert response["data"]["cash_position"] == 100000.0
    assert response["data"]["period_expense"] == 20000.0
    assert isinstance(response["data"]["runway_days"], (int, float))
    assert response["data"]["status"] in {"ok", "insufficient_inputs"}


def test_odoo_connector_supports_query_spec_operation(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)

    def fake_execute_kw(client, *, config, uid, model, method, args=None, kwargs=None):
        assert model == "account.move.line"
        assert method == "read_group"
        assert kwargs is not None
        assert kwargs["fields"] == ["balance:sum"]
        assert kwargs["groupby"] == ["company_id", "date:month"]
        return [{"company_id": [5, "Ride Electric Burleigh"], "date:month": "2026-04", "balance": 12345.0}]

    monkeypatch.setattr(odoo_connector, "_execute_kw", fake_execute_kw)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.rpc.query_spec",
        payload={
            "query_spec": {
                "model": "account.move.line",
                "method": "read_group",
                "domain": [["date", ">=", "2026-04-01"], ["date", "<", "2026-05-01"]],
                "fields": ["balance:sum"],
                "groupby": ["company_id", "date:month"],
                "lazy": False,
            }
        },
    )

    assert response["success"] is True
    assert response["data"]["result_type"] == "query_spec_result"
    assert response["data"]["count"] == 1
    assert response["data"]["query_spec"]["method"] == "read_group"


def test_odoo_connector_supports_monthly_margin_comparison(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)
    monkeypatch.setattr(
        odoo_connector,
        "_company_name_map",
        lambda client, *, config, uid, company_ids: {3: "Ride Electric Retail", 5: "Ride Electric Burleigh"},
    )

    def fake_execute_kw(client, *, config, uid, model, method, args=None, kwargs=None):
        assert method == "read_group"
        if model == "account.move":
            return [
                {
                    "company_id": [3, "Ride Electric Retail"],
                    "invoice_date:month": "2026-01",
                    "amount_untaxed_signed": 1000.0,
                    "__range": {"invoice_date:month": {"from": "2026-01-01", "to": "2026-02-01"}},
                },
                {
                    "company_id": [3, "Ride Electric Retail"],
                    "invoice_date:month": "2026-02",
                    "amount_untaxed_signed": 1300.0,
                    "__range": {"invoice_date:month": {"from": "2026-02-01", "to": "2026-03-01"}},
                },
                {
                    "company_id": [5, "Ride Electric Burleigh"],
                    "invoice_date:month": "2026-01",
                    "amount_untaxed_signed": 1500.0,
                    "__range": {"invoice_date:month": {"from": "2026-01-01", "to": "2026-02-01"}},
                },
            ]
        if model == "account.move.line":
            return [
                {
                    "company_id": [3, "Ride Electric Retail"],
                    "date:month": "2026-01",
                    "balance": 700.0,
                    "__range": {"date:month": {"from": "2026-01-01", "to": "2026-02-01"}},
                },
                {
                    "company_id": [3, "Ride Electric Retail"],
                    "date:month": "2026-02",
                    "balance": 1000.0,
                    "__range": {"date:month": {"from": "2026-02-01", "to": "2026-03-01"}},
                },
                {
                    "company_id": [5, "Ride Electric Burleigh"],
                    "date:month": "2026-01",
                    "balance": 900.0,
                    "__range": {"date:month": {"from": "2026-01-01", "to": "2026-02-01"}},
                },
            ]
        raise AssertionError(f"Unexpected model {model}")

    monkeypatch.setattr(odoo_connector, "_execute_kw", fake_execute_kw)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.finance.margin.monthly_comparison",
        payload={"company_ids": [3, 5], "months": 2, "date_from": "2026-01-01", "date_to": "2026-03-01"},
    )

    assert response["success"] is True
    companies = response["data"]["companies"]
    retail = next(company for company in companies if company["company_id"] == 3)
    burleigh = next(company for company in companies if company["company_id"] == 5)
    assert retail["company_name"] == "Ride Electric Retail"
    assert retail["total_gp"] == 600.0
    assert burleigh["company_name"] == "Ride Electric Burleigh"
    assert burleigh["months"][0]["month"] == "2026-01"
    assert response["data"]["anomalies"]


def test_odoo_connector_supports_monthly_cogs_code_breakdown(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)
    monkeypatch.setattr(
        odoo_connector,
        "_company_name_map",
        lambda client, *, config, uid, company_ids: {3: "Ride Electric Retail"},
    )
    monkeypatch.setattr(
        odoo_connector,
        "_account_identity_map",
        lambda client, *, config, uid, account_ids: {
            401: {"code": "COGS-401", "name": "Retail Accessories"},
            402: {"code": "COGS-402", "name": "Retail Bikes"},
        },
    )

    def fake_execute_kw(client, *, config, uid, model, method, args=None, kwargs=None):
        assert method == "read_group"
        assert model == "account.move.line"
        return [
            {
                "company_id": [3, "Ride Electric Retail"],
                "date:month": "2025-07",
                "account_id": [401, "Retail Accessories"],
                "balance": 1200.0,
                "__range": {"date:month": {"from": "2025-07-01", "to": "2025-08-01"}},
            },
            {
                "company_id": [3, "Ride Electric Retail"],
                "date:month": "2025-08",
                "account_id": [401, "Retail Accessories"],
                "balance": 1800.0,
                "__range": {"date:month": {"from": "2025-08-01", "to": "2025-09-01"}},
            },
            {
                "company_id": [3, "Ride Electric Retail"],
                "date:month": "2025-09",
                "account_id": [402, "Retail Bikes"],
                "balance": 2400.0,
                "__range": {"date:month": {"from": "2025-09-01", "to": "2025-10-01"}},
            },
        ]

    monkeypatch.setattr(odoo_connector, "_execute_kw", fake_execute_kw)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.finance.cogs.monthly_code_breakdown",
        payload={"company_id": 3, "date_from": "2025-07-01", "date_to": "2025-10-01", "months": 3, "top_n": 5},
    )

    assert response["success"] is True
    assert response["data"]["result_type"] == "monthly_cogs_code_breakdown"
    assert response["data"]["buckets"][0]["month"] == "2025-07"
    assert response["data"]["buckets"][0]["top_codes"][0]["account_code"] == "COGS-401"
    assert response["data"]["anomalies"]


def test_odoo_connector_supports_shopify_monthly_roi(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)
    monkeypatch.setattr(
        odoo_connector,
        "_company_name_map",
        lambda client, *, config, uid, company_ids: {3: "Ride Electric Retail"},
    )

    def fake_search_read(client, *, config, uid, model, domain=None, fields=None, limit=20, offset=0, order=None):
        if model == "account.account":
            return [
                {"id": 1436, "code": "280", "name": "Shopify Sales", "account_type": "income"},
                {"id": 1437, "code": "281", "name": "Shopify Discount", "account_type": "income"},
                {"id": 1438, "code": "282", "name": "Shopify Refunds", "account_type": "income"},
                {"id": 1439, "code": "283", "name": "Shopify Shipping", "account_type": "income"},
                {"id": 3399, "code": "519", "name": "Merchant Fees - Shopify", "account_type": "expense"},
                {"id": 3290, "code": "518", "name": "Marketing - Advertising", "account_type": "expense"},
                {"id": 4704, "code": "522", "name": "Facebook", "account_type": "expense"},
            ]
        if model == "account.journal":
            # Shopify ROI helper may query journals for fallback modes; empty is fine for this test.
            return []
        raise AssertionError(f"Unexpected model {model}")

    def fake_search_read_paginated(client, *, config, uid, model, domain=None, fields=None, limit=200, max_records=5000, order=None):
        assert model == "account.move.line"
        return [
            {
                "id": 1,
                "date": "2024-07-05",
                "name": "Shopify Sales July",
                "ref": "RE Shopify batch",
                "move_name": "INV/2024/07",
                "journal_id": [58, "Shopify Payments (Ride Electric) - NEW"],
                "account_id": [1436, "Shopify Sales"],
                "partner_id": False,
                "balance": -1000.0,
                "credit": 1000.0,
                "debit": 0.0,
                "company_id": [3, "Ride Electric Retail"],
            },
            {
                "id": 2,
                "date": "2024-07-05",
                "name": "Shopify Discounts July",
                "ref": "RE Shopify batch",
                "move_name": "INV/2024/07",
                "journal_id": [58, "Shopify Payments (Ride Electric) - NEW"],
                "account_id": [1437, "Shopify Discount"],
                "partner_id": False,
                "balance": 50.0,
                "credit": 0.0,
                "debit": 50.0,
                "company_id": [3, "Ride Electric Retail"],
            },
            {
                "id": 3,
                "date": "2024-07-05",
                "name": "Shopify Refund July",
                "ref": "RE Shopify batch",
                "move_name": "INV/2024/07",
                "journal_id": [58, "Shopify Payments (Ride Electric) - NEW"],
                "account_id": [1438, "Shopify Refunds"],
                "partner_id": False,
                "balance": 25.0,
                "credit": 0.0,
                "debit": 25.0,
                "company_id": [3, "Ride Electric Retail"],
            },
            {
                "id": 4,
                "date": "2024-07-05",
                "name": "Shopify Shipping July",
                "ref": "RE Shopify batch",
                "move_name": "INV/2024/07",
                "journal_id": [58, "Shopify Payments (Ride Electric) - NEW"],
                "account_id": [1439, "Shopify Shipping"],
                "partner_id": False,
                "balance": -20.0,
                "credit": 20.0,
                "debit": 0.0,
                "company_id": [3, "Ride Electric Retail"],
            },
            {
                "id": 5,
                "date": "2024-07-05",
                "name": "Shopify Merchant Fee July",
                "ref": "RE Shopify batch",
                "move_name": "INV/2024/07",
                "journal_id": [58, "Shopify Payments (Ride Electric) - NEW"],
                "account_id": [3399, "Merchant Fees - Shopify"],
                "partner_id": False,
                "balance": 30.0,
                "credit": 0.0,
                "debit": 30.0,
                "company_id": [3, "Ride Electric Retail"],
            },
            {
                "id": 6,
                "date": "2024-07-06",
                "name": "Google Adwords",
                "ref": False,
                "move_name": "AMEX/2024/0001",
                "journal_id": [183, "American Express (1007) NEW"],
                "account_id": [3290, "Marketing - Advertising"],
                "partner_id": False,
                "balance": 200.0,
                "credit": 0.0,
                "debit": 200.0,
                "company_id": [3, "Ride Electric Retail"],
            },
            {
                "id": 7,
                "date": "2024-07-07",
                "name": "Meta Platforms, Inc. Pre-approved Payment Bill User Payment",
                "ref": False,
                "move_name": "AMEX/2024/0002",
                "journal_id": [183, "American Express (1007) NEW"],
                "account_id": [4704, "Facebook"],
                "partner_id": [900, "Meta Platforms, Inc."],
                "balance": 150.0,
                "credit": 0.0,
                "debit": 150.0,
                "company_id": [3, "Ride Electric Retail"],
            },
        ]

    monkeypatch.setattr(odoo_connector, "_search_read", fake_search_read)
    monkeypatch.setattr(odoo_connector, "_search_read_paginated", fake_search_read_paginated)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.finance.shopify.monthly_roi",
        payload={"company_id": 3, "date_from": "2024-07-01", "date_to": "2024-08-01"},
    )

    assert response["success"] is True
    assert response["data"]["result_type"] == "shopify_monthly_roi"
    assert response["data"]["company_ids"] == [3]
    company = response["data"]["companies"][0]
    assert company["company_name"] == "Ride Electric Retail"
    assert company["shopify_revenue"] == 1000.0
    assert company["shopify_discounts"] == 50.0
    assert company["shopify_refunds"] == 25.0
    assert company["shopify_shipping"] == 20.0
    assert company["shopify_fees"] == 30.0
    assert company["marketing_spend"] == 350.0
    assert company["net_shopify_revenue"] == 915.0
    assert round(company["roas"], 4) == round(1000.0 / 350.0, 4)
    assert company["contribution_after_marketing"] == 565.0
    assert "Shopify Payments (Ride Electric) - NEW" in response["data"]["journals_used"]
    assert "American Express (1007) NEW" in response["data"]["journals_used"]
    assert "Google" in response["data"]["vendors_used"]
    assert "Meta Platforms, Inc." in response["data"]["vendors_used"]
    assert "Shopify Sales" in response["data"]["accounts_used"]["shopify_revenue"]
    assert response["data"]["marketing_vendor_samples"]


def test_odoo_connector_supports_sales_drilldown_period(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)
    monkeypatch.setattr(
        odoo_connector,
        "_company_name_map",
        lambda client, *, config, uid, company_ids: {5: "Ride Electric Burleigh"},
    )

    def fake_execute_kw(client, *, config, uid, model, method, args=None, kwargs=None):
        assert method == "read_group"
        if model == "sale.order":
            return [
                {
                    "user_id": [44, "Ian"],
                    "amount_total": 32500.0,
                    "__count": 17,
                }
            ]
        if model == "sale.order.line":
            return [
                {
                    "product_id": [901, "Commuter Bike"],
                    "price_subtotal": 18200.0,
                    "product_uom_qty": 26.0,
                    "__count": 26,
                }
            ]
        if model == "account.payment":
            return [
                {
                    "payment_method_line_id": [6, "Card"],
                    "amount": 28800.0,
                    "__count": 40,
                }
            ]
        raise AssertionError(f"Unexpected model {model}")

    monkeypatch.setattr(odoo_connector, "_execute_kw", fake_execute_kw)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.sales.drilldown.period",
        payload={"company_id": 5, "date_from": "2026-04-13", "date_to": "2026-04-20"},
    )

    assert response["success"] is True
    assert response["data"]["result_type"] == "sales_drilldown_period"
    assert response["data"]["company_id"] == 5
    assert response["data"]["leaders"]["sales_agent"]["user_name"] == "Ian"
    assert response["data"]["leaders"]["product"]["product_name"] == "Commuter Bike"
    assert response["data"]["leaders"]["payment_method"]["method_name"] == "Card"
    assert response["data"]["payment_source_used"] == "account.payment:payment_method_line_id"


def test_odoo_connector_products_search_supports_can_be_sold_and_search_term(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)

    def fake_search_read(client, *, config, uid, model, domain=None, fields=None, limit=20, offset=0, order=None):
        assert model == "product.template"
        assert domain is not None
        assert ["sale_ok", "=", True] in domain
        assert "|" in domain
        assert ["name", "ilike", "%fatfish%"] in domain
        assert ["default_code", "ilike", "%fatfish%"] in domain
        return [{"id": 11, "name": "Fatfish Biggie", "default_code": "FAT-001", "sale_ok": True}]

    monkeypatch.setattr(odoo_connector, "_search_read", fake_search_read)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.products.search_read",
        payload={"query": "fatfish", "can_be_sold": True},
    )
    assert response["success"] is True
    assert response["data"]["count"] == 1
    assert response["data"]["records"][0]["name"] == "Fatfish Biggie"


def test_odoo_connector_supports_sales_products_gp_period_top_with_margin(monkeypatch) -> None:
    monkeypatch.setattr(odoo_connector.httpx, "Client", _DummyClient)
    monkeypatch.setattr(odoo_connector, "_authenticate", lambda client, config: 7)

    def fake_search_read(client, *, config, uid, model, domain=None, fields=None, limit=20, offset=0, order=None):
        if model == "product.template":
            return [{"id": 11, "name": "Fatfish Biggie", "default_code": "FAT-001", "sale_ok": True}]
        if model == "product.product":
            if fields and "product_tmpl_id" in fields:
                return [{"id": 201, "name": "Fatfish Biggie Variant", "default_code": "FAT-001-V", "product_tmpl_id": [11]}]
            return [{"id": 201, "name": "Fatfish Biggie Variant", "default_code": "FAT-001-V"}]
        if model == "res.company":
            return [{"id": 4, "name": "Ride Electric Brisbane"}]
        raise AssertionError(f"Unexpected model {model}")

    def fake_execute_kw(client, *, config, uid, model, method, args=None, kwargs=None):
        if method == "fields_get":
            field_name = args[0][0] if args and args[0] else ""
            if field_name == "margin":
                return {"margin": {"type": "float"}}
            if field_name == "purchase_price":
                return {"purchase_price": {"type": "float"}}
            return {}
        if method == "read_group" and model == "sale.order.line":
            return [
                {
                    "product_id": [201, "Fatfish Biggie Variant"],
                    "price_subtotal": 5000.0,
                    "product_uom_qty": 10.0,
                    "margin": 1750.0,
                }
            ]
        raise AssertionError(f"Unexpected model/method {model}.{method}")

    monkeypatch.setattr(odoo_connector, "_search_read", fake_search_read)
    monkeypatch.setattr(odoo_connector, "_execute_kw", fake_execute_kw)

    response = odoo_connector.execute_odoo_operation(
        {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "read_only": True,
        },
        operation="odoo.sales.products_gp.period_top",
        payload={
            "company_id": 4,
            "date_from": "2026-04-13",
            "date_to": "2026-04-20",
            "top_n": 5,
            "can_be_sold": True,
            "revenue_reference_total": 23074.70,
        },
    )
    assert response["success"] is True
    assert response["data"]["result_type"] == "sales_products_gp_period_top"
    assert response["data"]["rows"][0]["product_id"] == 201
    assert response["data"]["rows"][0]["gp"] == 1750.0
    assert response["data"]["rows"][0]["gp_source"] == "sale.order.line.margin"
    assert response["data"]["product_filters"]["can_be_sold"] is True
    assert response["data"]["reconciliation"]["revenue_reference_total"] == 23074.70


def test_consumer_chat_allows_governed_low_level_odoo_reads() -> None:
    allowed, reason = tool_registry._consumer_chat_operation_allowed(
        "odoo.rpc.read_group",
        {"model": "account.move.line"},
    )
    assert allowed is True
    assert reason is None

    allowed, reason = tool_registry._consumer_chat_operation_allowed(
        "odoo.rpc.search_read",
        {"model": "account.move.line"},
    )
    assert allowed is True
    assert reason is None

    allowed, reason = tool_registry._consumer_chat_operation_allowed(
        "odoo.rpc.search_read",
        {"model": "res.partner.bank"},
    )
    assert allowed is False
    assert "Consumer chat only allows `odoo.rpc.search_read`" in str(reason)

    allowed, reason = tool_registry._consumer_chat_operation_allowed(
        "odoo.finance.cash.runway_summary",
        {"company_name_terms": ["burleigh"], "date_from": "2026-04-18", "date_to": "2026-04-20"},
    )
    assert allowed is True
    assert reason is None

    allowed, reason = tool_registry._consumer_chat_operation_allowed(
        "odoo.rpc.query_spec",
        {
            "query_spec": {
                "model": "account.move.line",
                "method": "read_group",
                "fields": ["balance:sum"],
                "groupby": ["company_id"],
            }
        },
    )
    assert allowed is True
    assert reason is None

    allowed, reason = tool_registry._consumer_chat_operation_allowed(
        "odoo.rpc.query_spec",
        {
            "company_scope_lock": "single_exact",
            "company_scope_lock_canonical": "brisbane",
            "company_name_terms": ["brisbane"],
            "query_spec": {
                "model": "account.move.line",
                "method": "read_group",
                "domain": [["parent_state", "=", "posted"]],
                "fields": ["balance:sum"],
                "groupby": ["date:month", "account_id"],
            },
        },
    )
    assert allowed is True
    assert reason is None


def test_consumer_chat_allows_sales_drilldown_helper() -> None:
    allowed, reason = tool_registry._consumer_chat_operation_allowed(
        "odoo.sales.drilldown.period",
        {"company_name_terms": ["burleigh"], "date_from": "2026-04-13", "date_to": "2026-04-20"},
    )
    assert allowed is True
    assert reason is None


def test_consumer_chat_allows_products_gp_period_top_helper() -> None:
    allowed, reason = tool_registry._consumer_chat_operation_allowed(
        "odoo.sales.products_gp.period_top",
        {"company_name_terms": ["brisbane"], "date_from": "2026-04-13", "date_to": "2026-04-20", "top_n": 5},
    )
    assert allowed is True
    assert reason is None
