from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator


class CaseFramingOutput(BaseModel):
    objective: str = Field(min_length=1)
    sub_questions: list[str] = Field(default_factory=list)
    required_evidence: list[str] = Field(default_factory=list)
    recommended_workflow: str = Field(min_length=1)
    risk_level: Literal["low", "medium", "high", "critical"] = "medium"
    write_access_required: bool = False


class EvidenceRetrievalOutput(BaseModel):
    normalized_evidence_pack: list[dict[str, Any]] = Field(default_factory=list)
    source_attribution: list[dict[str, Any]] = Field(default_factory=list)
    freshness_score: float = Field(ge=0.0, le=1.0, default=0.0)
    contradiction_flags: list[str] = Field(default_factory=list)
    missing_data_flags: list[str] = Field(default_factory=list)


class BpCaseFrameOutput(BaseModel):
    objective: str = Field(min_length=1)
    required_metrics: list[str] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)
    date_window: str = Field(min_length=1, default="unspecified")
    assumptions: list[str] = Field(default_factory=list)
    blockers: list[str] = Field(default_factory=list)


class BpAuditResult(BaseModel):
    fit_for_purpose: Literal["pass", "fail"] = "pass"
    best_practice: Literal["pass", "fail"] = "pass"
    efficiency: Literal["pass", "fail"] = "pass"
    business_value: Literal["pass", "fail"] = "pass"
    hard_fail: bool = False
    findings: list[str] = Field(default_factory=list)
    remediation_actions: list[str] = Field(default_factory=list)
    confidence_score: float = Field(ge=0.0, le=1.0, default=0.0)


class OdooOperationActionRequest(BaseModel):
    target_model: str = Field(min_length=1, max_length=128)
    operation: str = Field(min_length=1, max_length=128)
    field_whitelist: list[str] = Field(default_factory=list, min_length=1)
    reason: str = Field(min_length=1, max_length=1000)
    approval_state: Literal["approved", "pending", "rejected", "not_required"]
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("field_whitelist")
    @classmethod
    def _normalize_field_whitelist(cls, values: list[str]) -> list[str]:
        cleaned: list[str] = []
        for raw in values:
            field = str(raw or "").strip()
            if not field:
                continue
            cleaned.append(field)
        if not cleaned:
            raise ValueError("field_whitelist must contain at least one field")
        deduped: list[str] = []
        seen: set[str] = set()
        for field in cleaned:
            lowered = field.casefold()
            if lowered in seen:
                continue
            seen.add(lowered)
            deduped.append(field)
        return deduped


def parse_odoo_operation_action_request(raw_message: str) -> tuple[OdooOperationActionRequest | None, str | None]:
    text = str(raw_message or "").strip()
    if not text:
        return None, "Structured action JSON is required."
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, f"Invalid JSON for Odoo Operations Agent: {exc.msg}."
    if not isinstance(parsed, dict):
        return None, "Structured action must be a JSON object."
    try:
        request = OdooOperationActionRequest.model_validate(parsed)
    except ValidationError as exc:
        return None, f"Invalid structured action fields: {exc.errors(include_url=False)}"
    whitelist_error = _validate_field_whitelist_constraints(request)
    if whitelist_error:
        return None, whitelist_error
    return request, None


def build_odoo_action_tool_plan(request: OdooOperationActionRequest) -> dict[str, Any]:
    payload = dict(request.payload or {})
    if request.operation in {"odoo.rpc.search_read", "odoo.rpc.read_group", "odoo.rpc.execute_kw"}:
        payload.setdefault("model", request.target_model)
    if request.operation == "odoo.rpc.query_spec":
        query_spec = payload.get("query_spec")
        if not isinstance(query_spec, dict):
            query_spec = {}
        query_spec.setdefault("model", request.target_model)
        payload["query_spec"] = query_spec
    return {
        "tool_id": "odoo_primary",
        "mode": "required",
        "operation": request.operation,
        "payload": payload,
        "reason": (
            "Structured Odoo action request accepted "
            f"(target_model={request.target_model}, approval_state={request.approval_state})."
        ),
    }


