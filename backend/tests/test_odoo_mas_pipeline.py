from __future__ import annotations

import pytest

from ghostdash_api.odoo_mas.assembler import build_metric_pack
from ghostdash_api.odoo_mas.composer import compose_board_markdown
from ghostdash_api.odoo_mas.contracts import MetricPack, MetricRow, NormalizedReport, NormalizedReportLine, PeriodScope, SourceExecutionRequest
from ghostdash_api.odoo_mas.extractors import execute_source_request
from ghostdash_api.odoo_mas.normalizers import normalize_source_result
from ghostdash_api.odoo_mas.pipeline import run_odoo_mas_pipeline
from ghostdash_api.odoo_mas.planner import build_source_plan
from ghostdash_api.odoo_mas.reasoner import reason_about_metric_pack
from ghostdash_api.odoo_mas.router import route_intent


def test_router_blocks_net_semantics() -> None:
    intent = route_intent("Give me revenue, cogs, gp and NET for Burleigh in March.")
    assert "net_definition_required" in intent.ambiguities
    assert intent.period.date_from.endswith("-03-01")


def test_router_honors_explicit_iso_date_range() -> None:
    intent = route_intent(
        "Using Odoo only, show GP for Brisbane from 2025-07-01 to 2026-03-31 with monthly values and total."
    )
    assert intent.period.date_from == "2025-07-01"
    # date_to is modeled as exclusive upper bound
    assert intent.period.date_to == "2026-04-01"
    assert intent.granularity == "monthly"


def test_router_honors_named_date_range() -> None:
    intent = route_intent(
        "Show gross profit for Brisbane from 1 July 2025 through March 2026."
    )
    assert intent.period.date_from == "2025-07-01"
    assert intent.period.date_to == "2026-04-01"


def test_router_extracts_opex_ledger_terms_for_marketing_cost_query() -> None:
    intent = route_intent('Search OPEX ledger for "google" marketing costs in Brisbane from 2025-07-01 to 2025-09-30.')
    assert "opex_total" in intent.metrics
    assert "marketing_costs" in intent.metrics
    assert "ledger_terms" in intent.dimensions
    assert "google" in intent.dimensions["ledger_terms"]


def test_router_supports_fiscal_year_tokens() -> None:
    intent = route_intent("Show GP for Brisbane for FY25.")
    assert intent.period.date_from == "2024-07-01"
    assert intent.period.date_to == "2025-07-01"


def test_router_handles_repeated_letter_typos_in_monthly_requests() -> None:
    intent = route_intent("show gpp for brissbane monnthly from 2025-07-01 to 2025-09-30")
    assert "gross_profit" in intent.metrics
    assert intent.granularity == "monthly"
    assert intent.period.date_from == "2025-07-01"
    assert intent.period.date_to == "2025-10-01"


def test_metric_pack_and_composer_output() -> None:
    report = NormalizedReport(
        report_key="profit_and_loss",
        dimension_scope={"business_unit": "Ride Electric Burleigh"},
        period=PeriodScope(date_from="2026-03-01", date_to="2026-04-01"),
        lines=[
            NormalizedReportLine(code="revenue", label="Revenue", section="income", value=1000.0),
            NormalizedReportLine(code="cogs", label="COGS", section="expense", value=700.0),
            NormalizedReportLine(code="gross_profit", label="Gross Profit", section="profitability", value=300.0),
            NormalizedReportLine(code="net_profit", label="Net Profit", section="profitability", value=120.0),
            NormalizedReportLine(code="ad_spend", label="Ad Spend", section="marketing", value=100.0),
            NormalizedReportLine(code="roas", label="ROAS", section="marketing", value=10.0),
        ],
        metadata={
            "monthly_rows": [
                {
                    "business_unit": "Ride Electric Burleigh",
                    "month": "2026-03",
                    "revenue": 1000.0,
                    "cogs": 700.0,
                    "gross_profit": 300.0,
                    "gross_margin_pct": 0.3,
                }
            ],
            "ledger_rows": [
                {
                    "business_unit": "Ride Electric Burleigh",
                    "month": "2026-03",
                    "account": "Marketing - Google Ads",
                    "account_class": "marketing_direct",
                    "amount": 450.0,
                    "matches_query_terms": True,
                }
            ],
        },
    )
    metric_pack = build_metric_pack([report])
    reasoning = reason_about_metric_pack(metric_pack, net_blocked=False)
    output = compose_board_markdown(metric_pack, reasoning)

    assert metric_pack.rows[0].gross_profit == 300.0
    assert reasoning.winner is None
    assert reasoning.headline == "Financial evidence compiled for period 2026-03."
    assert "## KPI Table" in output
    assert "## Monthly Breakdown" in output
    assert "## Supporting Ledger Evidence" in output
    assert "Ride Electric Burleigh" in output
    assert "Top performer (gross profit):" not in output


def test_reasoner_and_composer_show_top_performer_only_for_true_comparison() -> None:
    report_a = NormalizedReport(
        report_key="profit_and_loss",
        dimension_scope={"business_unit": "Ride Electric Brisbane"},
        period=PeriodScope(date_from="2026-03-01", date_to="2026-04-01"),
        lines=[
            NormalizedReportLine(code="revenue", label="Revenue", section="income", value=2000.0),
            NormalizedReportLine(code="cogs", label="COGS", section="expense", value=1200.0),
            NormalizedReportLine(code="gross_profit", label="Gross Profit", section="profitability", value=800.0),
        ],
        metadata={},
    )
    report_b = NormalizedReport(
        report_key="profit_and_loss",
        dimension_scope={"business_unit": "Ride Electric Burleigh"},
        period=PeriodScope(date_from="2026-03-01", date_to="2026-04-01"),
        lines=[
            NormalizedReportLine(code="revenue", label="Revenue", section="income", value=1500.0),
            NormalizedReportLine(code="cogs", label="COGS", section="expense", value=900.0),
            NormalizedReportLine(code="gross_profit", label="Gross Profit", section="profitability", value=600.0),
        ],
        metadata={},
    )
    metric_pack = build_metric_pack([report_a, report_b])
    reasoning = reason_about_metric_pack(metric_pack, net_blocked=False)
    output = compose_board_markdown(metric_pack, reasoning)

    assert reasoning.winner == "Ride Electric Brisbane"
    assert reasoning.headline == "Comparison complete for period 2026-03."
    assert "Top performer (gross profit): Ride Electric Brisbane" in output


