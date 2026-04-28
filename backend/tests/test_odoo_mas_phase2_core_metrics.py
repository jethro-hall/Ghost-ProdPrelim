from __future__ import annotations

import pytest

from ghostdash_api.odoo_mas.contracts import MetricPack, MetricRow
from ghostdash_api.odoo_mas.metrics import (
    calculate_contribution_margin,
    calculate_gross_margin_pct,
    calculate_gross_profit,
    calculate_roas,
    get_metric_definitions,
    resolve_metrics_from_metric_pack,
)


def test_metric_definitions_config_loads() -> None:
    payload = get_metric_definitions()
    metrics = payload["metrics"]
    assert "revenue" in metrics
    assert "gross_profit" in metrics
    assert "roas" in metrics
    assert metrics["net_profit"]["status"] == "blocked_until_defined"


@pytest.mark.parametrize(
    ("revenue", "cogs", "expected"),
    [
        (1000.0, 700.0, 300.0),
        (1000.0, -700.0, 1700.0),
        (0.0, 0.0, 0.0),
        (None, 700.0, None),
        (1000.0, None, None),
    ],
)
def test_calculate_gross_profit(revenue, cogs, expected) -> None:
    assert calculate_gross_profit(revenue, cogs) == expected


@pytest.mark.parametrize(
    ("gross_profit", "revenue", "expected"),
    [
        (300.0, 1000.0, 0.3),
        (0.0, 1000.0, 0.0),
        (300.0, 0.0, None),
        (300.0, None, None),
        (None, 1000.0, None),
    ],
)
def test_calculate_gross_margin_pct(gross_profit, revenue, expected) -> None:
    assert calculate_gross_margin_pct(gross_profit, revenue) == expected


@pytest.mark.parametrize(
    ("gross_profit", "marketing_cost", "expected"),
    [
        (300.0, 100.0, 200.0),
        (300.0, 0.0, 300.0),
        (None, 100.0, None),
        (300.0, None, None),
    ],
)
def test_calculate_contribution_margin(gross_profit, marketing_cost, expected) -> None:
    assert calculate_contribution_margin(gross_profit, marketing_cost) == expected


@pytest.mark.parametrize(
    ("revenue", "marketing_cost", "expected"),
    [
        (1000.0, 100.0, 10.0),
        (1000.0, 0.0, None),
        (1000.0, None, None),
        (None, 100.0, None),
    ],
)
def test_calculate_roas(revenue, marketing_cost, expected) -> None:
    assert calculate_roas(revenue, marketing_cost) == expected


def test_resolve_metrics_from_metric_pack() -> None:
    metric_pack = MetricPack(
        period="2026-03",
        rows=[
            MetricRow(
                business_unit="Ride Electric Retail",
                revenue=1000.0,
                cogs=700.0,
                gross_profit=None,
                marketing_cost_total=100.0,
                net_profit=50.0,
            )
        ],
    )
    resolved = resolve_metrics_from_metric_pack(metric_pack)
    assert len(resolved) == 1
    row = resolved[0]
    assert row["gross_profit"] == pytest.approx(300.0)
    assert row["gross_margin_pct"] == pytest.approx(0.3)
    assert row["marketing_cost"] == pytest.approx(100.0)
    assert row["contribution_margin"] == pytest.approx(200.0)
    assert row["roas"] == pytest.approx(10.0)
    assert row.get("centralized_roas") == pytest.approx(10.0)
    assert row.get("roas_mode") == "central_marketing_allocated"
    assert row["net_profit"] is None
