from __future__ import annotations

import json

from ghostdash_api.agent_builds import (
    build_odoo_action_tool_plan,
    parse_odoo_operation_action_request,
)


def test_parse_odoo_operation_action_request_accepts_structured_json() -> None:
    message = json.dumps(
        {
            "target_model": "account.move",
            "operation": "odoo.rpc.search_read",
            "field_whitelist": ["id", "name", "invoice_date"],
            "reason": "Retrieve invoice status for customer follow-up.",
            "approval_state": "approved",
            "payload": {"fields": ["id", "name"]},
        }
    )
    request, error = parse_odoo_operation_action_request(message)
    assert error is None
    assert request is not None
    assert request.target_model == "account.move"
    plan = build_odoo_action_tool_plan(request)
    assert plan["operation"] == "odoo.rpc.search_read"
    assert plan["payload"]["model"] == "account.move"


def test_parse_odoo_operation_action_request_rejects_non_json_free_text() -> None:
    request, error = parse_odoo_operation_action_request("please update the order now")
    assert request is None
    assert error is not None
    assert "Invalid JSON" in error


def test_parse_odoo_operation_action_request_enforces_field_whitelist() -> None:
    message = json.dumps(
        {
            "target_model": "account.move",
            "operation": "odoo.rpc.search_read",
            "field_whitelist": ["id"],
            "reason": "Need exact invoice ids only.",
            "approval_state": "approved",
            "payload": {"fields": ["id", "amount_total"]},
        }
    )
    request, error = parse_odoo_operation_action_request(message)
    assert request is None
    assert error is not None
    assert "non-whitelisted fields" in error