def test_reasoner_and_composer_show_efficiency_winner_when_gp_roas_differs() -> None:
    metric_pack = MetricPack(
        period="2026-03",
        rows=[
            MetricRow(
                business_unit="Ride Electric Brisbane",
                revenue=1000.0,
                cogs=600.0,
                gross_profit=400.0,
                marketing_cost_total=100.0,
                revenue_roas=10.0,
                gp_roas=4.0,
                contribution_margin=300.0,
            ),
            MetricRow(
                business_unit="Ride Electric Burleigh",
                revenue=1500.0,
                cogs=900.0,
                gross_profit=600.0,
                marketing_cost_total=250.0,
                revenue_roas=6.0,
                gp_roas=2.4,
                contribution_margin=350.0,
            ),
        ],
    )
    reasoning = reason_about_metric_pack(metric_pack, net_blocked=False)
    output = compose_board_markdown(metric_pack, reasoning)

    assert reasoning.winner == "Ride Electric Burleigh"
    assert reasoning.efficiency_winner == "Ride Electric Brisbane"
    assert "Top performer (gross profit): Ride Electric Burleigh" in output
    assert "Top performer (efficiency / GP ROAS): Ride Electric Brisbane" in output


def test_planner_uses_monthly_margin_comparison_for_monthly_gp_requests() -> None:
    intent = route_intent("Show GP for Brisbane from 2025-07-01 to 2026-03-31 by month.")
    plan = build_source_plan(intent)
    assert plan.sources
    first = plan.sources[0]
    assert first.source_key == "profit_and_loss_monthly_margin_comparison"
    assert first.params["date_from"] == "2025-07-01"
    assert first.params["date_to"] == "2026-04-01"
    assert first.params["months"] == 9


def test_planner_adds_dynamic_opex_ledger_source_for_marketing_cost_questions() -> None:
    intent = route_intent('Search OPEX ledger for "meta" and "google" marketing costs in Brisbane for FY25.')
    plan = build_source_plan(intent)
    opex_sources = [item for item in plan.sources if item.source_key == "opex_ledger_search"]
    assert opex_sources
    # Metric requests must not run on ledger-only primary plans.
    assert any(item.source_key == "profit_and_loss" for item in plan.sources)
    opex = opex_sources[0]
    assert opex.params["date_from"] == "2024-07-01"
    assert opex.params["date_to"] == "2025-07-01"
    assert opex.params["company_scope_lock"] == "single_exact"
    assert opex.params["company_name_terms"] == ["Ride Electric Retail"]
    assert "Ride Electric Brisbane" in list(opex.params.get("requested_business_units") or [])


def test_opex_extractor_uses_odoo_accounting_report_engine(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_execute_tool_operation(_session, _connection, *, operation, payload, **_kwargs):
        captured["operation"] = operation
        captured["payload"] = payload

        class _Result:
            success = True
            message = "ok"
            data = {
                "account_rows": [
                    {
                        "account_id": 518,
                        "account_code": "518",
                        "account_name": "Marketing - Advertising - Google",
                        "normalized_amount": 120.0,
                    }
                ]
            }

        return _Result()

    monkeypatch.setattr("ghostdash_api.odoo_mas.extractors.execute_tool_operation", fake_execute_tool_operation)
    request = route_intent("show marketing costs for brisbane in march 2026")
    plan = build_source_plan(request)
    opex = next(source for source in plan.sources if source.source_key == "opex_ledger_search")
    result = execute_source_request(None, opex)
    assert captured["operation"] == "odoo.finance.pnl.period_summary"
    assert result["data"]["evidence_source_mode"] == "odoo_accounting_report_engine"
    assert result["data"]["rows"][0]["account_id"][1].startswith("518 Marketing - Advertising - Google")
    assert "marketing_cost_total" in opex.purpose


def test_opex_extractor_centralized_mode_forces_primary_entity_scope(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_execute_tool_operation(_session, _connection, *, operation, payload, **_kwargs):
        captured["operation"] = operation
        captured["payload"] = payload

        class _Result:
            success = True
            message = "ok"
            data = {"account_rows": []}

        return _Result()

    monkeypatch.setattr("ghostdash_api.odoo_mas.extractors.execute_tool_operation", fake_execute_tool_operation)
    request = SourceExecutionRequest(
        source_key="opex_ledger_search",
        system="odoo",
        purpose=["marketing_costs", "marketing_cost_total"],
        params={
            "date_from": "2026-03-01",
            "date_to": "2026-04-01",
            "company_name_terms": ["Ride Electric Brisbane"],
            "requested_business_units": ["Ride Electric Brisbane"],
            "centralized_marketing_source_entity": "Ride Electric Retail",
        },
    )
    execute_source_request(None, request)
    payload = dict(captured["payload"] or {})
    assert payload["company_name_terms"] == ["Ride Electric Retail"]
    assert "Ride Electric Brisbane" not in list(payload.get("company_name_terms") or [])
    assert payload["company_scope_lock"] == "single_exact"


def test_normalizer_marks_advertising_rows_as_marketing_when_query_requests_marketing() -> None:
    report = normalize_source_result(
        "opex_ledger_search",
        {
            "data": {
                "date_from": "2025-07-01",
                "date_to": "2025-10-01",
                "company_name_terms": ["Ride Electric Brisbane"],
                "ledger_terms": ["marketing"],
                "rows": [
                    {"account_id": [530, "530 Marketing Expenses"], "date:month": "2025-08-01", "balance": 102.68},
                    {"account_id": [449, "Rent"], "date:month": "2025-08-01", "balance": 9469.69},
                ],
            }
        },
    )
    ledger_rows = list(report.metadata.get("ledger_rows") or [])
    assert any(str(item.get("account_class") or "") == "marketing_direct" for item in ledger_rows)


def test_normalizer_marks_policy_account_code_as_marketing_without_query_term_match() -> None:
    report = normalize_source_result(
        "opex_ledger_search",
        {
            "data": {
                "date_from": "2026-03-01",
                "date_to": "2026-04-01",
                "company_name_terms": ["Ride Electric Retail"],
                "ledger_terms": [],
                "marketing_account_codes": [518],
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising - Google"], "date:month": "2026-03-01", "balance": 355744.97},
                ],
            }
        },
    )
    ledger_rows = list(report.metadata.get("ledger_rows") or [])
    assert ledger_rows
    assert ledger_rows[0]["month"] == "2026-03"
    assert ledger_rows[0]["account_class"] == "marketing_direct"
    assert ledger_rows[0]["include_in_metric"] is True


def test_metric_assembly_excludes_merchant_fees_and_marketing_wages_by_default() -> None:
    report = NormalizedReport(
        report_key="opex_ledger_search",
        dimension_scope={"business_unit": "Ride Electric Retail"},
        period=PeriodScope(date_from="2026-03-01", date_to="2026-04-01"),
        lines=[
            NormalizedReportLine(code="revenue", label="Revenue", section="income", value=1000.0),
        ],
        metadata={
            "ledger_rows": [
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "518 Marketing - Advertising - Google",
                    "account_code": 518,
                    "account_class": "marketing_direct",
                    "include_in_metric": True,
                    "amount": -300.0,
                    "matches_query_terms": True,
                },
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "523 Marketing - Merchant Fees - Bunnings",
                    "account_code": 523,
                    "account_class": "merchant_fees",
                    "include_in_metric": False,
                    "amount": -90.0,
                    "matches_query_terms": True,
                },
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "510 Marketing - Wages",
                    "account_code": 510,
                    "account_class": "marketing_wages",
                    "include_in_metric": False,
                    "amount": -120.0,
                    "matches_query_terms": True,
                },
            ]
        },
    )

    metric_pack = build_metric_pack([report])

    assert metric_pack.rows
    assert metric_pack.rows[0].ad_spend == 300.0
    assert metric_pack.rows[0].roas == pytest.approx(1000.0 / 300.0)
    assert metric_pack.ledger_rows[0].amount == 300.0
    assert metric_pack.ledger_rows[0].include_in_metric is True
    assert metric_pack.ledger_rows[1].include_in_metric is False
    assert metric_pack.ledger_rows[2].include_in_metric is False


