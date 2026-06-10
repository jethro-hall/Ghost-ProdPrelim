"""ElevenLabs HubTiger booking tool sync — Voice Ops utility (not Magic Mike control plane)."""

from __future__ import annotations

import copy
import json
import threading
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

from ghostdash_api.integrations.elevenlabs_client import (
    WEBHOOK_SECRET_HEADER,
    WEBHOOK_SECRET_PLACEHOLDER,
    fetch_elevenlabs_json,
    redact_value,
)
from ghostdash_api.integrations.elevenlabs_tool_catalog import STAGED_BOOKING_TOOL_FILES, load_repo_tool_raw
from ghostdash_api.integrations.elevenlabs_tool_transform import (
    normalize_tool_config_for_compare,
    transform_ui_export_to_api_tool_config,
)
from ghostdash_api.settings import get_settings

SyncAction = Literal["create", "update", "unchanged", "error"]

_sync_lock = threading.Lock()
_sync_in_progress = False


class ToolSyncRequest(BaseModel):
    dry_run: bool = True
    attach_to_agent: bool = False
    agent_id: str | None = Field(default=None, max_length=128)
    confirm_agent_attachment: bool = False
    tool_files: list[str] | None = None


def _sync_artifacts_dir() -> Path:
    settings = get_settings()
    chosen = Path(str(settings.app_data_dir or "/data")) / "elevenlabs-sync"
    chosen.mkdir(parents=True, exist_ok=True)
    return chosen


def _timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def _acquire_sync_lock() -> None:
    global _sync_in_progress
    with _sync_lock:
        if _sync_in_progress:
            raise HTTPException(
                status_code=409,
                detail={"code": "ELEVENLABS_TOOL_SYNC_IN_PROGRESS", "message": "Another tool sync is already running."},
            )
        _sync_in_progress = True


def _release_sync_lock() -> None:
    global _sync_in_progress
    with _sync_lock:
        _sync_in_progress = False


def reset_sync_lock_for_tests() -> None:
    global _sync_in_progress
    with _sync_lock:
        _sync_in_progress = False


def _resolve_tool_files(tool_files: list[str] | None) -> list[str]:
    if not tool_files:
        return list(STAGED_BOOKING_TOOL_FILES)
    allowed = set(STAGED_BOOKING_TOOL_FILES)
    resolved: list[str] = []
    for name in tool_files:
        safe = Path(name).name
        if safe not in allowed:
            raise HTTPException(status_code=400, detail=f"Tool file not in allowlist: {safe}")
        if safe not in resolved:
            resolved.append(safe)
    return resolved


def _inject_webhook_secret(config: dict[str, Any], secret: str) -> dict[str, Any]:
    prepared = copy.deepcopy(config)
    api_schema = prepared.get("api_schema")
    if not isinstance(api_schema, dict):
        return prepared
    headers = api_schema.get("request_headers")
    if isinstance(headers, list):
        for header in headers:
            if isinstance(header, dict) and str(header.get("name") or "") == WEBHOOK_SECRET_HEADER:
                header["value"] = secret
    elif isinstance(headers, dict) and WEBHOOK_SECRET_HEADER in headers:
        headers[WEBHOOK_SECRET_HEADER] = secret
    return prepared


def _normalize_secret_placeholder(config: dict[str, Any]) -> dict[str, Any]:
    normalized = copy.deepcopy(config)
    api_schema = normalized.get("api_schema")
    if isinstance(api_schema, dict):
        headers = api_schema.get("request_headers")
        if isinstance(headers, list):
            for header in headers:
                if isinstance(header, dict) and str(header.get("name") or "") == WEBHOOK_SECRET_HEADER:
                    header["value"] = WEBHOOK_SECRET_PLACEHOLDER
        elif isinstance(headers, dict) and WEBHOOK_SECRET_HEADER in headers:
            headers[WEBHOOK_SECRET_HEADER] = WEBHOOK_SECRET_PLACEHOLDER
    return normalized


