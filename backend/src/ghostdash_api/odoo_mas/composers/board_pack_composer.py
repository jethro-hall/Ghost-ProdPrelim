from __future__ import annotations

import json
from typing import Any

from ..registry_loader import get_board_output_templates


def _md_table(rows: list[dict[str, Any]], headers: list[str]) -> str:
    if not headers:
        return ""
    line = " | ".join(headers)
    sep = " | ".join("---" for _ in headers)
    out = [line, sep]
    for row in rows:
        out.append(" | ".join(str(row.get(h, "")) for h in headers))
    return "\n".join(out)


def compose_board_pack(
    *,
    period_label: str,
    kpi_rows: list[dict[str, Any]] | None = None,
    variance_pack: dict[str, Any] | None = None,
    anomaly_pack: dict[str, Any] | None = None,
    forecast_pack: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Produces a BoardPack-shaped output. All numeric content must already exist in the inputs; this
    function formats only (no new math, no new finance truth).
    """
    t = get_board_output_templates()
    caveat = str(dict(t.get("caveat_lines") or {}).get("no_new_math", ""))
    kpi = ""
    if kpi_rows:
        headers = []
        for row in kpi_rows:
            for k in row.keys():
                if k not in headers:
                    headers.append(k)
        if headers:
            kpi = _md_table(kpi_rows, headers)

    exec_summary = (
        f"Period: **{period_label}**. Structured financial intelligence built from "
        f"variance, anomaly, and forecast packs. {caveat}"
    )
    performance = "No variance pack was supplied; performance driver narrative is not generated."
    if variance_pack and variance_pack.get("entity_table"):
        try:
            performance = (
                "Entity comparison snapshot:\n\n```json\n"
                f"{json.dumps(variance_pack.get('entity_table'), indent=2, ensure_ascii=True)}\n```\n"
            )
        except (TypeError, ValueError):
            performance = str(variance_pack.get("entity_table"))

    anom = "No anomaly pack was supplied."
    if anomaly_pack and anomaly_pack.get("flags"):
        lines = [f"- {f.get('anomaly_id')}: {f.get('message', '')}" for f in anomaly_pack.get("flags") or []]
        anom = "\n".join(lines) if lines else "No rules fired."

    fcst = "No forecast pack was supplied."
    if forecast_pack and forecast_pack.get("forecasts"):
        f_lines = [f"- {f.get('label', '')}: {f.get('value')} ({f.get('status', 'n/a')})" for f in forecast_pack.get("forecasts") or []]
        caveats = forecast_pack.get("caveats") or []
        if caveats:
            f_lines.append("Caveats: " + "; ".join(str(c) for c in caveats))
        fcst = "\n".join(f_lines)

    risks: list[str] = []
    if anomaly_pack and anomaly_pack.get("flags"):
        for f in anomaly_pack.get("flags") or []:
            if str(f.get("severity", "")).casefold() == "high":
                risks.append(f"**{f.get('anomaly_id')}** ({f.get('metric')}) on {f.get('entity', 'scope')}")
    if forecast_pack and forecast_pack.get("caveats"):
        for c in forecast_pack.get("caveats") or []:
            risks.append(str(c))
    if not risks:
        risks = ["(none flagged from supplied packs)"]
    recs: list[str] = []
    if variance_pack and variance_pack.get("metric_spreads"):
        for m, s in (variance_pack.get("metric_spreads") or {}).items():
            mx = s.get("max") or {}
            mn = s.get("min") or {}
            if m and isinstance(mx, dict) and isinstance(mn, dict) and "entity" in mx and "entity" in mn:
                recs.append(
                    f"Review {m} gap: highest {mx.get('value')} at {mx.get('entity')}, "
                    f"lowest {mn.get('value')} at {mn.get('entity')}"
                )
    if not recs:
        recs = [
            "Validate the metric pack against source Odoo P&L before using this for decisions.",
        ]

    caveats_section = "\n".join(
        [
            caveat,
            str(dict(t.get("caveat_lines") or {}).get("incomplete", "")).strip() or "Incomplete inputs reduce confidence.",
        ]
    )

    sections = {
        "executive_summary": exec_summary,
        "kpi_table": kpi or "*(no kpi table rows were supplied)*",
        "performance_drivers": performance,
        "anomalies": anom,
        "forecast": fcst,
        "risks": "\n".join(f"- {r}" for r in risks) if risks else "—",
        "recommendations": "\n".join(f"- {r}" for r in recs) if recs else "—",
        "caveats": caveats_section,
    }
    return {
        "format": "board_v1",
        "period_label": period_label,
        "sections": sections,
        "structured": {
            "kpi_row_count": len(kpi_rows or []),
            "variance": bool(variance_pack),
            "anomaly": bool(anomaly_pack and anomaly_pack.get("flags")),
            "forecast": bool(forecast_pack and forecast_pack.get("forecasts")),
        },
    }


def format_board_markdown(pack: dict[str, Any]) -> str:
    t = get_board_output_templates()
    st = dict(t.get("section_titles") or {})
    s = pack.get("sections") or {}
    out: list[str] = []
    order = [
        "executive_summary",
        "kpi_table",
        "performance_drivers",
        "anomalies",
        "forecast",
        "risks",
        "recommendations",
        "caveats",
    ]
    for key in order:
        text = s.get(key)
        if not text:
            continue
        title = str(st.get(key) or key)
        out.append(f"## {title}\n")
        out.append(str(text).strip())
        out.append("")
    return "\n".join(out).strip() + "\n"