def test_metric_assembly_honors_explicit_policy_overrides_for_marketing_spend() -> None:
    report = NormalizedReport(
        report_key="opex_ledger_search",
        dimension_scope={"business_unit": "Ride Electric Retail"},
        period=PeriodScope(date_from="2026-03-01", date_to="2026-04-01"),
        lines=[
            NormalizedReportLine(code="revenue", label="Revenue", section="income", value=1000.0),
        ],
        metadata={
            "policy_overrides": {
                "include_merchant_fees_in_marketing": True,
                "include_marketing_wages_in_marketing": True,
            },
            "ledger_rows": [
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "518 Marketing - Advertising - Google",
                    "account_code": 518,
                    "account_class": "marketing_direct",
                    "include_in_metric": True,
                    "amount": -300.0,
                    "matches_query_terms": True,
                },
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "523 Marketing - Merchant Fees - Bunnings",
                    "account_code": 523,
                    "account_class": "merchant_fees",
                    "include_in_metric": False,
                    "amount": -90.0,
                    "matches_query_terms": True,
                },
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "510 Marketing - Wages",
                    "account_code": 510,
                    "account_class": "marketing_wages",
                    "include_in_metric": False,
                    "amount": -120.0,
                    "matches_query_terms": True,
                },
            ],
        },
    )

    metric_pack = build_metric_pack([report])

    assert metric_pack.rows
    assert metric_pack.rows[0].ad_spend == 300.0
    assert metric_pack.rows[0].roas == pytest.approx(1000.0 / 300.0)
    assert metric_pack.ledger_rows[0].include_in_metric is True
    assert metric_pack.ledger_rows[1].include_in_metric is False
    assert metric_pack.ledger_rows[2].include_in_metric is False


def test_metric_assembly_excludes_misclassified_shopify_fees_from_marketing_direct() -> None:
    report = NormalizedReport(
        report_key="opex_ledger_search",
        dimension_scope={"business_unit": "Ride Electric Retail"},
        period=PeriodScope(date_from="2026-03-01", date_to="2026-04-01"),
        lines=[
            NormalizedReportLine(code="revenue", label="Revenue", section="income", value=1000.0),
        ],
        metadata={
            "ledger_rows": [
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "518 Marketing - Advertising",
                    "account_code": 518,
                    "account_class": "marketing_direct",
                    "include_in_metric": True,
                    "amount": -300.0,
                },
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "526 Shopify Fees",
                    "account_code": 526,
                    "account_class": "marketing_direct",
                    "include_in_metric": True,
                    "amount": -80.0,
                },
            ]
        },
    )

    metric_pack = build_metric_pack([report])
    assert metric_pack.rows
    assert metric_pack.rows[0].marketing_cost_total == 300.0
    misclassified = next(row for row in metric_pack.ledger_rows if row.account == "526 Shopify Fees")
    assert misclassified.include_in_metric is False


def test_normalizer_classifies_marketing_rows_without_query_term_matching() -> None:
    report = normalize_source_result(
        "opex_ledger_search",
        {
            "data": {
                "date_from": "2026-03-01",
                "date_to": "2026-04-01",
                "company_name_terms": ["Ride Electric Retail"],
                "ledger_terms": [],
                "marketing_account_codes": [],
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising - Google"], "date:month": "2026-03-01", "balance": -123.0},
                ],
            }
        },
    )
    ledger_rows = list(report.metadata.get("ledger_rows") or [])
    assert ledger_rows
    assert ledger_rows[0]["account_class"] == "marketing_direct"
    assert ledger_rows[0]["include_in_metric"] is True
    marketing_line = next((line for line in report.lines if line.code == "marketing_costs"), None)
    assert marketing_line is not None
    assert marketing_line.value == pytest.approx(-123.0)


