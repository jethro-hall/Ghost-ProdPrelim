"""Transform ElevenLabs UI-export tool JSON into ConvAI API tool_config shape."""

from __future__ import annotations

import copy
from typing import Any


def _humanize_field_id(field_id: str) -> str:
    return field_id.replace("_", " ").strip() or "value"


def _scalar_property_fields(prop: dict[str, Any]) -> dict[str, Any]:
    value_type = str(prop.get("value_type") or "llm_prompt")
    field_id = str(prop.get("id") or "")
    out: dict[str, Any] = {"type": prop.get("type")}

    enum_val = prop.get("enum")
    if enum_val is not None:
        out["enum"] = enum_val

    if value_type == "constant":
        out["constant_value"] = str(prop.get("constant_value") or _humanize_field_id(field_id))
    elif value_type == "dynamic_variable":
        out["dynamic_variable"] = str(prop.get("dynamic_variable") or field_id or "dynamic_value")
    elif prop.get("is_system_provided"):
        out["is_system_provided"] = True
    else:
        description = str(prop.get("description") or "")
        if not description.strip():
            description = _humanize_field_id(field_id)
        out["description"] = description

    return out


def _transform_property(prop: dict[str, Any]) -> dict[str, Any]:
    if prop.get("type") == "object":
        out: dict[str, Any] = {
            "type": "object",
            "description": str(prop.get("description") or ""),
        }
        nested = prop.get("properties")
        if isinstance(nested, list):
            props_dict: dict[str, Any] = {}
            nested_required: list[str] = []
            for child in nested:
                if not isinstance(child, dict):
                    continue
                key = str(child.get("id") or "").strip()
                if not key:
                    continue
                props_dict[key] = _transform_property(child)
                if child.get("required"):
                    nested_required.append(key)
            out["properties"] = props_dict
            out["required"] = nested_required
        elif isinstance(nested, dict):
            out["properties"] = nested
            out["required"] = list(prop.get("required") or [])
        else:
            out["properties"] = {}
            out["required"] = []
        return out
    return _scalar_property_fields(prop)


def _transform_properties_list(props: list[Any]) -> tuple[dict[str, Any], list[str]]:
    transformed: dict[str, Any] = {}
    required: list[str] = []
    for prop in props:
        if not isinstance(prop, dict):
            continue
        key = str(prop.get("id") or "").strip()
        if not key:
            continue
        transformed[key] = _transform_property(prop)
        if prop.get("required"):
            required.append(key)
    return transformed, required


def transform_ui_export_to_api_tool_config(config: dict[str, Any]) -> dict[str, Any]:
    """Convert repo ElevenLabs UI export JSON to POST/PATCH tool_config payload."""
    out = copy.deepcopy(config)
    api_schema = out.get("api_schema")
    if not isinstance(api_schema, dict):
        return out

    headers = api_schema.get("request_headers")
    if isinstance(headers, list):
        header_map: dict[str, str] = {}
        for header in headers:
            if isinstance(header, dict) and header.get("name"):
                header_map[str(header["name"])] = str(header.get("value") or "")
        api_schema["request_headers"] = header_map

    for key in ("path_params_schema",):
        value = api_schema.get(key)
        if value in ([], None, {}):
            api_schema[key] = {}

    query = api_schema.get("query_params_schema")
    if query in ([], None, {}, {"properties": {}}):
        api_schema.pop("query_params_schema", None)

    body = api_schema.get("request_body_schema")
    if isinstance(body, dict):
        props = body.get("properties")
        if isinstance(props, list):
            transformed, required = _transform_properties_list(props)
            body["properties"] = transformed
            body["required"] = required
        for ui_only in ("id", "value_type"):
            body.pop(ui_only, None)
        if body.get("required") is False:
            body["required"] = []

    # Drop UI-only top-level keys not accepted by API if present
    for ui_only in ("assignments", "response_mocks"):
        out.pop(ui_only, None)

    return out


def _normalize_scalar_property_for_compare(prop: dict[str, Any]) -> dict[str, Any]:
    if prop.get("type") == "object":
        out: dict[str, Any] = {
            "type": "object",
            "description": str(prop.get("description") or ""),
        }
        nested = prop.get("properties")
        if isinstance(nested, dict):
            out["properties"] = {
                key: _normalize_scalar_property_for_compare(value)
                for key, value in nested.items()
                if isinstance(value, dict)
            }
            out["required"] = sorted(str(item) for item in (prop.get("required") or []))
        else:
            out["properties"] = {}
            out["required"] = []
        return out

    out: dict[str, Any] = {"type": prop.get("type")}
    if prop.get("enum") is not None:
        out["enum"] = prop.get("enum")
    constant_value = str(prop.get("constant_value") or "")
    dynamic_variable = str(prop.get("dynamic_variable") or "")
    if constant_value:
        out["constant_value"] = constant_value
    elif dynamic_variable:
        out["dynamic_variable"] = dynamic_variable
    elif prop.get("is_system_provided"):
        out["is_system_provided"] = True
    else:
        out["description"] = str(prop.get("description") or "")
    return out


def _normalize_body_schema(body: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(body)
    props = out.get("properties")
    if isinstance(props, dict):
        out["properties"] = {
            key: _normalize_scalar_property_for_compare(value)
            for key, value in props.items()
            if isinstance(value, dict)
        }
    if isinstance(out.get("required"), list):
        out["required"] = sorted(str(item) for item in out["required"])
    for ui_only in ("id", "value_type"):
        out.pop(ui_only, None)
    if out.get("required") is False:
        out["required"] = []
    return out


def normalize_tool_config_for_compare(config: dict[str, Any]) -> dict[str, Any]:
    """Normalize repo export or ElevenLabs API tool_config for stable diffing."""
    out = transform_ui_export_to_api_tool_config(config)
    api_schema = out.get("api_schema")
    if isinstance(api_schema, dict):
        body = api_schema.get("request_body_schema")
        if isinstance(body, dict):
            api_schema["request_body_schema"] = _normalize_body_schema(body)
        if api_schema.get("query_params_schema") in (None, {}, {"properties": {}}):
            api_schema.pop("query_params_schema", None)
        if api_schema.get("path_params_schema") in (None,):
            api_schema["path_params_schema"] = {}
    for ui_only in (
        "assignments",
        "response_mocks",
        "dynamic_variables",
        "disable_interruptions",
        "force_pre_tool_speech",
        "pre_tool_speech",
        "tool_call_sound",
        "tool_call_sound_behavior",
        "tool_error_handling_mode",
        "execution_mode",
    ):
        out.pop(ui_only, None)
    return out
