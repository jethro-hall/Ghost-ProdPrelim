from __future__ import annotations

from datetime import date

import pytest

from ghostdash_api.odoo_mas.pipeline import run_odoo_mas_pipeline
from ghostdash_api.odoo_mas.planner import build_source_plan
from ghostdash_api.odoo_mas.router import route_intent


def _marketing_total_for_month(month_start: str) -> float:
    start = date.fromisoformat(month_start)
    index = ((start.year - 2025) * 12) + (start.month - 1)
    return 100.0 + (index * 10.0)


def test_router_marks_multi_period_marketing_trend_request() -> None:
    intent = route_intent(
        "Using Odoo only, show marketing costs increase for Ride Electric Retail from Jan 2025 till April 2026"
    )
    assert intent.intent == "multi_period_metric_trend"
    assert intent.metrics == ["marketing_costs"]
    assert intent.granularity == "monthly"
    assert intent.period.date_from == "2025-01-01"
    assert intent.period.date_to == "2026-05-01"
    assert intent.output == "trend_table"
    assert intent.include_ledger_evidence is False


def test_planner_builds_monthly_marketing_requests_for_multi_period_trend() -> None:
    intent = route_intent(
        "Using Odoo only, show marketing costs increase for Ride Electric Retail from Jan 2025 till April 2026"
    )

    plan = build_source_plan(intent)

    opex_sources = [source for source in plan.sources if source.source_key == "opex_ledger_search"]
    assert len(opex_sources) == 16
    assert opex_sources[0].params["date_from"] == "2025-01-01"
    assert opex_sources[0].params["date_to"] == "2025-02-01"
    assert opex_sources[-1].params["date_from"] == "2026-04-01"
    assert opex_sources[-1].params["date_to"] == "2026-05-01"


def test_pipeline_returns_marketing_trend_table_without_ledger_dump(monkeypatch) -> None:
    def fake_execute(_session, source):
        if source.source_key == "profit_and_loss":
            return {
                "success": True,
                "data": {
                    "date_from": source.params["date_from"],
                    "date_to": source.params["date_to"],
                    "company_name_terms": list(source.params.get("company_name_terms") or []),
                    "rows": [],
                },
            }

        monthly_total = _marketing_total_for_month(str(source.params["date_from"]))
        return {
            "success": True,
            "data": {
                "date_from": source.params["date_from"],
                "date_to": source.params["date_to"],
                "company_name_terms": list(source.params.get("company_name_terms") or []),
                "requested_business_units": list(source.params.get("requested_business_units") or []),
                "rows": [
                    {
                        "account_id": [518, "518 Marketing - Advertising - Google"],
                        "balance": -monthly_total,
                        "date:month": source.params["date_from"],
                    }
                ],
            },
        }

    monkeypatch.setattr("ghostdash_api.odoo_mas.pipeline.execute_source_request", fake_execute)

    result = run_odoo_mas_pipeline(
        None,
        message="Using Odoo only, show marketing costs increase for Ride Electric Retail from Jan 2025 till April 2026",
    )

    assert result["success"] is True
    assert result["intent"]["intent"] == "multi_period_metric_trend"
    assert result["intent"]["output"] == "trend_table"
    assert result["metric_pack"]["period"] == "2025-01 to 2026-04"
    assert result["metric_pack"]["ledger_rows"] == []

    monthly_rows = list(result["metric_pack"]["monthly_rows"])
    assert len(monthly_rows) == 16
    assert [row["month"] for row in monthly_rows] == [
        "2025-01",
        "2025-02",
        "2025-03",
        "2025-04",
        "2025-05",
        "2025-06",
        "2025-07",
        "2025-08",
        "2025-09",
        "2025-10",
        "2025-11",
        "2025-12",
        "2026-01",
        "2026-02",
        "2026-03",
        "2026-04",
    ]
    assert monthly_rows[0]["marketing_cost_total"] == pytest.approx(100.0)
    assert monthly_rows[0]["change_vs_prior_month"] is None
    assert monthly_rows[0]["pct_change_vs_prior_month"] is None
    assert monthly_rows[1]["marketing_cost_total"] == pytest.approx(110.0)
    assert monthly_rows[1]["change_vs_prior_month"] == pytest.approx(10.0)
    assert monthly_rows[1]["pct_change_vs_prior_month"] == pytest.approx(0.1)
    assert monthly_rows[-1]["marketing_cost_total"] == pytest.approx(250.0)
    assert monthly_rows[-1]["change_vs_prior_month"] == pytest.approx(10.0)

    markdown = str(result["markdown"])
    assert "## Marketing Cost Trend" in markdown
    assert "| Month | Marketing Cost | Change vs Prior Month | % Change |" in markdown
    assert "| 2025-01 | 100.00 | n/a | n/a |" in markdown
    assert "| 2026-04 | 250.00 | +10.00 | +4.17% |" in markdown
    assert "| Ride Electric Retail | 2,800.00 |" not in markdown
    assert "## Marketing Cost Total" not in markdown
    assert "## Supporting Ledger Evidence" not in markdown