def test_normalizer_classifies_526_shopify_fees_as_merchant_fees() -> None:
    report = normalize_source_result(
        "opex_ledger_search",
        {
            "data": {
                "date_from": "2026-03-01",
                "date_to": "2026-04-01",
                "company_name_terms": ["Ride Electric Retail"],
                "rows": [
                    {"account_id": [526, "526 Shopify Fees"], "date:month": "2026-03-01", "balance": -3923.12},
                ],
            }
        },
    )
    ledger_rows = list(report.metadata.get("ledger_rows") or [])
    assert ledger_rows
    assert ledger_rows[0]["account_class"] == "merchant_fees"
    assert ledger_rows[0]["include_in_metric"] is False


def test_pipeline_blocks_finance_composition_when_metric_pack_missing(monkeypatch) -> None:
    monkeypatch.setattr(
        "ghostdash_api.odoo_mas.pipeline.execute_source_request",
        lambda *_args, **_kwargs: {"success": False, "error": "upstream unavailable"},
    )
    result = run_odoo_mas_pipeline(None, message="Using Odoo only, show revenue for Brisbane in March 2026.")
    assert result["success"] is False
    assert result["status"] == "blocked"
    assert result["reason"] == "metric_missing"


def test_pipeline_blocks_when_marketing_primary_metric_missing(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": "2026-03-01",
                    "date_to": "2026-04-01",
                    "rows": [{"revenue": 1000.0, "cogs": 700.0, "gp": 300.0}],
                },
            }
        return {"success": False, "error": "ledger unavailable"}

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)
    result = run_odoo_mas_pipeline(None, message="Using Odoo only, show marketing costs for Brisbane in March 2026.")
    assert result["success"] is False
    assert result["status"] == "blocked"
    assert result["reason"] == "metric_missing"


def test_assembler_filters_ledger_evidence_to_marketing_classes_only() -> None:
    report = NormalizedReport(
        report_key="opex_ledger_search",
        dimension_scope={"business_unit": "Ride Electric Retail"},
        period=PeriodScope(date_from="2026-03-01", date_to="2026-04-01"),
        lines=[NormalizedReportLine(code="revenue", label="Revenue", section="income", value=1000.0)],
        metadata={
            "ledger_rows": [
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "518 Marketing - Advertising - Google",
                    "account_code": 518,
                    "account_class": "marketing_direct",
                    "amount": -300.0,
                },
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "305 COGS - Parts",
                    "account_code": 305,
                    "account_class": "cogs",
                    "amount": -250.0,
                },
            ]
        },
    )
    metric_pack = build_metric_pack([report])
    assert len(metric_pack.ledger_rows) == 1
    assert metric_pack.ledger_rows[0].account_class == "marketing_direct"


def test_contract_mechanic_520_not_included_in_marketing_cost() -> None:
    report = normalize_source_result(
        "opex_ledger_search",
        {
            "data": {
                "date_from": "2026-03-01",
                "date_to": "2026-04-01",
                "company_name_terms": ["Ride Electric Retail"],
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising - Google"], "date:month": "2026-03-01", "balance": -200.0},
                    {"account_id": [520, "520 Contract Mechanic"], "date:month": "2026-03-01", "balance": -900.0},
                ],
            }
        },
    )
    ledger_rows = list(report.metadata.get("ledger_rows") or [])
    mechanic = next(item for item in ledger_rows if int(item.get("account_code") or 0) == 520)
    assert mechanic["account_class"] == "workshop_cost"
    metric_pack = build_metric_pack([report])
    assert metric_pack.rows
    assert metric_pack.rows[0].marketing_cost_total == pytest.approx(200.0)
    assert all("contract mechanic" not in row.account.casefold() for row in metric_pack.ledger_rows)


def test_only_approved_marketing_classes_contribute_to_marketing_cost() -> None:
    report = normalize_source_result(
        "opex_ledger_search",
        {
            "data": {
                "date_from": "2026-03-01",
                "date_to": "2026-04-01",
                "company_name_terms": ["Ride Electric Retail"],
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising - Google"], "date:month": "2026-03-01", "balance": -200.0},
                    {"account_id": [523, "523 Marketing - Merchant Fees - Bunnings"], "date:month": "2026-03-01", "balance": -90.0},
                    {"account_id": [510, "510 Marketing - Wages"], "date:month": "2026-03-01", "balance": -120.0},
                    {"account_id": [305, "305 COGS - Parts"], "date:month": "2026-03-01", "balance": -400.0},
                    {"account_id": [520, "520 Contract Mechanic"], "date:month": "2026-03-01", "balance": -800.0},
                ],
            }
        },
    )
    metric_pack = build_metric_pack([report])
    assert metric_pack.rows
    # Default policy includes direct marketing only.
    assert metric_pack.rows[0].marketing_cost_total == pytest.approx(200.0)
    assert all(row.account_class in {"marketing_direct", "merchant_fees", "marketing_wages", "business_advisor"} for row in metric_pack.ledger_rows)


def test_business_unit_labels_are_canonicalized_to_single_row() -> None:
    report_lower = NormalizedReport(
        report_key="profit_and_loss",
        dimension_scope={"business_unit": "ride electric brisbane"},
        period=PeriodScope(date_from="2026-03-01", date_to="2026-04-01"),
        lines=[NormalizedReportLine(code="revenue", label="Revenue", section="income", value=1200.0)],
        metadata={},
    )
    report_title = NormalizedReport(
        report_key="opex_ledger_search",
        dimension_scope={"business_unit": "Ride Electric Brisbane"},
        period=PeriodScope(date_from="2026-03-01", date_to="2026-04-01"),
        lines=[NormalizedReportLine(code="marketing_costs", label="Marketing Costs", section="marketing", value=-200.0)],
        metadata={
            "ledger_rows": [
                {
                    "business_unit": "ride electric brisbane",
                    "month": "2026-03",
                    "account": "518 Marketing - Advertising - Google",
                    "account_code": 518,
                    "account_class": "marketing_direct",
                    "amount": -200.0,
                }
            ]
        },
    )
    metric_pack = build_metric_pack([report_lower, report_title])
    assert len(metric_pack.rows) == 1
    assert metric_pack.rows[0].business_unit == "Ride Electric Brisbane"
    assert metric_pack.rows[0].marketing_cost_total == pytest.approx(200.0)


