from __future__ import annotations

from datetime import UTC, datetime, timedelta

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


def test_plan_odoo_tool_usage_routes_named_business_ytd_question_to_monthly_comparison() -> None:
    plan = _plan_odoo_tool_usage(
        "Across the 3x main business Retail, Burleigh, Brisbane break down the year so far and who is the performer?"
    )

    assert plan["operation"] == "odoo.finance.margin.monthly_comparison"
    assert plan["payload"]["company_name_terms"] == ["retail", "burleigh", "brisbane"]
    assert plan["payload"]["date_from"].endswith("-01-01")
    assert int(plan["payload"]["months"]) >= 1
    assert plan["suppress_retrieval"] is True


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


def test_plan_odoo_tool_usage_routes_shopify_marketing_roi_question_to_shopify_helper() -> None:
    plan = _plan_odoo_tool_usage(
        "Using only Odoo, for Ride Electric Retail identify all Shopify-linked revenue and fee accounts plus marketing expense accounts and return monthly ROAS for FY25 and FY25/26 YTD."
    )

    assert plan["operation"] == "odoo.finance.shopify.monthly_roi"
    assert plan["payload"]["company_name_terms"] == ["retail"]
    assert plan["payload"]["date_from"] == "2024-07-01"
    assert plan["payload"]["date_to"] == "2026-07-01"
    assert plan["suppress_retrieval"] is True


def test_plan_odoo_tool_usage_does_not_treat_fiscal_years_as_company_ids() -> None:
    plan = _plan_odoo_tool_usage(
        "Generate FY25 monthly Shopify ROI for Ride Electric Retail from 2024-07-01 to 2025-07-01 and compare with FY26 YTD."
    )

    assert plan["operation"] == "odoo.finance.shopify.monthly_roi"
    assert plan["payload"]["company_name_terms"] == ["retail"]
    assert "company_id" not in plan["payload"]
    assert "company_ids" not in plan["payload"]
    assert plan["payload"]["date_from"] == "2024-07-01"
    assert plan["payload"]["date_to"] == "2026-07-01"


def test_plan_odoo_tool_usage_handles_typos_for_last_month_shopify_marketing_request() -> None:
    plan = _plan_odoo_tool_usage(
        "I need an indepth report on lasst monthss financials for Retail, Burleigh & Brisbane and look into maraketing spend and shopify saless."
    )

    assert plan["operation"] == "odoo.finance.shopify.monthly_roi"
    assert plan["payload"]["relative_period"] == "last_month"
    assert plan["payload"]["company_name_terms"] == ["retail", "burleigh", "brisbane"]
    assert plan["mode"] == "required"


def test_plan_odoo_tool_usage_routes_shopify_sales_wording_to_shopify_helper() -> None:
    plan = _plan_odoo_tool_usage(
        "For last month across Ride Electric Retail, Burleigh, and Brisbane, pull Shopify sales and order trends."
    )

    assert plan["operation"] == "odoo.finance.shopify.monthly_roi"
    assert plan["payload"]["relative_period"] == "last_month"
    assert plan["payload"]["company_name_terms"] == ["retail", "burleigh", "brisbane"]
    assert plan["mode"] == "required"


def test_plan_odoo_tool_usage_understands_abbreviated_month_span() -> None:
    plan = _plan_odoo_tool_usage(
        "Retail COGS codes Jul, Aug, Sept 2025 for company_id 3."
    )

    assert plan["operation"] == "odoo.finance.cogs.monthly_code_breakdown"
    assert plan["payload"]["date_from"] == "2025-07-01"
    assert plan["payload"]["date_to"] == "2025-10-01"
    assert plan["suppress_retrieval"] is True


def test_plan_odoo_tool_usage_defaults_as_of_today_to_month_to_date_window() -> None:
    plan = _plan_odoo_tool_usage(
        "Give me up-to-date Shopify performance as of today for Retail and Burleigh including orders and AOV."
    )

    assert plan["operation"] == "odoo.finance.shopify.monthly_roi"
    assert plan["payload"]["relative_period"] == "month_to_date"
    assert plan["payload"]["date_from"] is not None
    assert plan["payload"]["date_to"] is not None


def test_plan_odoo_tool_usage_parses_last_30_days_window() -> None:
    plan = _plan_odoo_tool_usage(
        "Use Odoo and return Shopify revenue, marketing spend, orders and AOV for the last 30 days for Retail."
    )

    assert plan["operation"] == "odoo.finance.shopify.monthly_roi"
    assert plan["payload"]["relative_period"] == "last_30_days"
    assert plan["payload"]["date_from"] is not None
    assert plan["payload"]["date_to"] is not None


def test_plan_odoo_tool_usage_routes_realtime_bi_prompt_to_margin_summary() -> None:
    plan = _plan_odoo_tool_usage(
        "Act as a real-time business intelligence engine. Given financial data, produce current financial reality and what matters now."
    )

    assert plan["operation"] == "odoo.finance.margin.period_summary"
    assert plan["mode"] == "required"
    assert plan["payload"]["relative_period"] == "month_to_date"
    assert plan["payload"]["date_from"] is not None
    assert plan["payload"]["date_to"] is not None


