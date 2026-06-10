from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from ghostdash_api import control_api
from ghostdash_api.integrations import elevenlabs_tool_sync as sync_mod
from ghostdash_api.integrations.elevenlabs_client import WEBHOOK_SECRET_PLACEHOLDER
from ghostdash_api.integrations.operator_admin import OPERATOR_ADMIN_HEADER


def _sample_tool(name: str = "hubtiger_booking_create") -> dict:
    return {
        "type": "webhook",
        "name": name,
        "description": "test",
        "response_timeout_secs": 30,
        "api_schema": {
            "url": "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool",
            "method": "POST",
            "request_headers": [
                {"type": "value", "name": "Content-Type", "value": "application/json"},
                {"type": "value", "name": "X-Ghost-Voice-Key", "value": WEBHOOK_SECRET_PLACEHOLDER},
            ],
        },
    }


def test_canonical_diff_ignores_secret_value() -> None:
    left = _sample_tool()
    right = _sample_tool()
    right["api_schema"]["request_headers"][1]["value"] = "super-secret-value"
    assert sync_mod.configs_equivalent(left, right) is True


def test_duplicate_remote_tool_names_fail_closed() -> None:
    preview = sync_mod.preview_tool_entry(
        file_name="hubtiger_booking_create.json",
        repo_config=_sample_tool(),
        remote_index={
            "hubtiger_booking_create": [
                {"id": "tool_a", "tool_config": _sample_tool()},
                {"id": "tool_b", "tool_config": _sample_tool()},
            ]
        },
    )
    assert preview["action"] == "error"
    assert preview["error_code"] == "DUPLICATE_REMOTE_TOOL_NAME"


def test_inject_webhook_secret_replaces_placeholder() -> None:
    injected = sync_mod._inject_webhook_secret(_sample_tool(), "live-secret")
    headers = injected["api_schema"]["request_headers"]
    assert headers[1]["value"] == "live-secret"


def test_missing_webhook_secret_fails_closed() -> None:
    with patch.object(sync_mod, "get_settings") as mock_settings:
        mock_settings.return_value.elevenlabs_hubtiger_webhook_secret = ""
        with pytest.raises(HTTPException) as exc:
            sync_mod._require_webhook_secret()
        assert exc.value.status_code == 422


def test_dry_run_performs_no_mutation_calls(monkeypatch, tmp_path: Path) -> None:
    import asyncio

    async def _run():
        sync_mod.reset_sync_lock_for_tests()
        monkeypatch.setattr(sync_mod, "_sync_artifacts_dir", lambda: tmp_path)
        class FakeSettings:
            elevenlabs_hubtiger_webhook_secret = "secret"
            elevenlabs_api_key = "el-key"
            app_data_dir = str(tmp_path)
            elevenlabs_convai_agent_id = None
        monkeypatch.setattr(sync_mod, "get_settings", lambda: FakeSettings())
        
        repo_tool = _sample_tool("hubtiger_booking_availability_readonly")
        monkeypatch.setattr(sync_mod, "load_repo_tool_raw", lambda fn: (tmp_path / fn, repo_tool))
        monkeypatch.setattr(
            sync_mod,
            "STAGED_BOOKING_TOOL_FILES",
            ("hubtiger_booking_availability.json",),
        )
        
        fetch = AsyncMock(
            side_effect=[
                {"tools": [], "has_more": False},
            ]
        )
        monkeypatch.setattr(sync_mod, "fetch_elevenlabs_json", fetch)
        
        result = await sync_mod.run_sync(
            body=sync_mod.ToolSyncRequest(dry_run=True),
            trace_id="trace-dry",
        )
        assert result["dry_run"] is True
        assert all(call.args[0] == "GET" for call in fetch.call_args_list)
        

    asyncio.run(_run())
