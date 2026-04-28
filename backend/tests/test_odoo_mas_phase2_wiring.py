from __future__ import annotations

import pytest

from ghostdash_api.odoo_mas.contracts import MetricPack, MetricRow
from ghostdash_api.odoo_mas.phase2_bridge import build_phase2_payload, format_phase2_markdown_append


def test_build_phase2_payload_includes_variance_for_two_entities() -> None:
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
    p2 = build_phase2_payload(mp)
    assert p2.get("version") == 1
    assert len(p2["resolved_metrics"]) == 2
    v = p2.get("variance_pack")
    assert v is not None
    assert v.get("comparison_type") == "entity_vs_entity"
    assert "entity_table" in v
    md = format_phase2_markdown_append(p2)
    assert "Finance intelligence (Phase 2" in md
    assert "Entity spread" in md
