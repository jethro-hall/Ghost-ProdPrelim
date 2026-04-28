from __future__ import annotations

from datetime import UTC, datetime, timedelta

from ghostdash_api.workflows import _extract_period_scope, _plan_odoo_tool_usage


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


def test_plan_odoo_tool_usage_routes_sales_drilldown_prompt_to_named_helper() -> None:
    plan = _plan_odoo_tool_usage(
        "After receiving the revenue numbers for the previous 7 days from 20/04/2026, please using Odoo show the leading sales agent payment method and product sold for Burleigh."
    )

    assert plan["operation"] == "odoo.sales.drilldown.period"
    assert plan["payload"]["date_from"] == "2026-04-13"
    assert plan["payload"]["date_to"] == "2026-04-20"
    assert plan["payload"]["company_name_terms"] == ["burleigh"]
    assert plan["suppress_retrieval"] is True


def test_plan_odoo_tool_usage_routes_top_products_gp_prompt_to_named_helper() -> None:
    plan = _plan_odoo_tool_usage(
        "out of the 23,074.70 revenue for Brisbane, show me what was the top 5 products sold and each products GP"
    )
    assert plan["operation"] == "odoo.sales.products_gp.period_top"
    assert plan["payload"]["top_n"] == 5
    assert plan["payload"]["can_be_sold"] is True
    assert plan["payload"]["company_name_terms"] == ["brisbane"]
    assert plan["payload"]["revenue_reference_total"] == 23074.70
    assert plan["payload"]["date_from"] is not None
    assert plan["payload"]["date_to"] is not None


def test_plan_odoo_tool_usage_routes_product_catalog_lookup_to_products_search_read() -> None:
    plan = _plan_odoo_tool_usage(
        "Using Odoo, list products matching fatfish for catalog review."
    )

    assert plan["operation"] == "odoo.products.search_read"
    assert plan["payload"]["can_be_sold"] is True
    assert plan["payload"]["query"] == "fatfish"
    assert "name" in plan["payload"]["fields"]
    assert "default_code" in plan["payload"]["fields"]


def test_plan_odoo_tool_usage_routes_period_sales_order_lookup_to_sales_orders_search_read() -> None:
    plan = _plan_odoo_tool_usage(
        "Using Odoo, show sales orders for company_id 3 for last month."
    )

    assert plan["operation"] == "odoo.sales.orders.search_read"
    assert plan["mode"] == "required"
    assert plan["payload"]["limit"] == 100
    assert ["company_id", "=", 3] in plan["payload"]["domain"]
    assert ["state", "in", ["sale", "done"]] in plan["payload"]["domain"]
    assert any(item[0] == "date_order" and item[1] == ">=" for item in plan["payload"]["domain"])
    assert any(item[0] == "date_order" and item[1] == "<" for item in plan["payload"]["domain"])


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


def test_plan_odoo_tool_usage_routes_burleigh_gp_roas_five_day_window_to_period_summary() -> None:
    """Anchored 'previous N days from DD/MM/YYYY' must resolve so we use ledger GP, not Shopify ROI."""
    plan = _plan_odoo_tool_usage(
        "Using Odoo, Show me GP/ROAS/performance and any relevant financial / assessment data "
        "for the previous 5 days from the 20/04/2026 for the BUSINESS Ride Electric Burleigh ONLY.",
        intent_message=(
            "Using Odoo, Show me GP/ROAS/performance and any relevant financial / assessment data "
            "for the previous 5 days from the 20/04/2026 for the BUSINESS Ride Electric Burleigh ONLY."
        ),
    )

    assert plan["operation"] == "odoo.finance.margin.period_summary"
    assert plan["payload"]["date_from"] == "2026-04-15"
    assert plan["payload"]["date_to"] == "2026-04-20"
    assert plan["payload"]["company_name_terms"] == ["burleigh"]