def test_sync_redacts_secret_in_result_artifact(monkeypatch, tmp_path: Path) -> None:
    import asyncio

    async def _run():
        sync_mod.reset_sync_lock_for_tests()
        monkeypatch.setattr(sync_mod, "_sync_artifacts_dir", lambda: tmp_path)
        settings = sync_mod.get_settings()
        monkeypatch.setattr(sync_mod, "get_settings", lambda: settings)
        settings.elevenlabs_hubtiger_webhook_secret = "secret"
        
        repo_tool = _sample_tool()
        monkeypatch.setattr(sync_mod, "load_repo_tool_raw", lambda fn: (tmp_path / fn, repo_tool))
        monkeypatch.setattr(sync_mod, "STAGED_BOOKING_TOOL_FILES", ("hubtiger_booking_create.json",))
        
        async def fake_fetch(method, path, *, body=None, params=None, trace_id=""):
            if method == "GET" and path == "/v1/convai/tools":
                return {"tools": [], "has_more": False}
            if method == "POST":
                return {"id": "tool_new_1"}
            if method == "GET" and path.startswith("/v1/convai/tools/tool_new"):
                return {"id": "tool_new_1", "tool_config": sync_mod._inject_webhook_secret(repo_tool, "secret")}
            raise AssertionError(f"unexpected {method} {path}")
        
        monkeypatch.setattr(sync_mod, "fetch_elevenlabs_json", fake_fetch)
        
        await sync_mod.run_sync(body=sync_mod.ToolSyncRequest(dry_run=False), trace_id="trace-live")
        for artifact in tmp_path.glob("*.json"):
            raw = artifact.read_text(encoding="utf-8")
            assert "secret" not in raw
        

    asyncio.run(_run())
def test_missing_agent_id_with_attach_fails_closed(monkeypatch) -> None:
    import asyncio

    async def _run():
        sync_mod.reset_sync_lock_for_tests()
        settings = sync_mod.get_settings()
        monkeypatch.setattr(sync_mod, "get_settings", lambda: settings)
        settings.elevenlabs_convai_agent_id = None
        with pytest.raises(HTTPException) as exc:
            await sync_mod.run_sync(
                body=sync_mod.ToolSyncRequest(
                    dry_run=True,
                    attach_to_agent=True,
                    confirm_agent_attachment=True,
                ),
                trace_id="trace-agent",
            )
        assert exc.value.status_code == 422
        

    asyncio.run(_run())
def test_confirm_agent_attachment_false_blocks(monkeypatch) -> None:
    import asyncio

    async def _run():
        sync_mod.reset_sync_lock_for_tests()
        with pytest.raises(HTTPException) as exc:
            await sync_mod.run_sync(
                body=sync_mod.ToolSyncRequest(dry_run=False, attach_to_agent=True, agent_id="agent_test"),
                trace_id="trace-no-confirm",
            )
        assert exc.value.status_code == 422
        

    asyncio.run(_run())