def test_composer_removes_generic_kpi_for_marketing_single_metric() -> None:
    report = NormalizedReport(
        report_key="opex_ledger_search",
        dimension_scope={"business_unit": "Ride Electric Retail"},
        period=PeriodScope(date_from="2026-03-01", date_to="2026-04-01"),
        lines=[NormalizedReportLine(code="marketing_costs", label="Marketing Costs", section="marketing", value=-300.0)],
        metadata={
            "ledger_rows": [
                {
                    "business_unit": "Ride Electric Retail",
                    "month": "2026-03",
                    "account": "518 Marketing - Advertising - Google",
                    "account_code": 518,
                    "account_class": "marketing_direct",
                    "amount": -300.0,
                }
            ]
        },
    )
    metric_pack = build_metric_pack([report])
    reasoning = reason_about_metric_pack(metric_pack, net_blocked=False)
    output = compose_board_markdown(metric_pack, reasoning, requested_metrics=["marketing_costs"])
    assert "## KPI Table" not in output
    assert "## Marketing Cost Total" in output
    assert "## Findings" not in output


def test_marketing_query_for_brisbane_uses_centralized_retail_total(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": "2026-03-01",
                    "date_to": "2026-04-01",
                    "company_name_terms": ["Ride Electric Brisbane"],
                    "rows": [{"revenue": 1000.0, "cogs": 700.0, "gp": 300.0},
                    ],
                },
            }
        if source.source_key == "opex_ledger_search":
            assert source.params.get("company_name_terms") == ["Ride Electric Retail"]
            return {
                "success": True,
                "data": {
                    "date_from": "2026-03-01",
                    "date_to": "2026-04-01",
                    "company_name_terms": ["Ride Electric Retail"],
                        "requested_business_units": ["Ride Electric Brisbane"],
                    "rows": [
                        {"account_id": [518, "518 Marketing - Advertising - Google"], "date:month": "2026-03-01", "balance": -200.0},
                            {"account_id": [520, "520 Marketing - Advertising - Klaviyo"], "date:month": "2026-03-01", "balance": 0.0},
                            {"account_id": [522, "522 Marketing - Advertising - Meta"], "date:month": "2026-03-01", "balance": 0.0},
                            {"account_id": [524, "524 Marketing - Advertising - Billboards"], "date:month": "2026-03-01", "balance": 0.0},
                            {"account_id": [526, "526 Marketing - Advertising - Other"], "date:month": "2026-03-01", "balance": 0.0},
                            {"account_id": [527, "527 Marketing - Advertising - Aws"], "date:month": "2026-03-01", "balance": 0.0},
                            {"account_id": [528, "528 Marketing - Graphic Design"], "date:month": "2026-03-01", "balance": 0.0},
                            {"account_id": [536, "536 Marketing - Commission Factory"], "date:month": "2026-03-01", "balance": 0.0},
                        {"account_id": [520, "520 Contract Mechanic"], "date:month": "2026-03-01", "balance": -900.0},
                    ],
                },
            }
        return {"success": False, "error": "unexpected source"}

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)
    result = run_odoo_mas_pipeline(None, message="Using Odoo only, show marketing costs for Brisbane in March 2026 and include ledger lines")
    assert result["success"] is True
    row = result["metric_pack"]["rows"][0]
    assert row["business_unit"] == "Ride Electric Brisbane"
    assert row["marketing_cost_total"] == pytest.approx(200.0)
    note = str(result.get("centralized_marketing_note") or "")
    assert "requested entity = Ride Electric Brisbane" in note
    assert "source posting entity = Ride Electric Retail" in note
    p2 = result.get("phase2")
    assert isinstance(p2, dict) and p2.get("version") == 1
    assert p2.get("variance_pack") is None
    r0 = p2.get("resolved_metrics", [{}])[0]
    assert r0.get("centralized_roas") is not None
    assert "Finance intelligence (Phase 2" in str(result.get("markdown") or "")


