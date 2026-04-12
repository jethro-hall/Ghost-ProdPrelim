from __future__ import annotations

import json
from typing import Any

import yaml


def parse_workflow_definition_text(*, definition_text: str, format: str) -> dict[str, Any]:
    normalized_format = format.strip().lower()
    if normalized_format == "json":
        value = json.loads(definition_text)
    elif normalized_format == "yaml":
        value = yaml.safe_load(definition_text)
    else:
        raise ValueError("workflow definition format must be json or yaml")

    if not isinstance(value, dict):
        raise ValueError("workflow definition must decode to an object")
    return value


def dump_workflow_definition_text(*, definition: dict[str, Any], format: str) -> str:
    normalized_format = format.strip().lower()
    if normalized_format == "json":
        return json.dumps(definition, indent=2, sort_keys=False)
    if normalized_format == "yaml":
        return yaml.safe_dump(definition, sort_keys=False, allow_unicode=False)
    raise ValueError("workflow definition format must be json or yaml")
