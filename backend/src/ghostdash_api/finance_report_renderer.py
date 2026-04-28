from __future__ import annotations

import html
import json
import math
import tempfile
from pathlib import Path
from typing import Any
from uuid import uuid4

from .odoo_mas.contracts import FinanceReasoningResult, MetricPack
from .settings import get_settings


def build_finance_answer_payload(
    metric_pack: MetricPack,
    *,
    phase2: dict[str, Any] | None = None,
    reasoning: FinanceReasoningResult | dict[str, Any] | None = None,
    operation: str = "odoo.mas.intent.auto_route",
    source_mode: str = "odoo_only",
) -> dict[str, Any]:
    """Build the structured finance card contract used by chat and reports."""
    resolved_rows = _resolved_rows(metric_pack, phase2)
    allocation = _allocation_from_rows(resolved_rows)
    entities = [_entity_payload(row) for row in resolved_rows]
    winners = _winners(entities)
    period = _period_label(metric_pack.period)
    is_central_roas = any(entity.get("allocated_marketing") is not None for entity in entities)
    payload = {
        "status": "ok",
        "source_mode": source_mode,
        "period": period,
        "question_type": "centralized_marketing_roas" if is_central_roas else "finance_metric_comparison",
        "currency": "AUD",
        "allocation": allocation,
        "entities": entities,
        "winners": winners,
        "executive_readout": _executive_readout(entities, winners),
        "interpretation": _interpretation(entities, is_central_roas),
        "caveats": _caveats(reasoning),
        "evidence": {
            "execution_source": operation,
            "orchestrator_status": "not_attempted",
        },
    }
    return _round_payload(payload)