def test_centralized_roas_query_fetches_retail_marketing_for_branch_revenue(monkeypatch) -> None:
    seen_ledger_sources: list[list[str]] = []

    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            terms = list(source.params.get("company_name_terms") or [])
            if terms == ["Ride Electric Brisbane"]:
                revenue = 800.0
            elif terms == ["Ride Electric Burleigh"]:
                revenue = 1200.0
            else:
                revenue = 0.0
            return {
                "success": True,
                "data": {
                    "date_from": "2026-03-01",
                    "date_to": "2026-04-01",
                    "company_name_terms": terms,
                    "rows": [{"revenue": revenue, "cogs": revenue / 2.0, "gp": revenue / 2.0}],
                },
            }
        if source.source_key == "opex_ledger_search":
            seen_ledger_sources.append(list(source.params.get("company_name_terms") or []))
            assert source.params.get("company_name_terms") == ["Ride Electric Retail"]
            assert source.params.get("requested_business_units") == [
                "Ride Electric Brisbane",
                "Ride Electric Burleigh",
            ]
            return {
                "success": True,
                "data": {
                    "date_from": "2026-03-01",
                    "date_to": "2026-04-01",
                    "company_name_terms": ["Ride Electric Retail"],
                    "requested_business_units": [
                        "Ride Electric Brisbane",
                        "Ride Electric Burleigh",
                    ],
                    "rows": [
                        {"account_id": [518, "518 Marketing - Advertising - Google"], "date:month": "2026-03-01", "balance": -200.0},
                        {"account_id": [520, "520 Klaviyo"], "date:month": "2026-03-01", "balance": 0.0},
                        {"account_id": [522, "522 Facebook"], "date:month": "2026-03-01", "balance": 0.0},
                        {"account_id": [524, "524 Marketing - Advertising - Billboards"], "date:month": "2026-03-01", "balance": 0.0},
                        {"account_id": [526, "526 Marketing - Advertising - Other"], "date:month": "2026-03-01", "balance": 0.0},
                        {"account_id": [527, "527 Marketing - Advertising - AWS"], "date:month": "2026-03-01", "balance": 0.0},
                        {"account_id": [528, "528 Marketing - Graphic Design"], "date:month": "2026-03-01", "balance": 0.0},
                        {"account_id": [536, "536 Marketing - Commission Factory"], "date:month": "2026-03-01", "balance": 0.0},
                    ],
                },
            }
        return {"success": False, "error": "unexpected source"}

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)

    result = run_odoo_mas_pipeline(
        None,
        message="Using Odoo only, show ROAS for Brisbane and Burleigh in March 2026 using centralized marketing.",
    )

    assert result["success"] is True
    assert seen_ledger_sources == [["Ride Electric Retail"]]
    rows = {row["business_unit"]: row for row in result["phase2"]["resolved_metrics"]}
    assert rows["Ride Electric Brisbane"]["allocated_marketing_cost"] == pytest.approx(80.0)
    assert rows["Ride Electric Burleigh"]["allocated_marketing_cost"] == pytest.approx(120.0)
    assert rows["Ride Electric Brisbane"]["revenue_roas"] == pytest.approx(10.0)
    assert rows["Ride Electric Burleigh"]["revenue_roas"] == pytest.approx(10.0)
    assert rows["Ride Electric Brisbane"]["gp_roas"] == pytest.approx(5.0)
    assert rows["Ride Electric Burleigh"]["gp_roas"] == pytest.approx(5.0)
    assert rows["Ride Electric Brisbane"]["allocation_method"] == "revenue_weighted"
    assert sum(float(row["allocated_marketing_cost"]) for row in rows.values()) == pytest.approx(200.0)
    assert "Finance intelligence (Phase 2" in str(result.get("markdown") or "")
    rendered_rows = {row["business_unit"]: row for row in result["metric_pack"]["rows"]}
    assert rendered_rows["Ride Electric Brisbane"]["marketing_cost_total"] == pytest.approx(80.0)
    assert rendered_rows["Ride Electric Burleigh"]["marketing_cost_total"] == pytest.approx(120.0)
    assert rendered_rows["Ride Electric Brisbane"]["roas"] == pytest.approx(10.0)
    assert rendered_rows["Ride Electric Brisbane"]["revenue_roas"] == pytest.approx(10.0)
    assert rendered_rows["Ride Electric Brisbane"]["gp_roas"] == pytest.approx(5.0)
    assert rendered_rows["Ride Electric Brisbane"]["contribution_margin"] == pytest.approx(320.0)
    assert rendered_rows["Ride Electric Burleigh"]["contribution_margin"] == pytest.approx(480.0)
    caveats = set(result["reasoning"]["caveats"])
    assert "roas_unavailable" not in caveats
    assert "roas_status:unavailable" not in caveats
    assert not any(str(caveat).endswith(":roas:missing_value") for caveat in caveats)
    markdown = str(result.get("markdown") or "")
    assert "| Business Unit | Revenue | COGS | Gross Profit | Allocated Marketing | Revenue ROAS | GP ROAS | Contribution Margin |" in markdown
    assert "Top performer (gross profit): Ride Electric Burleigh" in markdown
    assert "Top performer (efficiency / GP ROAS):" not in markdown


