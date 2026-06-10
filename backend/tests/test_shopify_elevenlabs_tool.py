from __future__ import annotations

from types import SimpleNamespace

from ghostdash_api import control_api, voice_ingress
from ghostdash_api.shopify_mcp import ShopifyMcpCallResult
from fastapi.testclient import TestClient


def _voice_headers(secret: str) -> dict[str, str]:
    return {"X-Ghost-Voice-Key": secret}


def test_shopify_health_requires_voice_key(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_shopify_webhook_secret", "shopify-hook")

    response = client.get("/api/elevenlabs/shopify/health")
    assert response.status_code == 401


def test_shopify_health_reports_missing_mcp_url(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_shopify_webhook_secret", "shopify-hook")
    monkeypatch.setattr(
        "ghostdash_api.integrations.shopify_elevenlabs_tool.get_settings",
        lambda: SimpleNamespace(shopify_mcp_url=None, shopify_mcp_health_timeout_ms=4000),
    )

    response = client.get("/api/elevenlabs/shopify/health", headers=_voice_headers("shopify-hook"))
    assert response.status_code == 503
    body = response.json()
    assert body["error_code"] == "shopify_mcp_url_missing"


def test_shopify_tool_connection_check(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_shopify_webhook_secret", "shopify-hook")

    async def fake_call(*, operation: str, payload: dict, trace_id: str) -> ShopifyMcpCallResult:
        assert operation == "connection_check"
        return ShopifyMcpCallResult(
            success=True,
            operation="connection_check",
            message="Connected.",
            data={"shop": {"name": "Test"}},
        )

    monkeypatch.setattr("integrations.elevenlabs_shopify.router.call_shopify_mcp", fake_call)

    response = client.post(
        "/api/elevenlabs/shopify/tool",
        json={"function": "ping", "payload": {}},
        headers=_voice_headers("shopify-hook"),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["operation"] == "connection_check"


def test_shopify_tool_rejects_unknown_function(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_shopify_webhook_secret", "shopify-hook")

    response = client.post(
        "/api/elevenlabs/shopify/tool",
        json={"function": "delete_all_orders", "payload": {}},
        headers=_voice_headers("shopify-hook"),
    )
    assert response.status_code == 422


def test_shopify_agent_route_matches_api(monkeypatch) -> None:
    from ghostdash_api import agent_ingress

    app = agent_ingress.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_shopify_webhook_secret", "shopify-hook")

    async def fake_call(*, operation: str, payload: dict, trace_id: str) -> ShopifyMcpCallResult:
        return ShopifyMcpCallResult(
            success=True,
            operation="product_search",
            message="ok",
            data={"count": 0, "products": []},
        )

    monkeypatch.setattr("integrations.elevenlabs_shopify.router.call_shopify_mcp", fake_call)

    response = client.post(
        "/agent/integrations/elevenlabs/shopify/tool",
        json={"function": "product_search", "payload": {"query": "bike"}},
        headers=_voice_headers("shopify-hook"),
    )
    assert response.status_code == 200
    assert response.json()["operation"] == "product_search"
