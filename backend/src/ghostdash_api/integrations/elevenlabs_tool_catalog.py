"""Shared HubTiger ElevenLabs repo tool catalog paths and loaders."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from ghostdash_api.settings import get_settings

STAGED_BOOKING_TOOL_FILES: tuple[str, ...] = (
    "hubtiger_booking_availability.json",
    "hubtiger_booking_slot.json",
    "hubtiger_booking_customer_search.json",
    "hubtiger_booking_customer_confirm.json",
    "hubtiger_booking_bike_list.json",
    "hubtiger_booking_bike_confirm.json",
    "hubtiger_booking_service_set.json",
    "hubtiger_booking_submit.json",
    "hubtiger_booking_create.json",
)


def tool_roots() -> list[Path]:
    settings = get_settings()
    configured = str(getattr(settings, "hubtiger_elevenlabs_tool_dir", None) or "").strip()
    roots: list[Path] = []
    if configured:
        roots.append(Path(configured))
    for candidate in (
        Path("/app/hubtiger-tools"),
        Path("/var/llamaindex/ghoststack-rag/scripts/hubtiger"),
    ):
        if candidate not in roots and candidate.is_dir():
            roots.append(candidate)
    return roots


def load_repo_tool_raw(file_name: str) -> tuple[Path, dict[str, Any]]:
    safe = Path(file_name).name
    for root in tool_roots():
        for candidate in (root / safe, root / "hubtiger-api" / "elevenlabs-tools" / safe):
            if candidate.is_file():
                raw = json.loads(candidate.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):
                    raise HTTPException(status_code=500, detail=f"Invalid tool JSON: {safe}")
                return candidate, raw
    raise HTTPException(status_code=404, detail=f"Repo tool not found: {safe}")