def test_526_shopify_fees_is_excluded_from_centralized_marketing_total(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": "2026-03-01",
                    "date_to": "2026-04-01",
                    "company_name_terms": ["Ride Electric Brisbane"],
                    "rows": [{"revenue": 1000.0, "cogs": 700.0, "gp": 300.0}],
                },
            }
        return {
            "success": True,
            "data": {
                "date_from": "2026-03-01",
                "date_to": "2026-04-01",
                "company_name_terms": ["Ride Electric Retail"],
                "requested_business_units": ["Ride Electric Brisbane"],
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising"], "date:month": "2026-03-01", "balance": -100.0},
                    {"account_id": [520, "520 Klaviyo"], "date:month": "2026-03-01", "balance": -30.0},
                    {"account_id": [522, "522 Facebook"], "date:month": "2026-03-01", "balance": -50.0},
                    {"account_id": [524, "524 Marketing - Advertising - Billboards"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [526, "526 Shopify Fees"], "date:month": "2026-03-01", "balance": -40.0},
                    {"account_id": [526, "526 Marketing - Advertising - Other"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [527, "527 Marketing - Advertising - AWS"], "date:month": "2026-03-01", "balance": -20.0},
                    {"account_id": [528, "528 Marketing - Graphic Design"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [536, "536 Marketing - Commission Factory"], "date:month": "2026-03-01", "balance": 0.0},
                ],
            },
        }

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)
    result = run_odoo_mas_pipeline(None, message="Using Odoo only, show marketing costs for Brisbane in March 2026.")
    assert result["success"] is True
    row = result["metric_pack"]["rows"][0]
    # 526 Shopify Fees must be excluded from marketing_direct metric sum.
    assert row["marketing_cost_total"] == pytest.approx(200.0)
    ledger_rows = list(result["metric_pack"]["ledger_rows"])
    shopify = next(item for item in ledger_rows if str(item.get("account") or "").startswith("526 "))
    assert shopify["account_class"] == "merchant_fees"
    assert shopify["include_in_metric"] is False


def test_marketing_cost_includes_google_meta_klaviyo_for_march(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": "2026-03-01",
                    "date_to": "2026-04-01",
                    "company_name_terms": ["Ride Electric Brisbane"],
                    "rows": [{"revenue": 1000.0, "cogs": 700.0, "gp": 300.0}],
                },
            }
        return {
            "success": True,
            "data": {
                "date_from": "2026-03-01",
                "date_to": "2026-04-01",
                "company_name_terms": ["Ride Electric Retail"],
                "requested_business_units": ["Ride Electric Brisbane"],
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising - Google"], "date:month": "2026-03-01", "balance": -120.0},
                    {"account_id": [520, "520 Marketing - Advertising - Klaviyo"], "date:month": "2026-03-01", "balance": -30.0},
                    {"account_id": [522, "522 Marketing - Advertising - Meta"], "date:month": "2026-03-01", "balance": -50.0},
                    {"account_id": [524, "524 Marketing - Advertising - Billboards"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [526, "526 Marketing - Advertising - Other"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [527, "527 Marketing - Advertising - Aws"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [528, "528 Marketing - Graphic Design"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [536, "536 Marketing - Commission Factory"], "date:month": "2026-03-01", "balance": 0.0},
                ],
            },
        }

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)
    result = run_odoo_mas_pipeline(None, message="Using Odoo only, show marketing costs for Brisbane in March 2026.")
    assert result["success"] is True
    row = result["metric_pack"]["rows"][0]
    assert row["marketing_cost_total"] == pytest.approx(200.0)


def test_marketing_cost_unknown_required_account_still_blocks(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": "2026-03-01",
                    "date_to": "2026-04-01",
                    "company_name_terms": ["Ride Electric Brisbane"],
                    "rows": [{"revenue": 1000.0, "cogs": 700.0, "gp": 300.0}],
                },
            }
        return {
            "success": True,
            "data": {
                "date_from": "2026-03-01",
                "date_to": "2026-04-01",
                "company_name_terms": ["Ride Electric Retail"],
                "requested_business_units": ["Ride Electric Brisbane"],
                "policy_overrides": {"required_marketing_accounts": ["999 Unknown Required Account"]},
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising - Google"], "date:month": "2026-03-01", "balance": -120.0},
                    {"account_id": [520, "520 Marketing - Advertising - Klaviyo"], "date:month": "2026-03-01", "balance": -30.0},
                    {"account_id": [522, "522 Marketing - Advertising - Meta"], "date:month": "2026-03-01", "balance": -50.0},
                    {"account_id": [524, "524 Marketing - Advertising - Billboards"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [526, "526 Shopify Fees"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [527, "527 Marketing - Advertising - Aws"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [528, "528 Marketing - Graphic Design"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [536, "536 Marketing - Commission Factory"], "date:month": "2026-03-01", "balance": 0.0},
                ],
            },
        }

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)
    result = run_odoo_mas_pipeline(None, message="Using Odoo only, show marketing costs for Brisbane in March 2026.")
    assert result["success"] is False
    assert result["status"] == "blocked"
    assert result["reason"] == "metric_missing"


def test_january_retail_marketing_does_not_block_when_528_536_inactive(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": "2026-01-01",
                    "date_to": "2026-02-01",
                    "company_name_terms": ["Ride Electric Retail"],
                    "rows": [{"revenue": 900.0, "cogs": 500.0, "gp": 400.0}],
                },
            }
        return {
            "success": True,
            "data": {
                "date_from": "2026-01-01",
                "date_to": "2026-02-01",
                "company_name_terms": ["Ride Electric Retail"],
                "requested_business_units": ["Ride Electric Retail"],
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising"], "date:month": "2026-01-01", "balance": -100.0},
                    {"account_id": [520, "520 Klaviyo"], "date:month": "2026-01-01", "balance": -30.0},
                    {"account_id": [522, "522 Facebook"], "date:month": "2026-01-01", "balance": -50.0},
                    {"account_id": [524, "524 Marketing - Advertising - Billboards"], "date:month": "2026-01-01", "balance": -10.0},
                    {"account_id": [527, "527 Marketing - Advertising - AWS"], "date:month": "2026-01-01", "balance": -20.0},
                    # 528 and 536 intentionally absent from period activity
                ],
            },
        }

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)
    result = run_odoo_mas_pipeline(None, message="Using Odoo only, show marketing costs for Ride Electric Retail in Jan 2026 and include ledger lines.")
    assert result["success"] is True
    # Active accounts only: 100 + 30 + 50 + 10 + 20
    assert result["metric_pack"]["rows"][0]["marketing_cost_total"] == pytest.approx(210.0)


def test_inactive_configured_marketing_accounts_return_zero_with_status(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": "2026-01-01",
                    "date_to": "2026-02-01",
                    "company_name_terms": ["Ride Electric Retail"],
                    "rows": [{"revenue": 900.0, "cogs": 500.0, "gp": 400.0}],
                },
            }
        return {
            "success": True,
            "data": {
                "date_from": "2026-01-01",
                "date_to": "2026-02-01",
                "company_name_terms": ["Ride Electric Retail"],
                "requested_business_units": ["Ride Electric Retail"],
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising"], "date:month": "2026-01-01", "balance": -100.0},
                    {"account_id": [520, "520 Klaviyo"], "date:month": "2026-01-01", "balance": -30.0},
                    {"account_id": [522, "522 Facebook"], "date:month": "2026-01-01", "balance": -50.0},
                    {"account_id": [524, "524 Marketing - Advertising - Billboards"], "date:month": "2026-01-01", "balance": -10.0},
                    {"account_id": [527, "527 Marketing - Advertising - AWS"], "date:month": "2026-01-01", "balance": -20.0},
                ],
            },
        }

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)
    result = run_odoo_mas_pipeline(None, message="Using Odoo only, show marketing costs for Ride Electric Retail in Jan 2026 and include ledger lines.")
    assert result["success"] is True
    ledger_rows = list(result["metric_pack"]["ledger_rows"])
    acc_528 = next(item for item in ledger_rows if str(item.get("account") or "").startswith("528 "))
    acc_536 = next(item for item in ledger_rows if str(item.get("account") or "").startswith("536 "))
    assert acc_528["amount"] == pytest.approx(0.0)
    assert acc_536["amount"] == pytest.approx(0.0)
    assert acc_528["status"] == "no_activity_in_period"
    assert acc_536["status"] == "no_activity_in_period"


