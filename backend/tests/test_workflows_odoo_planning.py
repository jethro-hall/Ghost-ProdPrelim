from __future__ import annotations

from ghostdash_api.workflows import _plan_odoo_tool_usage


def test_plan_odoo_tool_usage_carries_forward_company_scope_from_history() -> None:
    plan = _plan_odoo_tool_usage(
        "show invoices",
        fallback_message="Recent conversation memory:\nUser: use company_id=7\n\nCurrent user request:\nshow invoices",
    )

    assert plan["operation"] == "odoo.finance.invoices.search_read"
    assert plan["payload"]["domain"] == [["company_id", "=", 7]]
    assert plan["blocked_reason"] is None


def test_plan_odoo_tool_usage_blocks_ambiguous_company_invoice_request() -> None:
    plan = _plan_odoo_tool_usage("show invoices for one company only")

    assert plan["operation"] == "odoo.finance.invoices.search_read"
    assert plan["blocked_reason"] == "company_scope_ambiguous"
    assert "company scope is ambiguous" in str(plan["direct_answer"]).lower()


def test_plan_odoo_tool_usage_routes_monthly_gp_question_to_period_summary() -> None:
    plan = _plan_odoo_tool_usage("What was the GP for Ride Electric Burleigh company 5 for last month")

    assert plan["operation"] == "odoo.finance.margin.period_summary"
    assert plan["payload"]["company_id"] == 5
    assert plan["payload"]["relative_period"] == "last_month"
    assert plan["payload"]["date_from"]
    assert plan["payload"]["date_to"]


def test_plan_odoo_tool_usage_routes_multi_company_gp_question_to_monthly_comparison() -> None:
    plan = _plan_odoo_tool_usage(
        "Execute Odoo now. I want a CFO-grade GP analysis across company_id 3, 4, and 5 for the last 4 completed months."
    )

    assert plan["operation"] == "odoo.finance.margin.monthly_comparison"
    assert plan["payload"]["company_ids"] == [3, 4, 5]
    assert plan["payload"]["months"] == 4


def test_plan_odoo_tool_usage_routes_cogs_code_questions_to_read_group() -> None:
    plan = _plan_odoo_tool_usage(
        "Review the Retail COGS codes for July, Aug, Sept 2025 and tell me what caused gross profit to be way out for company_id 3."
    )

    assert plan["operation"] == "odoo.finance.cogs.monthly_code_breakdown"
    assert plan["payload"]["company_id"] == 3
    assert plan["payload"]["date_from"] == "2025-07-01"
    assert plan["payload"]["date_to"] == "2025-10-01"
    assert plan["payload"]["months"] == 3
    assert plan["payload"]["top_n"] == 8


def test_plan_odoo_tool_usage_understands_abbreviated_month_span() -> None:
    plan = _plan_odoo_tool_usage(
        "Retail COGS codes Jul, Aug, Sept 2025 for company_id 3."
    )

    assert plan["operation"] == "odoo.finance.cogs.monthly_code_breakdown"
    assert plan["payload"]["date_from"] == "2025-07-01"
    assert plan["payload"]["date_to"] == "2025-10-01"
    assert plan["suppress_retrieval"] is True