def test_agent_attach_preserves_unrelated_tool_ids(monkeypatch, tmp_path: Path) -> None:
    import asyncio

    async def _run():
        sync_mod.reset_sync_lock_for_tests()
        monkeypatch.setattr(sync_mod, "_sync_artifacts_dir", lambda: tmp_path)
        settings = sync_mod.get_settings()
        monkeypatch.setattr(sync_mod, "get_settings", lambda: settings)
        settings.elevenlabs_hubtiger_webhook_secret = "secret"
        
        repo_tool = _sample_tool()
        monkeypatch.setattr(sync_mod, "load_repo_tool_raw", lambda fn: (tmp_path / fn, repo_tool))
        monkeypatch.setattr(sync_mod, "STAGED_BOOKING_TOOL_FILES", ("hubtiger_booking_create.json",))
        
        agent_tool_ids = ["shopify_1"]

        async def fake_fetch(method, path, *, body=None, params=None, trace_id=""):
            if method == "GET" and path == "/v1/convai/tools":
                return {"tools": [], "has_more": False}
            if method == "POST" and path == "/v1/convai/tools":
                return {"id": "tool_new_1"}
            if method == "GET" and path == "/v1/convai/tools/tool_new_1":
                return {"id": "tool_new_1", "tool_config": sync_mod._inject_webhook_secret(repo_tool, "secret")}
            if method == "GET" and path == "/v1/convai/agents/agent_test":
                return {"conversation_config": {"agent": {"prompt": {"tool_ids": list(agent_tool_ids)}}}}
            if method == "PATCH" and path == "/v1/convai/agents/agent_test":
                merged = body["conversation_config"]["agent"]["prompt"]["tool_ids"]
                assert "shopify_1" in merged
                assert "tool_new_1" in merged
                agent_tool_ids[:] = merged
                return {"ok": True}
            raise AssertionError((method, path))
        
        monkeypatch.setattr(sync_mod, "fetch_elevenlabs_json", fake_fetch)
        
        result = await sync_mod.run_sync(
            body=sync_mod.ToolSyncRequest(
                dry_run=False,
                attach_to_agent=True,
                agent_id="agent_test",
                confirm_agent_attachment=True,
            ),
            trace_id="trace-attach",
        )
        assert result["attach"]["success"] is True
        

    asyncio.run(_run())
def test_verification_failure_reported(monkeypatch, tmp_path: Path) -> None:
    import asyncio

    async def _run():
        sync_mod.reset_sync_lock_for_tests()
        monkeypatch.setattr(sync_mod, "_sync_artifacts_dir", lambda: tmp_path)
        settings = sync_mod.get_settings()
        monkeypatch.setattr(sync_mod, "get_settings", lambda: settings)
        settings.elevenlabs_hubtiger_webhook_secret = "secret"
        
        repo_tool = _sample_tool()
        monkeypatch.setattr(sync_mod, "load_repo_tool_raw", lambda fn: (tmp_path / fn, repo_tool))
        monkeypatch.setattr(sync_mod, "STAGED_BOOKING_TOOL_FILES", ("hubtiger_booking_create.json",))
        
        async def fake_fetch(method, path, *, body=None, params=None, trace_id=""):
            if method == "GET" and path == "/v1/convai/tools":
                return {"tools": [], "has_more": False}
            if method == "POST":
                return {"id": "tool_new_1"}
            if method == "GET" and path == "/v1/convai/tools/tool_new_1":
                bad = _sample_tool("wrong_name")
                return {"id": "tool_new_1", "tool_config": bad}
            raise AssertionError((method, path))
        
        monkeypatch.setattr(sync_mod, "fetch_elevenlabs_json", fake_fetch)
        result = await sync_mod.run_sync(body=sync_mod.ToolSyncRequest(dry_run=False), trace_id="trace-verify")
        assert result["tools"][0]["success"] is False
        assert "verification_failed" in str(result["tools"][0]["error"])
        

    asyncio.run(_run())
def test_sync_lock_returns_409(monkeypatch) -> None:
    sync_mod.reset_sync_lock_for_tests()
    sync_mod._acquire_sync_lock()
    with pytest.raises(HTTPException) as exc:
        sync_mod._acquire_sync_lock()
    assert exc.value.status_code == 409
    sync_mod.reset_sync_lock_for_tests()


def test_no_hardcoded_production_agent_in_sync_module() -> None:
    source = Path("/var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/integrations/elevenlabs_tool_sync.py").read_text()
    assert "agent_3701kq9fcmz1errsmhesm3j47rsg" not in source


def test_admin_auth_required_on_sync_routes(monkeypatch) -> None:
    client = TestClient(control_api.create_app())
    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_tool_sync.preview_sync",
        AsyncMock(return_value={"tools": [], "tool_count": 0}),
    )
    response = client.get("/api/elevenlabs/operator/tools/sync/preview")
    assert response.status_code in {401, 503}


