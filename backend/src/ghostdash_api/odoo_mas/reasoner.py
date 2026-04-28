from __future__ import annotations

from .contracts import FinanceReasoningResult, MetricPack


def reason_about_metric_pack(metric_pack: MetricPack, *, net_blocked: bool = True) -> FinanceReasoningResult:
    if not metric_pack.rows:
        return FinanceReasoningResult(
            headline="No finance evidence was returned.",
            findings=[],
            caveats=["No rows were assembled from available sources."],
            confidence="low",
        )

    winner = None
    efficiency_winner = None
    gross_margin_winner = None
    headline = f"Financial evidence compiled for period {metric_pack.period}."
    comparable_rows = [row for row in metric_pack.rows if row.gross_profit is not None]
    if len(metric_pack.rows) > 1:
        headline = f"Comparison complete for period {metric_pack.period}."
    if len(comparable_rows) >= 2:
        sorted_rows = sorted(comparable_rows, key=lambda item: float(item.gross_profit or 0.0), reverse=True)
        top_row = sorted_rows[0]
        second_row = sorted_rows[1]
        if float(top_row.gross_profit or 0.0) > float(second_row.gross_profit or 0.0):
            winner = top_row.business_unit
    comparable_gp_roas = [row for row in metric_pack.rows if row.gp_roas is not None]
    if len(comparable_gp_roas) >= 2:
        sorted_rows = sorted(comparable_gp_roas, key=lambda item: float(item.gp_roas or 0.0), reverse=True)
        top_row = sorted_rows[0]
        second_row = sorted_rows[1]
        if float(top_row.gp_roas or 0.0) > float(second_row.gp_roas or 0.0):
            efficiency_winner = top_row.business_unit
    comparable_gross_margin = [row for row in metric_pack.rows if row.gross_margin_pct is not None]
    if len(comparable_gross_margin) >= 2:
        sorted_rows = sorted(comparable_gross_margin, key=lambda item: float(item.gross_margin_pct or 0.0), reverse=True)
        top_row = sorted_rows[0]
        second_row = sorted_rows[1]
        if float(top_row.gross_margin_pct or 0.0) > float(second_row.gross_margin_pct or 0.0):
            gross_margin_winner = top_row.business_unit

    findings = []
    for row in metric_pack.rows:
        findings.append(
            (
                f"{row.business_unit}: revenue={row.revenue}, cogs={row.cogs}, gross_profit={row.gross_profit}, "
                f"gross_margin_pct={row.gross_margin_pct}, revenue_roas={row.revenue_roas}, gp_roas={row.gp_roas}, "
                f"contribution_margin={row.contribution_margin}"
            )
        )
    caveats = list(metric_pack.gaps)
    if net_blocked:
        caveats.append("NET semantics are blocked pending approved business definition.")

    confidence = "high" if not caveats else "medium"
    return FinanceReasoningResult(
        headline=headline,
        findings=findings,
        winner=winner,
        efficiency_winner=efficiency_winner,
        gross_margin_winner=gross_margin_winner,
        caveats=sorted(set(caveats)),
        confidence=confidence,
    )