def test_plan_odoo_tool_usage_routes_mixed_revenue_cogs_margin_prompt_to_period_summary() -> None:
    plan = _plan_odoo_tool_usage(
        "As of today for company_id 3 show revenue, COGS and margin and tell me what matters now."
    )

    assert plan["operation"] == "odoo.finance.margin.period_summary"
    assert plan["payload"]["company_id"] == 3
    assert plan["payload"]["relative_period"] == "month_to_date"


def test_plan_odoo_tool_usage_routes_branch_underperformer_to_monthly_comparison() -> None:
    plan = _plan_odoo_tool_usage(
        "For month-to-date, which branch is underperforming across Retail, Burleigh and Brisbane?"
    )

    assert plan["operation"] == "odoo.finance.margin.monthly_comparison"
    assert plan["payload"]["company_name_terms"] == ["retail", "burleigh", "brisbane"]
    assert plan["payload"]["date_from"] is not None
    assert plan["payload"]["date_to"] is not None


def test_plan_odoo_tool_usage_routes_product_branch_exploration_to_multi_step_operation() -> None:
    plan = _plan_odoo_tool_usage(
        "Show total sales for the group then compare Brisbane and Burleigh for all products sold relating to fatfish for FY25."
    )

    assert plan["operation"] == "odoo.exploration.product_branch_sales"
    assert plan["payload"]["product_name_substring"] == "fatfish"
    assert "brisbane" in plan["payload"]["company_name_terms"]
    assert "burleigh" in plan["payload"]["company_name_terms"]
    assert plan["payload"].get("date_from")


def test_plan_odoo_tool_usage_brisbane_only_forces_single_company_for_dynamic_odoo() -> None:
    plan = _plan_odoo_tool_usage(
        "Using Odoo only, run a dynamic custom query deep dive for Brisbane ONLY for Jan, Feb, March, April 2026 revenue and cogs anomalies.",
        fallback_message=(
            "Recent conversation memory:\n"
            "Resolved company names: retail->Ride Electric Retail (3), burleigh->Ride Electric Burleigh (5), "
            "brisbane->Ride Electric Brisbane (4)\n"
            "company_id list: 3, 4, 5\n"
        ),
    )

    assert plan["operation"] == "odoo.rpc.query_spec"
    assert plan["payload"]["company_name_terms"] == ["brisbane"]
    assert plan["payload"]["company_scope_lock"] == "single_exact"
    assert plan["payload"]["company_scope_lock_canonical"] == "brisbane"
    assert plan["payload"].get("company_ids") in (None, [])


def test_plan_odoo_tool_usage_parses_weekend_day_range_and_single_branch_name() -> None:
    plan = _plan_odoo_tool_usage(
        "Using Odoo only, retrieve Burleigh weekend 18th/19th April 2026 revenue, COGS and gross margin."
    )

    assert plan["operation"] == "odoo.finance.margin.period_summary"
    assert plan["payload"]["date_from"] == "2026-04-18"
    assert plan["payload"]["date_to"] == "2026-04-20"
    assert plan["payload"]["company_name_terms"] == ["burleigh"]
    assert plan["blocked_reason"] is None


def test_plan_odoo_tool_usage_routes_single_named_branch_period_request_to_name_terms() -> None:
    plan = _plan_odoo_tool_usage(
        "For Burleigh for last month, show revenue and gross margin."
    )

    assert plan["operation"] == "odoo.finance.margin.period_summary"
    assert plan["payload"]["relative_period"] == "last_month"
    assert plan["payload"]["company_name_terms"] == ["burleigh"]


def test_plan_odoo_tool_usage_routes_cash_runway_questions_to_runway_summary() -> None:
    plan = _plan_odoo_tool_usage(
        "Using Odoo only, Burleigh 18th/19th April 2026 revenue, COGS, gross margin and cash runway."
    )

    assert plan["operation"] == "odoo.finance.cash.runway_summary"
    assert plan["payload"]["date_from"] == "2026-04-18"
    assert plan["payload"]["date_to"] == "2026-04-20"
    assert plan["payload"]["company_name_terms"] == ["burleigh"]


def test_plan_odoo_tool_usage_routes_dynamic_finance_deep_dive_to_query_spec() -> None:
    plan = _plan_odoo_tool_usage(
        "Using Odoo only, run a dynamic deep dive custom query for Burleigh last month revenue/cogs anomalies."
    )

    assert plan["operation"] == "odoo.rpc.query_spec"
    query_spec = plan["payload"]["query_spec"]
    assert query_spec["model"] == "account.move.line"
    assert query_spec["method"] == "read_group"
    assert query_spec["fields"] == ["balance:sum"]


def test_plan_odoo_tool_usage_prioritizes_explicit_from_date_to_now_over_fy_token() -> None:
    today = datetime.now(UTC).date()
    plan = _plan_odoo_tool_usage(
        "GPP margin for Brisbane Ride Electric FY25 from 1st July 2025 till now."
    )

    assert plan["operation"] == "odoo.finance.margin.period_summary"
    assert plan["payload"]["date_from"] == "2025-07-01"
    assert plan["payload"]["date_to"] == (today + timedelta(days=1)).isoformat()
    assert plan["payload"]["company_name_terms"] == ["brisbane"]