def test_plan_odoo_tool_usage_dual_odoo_gp_and_shopify_prefers_margin_with_planner_hint() -> None:
    plan = _plan_odoo_tool_usage(
        "In Odoo for Burleigh last month: gross profit plus Shopify ROAS.",
    )

    assert plan["operation"] == "odoo.finance.margin.period_summary"
    assert plan.get("multi_step_odoo_hint")


def test_plan_odoo_tool_usage_routes_bp_scorecard_prompt_to_branch_comparison() -> None:
    plan = _plan_odoo_tool_usage(
        "Please give me COGS GP revenue net and ROAS for Burleigh and Brisbane and package it board-ready."
    )

    assert plan["operation"] == "odoo.finance.pnl.period_summary"
    assert plan["payload"]["company_name_terms"] == ["burleigh", "brisbane"]
    assert plan["payload"]["required_metrics"] == ["cogs", "gp", "revenue", "net", "roas"]
    assert plan.get("multi_step_odoo_hint")
    assert "Shopify" in str(plan["multi_step_odoo_hint"])


def test_plan_odoo_tool_usage_interprets_named_month_without_year_for_bp_mode() -> None:
    today = datetime.now(UTC).date()
    expected_year = today.year if today.month >= 3 else today.year - 1
    period_scope = _extract_period_scope(
        "Please give me COGS/GP/REV/NET and ROAS for Burleigh and Brisbane for March."
    )

    assert period_scope["relative_period"] == f"march_{expected_year}"
    assert period_scope["date_from"] == f"{expected_year}-03-01"
    assert period_scope["date_to"] == f"{expected_year}-04-01"


def test_plan_odoo_tool_usage_routes_pnl_prompt_to_pnl_period_summary() -> None:
    plan = _plan_odoo_tool_usage(
        "For Burleigh and Brisbane for last month, return profit and loss including operating income, total expenses, and net profit."
    )

    assert plan["operation"] == "odoo.finance.pnl.period_summary"
    assert plan["payload"]["company_name_terms"] == ["burleigh", "brisbane"]
    assert plan["payload"]["relative_period"] == "last_month"


def test_plan_odoo_tool_usage_negates_shopify_when_user_says_not_shopify() -> None:
    """Mentioning 'not Shopify' must not trigger the Shopify ROI helper."""
    plan = _plan_odoo_tool_usage(
        "Using Odoo show GP/ROAS for Burleigh only — ERP ledger actuals, not Shopify.",
    )

    assert plan["operation"] != "odoo.finance.shopify.monthly_roi"


def test_plan_odoo_tool_usage_does_not_route_shopify_from_assistant_history_alone() -> None:
    """Full-thread replanning must not treat assistant 'Shopify' mentions as user intent."""
    plan = _plan_odoo_tool_usage(
        "assistant: we already ran odoo.finance.shopify.monthly_roi for Shopify-linked revenue.\n"
        "user: Using Odoo, show gross profit for Ride Electric Burleigh for last month",
        intent_message="Using Odoo, show gross profit for Ride Electric Burleigh for last month",
    )

    assert plan["operation"] == "odoo.finance.margin.period_summary"
    assert plan["payload"]["relative_period"] == "last_month"


def test_plan_odoo_tool_usage_ignores_execution_legend_company_ids_in_history() -> None:
    plan = _plan_odoo_tool_usage(
        "assistant: Execution legend\n"
        "source:live_odoo | window:2026-03-01->2026-04-01 | companies:98,0\n"
        "user: Using Odoo, show gross profit for Ride Electric Brisbane and Burleigh for last month",
        intent_message="Using Odoo, show gross profit for Ride Electric Brisbane and Burleigh for last month",
    )

    assert plan["operation"] == "odoo.finance.margin.monthly_comparison"
    assert set(plan["payload"]["company_name_terms"]) == {"brisbane", "burleigh"}
    assert plan["payload"].get("company_ids") in (None, [], [4, 5])
    assert 98 not in plan["payload"].get("company_ids", [])
    assert 0 not in plan["payload"].get("company_ids", [])
