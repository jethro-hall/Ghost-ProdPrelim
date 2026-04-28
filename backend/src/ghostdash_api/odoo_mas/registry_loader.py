from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any


_CONFIG_DIR = Path(__file__).resolve().parent / "config"
_ACCOUNT_CLASSIFICATION_DIR = _CONFIG_DIR / "account_classification"


def _load_registry(filename: str) -> dict[str, Any]:
    path = _CONFIG_DIR / filename
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Registry {filename} must be a JSON object")
    return payload


@lru_cache(maxsize=1)
def get_metric_registry() -> dict[str, Any]:
    return _load_registry("metric_registry.json")


@lru_cache(maxsize=1)
def get_dimension_registry() -> dict[str, Any]:
    return _load_registry("dimension_registry.json")


@lru_cache(maxsize=1)
def get_source_registry() -> dict[str, Any]:
    return _load_registry("source_registry.json")


@lru_cache(maxsize=1)
def get_presentation_registry() -> dict[str, Any]:
    return _load_registry("presentation_registry.json")


@lru_cache(maxsize=1)
def get_marketing_ledger_policy() -> dict[str, Any]:
    return _load_registry("marketing_ledger_policy.json")


@lru_cache(maxsize=1)
def get_policy_config() -> dict[str, Any]:
    return _load_registry("policy_config.json")


@lru_cache(maxsize=1)
def get_account_classification_map() -> dict[str, dict[str, dict[str, object]]]:
    result: dict[str, dict[str, dict[str, object]]] = {}
    for entity in ("retail", "brisbane", "burleigh"):
        path = _ACCOUNT_CLASSIFICATION_DIR / f"{entity}.json"
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict):
            raise ValueError(f"{path.name} must be a JSON object")
        mapping = payload.get("accounts")
        if not isinstance(mapping, dict):
            raise ValueError(f"{path.name} must define an 'accounts' object")
        normalized: dict[str, dict[str, object]] = {}
        for account_name, cfg in mapping.items():
            if not isinstance(cfg, dict):
                raise ValueError(f"{path.name} account entry '{account_name}' must be an object")
            cls = str(cfg.get("class") or "").strip()
            if not cls:
                raise ValueError(f"{path.name} account entry '{account_name}' is missing class")
            code_match = re.match(r"^\s*(\d{3,4})\b", str(account_name))
            normalized[" ".join(str(account_name).strip().casefold().split())] = {
                "display_name": str(account_name).strip(),
                "account_code": int(code_match.group(1)) if code_match else None,
                "class": cls,
                "include_in_metric": bool(cfg.get("include_in_metric", False)),
            }
        result[entity] = normalized
    return result


@lru_cache(maxsize=1)
def get_metric_request_rules() -> dict[str, Any]:
    payload = _load_registry("metric_request_rules.json")
    metric_concepts = payload.get("metric_concepts")
    planner_policy = payload.get("planner_policy")
    if not isinstance(metric_concepts, list):
        raise ValueError("metric_request_rules.json must define a 'metric_concepts' list")
    if not isinstance(planner_policy, dict):
        raise ValueError("metric_request_rules.json must define a 'planner_policy' object")
    return payload


@lru_cache(maxsize=1)
def get_anomaly_rules() -> dict[str, Any]:
    payload = _load_registry("anomaly_rules.json")
    if "rules" not in payload and "version" not in payload:
        raise ValueError("anomaly_rules.json must be a valid object")
    return payload


@lru_cache(maxsize=1)
def get_forecast_rules() -> dict[str, Any]:
    return _load_registry("forecast_rules.json")


@lru_cache(maxsize=1)
def get_board_output_templates() -> dict[str, Any]:
    return _load_registry("board_output_templates.json")
