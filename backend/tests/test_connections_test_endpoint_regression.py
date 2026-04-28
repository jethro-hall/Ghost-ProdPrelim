from __future__ import annotations

import httpx

from ghostdash_api import control_api

from test_connections_and_bootstrap import build_client


def _payload(**overrides):
    payload = {
        "provider": "openai-staging",
        "provider_kind": "openai",
        "auth_strategy": "bearer",
        "api_key": "sk-test",
        "base_url": "https://api.openai.com/v1",
        "api_mode": "chat_completions",
        "model_id": "gpt-5.4-nano",
        "prompt": "Reply with OK",
    }
    payload.update(overrides)
    return payload


def test_connection_test_maps_auth_failures_to_401(monkeypatch) -> None:
    client, _ = build_client(monkeypatch)

    def fake_test_provider_connection(*_args, **_kwargs):
        request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
        response = httpx.Response(
            401,
            request=request,
            json={"error": {"code": "invalid_api_key", "message": "bad key"}},
        )
        raise httpx.HTTPStatusError("401 Unauthorized", request=request, response=response)

    monkeypatch.setattr(control_api, "test_provider_connection", fake_test_provider_connection)

    response = client.post("/api/connections/test", json=_payload())
    assert response.status_code == 401
    assert response.status_code != 500
    assert "authentication" in response.json()["detail"].lower()


def test_connection_test_maps_model_not_found_to_400(monkeypatch) -> None:
    client, _ = build_client(monkeypatch)

    def fake_test_provider_connection(*_args, **_kwargs):
        request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
        response = httpx.Response(
            404,
            request=request,
            json={"error": {"code": "model_not_found", "message": "missing model"}},
        )
        raise httpx.HTTPStatusError("404 Not Found", request=request, response=response)

    monkeypatch.setattr(control_api, "test_provider_connection", fake_test_provider_connection)

    response = client.post("/api/connections/test", json=_payload(model_id="gpt-5.4-does-not-exist"))
    assert response.status_code == 400
    assert response.status_code != 500
    assert "model" in response.json()["detail"].lower()


def test_connection_test_maps_network_failures_to_503(monkeypatch) -> None:
    client, _ = build_client(monkeypatch)

    def fake_test_provider_connection(*_args, **_kwargs):
        request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
        raise httpx.ConnectError("connect failed", request=request)

    monkeypatch.setattr(control_api, "test_provider_connection", fake_test_provider_connection)

    response = client.post("/api/connections/test", json=_payload())
    assert response.status_code == 503
    assert response.status_code != 500
    assert "timed out" in response.json()["detail"].lower() or "unreachable" in response.json()["detail"].lower()


def test_connection_test_success_shape_unchanged(monkeypatch) -> None:
    client, _ = build_client(monkeypatch)

    monkeypatch.setattr(
        control_api,
        "test_provider_connection",
        lambda *_args, **_kwargs: {
            "api_mode": "chat_completions",
            "model": "gpt-5.4-nano",
            "base_url": "https://api.openai.com/v1",
            "output": "OK",
        },
    )

    response = client.post("/api/connections/test", json=_payload())
    assert response.status_code == 200
    payload = response.json()
    assert payload == {
        "ok": True,
        "api_mode": "chat_completions",
        "model": "gpt-5.4-nano",
        "base_url": "https://api.openai.com/v1",
        "output": "OK",
    }
