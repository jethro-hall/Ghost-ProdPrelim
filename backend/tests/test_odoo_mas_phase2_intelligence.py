from __future__ import annotations

import pytest

from ghostdash_api.odoo_mas.composers import compose_board_pack, format_board_markdown
from ghostdash_api.odoo_mas.contracts import MetricPack, MetricRow
from ghostdash_api.odoo_mas.intelligence import (
    compare_entities,
    compare_month_over_month,
    detect_month_over_month_anomalies,
    flat_last_actual,
    forecast_from_history,
    linear_trend_next,
    trailing_average,
)
from ghostdash_api.odoo_mas.metrics import resolve_metrics_from_metric_pack


def test_task220_compare_entities() -> None:
    rows: list[dict] = [
        {
            "business_unit": "Ride Electric Retail",
            "revenue": 100.0,
            "cogs": 60.0,
            "gross_margin_pct": 0.4,
            "roas": 1.0,
        },
        {
            "business_unit": "Ride Electric Brisbane",
            "revenue": 40.0,
            "cogs": 20.0,
            "gross_margin_pct": 0.5,
            "roas": 0.2,
        },
    ]
    pack = compare_entities(rows, period_label="2026-03")
    assert pack["comparison_type"] == "entity_vs_entity"
    assert "metric_spreads" in pack
    assert pack["entity_table"]["Ride Electric Retail"]["revenue"] == 100.0
    assert any(d["a"] == "Ride Electric Retail" and d["metric"] == "revenue" for d in pack["pairwise_deltas"])


def test_task220_compare_mom() -> None:
    cur = {"revenue": 100.0, "cogs": 50.0, "business_unit": "Ride Electric Retail"}
    prior = {"revenue": 80.0, "cogs": 50.0, "business_unit": "Ride Electric Retail"}
    m = compare_month_over_month(
        cur,
        prior,
        current_period="2026-03",
        prior_period="2026-02",
    )
    assert m["comparison_type"] == "month_over_month"
    assert m["changes"]["revenue"]["delta"] == pytest.approx(20.0)
    assert m["changes"]["revenue"]["pct_change"] == pytest.approx(0.25)


def test_task232_anomaly_mom() -> None:
    cur = {
        "business_unit": "Ride Electric Retail",
        "revenue": 100.0,
        "cogs": 200.0,
    }
    prior = {
        "business_unit": "Ride Electric Retail",
        "revenue": 200.0,
        "cogs": 100.0,
    }
    pack = detect_month_over_month_anomalies(cur, prior, entity="Ride Electric Retail")
    ids = {f.get("anomaly_id") for f in pack.get("flags") or []}
    assert "revenue_mom_down" in ids
    assert "cogs_mom_up" in ids


def test_task242_forecast_caveat_insufficient_history() -> None:
    hist = [("2026-01", {"revenue": 1.0}), ("2026-02", {"revenue": 2.0})]
    pack = forecast_from_history(hist, ["revenue"], method="trailing_average_3m", horizon=1)
    assert any("insufficient_history" in str(c) for c in (pack.get("caveats") or []))
    assert pack["forecasts"][0].get("value") is None or pack["forecasts"][0].get("status") in ("ok", "blocked")


def test_task242_trailing_and_linear() -> None:
    assert trailing_average([1, 2, 3, 4, None, 5], 3) == pytest.approx((3 + 4 + 5) / 3)
    assert flat_last_actual([1.0, 2.0, None, 3.0]) == pytest.approx(3.0)
    # six points, linear: y = 0,1,2,3,4,5
    y = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]
    n = linear_trend_next(y)
    assert n is not None and n == pytest.approx(6.0, abs=1e-5)


def test_task251_golden_board_pack() -> None:
    rows: list[dict] = [
        {
            "business_unit": "Ride Electric Retail",
            "revenue": 100.0,
            "gross_profit": 20.0,
        },
    ]
    var_ = compare_entities(
        rows + [{"business_unit": "Ride Electric Brisbane", "revenue": 50.0, "gross_profit": 5.0}],
        period_label="2026-03",
    )
    anom = detect_month_over_month_anomalies(
        {"revenue": 100.0, "cogs": 40.0},
        {"revenue": 150.0, "cogs": 40.0},
        entity="E",
    )
    fcst = {
        "method": "trailing_average_3m",
        "horizon": 1,
        "forecasts": [],
        "caveats": [],
    }
    pack = compose_board_pack(
        period_label="2026-03",
        kpi_rows=rows,
        variance_pack=var_,
        anomaly_pack=anom,
        forecast_pack=fcst,
    )
    text = format_board_markdown(pack)
    assert pack["format"] == "board_v1"
    assert "Executive summary" in text
    assert "KPI table" in text
    assert "Caveats" in text
    # Stable substring from variance JSON embed
    assert "Ride Electric Retail" in text


def test_centralized_roas_multi_entity() -> None:
    mp = MetricPack(
        period="2026-03",
        rows=[
            MetricRow(
                business_unit="Ride Electric Retail",
                revenue=5000.0,
                cogs=2000.0,
                marketing_cost_total=200.0,
            ),
            MetricRow(
                business_unit="Ride Electric Brisbane",
                revenue=800.0,
                cogs=400.0,
                marketing_cost_total=0.0,
            ),
        ],
    )
    out = resolve_metrics_from_metric_pack(mp)
    by = {r["business_unit"]: r for r in out}
    assert by["Ride Electric Retail"]["allocated_marketing_cost"] == pytest.approx(5000.0 / 5800.0 * 200.0)
    assert by["Ride Electric Brisbane"]["allocated_marketing_cost"] == pytest.approx(800.0 / 5800.0 * 200.0)
    assert by["Ride Electric Brisbane"]["centralized_roas"] == pytest.approx(5800.0 / 200.0)
    assert by["Ride Electric Retail"]["revenue_roas"] == pytest.approx(5800.0 / 200.0)
    assert by["Ride Electric Brisbane"]["allocation_method"] == "revenue_weighted"