def test_admin_auth_with_key(monkeypatch) -> None:
    client = TestClient(control_api.create_app())
    monkeypatch.setattr(
        "ghostdash_api.integrations.operator_admin.get_settings",
        lambda: type("S", (), {"app_operator_admin_key": "admin-test-key"})(),
    )
    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_tool_sync.preview_sync",
        AsyncMock(return_value={"tools": [], "tool_count": 0, "remote_tool_count": 0}),
    )
    bad = client.get("/api/elevenlabs/operator/tools/sync/preview")
    assert bad.status_code == 401
    ok = client.get(
        "/api/elevenlabs/operator/tools/sync/preview",
        headers={OPERATOR_ADMIN_HEADER: "admin-test-key"},
    )
    assert ok.status_code == 200


def test_missing_elevenlabs_api_key_returns_503_on_preview(monkeypatch) -> None:
    client = TestClient(control_api.create_app())
    monkeypatch.setattr(
        "ghostdash_api.integrations.operator_admin.get_settings",
        lambda: type("S", (), {"app_operator_admin_key": "admin-test-key"})(),
    )

    async def boom(*args, **kwargs):
        raise HTTPException(status_code=503, detail={"code": "elevenlabs_not_configured"})

    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_tool_sync.list_remote_tools_rows", boom)
    response = client.get(
        "/api/elevenlabs/operator/tools/sync/preview",
        headers={OPERATOR_ADMIN_HEADER: "admin-test-key"},
    )
    assert response.status_code == 503


def test_preview_response_never_includes_injected_secret(monkeypatch, tmp_path: Path) -> None:
    import asyncio

    async def _run():
        sync_mod.reset_sync_lock_for_tests()
        repo_tool = _sample_tool("hubtiger_booking_availability_readonly")
        monkeypatch.setattr(sync_mod, "load_repo_tool_raw", lambda fn: (tmp_path / fn, repo_tool))
        
        async def fake_list(*, trace_id: str):
            remote = sync_mod._inject_webhook_secret(repo_tool, "remote-live-secret")
            return [{"id": "remote_1", "tool_config": remote}]
        
        monkeypatch.setattr(sync_mod, "list_remote_tools_rows", fake_list)
        payload = await sync_mod.preview_sync(tool_files=["hubtiger_booking_availability.json"], trace_id="t1")
        blob = json.dumps(payload)
        assert "remote-live-secret" not in blob

    asyncio.run(_run())


def test_transform_ui_export_headers_to_dict() -> None:
    from ghostdash_api.integrations.elevenlabs_tool_transform import transform_ui_export_to_api_tool_config

    raw = _sample_tool()
    raw["api_schema"]["request_body_schema"] = {
        "id": "body",
        "type": "object",
        "description": "payload",
        "required": False,
        "properties": [
            {
                "id": "function",
                "type": "string",
                "description": "tool function",
                "required": True,
                "value_type": "llm_prompt",
            },
            {
                "id": "payload",
                "type": "object",
                "description": "nested payload",
                "required": False,
                "properties": [
                    {
                        "id": "first_name",
                        "type": "string",
                        "description": "name",
                        "required": True,
                        "value_type": "llm_prompt",
                    }
                ],
            },
        ],
    }
    api = transform_ui_export_to_api_tool_config(raw)
    headers = api["api_schema"]["request_headers"]
    assert isinstance(headers, dict)
    assert headers["Content-Type"] == "application/json"
    props = api["api_schema"]["request_body_schema"]["properties"]
    assert isinstance(props, dict)
    assert "function" in props
    assert isinstance(api["api_schema"]["request_body_schema"]["required"], list)
    payload = api["api_schema"]["request_body_schema"]["properties"]["payload"]
    assert payload["type"] == "object"
    assert set(payload.keys()) == {"type", "description", "properties", "required"}
    assert "query_params_schema" not in api["api_schema"]
    assert api["api_schema"]["path_params_schema"] == {}