def case_framing_prompt(message: str) -> str:
    return (
        "You are the Case Framing Agent for a Group CFO Architect workflow.\n"
        "Produce only a JSON object matching this contract:\n"
        "{\n"
        '  "objective": string,\n'
        '  "sub_questions": string[],\n'
        '  "required_evidence": string[],\n'
        '  "recommended_workflow": string,\n'
        '  "risk_level": "low" | "medium" | "high" | "critical",\n'
        '  "write_access_required": boolean\n'
        "}\n\n"
        "Rules:\n"
        "- Do not use tools.\n"
        "- Do not perform writes.\n"
        "- Define exact entity scope, period scope, KPI scope, and decision intent.\n"
        "- Do not provide recommendations in this step.\n"
        f"Raw request:\n{message}"
    )


def evidence_retrieval_prompt(message: str) -> str:
    return (
        "You are the Evidence Retrieval Agent for a Group CFO Architect workflow.\n"
        "Return a factual evidence pack only (JSON), no recommendations and no actions.\n"
        "{\n"
        '  "normalized_evidence_pack": object[],\n'
        '  "source_attribution": object[],\n'
        '  "freshness_score": number(0..1),\n'
        '  "contradiction_flags": string[],\n'
        '  "missing_data_flags": string[]\n'
        "}\n\n"
        "Rules:\n"
        "- Only state what data says.\n"
        "- Include uncertainty only as missing_data_flags.\n"
        "- Preserve source attribution fidelity and freshness context.\n"
        "- Separate Odoo evidence from non-Odoo evidence when both are present.\n"
        f"Case request:\n{message}"
    )


def bp_mode_case_framing_prompt(message: str) -> str:
    return (
        "BP mode - case framing step.\n"
        "Return only JSON matching this contract:\n"
        "{\n"
        '  "objective": string,\n'
        '  "required_metrics": string[],\n'
        '  "entities": string[],\n'
        '  "date_window": string,\n'
        '  "assumptions": string[],\n'
        '  "blockers": string[]\n'
        "}\n\n"
        "Do not execute tools in this framing step. Convert the messy request into an exact business case.\n"
        f"Raw request:\n{message}"
    )


def bp_mode_auditor_prompt(message: str) -> str:
    return (
        "BP mode - auditor step.\n"
        "Return only JSON matching this contract:\n"
        "{\n"
        '  "fit_for_purpose": "pass" | "fail",\n'
        '  "best_practice": "pass" | "fail",\n'
        '  "efficiency": "pass" | "fail",\n'
        '  "business_value": "pass" | "fail",\n'
        '  "hard_fail": boolean,\n'
        '  "findings": string[],\n'
        '  "remediation_actions": string[],\n'
        '  "confidence_score": number(0..1)\n'
        "}\n\n"
        "Evaluate for audit quality only. If anything fails, provide explicit remediation actions.\n"
        f"Material to audit:\n{message}"
    )


def _validate_field_whitelist_constraints(request: OdooOperationActionRequest) -> str | None:
    whitelist = {field.casefold() for field in request.field_whitelist}
    payload = dict(request.payload or {})
    if request.operation == "odoo.rpc.search_read":
        fields = payload.get("fields")
        if fields is None:
            return "payload.fields is required for operation odoo.rpc.search_read."
        if not isinstance(fields, list):
            return "payload.fields must be a list for operation odoo.rpc.search_read."
        unauthorized = [str(field) for field in fields if str(field).casefold() not in whitelist]
        if unauthorized:
            return f"payload.fields includes non-whitelisted fields: {unauthorized}"
    if request.operation == "odoo.rpc.query_spec":
        query_spec = payload.get("query_spec")
        if not isinstance(query_spec, dict):
            return "payload.query_spec object is required for operation odoo.rpc.query_spec."
        model = str(query_spec.get("model") or "").strip()
        if model and model != request.target_model:
            return f"query_spec.model must match target_model ({request.target_model})."
        fields = query_spec.get("fields") or []
        if not isinstance(fields, list):
            return "query_spec.fields must be a list when provided."
        unauthorized = [str(field) for field in fields if str(field).casefold() not in whitelist]
        if unauthorized:
            return f"query_spec.fields includes non-whitelisted fields: {unauthorized}"
    return None