def test_marketing_coverage_uses_account_codes_not_exact_names(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": "2026-03-01",
                    "date_to": "2026-04-01",
                    "company_name_terms": ["Ride Electric Brisbane"],
                    "rows": [{"revenue": 1000.0, "cogs": 700.0, "gp": 300.0}],
                },
            }
        # Simulate Odoo account report rows where account labels differ
        # and account ids are internal DB ids, not account codes.
        return {
            "success": True,
            "data": {
                "date_from": "2026-03-01",
                "date_to": "2026-04-01",
                "company_name_terms": ["Ride Electric Retail"],
                "requested_business_units": ["Ride Electric Brisbane"],
                "rows": [
                    {"account_id": [12018, "518 Google Ads AU"], "date:month": "2026-03-01", "balance": -120.0},
                    {"account_id": [12020, "520 Klaviyo"], "date:month": "2026-03-01", "balance": -30.0},
                    {"account_id": [12022, "522 Meta Ads"], "date:month": "2026-03-01", "balance": -50.0},
                    {"account_id": [12024, "524 Billboards"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [12026, "526 Other Ads"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [12027, "527 AWS"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [12028, "528 Graphic Design"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [12036, "536 Commission Factory"], "date:month": "2026-03-01", "balance": 0.0},
                ],
            },
        }

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)
    result = run_odoo_mas_pipeline(None, message="Using Odoo only, show marketing costs for Brisbane in March 2026.")
    assert result["success"] is True
    assert result["metric_pack"]["rows"][0]["marketing_cost_total"] == pytest.approx(200.0)


def test_brisbane_marketing_query_extracts_from_retail_and_does_not_block(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": "2026-03-01",
                    "date_to": "2026-04-01",
                    "company_name_terms": ["Ride Electric Brisbane"],
                    "rows": [{"revenue": 1000.0, "cogs": 700.0, "gp": 300.0}],
                },
            }
        assert source.params.get("company_name_terms") == ["Ride Electric Retail"]
        return {
            "success": True,
            "data": {
                "date_from": "2026-03-01",
                "date_to": "2026-04-01",
                "company_name_terms": ["Ride Electric Retail"],
                "requested_business_units": ["Ride Electric Brisbane"],
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising - Google"], "date:month": "2026-03-01", "balance": -120.0},
                    {"account_id": [520, "520 Marketing - Advertising - Klaviyo"], "date:month": "2026-03-01", "balance": -30.0},
                    {"account_id": [522, "522 Marketing - Advertising - Meta"], "date:month": "2026-03-01", "balance": -50.0},
                    {"account_id": [524, "524 Marketing - Advertising - Billboards"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [526, "526 Marketing - Advertising - Other"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [527, "527 Marketing - Advertising - Aws"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [528, "528 Marketing - Graphic Design"], "date:month": "2026-03-01", "balance": 0.0},
                    {"account_id": [536, "536 Marketing - Commission Factory"], "date:month": "2026-03-01", "balance": 0.0},
                ],
            },
        }

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)
    result = run_odoo_mas_pipeline(None, message="Using Odoo only, show marketing costs for Brisbane in March 2026.")
    assert result["success"] is True
    extracted_accounts = {row["account"] for row in result["metric_pack"]["ledger_rows"]}
    assert any(account.startswith("518 ") for account in extracted_accounts)
    assert any(account.startswith("520 ") for account in extracted_accounts)
    assert any(account.startswith("522 ") for account in extracted_accounts)
    assert any(account.startswith("526 ") for account in extracted_accounts)
    assert any(account.startswith("527 ") for account in extracted_accounts)


def test_golden_january_2026_retail_marketing_cost(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": "2026-01-01",
                    "date_to": "2026-02-01",
                    "company_name_terms": ["Ride Electric Retail"],
                    "rows": [{"revenue": 1000.0, "cogs": 500.0, "gp": 500.0}],
                },
            }
        return {
            "success": True,
            "data": {
                "date_from": "2026-01-01",
                "date_to": "2026-02-01",
                "company_name_terms": ["Ride Electric Retail"],
                "requested_business_units": ["Ride Electric Retail"],
                "rows": [
                    {"account_id": [518, "518 Marketing - Advertising"], "date:month": "2026-01-01", "balance": -37149.55},
                    {"account_id": [520, "520 Klaviyo"], "date:month": "2026-01-01", "balance": -953.98},
                    {"account_id": [522, "522 Facebook"], "date:month": "2026-01-01", "balance": -6957.96},
                    {"account_id": [523, "523 Merchant Fees - Bunnings"], "date:month": "2026-01-01", "balance": -167.72},
                    {"account_id": [524, "524 Marketing - Advertising - Billboards"], "date:month": "2026-01-01", "balance": -1900.00},
                    {"account_id": [526, "526 Shopify Fees"], "date:month": "2026-01-01", "balance": -3923.12},
                    {"account_id": [527, "527 Marketing - Advertising - AWS"], "date:month": "2026-01-01", "balance": -2744.68},
                    {"account_id": [510, "510 Wages - Marketing"], "date:month": "2026-01-01", "balance": -8718.84},
                ],
            },
        }

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)
    result = run_odoo_mas_pipeline(
        None, message="Using Odoo only, show marketing costs for Ride Electric Retail in Jan 2026 and include ledger lines."
    )
    assert result["success"] is True
    row = result["metric_pack"]["rows"][0]
    # Included marketing_direct active rows only:
    # 518 + 520 + 522 + 524 + 527 = 49,706.17
    assert row["marketing_cost_total"] == pytest.approx(49706.17)

    ledger_rows = list(result["metric_pack"]["ledger_rows"])
    acc_526 = next(item for item in ledger_rows if str(item.get("account") or "").startswith("526 "))
    acc_528 = next(item for item in ledger_rows if str(item.get("account") or "").startswith("528 "))
    acc_536 = next(item for item in ledger_rows if str(item.get("account") or "").startswith("536 "))

    assert acc_526["account_class"] == "merchant_fees"
    assert acc_526["include_in_metric"] is False
    assert acc_528["amount"] == pytest.approx(0.0)
    assert acc_536["amount"] == pytest.approx(0.0)
    assert acc_528["status"] == "no_activity_in_period"
    assert acc_536["status"] == "no_activity_in_period"
