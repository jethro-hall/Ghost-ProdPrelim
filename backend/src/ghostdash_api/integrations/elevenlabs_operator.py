"""GhostDASH Voice Operator Console — repo tool catalog and operator health."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ghostdash_api.integrations.elevenlabs_tool_sync import ToolSyncRequest, preview_sync, run_sync
from ghostdash_api.integrations.operator_admin import check_operator_admin_auth

from ghostdash_api.integrations.elevenlabs_tool_catalog import tool_roots
from ghostdash_api.settings import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/elevenlabs/operator", tags=["elevenlabs-operator"])

_BOOKING_TOOL_FILES = frozenset(
    {
        "hubtiger_booking_availability.json",
        "hubtiger_booking_create.json",
        "hubtiger_booking_slot.json",
        "hubtiger_booking_customer_search.json",
        "hubtiger_booking_customer_confirm.json",
        "hubtiger_booking_bike_list.json",
        "hubtiger_booking_bike_confirm.json",
        "hubtiger_booking_service_set.json",
        "hubtiger_booking_submit.json",
        "hubtiger_booking_finalize.json",
        "hubtiger_job_search.json",
        "hubtiger_job_get.json",
        "hubtiger_customer_by_phone.json",
    }
)


def _scan_tool_json() -> list[dict[str, Any]]:
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for root in tool_roots():
        patterns = [
            root.glob("hubtiger_*.json"),
            (root / "hubtiger-api" / "elevenlabs-tools").glob("hubtiger_*.json")
            if (root / "hubtiger-api" / "elevenlabs-tools").is_dir()
            else [],
        ]
        for pattern in patterns:
            for path in sorted(pattern):
                name = path.name
                if name in seen:
                    continue
                seen.add(name)
                try:
                    raw = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as err:
                    logger.warning("skip_tool_json", extra={"path": str(path), "error": str(err)})
                    continue
                tool_name = str(raw.get("name") or name.replace(".json", ""))
                function_constant = None
                body_props = (
                    raw.get("api_schema", {})
                    .get("request_body_schema", {})
                    .get("properties", [])
                )
                if isinstance(body_props, list):
                    for prop in body_props:
                        if isinstance(prop, dict) and prop.get("id") == "function":
                            function_constant = prop.get("constant_value")
                            break
                items.append(
                    {
                        "file_name": name,
                        "path": str(path),
                        "tool_name": tool_name,
                        "api_function": function_constant,
                        "description": str(raw.get("description") or "")[:500],
                        "timeout_secs": raw.get("response_timeout_secs"),
                        "is_booking": name in _BOOKING_TOOL_FILES,
                        "recommended_flow": _recommended_flow(name),
                    }
                )
    items.sort(key=lambda row: (not row["is_booking"], row["file_name"]))
    return items


def _recommended_flow(file_name: str) -> str | None:
    if file_name == "hubtiger_booking_availability.json":
        return "two_tool_step_1"
    if file_name == "hubtiger_booking_create.json":
        return "two_tool_step_2"
    if file_name in {"hubtiger_booking_slot.json", "hubtiger_booking_customer_search.json"}:
        return "staged"
    return None


@router.get("/health")
async def operator_health() -> JSONResponse:
    settings = get_settings()
    tools = _scan_tool_json()
    el_key = bool(str(settings.elevenlabs_api_key or "").strip())
    agent_id = str(settings.elevenlabs_convai_agent_id or "").strip() or None
    tool_dir = str(getattr(settings, "hubtiger_elevenlabs_tool_dir", None) or "")
    roots = [str(p) for p in tool_roots()]
    return JSONResponse(
        status_code=200,
        content={
            "ok": True,
            "service": "elevenlabs-operator",
            "elevenlabs_api_configured": el_key,
            "elevenlabs_convai_agent_id": agent_id,
            "repo_tool_count": len(tools),
            "repo_tool_roots": roots,
            "hubtiger_tool_dir_setting": tool_dir or None,
            "ghostdash_webhook": "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool",
            "capabilities": {
                "repo_tool_catalog": len(tools) > 0,
                "hubtiger_live_test": True,
                "agent_chat_simulator": True,
                "test_workbench": True,
                "elevenlabs_simulate_api": el_key,
                "elevenlabs_remote_tool_list": el_key,
            },
        },
    )


@router.get("/tools")
async def list_repo_tools() -> JSONResponse:
    tools = _scan_tool_json()
    return JSONResponse(status_code=200, content={"tools": tools, "count": len(tools)})


@router.get("/tools/{file_name}")
async def get_repo_tool(file_name: str) -> JSONResponse:
    safe = Path(file_name).name
    if safe != file_name or not safe.endswith(".json"):
        raise HTTPException(status_code=400, detail="Invalid tool file name.")
    for root in tool_roots():
        for candidate in (
            root / safe,
            root / "hubtiger-api" / "elevenlabs-tools" / safe,
        ):
            if candidate.is_file():
                try:
                    payload = json.loads(candidate.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as err:
                    raise HTTPException(status_code=500, detail=f"Could not read tool JSON: {err}") from err
                return JSONResponse(
                    status_code=200,
                    content={"file_name": safe, "path": str(candidate), "tool": payload},
                )
    raise HTTPException(status_code=404, detail="Tool JSON not found in repo catalog.")


@router.get("/workflow-map")
async def workflow_map() -> JSONResponse:
    """Operator-facing workflow definitions (no ElevenLabs UI required for testing)."""
    return JSONResponse(
        status_code=200,
        content={
            "two_tool": {
                "label": "Recommended — availability + create",
                "doc": "docs/HUBTIGER_BOOKING_TWO_TOOL_ELEVENLABS_MAP.md",
                "nodes": [
                    {"id": "booking_availability", "tool_file": "hubtiger_booking_availability.json", "prompt": "NODE_SIMPLE_01_availability.md"},
                    {"id": "booking_collect", "conversation_only": True, "prompt": "NODE_SIMPLE_02_collect.md"},
                    {"id": "booking_create", "tool_file": "hubtiger_booking_create.json", "prompt": "NODE_SIMPLE_03_create.md"},
                    {"id": "booking_complete", "conversation_only": True, "prompt": "NODE_done.md"},
                ],
                "dynamic_variables": [
                    "booking_store",
                    "booking_service_date",
                    "booking_technician_id",
                    "booking_slot_display",
                ],
            },
            "staged": {
                "label": "Long calls — 8 tools + booking_session_id",
                "doc": "docs/HUBTIGER_BOOKING_WORKFLOW_NODES.md",
                "dynamic_variables": ["booking_session_id"],
            },
            "ghostdash_surfaces": {
                "voice_operator_console": "/analysis/voice-ops",
                "test_workbench": "/analysis/test-workbench",
                "agent_config": "/agent",
                "hubtiger_tools": "/tools",
                "simulator_panel": "Header → Simulator (slide-out)",
            },
        },
    )

@router.get("/tools/sync/preview")
async def operator_tools_sync_preview(request: Request) -> JSONResponse:
    check_operator_admin_auth(request)
    trace_id = str(getattr(request.state, "trace_id", "") or "")
    payload = await preview_sync(tool_files=None, trace_id=trace_id)
    return JSONResponse(status_code=200, content=payload)


@router.post("/tools/sync")
async def operator_tools_sync(body: ToolSyncRequest, request: Request) -> JSONResponse:
    check_operator_admin_auth(request)
    trace_id = str(getattr(request.state, "trace_id", "") or "")
    payload = await run_sync(body=body, trace_id=trace_id)
    return JSONResponse(status_code=200, content=payload)