def build_finance_report_html(payload: dict[str, Any]) -> str:
    title = _report_title(payload)
    rows = _metric_rows(payload)
    entities = _ordered_entities(payload)
    header_html = "".join(f"<th>{html.escape(_short_entity_name(str(entity.get('name') or 'Entity')))}</th>" for entity in entities)
    row_html = "\n".join(
        "<tr>"
        f"<td>{html.escape(label)}</td>"
        + "".join(f"<td class=\"num\">{html.escape(value)}</td>" for value in values)
        + f"<td>{html.escape(winner)}</td>"
        + "</tr>"
        for label, values, winner in rows
    )
    details = html.escape(json.dumps(payload, indent=2, sort_keys=True))
    caveats = "".join(f"<li>{html.escape(caveat)}</li>" for caveat in payload.get("caveats", []))
    interpretation = "".join(f"<li>{html.escape(item)}</li>" for item in payload.get("interpretation", []))
    allocation = dict(payload.get("allocation") or {})
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{html.escape(title)}</title>
  <style>
    body {{ font-family: Arial, sans-serif; color: #0f172a; margin: 40px; }}
    h1 {{ font-size: 28px; margin-bottom: 6px; }}
    h2 {{ margin-top: 28px; border-bottom: 1px solid #d8dee9; padding-bottom: 8px; }}
    .meta {{ color: #475569; line-height: 1.5; }}
    .summary {{ background: #eef6ff; border: 1px solid #bfdbfe; border-radius: 14px; padding: 16px; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 14px; }}
    th, td {{ border-bottom: 1px solid #e2e8f0; padding: 10px 8px; text-align: left; }}
    th {{ background: #f8fafc; }}
    .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
    pre {{ white-space: pre-wrap; background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 12px; }}
  </style>
</head>
<body>
  <section>
    <h1>{html.escape(title)}</h1>
    <div class="meta">
      Centralized marketing pool: {_fmt_money(allocation.get("pool"))}<br />
      Allocation method: {html.escape(_human_method(allocation.get("method")))}<br />
      Source: Odoo only
    </div>
  </section>
  <section>
    <h2>Executive summary</h2>
    <div class="summary">{html.escape(payload.get("executive_readout") or "")}</div>
  </section>
  <section>
    <h2>KPI table</h2>
    <table>
      <thead><tr><th>Metric</th>{header_html}<th>Winner</th></tr></thead>
      <tbody>{row_html}</tbody>
    </table>
  </section>
  <section>
    <h2>Allocation method</h2>
    <p>Marketing was allocated by {html.escape(str(allocation.get("basis") or "revenue"))} using the {html.escape(str(allocation.get("method") or "unknown"))} method.</p>
  </section>
  <section>
    <h2>Evidence / ledger source</h2>
    <p>Execution source: {html.escape(str((payload.get("evidence") or {}).get("execution_source") or ""))}</p>
  </section>
  <section>
    <h2>Caveats</h2>
    <ul>{caveats or "<li>None.</li>"}</ul>
  </section>
  <section>
    <h2>Calculation appendix</h2>
    <ul>{interpretation}</ul>
    <pre>{details}</pre>
  </section>
</body>
</html>"""


def build_finance_report_pdf(payload: dict[str, Any]) -> bytes:
    lines = [_report_title(payload), ""]
    allocation = dict(payload.get("allocation") or {})
    lines.extend(
        [
            f"Centralized marketing pool: {_fmt_money(allocation.get('pool'))}",
            f"Allocation method: {_human_method(allocation.get('method'))}",
            "Source: Odoo only",
            "",
            "Executive summary",
            str(payload.get("executive_readout") or ""),
            "",
            "KPI table",
        ]
    )
    entity_names = [_short_entity_name(str(entity.get("name") or "Entity")) for entity in _ordered_entities(payload)]
    for label, values, winner in _metric_rows(payload):
        parts = [f"{name} {value}" for name, value in zip(entity_names, values, strict=False)]
        lines.append(f"{label}: {' | '.join(parts)} | Winner {winner}")
    lines.extend(["", "Interpretation"])
    lines.extend(f"- {item}" for item in payload.get("interpretation", []))
    lines.extend(["", "Caveats"])
    lines.extend(f"- {item}" for item in payload.get("caveats", []) or ["None."])
    lines.extend(["", "Calculation appendix", json.dumps(payload, indent=2, sort_keys=True)])
    return _simple_pdf(lines)


def persist_finance_report(payload: dict[str, Any], *, run_id: str | None = None) -> dict[str, Any]:
    rid = run_id or str(uuid4())
    report_dir = _ensure_report_dir()
    payload = dict(payload)
    payload["run_id"] = rid
    (report_dir / f"{rid}.json").write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    (report_dir / f"{rid}.html").write_text(build_finance_report_html(payload), encoding="utf-8")
    (report_dir / f"{rid}.pdf").write_bytes(build_finance_report_pdf(payload))
    return {
        "run_id": rid,
        "chat_payload": payload,
        "report_url": f"/api/finance/reports/{rid}/pdf",
        "html_url": f"/api/finance/reports/{rid}/html",
    }


def load_finance_report(run_id: str) -> dict[str, Any]:
    path = _report_file(run_id, "json")
    if not path.exists():
        raise FileNotFoundError(run_id)
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {
        "run_id": run_id,
        "chat_payload": payload,
        "report_url": f"/api/finance/reports/{run_id}/pdf",
        "html_url": f"/api/finance/reports/{run_id}/html",
    }


def finance_report_file(run_id: str, suffix: str) -> Path:
    if suffix not in {"pdf", "html"}:
        raise ValueError("unsupported finance report suffix")
    return _report_file(run_id, suffix)


def _report_dir() -> Path:
    return get_settings().data_dir / "finance_reports"


def _ensure_report_dir() -> Path:
    primary = _report_dir()
    try:
        primary.mkdir(parents=True, exist_ok=True)
        return primary
    except PermissionError:
        fallback = Path(tempfile.gettempdir()) / "ghostdash_finance_reports"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def _report_file(run_id: str, suffix: str) -> Path:
    primary = _report_dir() / f"{run_id}.{suffix}"
    if primary.exists():
        return primary
    fallback = Path(tempfile.gettempdir()) / "ghostdash_finance_reports" / f"{run_id}.{suffix}"
    return fallback if fallback.exists() else primary


def _resolved_rows(metric_pack: MetricPack, phase2: dict[str, Any] | None) -> list[dict[str, Any]]:
    phase_rows = [row for row in list((phase2 or {}).get("resolved_metrics") or []) if isinstance(row, dict)]
    if phase_rows:
        return phase_rows
    return [
        {
            "business_unit": row.business_unit,
            "revenue": row.revenue,
            "cogs": row.cogs,
            "gross_profit": row.gross_profit,
            "gross_margin_pct": row.gross_margin_pct,
            "allocated_marketing_cost": row.marketing_cost_total,
            "allocation_share": None,
            "revenue_roas": row.revenue_roas or row.roas,
            "gp_roas": row.gp_roas,
            "contribution_margin": row.contribution_margin,
        }
        for row in metric_pack.rows
    ]


def _allocation_from_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    first = rows[0] if rows else {}
    pool = first.get("centralized_marketing_pool")
    if pool is None:
        allocated = [_num(row.get("allocated_marketing_cost")) for row in rows]
        pool = sum(value for value in allocated if value is not None) if allocated else None
    return {
        "pool": _round_number(pool, 2),
        "method": first.get("allocation_method") or "unknown",
        "basis": first.get("allocation_basis") or "unknown",
    }


def _entity_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": row.get("business_unit"),
        "revenue": _round_number(row.get("revenue"), 2),
        "cogs": _round_number(row.get("cogs"), 2),
        "gross_profit": _round_number(row.get("gross_profit"), 2),
        "gross_margin_pct": _round_number(row.get("gross_margin_pct"), 4),
        "allocation_share": _round_number(row.get("allocation_share"), 4),
        "allocated_marketing": _round_number(row.get("allocated_marketing_cost", row.get("marketing_cost")), 2),
        "revenue_roas": _round_number(row.get("revenue_roas", row.get("roas")), 4),
        "gp_roas": _round_number(row.get("gp_roas"), 4),
        "contribution_margin": _round_number(row.get("contribution_margin"), 2),
    }


def _winners(entities: list[dict[str, Any]]) -> dict[str, str]:
    winners: dict[str, str] = {}
    for metric in ("gross_profit", "gross_margin_pct", "gp_roas", "contribution_margin"):
        ranked = [
            (str(entity.get("name") or ""), _num(entity.get(metric)))
            for entity in entities
            if _num(entity.get(metric)) is not None
        ]
        ranked.sort(key=lambda item: float(item[1] or 0), reverse=True)
        if len(ranked) >= 2 and ranked[0][1] is not None and ranked[1][1] is not None:
            if float(ranked[0][1]) > float(ranked[1][1]):
                winners[metric] = ranked[0][0]
            else:
                winners[metric] = "Tie"
    return winners


def _executive_readout(entities: list[dict[str, Any]], winners: dict[str, str]) -> str:
    gp = _short_entity_name(winners.get("gross_profit"))
    contribution = _short_entity_name(winners.get("contribution_margin"))
    gp_roas = _short_entity_name(winners.get("gp_roas"))
    gross_margin = _short_entity_name(winners.get("gross_margin_pct"))
    if gp == contribution and gp_roas == gross_margin and gp and gp_roas:
        return f"{gp} generated more gross profit and contribution margin. {gp_roas} was more efficient on GP ROAS and gross margin."
    if len(entities) >= 2:
        return "The larger location generated more dollars, while the more efficient location led on margin quality."
    return "Finance metrics were calculated from Odoo evidence."


def _interpretation(entities: list[dict[str, Any]], is_central_roas: bool) -> list[str]:
    revenue_winner = _short_entity_name(_winner_for(entities, "revenue"))
    efficiency_winner = _short_entity_name(_winner_for(entities, "gp_roas"))
    base = [
        f"{revenue_winner} is larger and produces more dollars." if revenue_winner not in {"-", "Tie"} else "Revenue scale is tied or not available.",
        f"{efficiency_winner} is more efficient." if efficiency_winner not in {"-", "Tie"} else "Efficiency is tied or not available.",
    ]
    if is_central_roas:
        base.extend(
            [
                "Revenue ROAS is identical because marketing was allocated by revenue share.",
                "GP ROAS is the better comparison metric here.",
            ]
        )
    return base


def _caveats(reasoning: FinanceReasoningResult | dict[str, Any] | None) -> list[str]:
    caveats = list((reasoning.model_dump() if isinstance(reasoning, FinanceReasoningResult) else reasoning or {}).get("caveats") or [])
    normalized: list[str] = []
    for caveat in caveats:
        text = str(caveat)
        if text == "NET semantics are blocked pending approved business definition.":
            text = "Net profit excluded pending approved business definition."
        normalized.append(text)
    return normalized


def _period_label(period: str) -> str:
    return str(period or "").strip()


def _report_title(payload: dict[str, Any]) -> str:
    period = str(payload.get("period") or "Finance")
    entities = [_short_entity_name(str(entity.get("name") or "")) for entity in _ordered_entities(payload)]
    return f"{period} ROAS - {' vs '.join(entities) if entities else 'Finance'}"


def _metric_rows(payload: dict[str, Any]) -> list[tuple[str, list[str], str]]:
    entities = _ordered_entities(payload)
    winners = dict(payload.get("winners") or {})
    return [
        ("Revenue", [_fmt_money(entity.get("revenue")) for entity in entities], _short_entity_name(_winner_for(entities, "revenue"))),
        ("COGS", [_fmt_money(entity.get("cogs")) for entity in entities], "-"),
        ("Gross Profit", [_fmt_money(entity.get("gross_profit")) for entity in entities], _short_entity_name(winners.get("gross_profit"))),
        ("Gross Margin %", [_fmt_pct(entity.get("gross_margin_pct")) for entity in entities], _short_entity_name(winners.get("gross_margin_pct"))),
        ("Allocated Marketing", [_fmt_money(entity.get("allocated_marketing")) for entity in entities], "-"),
        ("Revenue ROAS", [_fmt_roas(entity.get("revenue_roas")) for entity in entities], _short_entity_name(_winner_for(entities, "revenue_roas"))),
        ("GP ROAS", [_fmt_roas(entity.get("gp_roas")) for entity in entities], _short_entity_name(winners.get("gp_roas"))),
        ("Contribution Margin", [_fmt_money(entity.get("contribution_margin")) for entity in entities], _short_entity_name(winners.get("contribution_margin"))),
    ]


def _ordered_entities(payload: dict[str, Any]) -> list[dict[str, Any]]:
    preferred = ("brisbane", "retail", "burleigh")
    entities = [entity for entity in list(payload.get("entities") or []) if isinstance(entity, dict)]

    def sort_key(entity: dict[str, Any]) -> tuple[int, str]:
        name = str(entity.get("name") or "").casefold()
        idx = next((i for i, token in enumerate(preferred) if token in name), len(preferred))
        return idx, name

    return sorted(entities, key=sort_key)


def _winner_for(entities: list[dict[str, Any]], metric: str) -> str:
    values = [(entity, _num(entity.get(metric))) for entity in entities]
    values = [(entity, value) for entity, value in values if value is not None]
    if len(values) < 2:
        return "-"
    values.sort(key=lambda item: float(item[1] or 0), reverse=True)
    if abs(float(values[0][1] or 0) - float(values[1][1] or 0)) < 0.005:
        return "Tie"
    return str(values[0][0].get("name") or "")


def _short_entity_name(name: str | None) -> str:
    text = str(name or "").strip()
    if not text:
        return "-"
    if text == "Tie":
        return "Tie"
    for token in ("Brisbane", "Retail", "Burleigh"):
        if token.casefold() in text.casefold():
            return token
    return text


def _fmt_money(value: Any) -> str:
    number = _num(value)
    return "-" if number is None else f"${number:,.2f}"


def _fmt_pct(value: Any) -> str:
    number = _num(value)
    return "-" if number is None else f"{number * 100:.2f}%"


def _fmt_roas(value: Any) -> str:
    number = _num(value)
    return "-" if number is None else f"{number:.2f}"


def _human_method(value: Any) -> str:
    text = str(value or "").replace("_", "-")
    return text[:1].upper() + text[1:] if text else "Unknown"


def _round_payload(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _round_payload(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_round_payload(v) for v in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return round(value, 4)
    return value


def _round_number(value: Any, digits: int) -> float | None:
    number = _num(value)
    return None if number is None else round(number, digits)


def _num(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _simple_pdf(lines: list[str]) -> bytes:
    escaped_lines = [_pdf_escape(line[:120]) for line in lines]
    content_lines = ["BT", "/F1 10 Tf", "50 780 Td", "14 TL"]
    for line in escaped_lines:
        content_lines.append(f"({line}) Tj")
        content_lines.append("T*")
    content_lines.append("ET")
    stream = "\n".join(content_lines).encode("latin-1", errors="replace")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for idx, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out.extend(f"{idx} 0 obj\n".encode())
        out.extend(obj)
        out.extend(b"\nendobj\n")
    xref = len(out)
    out.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        out.extend(f"{offset:010d} 00000 n \n".encode())
    out.extend(f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(out)


def _pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
