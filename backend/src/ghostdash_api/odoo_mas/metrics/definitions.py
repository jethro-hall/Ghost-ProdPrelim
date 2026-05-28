from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "metric_definitions.json"


@lru_cache(maxsize=1)
def get_metric_definitions() -> dict[str, Any]:
    with _CONFIG_PATH.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("metric_definitions.json must be a JSON object")
    metrics = payload.get("metrics")
    if not isinstance(metrics, dict):
        raise ValueError("metric_definitions.json must define a 'metrics' object")
    return payload
