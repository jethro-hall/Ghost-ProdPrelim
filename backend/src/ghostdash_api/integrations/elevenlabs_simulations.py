"""Read-only APIs for generated ElevenLabs call simulation packs."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from ghostdash_api.settings import get_settings

router = APIRouter(prefix="/api/elevenlabs/analysis/simulations", tags=["elevenlabs-analysis-simulations"])

_FILENAME_RE = re.compile(r"^JSON_[A-Za-z0-9_&\-]+_SIMULATION\.json$")


def _candidate_simulation_dirs() -> list[Path]:
    settings = get_settings()
    data_dir = Path(str(getattr(settings, "app_data_dir", "") or "").strip() or "/data")
    return [
        data_dir / "call-simulations",
        data_dir / "artefacts" / "call-simulations",
        Path("/app/artefacts/call-simulations"),
        Path.cwd() / "artefacts" / "call-simulations",
        Path(__file__).resolve().parents[4] / "artefacts" / "call-simulations",
    ]


def _simulations_dir() -> Path:
    for candidate in _candidate_simulation_dirs():
        if candidate.exists():
            return candidate
    return _candidate_simulation_dirs()[0]


def _load_json_file(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Simulation file not found.") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="Simulation file is not valid JSON.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="Simulation file has invalid structure.")
    return payload


def _strict_elevenlabs_test_payload(simulation: dict[str, Any]) -> dict[str, Any]:
    conversation = simulation.get("conversation") if isinstance(simulation.get("conversation"), dict) else {}
    playback = simulation.get("full_transcript_playback")
    timeline = playback if isinstance(playback, list) else []

    chat_history: list[dict[str, Any]] = []
    first_agent_message = ""
    for event in timeline:
        if not isinstance(event, dict):
            continue
        role = str(event.get("role") or "").strip().lower()
        if role not in {"agent", "user"}:
            continue
        message = str(event.get("text") or "").strip()
        if not message:
            continue
        at_seconds_raw = event.get("at_seconds")
        at_seconds = int(at_seconds_raw) if isinstance(at_seconds_raw, (int, float)) else 0
        chat_history.append({"role": role, "message": message, "time_in_call_secs": max(0, at_seconds)})
        if not first_agent_message and role == "agent":
            first_agent_message = message

    brief_summary = str(conversation.get("brief_summary") or "").strip() or "Simulation"
    conversation_id = str(conversation.get("id") or "").strip()

    # Strict structure expected by ElevenLabs test JSON editor.
    return {
        "name": f"{brief_summary[:96]}",
        "type": "llm",
        "chat_history": chat_history,
        "dynamic_variables": [],
        "from_conversation_metadata": {
            "conversation_id": conversation_id,
            "agent_id": "",
            "workflow_node_id": None,
            "original_agent_reply": [first_agent_message] if first_agent_message else [],
        },
        "success_condition": "",
        "success_examples": [],
        "failure_examples": [],
        "tool_call_parameters": None,
    }


@router.get("")
async def list_simulation_packs(
    limit: int = Query(default=250, ge=1, le=1000),
    search: str | None = Query(default=None, max_length=120),
) -> JSONResponse:
    root = _simulations_dir()
    if not root.exists():
        return JSONResponse(status_code=200, content={"items": [], "count": 0, "source_dir": str(root), "ready": False})

    files = [path for path in root.glob("JSON_*_SIMULATION.json") if path.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)

    needle = str(search or "").strip().lower()
    items: list[dict[str, Any]] = []
    for path in files:
        if len(items) >= limit:
            break
        payload = _load_json_file(path)
        conversation = payload.get("conversation") if isinstance(payload.get("conversation"), dict) else {}
        item = {
            "file_name": path.name,
            "conversation_id": str(conversation.get("id") or ""),
            "user": str(conversation.get("user") or "Unknown_User"),
            "brief_summary": str(conversation.get("brief_summary") or ""),
            "title": str(conversation.get("title") or ""),
            "duration_seconds": conversation.get("duration_seconds"),
            "generated_path": str(path),
        }
        if needle:
            searchable = " ".join(str(value) for value in item.values()).lower()
            if needle not in searchable:
                continue
        items.append(item)

    return JSONResponse(status_code=200, content={"items": items, "count": len(items), "source_dir": str(root), "ready": True})


@router.get("/{file_name}")
async def get_simulation_pack(file_name: str) -> JSONResponse:
    if not _FILENAME_RE.match(file_name):
        raise HTTPException(status_code=400, detail="Invalid simulation file name.")

    path = _simulations_dir() / file_name
    payload = _load_json_file(path)
    elevenlabs_json = _strict_elevenlabs_test_payload(payload)

    return JSONResponse(
        status_code=200,
        content={
            "file_name": file_name,
            "simulation": payload,
            "elevenlabs_test_payload": elevenlabs_json,
            "elevenlabs_test_payload_pretty": json.dumps(elevenlabs_json, indent=2, ensure_ascii=False),
        },
    )