def canonical_tool_config(config: dict[str, Any]) -> dict[str, Any]:
    return _normalize_secret_placeholder(normalize_tool_config_for_compare(config))


def canonical_json(config: dict[str, Any]) -> str:
    return json.dumps(canonical_tool_config(config), sort_keys=True, ensure_ascii=False)


def configs_equivalent(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return canonical_json(left) == canonical_json(right)


def _extract_remote_tool_config(row: dict[str, Any]) -> dict[str, Any]:
    tool_config = row.get("tool_config")
    if isinstance(tool_config, dict):
        return tool_config
    return {}


def _tool_name_from_config(config: dict[str, Any]) -> str:
    return str(config.get("name") or "").strip()


def _api_url_from_config(config: dict[str, Any]) -> str:
    api_schema = config.get("api_schema")
    if isinstance(api_schema, dict):
        return str(api_schema.get("url") or "").strip()
    return ""


def _timeout_from_config(config: dict[str, Any]) -> int | None:
    value = config.get("response_timeout_secs")
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


async def list_remote_tools_rows(*, trace_id: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        params: dict[str, Any] = {"page_size": 100}
        if cursor:
            params["cursor"] = cursor
        payload = await fetch_elevenlabs_json("GET", "/v1/convai/tools", params=params, trace_id=trace_id)
        batch = payload.get("tools")
        if isinstance(batch, list):
            rows.extend(item for item in batch if isinstance(item, dict))
        if not payload.get("has_more"):
            break
        cursor = str(payload.get("next_cursor") or "").strip() or None
        if not cursor:
            break
    return rows


def index_remote_tools_by_name(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    indexed: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        config = _extract_remote_tool_config(row)
        name = _tool_name_from_config(config)
        if name:
            indexed[name].append(row)
    return dict(indexed)


def preview_tool_entry(
    *,
    file_name: str,
    repo_config: dict[str, Any],
    remote_index: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    tool_name = _tool_name_from_config(repo_config)
    if not tool_name:
        return {
            "file_name": file_name,
            "tool_name": "",
            "action": "error",
            "error_code": "MISSING_TOOL_NAME",
            "message": "Repo tool JSON is missing name.",
        }
    matches = remote_index.get(tool_name) or []
    if len(matches) > 1:
        return {
            "file_name": file_name,
            "tool_name": tool_name,
            "action": "error",
            "error_code": "DUPLICATE_REMOTE_TOOL_NAME",
            "message": f"Multiple remote tools named {tool_name}.",
            "remote_tool_ids": [str(row.get("id") or "") for row in matches],
        }
    if not matches:
        return {
            "file_name": file_name,
            "tool_name": tool_name,
            "action": "create",
            "remote_tool_id": None,
            "api_url": _api_url_from_config(repo_config),
            "timeout_secs": _timeout_from_config(repo_config),
        }
    remote_row = matches[0]
    remote_config = _extract_remote_tool_config(remote_row)
    action: SyncAction = "update" if not configs_equivalent(repo_config, remote_config) else "unchanged"
    return {
        "file_name": file_name,
        "tool_name": tool_name,
        "action": action,
        "remote_tool_id": str(remote_row.get("id") or ""),
        "api_url": _api_url_from_config(repo_config),
        "timeout_secs": _timeout_from_config(repo_config),
    }


async def preview_sync(*, tool_files: list[str] | None, trace_id: str) -> dict[str, Any]:
    resolved = _resolve_tool_files(tool_files)
    remote_rows = await list_remote_tools_rows(trace_id=trace_id)
    remote_index = index_remote_tools_by_name(remote_rows)
    items = [
        preview_tool_entry(file_name=file_name, repo_config=load_repo_tool_raw(file_name)[1], remote_index=remote_index)
        for file_name in resolved
    ]
    return {"dry_run": True, "tool_count": len(items), "tools": items, "remote_tool_count": len(remote_rows)}


def _write_artifact(name: str, payload: Any) -> str:
    path = _sync_artifacts_dir() / name
    path.write_text(json.dumps(redact_value(payload), indent=2, ensure_ascii=False), encoding="utf-8")
    return str(path)


def _require_webhook_secret() -> str:
    secret = str(get_settings().elevenlabs_hubtiger_webhook_secret or "").strip()
    if not secret:
        raise HTTPException(
            status_code=422,
            detail={"code": "webhook_secret_missing", "message": "ELEVENLABS_HUBTIGER_WEBHOOK_SECRET is not configured."},
        )
    return secret


def _resolve_agent_id(*, request_agent_id: str | None, attach: bool) -> str | None:
    if not attach:
        return None
    agent_id = str(request_agent_id or "").strip() or str(get_settings().elevenlabs_convai_agent_id or "").strip()
    if not agent_id:
        raise HTTPException(
            status_code=422,
            detail={"code": "agent_id_required", "message": "agent_id is required when attach_to_agent is true."},
        )
    return agent_id


async def _verify_remote_tool(
    *,
    tool_id: str,
    expected_name: str,
    expected_config: dict[str, Any],
    trace_id: str,
) -> tuple[bool, str | None]:
    payload = await fetch_elevenlabs_json("GET", f"/v1/convai/tools/{tool_id}", trace_id=trace_id)
    remote_config = _extract_remote_tool_config(payload)
    if _tool_name_from_config(remote_config) != expected_name:
        return False, "verification_failed: name mismatch"
    if _api_url_from_config(remote_config) != _api_url_from_config(expected_config):
        return False, "verification_failed: api_schema.url mismatch"
    if _timeout_from_config(remote_config) != _timeout_from_config(expected_config):
        return False, "verification_failed: response_timeout_secs mismatch"
    if not configs_equivalent(expected_config, remote_config):
        return False, "verification_failed: canonical config mismatch"
    return True, None


def _extract_agent_tool_ids(agent_payload: dict[str, Any]) -> list[str]:
    conversation = agent_payload.get("conversation_config") if isinstance(agent_payload.get("conversation_config"), dict) else {}
    agent = conversation.get("agent") if isinstance(conversation.get("agent"), dict) else {}
    prompt = agent.get("prompt") if isinstance(agent.get("prompt"), dict) else {}
    tool_ids = prompt.get("tool_ids")
    if not isinstance(tool_ids, list):
        return []
    return [str(item).strip() for item in tool_ids if str(item).strip()]


async def run_sync(*, body: ToolSyncRequest, trace_id: str) -> dict[str, Any]:
    if body.attach_to_agent and not body.confirm_agent_attachment:
        raise HTTPException(
            status_code=422,
            detail={"code": "confirm_agent_attachment_required", "message": "confirm_agent_attachment must be true to attach tools."},
        )
    agent_id = _resolve_agent_id(request_agent_id=body.agent_id, attach=body.attach_to_agent)
    resolved = _resolve_tool_files(body.tool_files)
    _acquire_sync_lock()
    ts = _timestamp()
    artifact_paths: dict[str, str | None] = {
        "remote_tools_before": None,
        "remote_agent_before": None,
        "sync_result": None,
    }
    try:
        remote_rows = await list_remote_tools_rows(trace_id=trace_id)
        remote_index = index_remote_tools_by_name(remote_rows)
        if not body.dry_run:
            _require_webhook_secret()
        secret = str(get_settings().elevenlabs_hubtiger_webhook_secret or "").strip()

        if not body.dry_run:
            artifact_paths["remote_tools_before"] = _write_artifact(
                f"remote_tools_before_sync_{ts}.json",
                [
                    {
                        "id": row.get("id"),
                        "name": _tool_name_from_config(_extract_remote_tool_config(row)),
                        "tool_config": _extract_remote_tool_config(row),
                    }
                    for row in remote_rows
                ],
            )
            if body.attach_to_agent and agent_id:
                agent_before = await fetch_elevenlabs_json("GET", f"/v1/convai/agents/{agent_id}", trace_id=trace_id)
                artifact_paths["remote_agent_before"] = _write_artifact(
                    f"remote_agent_before_sync_{ts}.json",
                    {"agent_id": agent_id, "tool_ids": _extract_agent_tool_ids(agent_before)},
                )

        results: list[dict[str, Any]] = []

        for file_name in resolved:
            _, repo_config = load_repo_tool_raw(file_name)
            preview = preview_tool_entry(file_name=file_name, repo_config=repo_config, remote_index=remote_index)
            tool_name = str(preview.get("tool_name") or "")
            action = str(preview.get("action") or "error")
            previous_tool_id = preview.get("remote_tool_id")
            entry: dict[str, Any] = {
                "file_name": file_name,
                "tool_name": tool_name,
                "previous_tool_id": previous_tool_id,
                "new_tool_id": previous_tool_id,
                "action": action,
                "success": False,
                "error": None,
            }
            if action == "error":
                entry["error"] = preview.get("message")
                entry["error_code"] = preview.get("error_code")
                results.append(entry)
                continue
            if action == "unchanged":
                entry["success"] = True
                results.append(entry)
                continue
            if body.dry_run:
                entry["success"] = True
                entry["dry_run"] = True
                results.append(entry)
                continue

            prepared = transform_ui_export_to_api_tool_config(_inject_webhook_secret(repo_config, secret))
            request_body = {"tool_config": prepared}
            if action == "create":
                created = await fetch_elevenlabs_json("POST", "/v1/convai/tools", body=request_body, trace_id=trace_id)
                new_tool_id = str(created.get("id") or created.get("tool_id") or "")
            else:
                new_tool_id = str(previous_tool_id or "")
                await fetch_elevenlabs_json("PATCH", f"/v1/convai/tools/{new_tool_id}", body=request_body, trace_id=trace_id)

            entry["new_tool_id"] = new_tool_id
            ok, verify_error = await _verify_remote_tool(
                tool_id=new_tool_id,
                expected_name=tool_name,
                expected_config=prepared,
                trace_id=trace_id,
            )
            entry["success"] = ok
            entry["error"] = verify_error
            results.append(entry)
            if ok and action == "create" and new_tool_id:
                remote_index.setdefault(tool_name, []).append({"id": new_tool_id, "tool_config": prepared})

        attach_result: dict[str, Any] | None = None
        if body.attach_to_agent and agent_id and not body.dry_run and body.confirm_agent_attachment:
            successful_ids = [str(r.get("new_tool_id") or "") for r in results if r.get("success") and r.get("new_tool_id")]
            if successful_ids:
                agent_payload = await fetch_elevenlabs_json("GET", f"/v1/convai/agents/{agent_id}", trace_id=trace_id)
                existing = _extract_agent_tool_ids(agent_payload)
                merged = list(dict.fromkeys(existing + successful_ids))
                patch_body = {"conversation_config": {"agent": {"prompt": {"tool_ids": merged}}}}
                await fetch_elevenlabs_json("PATCH", f"/v1/convai/agents/{agent_id}", body=patch_body, trace_id=trace_id)
                agent_after = await fetch_elevenlabs_json("GET", f"/v1/convai/agents/{agent_id}", trace_id=trace_id)
                after_ids = _extract_agent_tool_ids(agent_after)
                attach_result = {
                    "agent_id": agent_id,
                    "previous_tool_ids": existing,
                    "merged_tool_ids": merged,
                    "verified_tool_ids": after_ids,
                    "success": set(successful_ids).issubset(set(after_ids)),
                }

        if not body.dry_run:
            artifact_paths["sync_result"] = _write_artifact(
                f"sync_result_{ts}.json",
                {"tools": results, "attach": attach_result},
            )

        return {
            "dry_run": body.dry_run,
            "timestamp": ts,
            "tool_count": len(results),
            "tools": [{k: v for k, v in item.items() if k != "error_code"} for item in results],
            "artifacts": artifact_paths,
            "attach": attach_result,
        }
    finally:
        _release_sync_lock()
