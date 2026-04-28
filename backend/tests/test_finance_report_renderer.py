from __future__ import annotations

import pytest

from ghostdash_api.finance_report_renderer import build_finance_answer_payload, build_finance_report_html, build_finance_report_pdf
from ghostdash_api.odoo_mas.contracts import MetricPack, MetricRow


def test_finance_answer_payload_formats_phase2_centralized_roas_contract() -> None:
    metric_pack = MetricPack(
        period="2026-03",
        rows=[
            MetricRow(business_unit="Ride Electric Brisbane"),
            MetricRow(business_unit="Ride Electric Burleigh"),
        ],
    )
    phase2 = {
        "resolved_metrics": [
            {
                "business_unit": "Ride Electric Brisbane",
                "revenue": 147204.96,
                "cogs": 91995.54000000001,
                "gross_profit": 55209.419999999984,
                "gross_margin_pct": 0.3750513569,
                "centralized_marketing_pool": 64906.18,
                "allocation_method": "revenue_weighted",
                "allocation_basis": "revenue",
                "allocation_share": 0.3439,
                "allocated_marketing_cost": 22321.2112,
                "revenue_roas": 6.5948464383,
                "gp_roas": 2.4734061057,
                "contribution_margin": 32888.2088,
            },
            {
                "business_unit": "Ride Electric Burleigh",
                "revenue": 280841.33,
                "cogs": 189058.03,
                "gross_profit": 91783.33,
                "gross_margin_pct": 0.3268156079,
                "centralized_marketing_pool": 64906.18,
                "allocation_method": "revenue_weighted",
                "allocation_basis": "revenue",
                "allocation_share": 0.6561,
                "allocated_marketing_cost": 42584.9688,
                "revenue_roas": 6.5948464383,
                "gp_roas": 2.1552987481,
                "contribution_margin": 49198.3612,
            },
        ]
    }

    payload = build_finance_answer_payload(metric_pack, phase2=phase2)

    assert payload["status"] == "ok"
    assert payload["source_mode"] == "odoo_only"
    assert payload["question_type"] == "centralized_marketing_roas"
    assert payload["allocation"]["pool"] == pytest.approx(64906.18)
    assert payload["allocation"]["method"] == "revenue_weighted"
    assert payload["entities"][0]["gross_profit"] == pytest.approx(55209.42)
    assert payload["entities"][0]["cogs"] == pytest.approx(91995.54)
    assert payload["entities"][0]["gp_roas"] == pytest.approx(2.4734)
    assert payload["winners"]["gross_profit"] == "Ride Electric Burleigh"
    assert payload["winners"]["gross_margin_pct"] == "Ride Electric Brisbane"
    assert payload["winners"]["gp_roas"] == "Ride Electric Brisbane"
    assert payload["winners"]["contribution_margin"] == "Ride Electric Burleigh"
    assert "GP ROAS is the better comparison metric here." in payload["interpretation"]


def test_finance_report_renderers_return_html_and_pdf_bytes() -> None:
    payload = {
        "period": "2026-03",
        "allocation": {"pool": 64906.18, "method": "revenue_weighted", "basis": "revenue"},
        "entities": [
            {"name": "Ride Electric Brisbane", "revenue": 10, "cogs": 4, "gross_profit": 6, "gross_margin_pct": 0.6},
            {"name": "Ride Electric Burleigh", "revenue": 20, "cogs": 10, "gross_profit": 10, "gross_margin_pct": 0.5},
        ],
        "winners": {"gross_profit": "Ride Electric Burleigh", "gross_margin_pct": "Ride Electric Brisbane"},
        "interpretation": ["Revenue ROAS is identical because marketing was allocated by revenue share."],
        "caveats": ["Net profit excluded pending approved business definition."],
        "evidence": {"execution_source": "odoo.mas.intent.auto_route"},
    }

    html = build_finance_report_html(payload)
    pdf = build_finance_report_pdf(payload)

    assert "Executive summary" in html
    assert "KPI table" in html
    assert pdf.startswith(b"%PDF-")


def test_finance_report_html_supports_three_entity_tables() -> None:
    payload = {
        "period": "2026-03 to 2026-04",
        "allocation": {"pool": 82391.14, "method": "revenue_weighted", "basis": "revenue"},
        "entities": [
            {"name": "Ride Electric Brisbane", "revenue": 119918.04, "gp_roas": 5.9928},
            {"name": "Ride Electric Burleigh", "revenue": 328536.59, "gp_roas": 4.7995},
            {"name": "Ride Electric Retail", "revenue": 867908.12, "gp_roas": 5.5621},
        ],
        "winners": {"gp_roas": "Ride Electric Brisbane"},
        "interpretation": [],
        "caveats": [],
        "evidence": {"execution_source": "odoo.mas.intent.auto_route"},
    }

    html = build_finance_report_html(payload)

    assert "<th>Brisbane</th><th>Retail</th><th>Burleigh</th>" in html
    assert "Retail" in html
    assert "867,908.12" in html
