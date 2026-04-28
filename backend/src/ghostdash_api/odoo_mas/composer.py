from __future__ import annotations

from .contracts import FinanceReasoningResult, MetricPack


def compose_board_markdown(
    metric_pack: MetricPack,
    reasoning: FinanceReasoningResult,
    *,
    requested_metrics: list[str] | None = None,
    centralized_note: str | None = None,
    intent_kind: str | None = None,
    include_ledger_evidence: bool = True,
) -> str:
    requested = set(str(item).strip() for item in (requested_metrics or []) if str(item).strip())
    marketing_single_metric = _is_marketing_single_metric_query(requested)
    marketing_trend = _is_marketing_trend_query(metric_pack, requested_metrics=requested, intent_kind=intent_kind)
    lines = [
        "## Executive Summary",
        "",
        reasoning.headline,
    ]
    if marketing_trend:
        trend_rows = _marketing_trend_rows(metric_pack)
        trend_business_units = {row.business_unit for row in trend_rows}
        lines.extend(
            [
                "",
                "## Marketing Cost Trend",
                "",
            ]
        )
        if len(trend_business_units) > 1:
            lines.extend(
                [
                    "| Business Unit | Month | Marketing Cost | Change vs Prior Month | % Change |",
                    "|---|---|---:|---:|---:|",
                ]
            )
            for row in trend_rows:
                lines.append(
                    f"| {row.business_unit} | {row.month} | {_fmt(row.marketing_cost_total)} | {_fmt_delta(row.change_vs_prior_month)} | {_fmt_delta_pct(row.pct_change_vs_prior_month)} |"
                )
        else:
            lines.extend(
                [
                    "| Month | Marketing Cost | Change vs Prior Month | % Change |",
                    "|---|---:|---:|---:|",
                ]
            )
            for row in trend_rows:
                lines.append(
                    f"| {row.month} | {_fmt(row.marketing_cost_total)} | {_fmt_delta(row.change_vs_prior_month)} | {_fmt_delta_pct(row.pct_change_vs_prior_month)} |"
                )
    elif marketing_single_metric:
        lines.extend(
            [
                "",
                "## Marketing Cost Total",
                "",
                "| Business Unit | Marketing Cost Total |",
                "|---|---:|",
            ]
        )
    else:
        lines.extend(
            [
                "",
                "## KPI Table",
                "",
                "| Business Unit | Revenue | COGS | Gross Profit | Allocated Marketing | Revenue ROAS | GP ROAS | Contribution Margin |",
                "|---|---:|---:|---:|---:|---:|---:|---:|",
            ]
        )
    if reasoning.winner:
        lines[3:3] = [f"Top performer (gross profit): {reasoning.winner}", ""]
    if reasoning.efficiency_winner:
        lines[3:3] = [f"Top performer (efficiency / GP ROAS): {reasoning.efficiency_winner}", ""]
    if reasoning.gross_margin_winner:
        lines[3:3] = [f"Top performer (gross margin %): {reasoning.gross_margin_winner}", ""]
    for row in metric_pack.rows:
        if marketing_trend:
            continue
        if marketing_single_metric:
            lines.append(f"| {row.business_unit} | {_fmt(row.marketing_cost_total)} |")
        else:
            lines.append(
                (
                    f"| {row.business_unit} | {_fmt(row.revenue)} | {_fmt(row.cogs)} | {_fmt(row.gross_profit)} | "
                    f"{_fmt(row.marketing_cost_total)} | {_fmt(row.revenue_roas or row.roas)} | {_fmt(row.gp_roas)} | "
                    f"{_fmt(row.contribution_margin)} |"
                )
            )

    has_monthly_pnl = any(
        row.revenue is not None or row.cogs is not None or row.gross_profit is not None or row.gross_margin_pct is not None
        for row in metric_pack.monthly_rows
    )
    if metric_pack.monthly_rows and has_monthly_pnl and not marketing_single_metric and not marketing_trend:
        lines.extend(
            [
                "",
                "## Monthly Breakdown",
                "",
                "| Business Unit | Month | Revenue | COGS | Gross Profit | Gross Margin % |",
                "|---|---|---:|---:|---:|---:|",
            ]
        )
        for row in metric_pack.monthly_rows:
            lines.append(
                f"| {row.business_unit} | {row.month} | {_fmt(row.revenue)} | {_fmt(row.cogs)} | {_fmt(row.gross_profit)} | {_fmt_pct(row.gross_margin_pct)} |"
            )

    if metric_pack.ledger_rows and include_ledger_evidence and not marketing_trend:
        lines.extend(
            [
                "",
                "## Supporting Ledger Evidence",
                "",
                "| Business Unit | Month | Account | Account Class | Amount | Included In Metric | Status |",
                "|---|---|---|---|---:|---|---|",
            ]
        )
        for row in metric_pack.ledger_rows:
            lines.append(
                f"| {row.business_unit} | {row.month} | {row.account} | {row.account_class or 'unclassified'} | {_fmt(row.amount)} | {'yes' if row.include_in_metric else 'no'} | {row.status} |"
            )

    if marketing_trend:
        lines.extend(
            [
                "",
                "## Notes",
                "",
                "- Marketing trend is assembled from classified marketing ledger classes only.",
                "- Ledger drill-down is intentionally omitted for multi-month trends unless a specific month is requested.",
            ]
        )
        if centralized_note:
            lines.append(f"- {centralized_note}")
    elif marketing_single_metric:
        lines.extend(
            [
                "",
                "## Notes",
                "",
                "- Marketing total is assembled from classified marketing ledger classes only.",
                "- Non-marketing classes are excluded from supporting evidence and totals.",
            ]
        )
        if centralized_note:
            lines.append(f"- {centralized_note}")
    else:
        lines.extend(["", "## Findings", ""])
        lines.extend(f"- {item}" for item in reasoning.findings)
        lines.extend(["", "## Caveats", ""])
        if reasoning.caveats:
            lines.extend(f"- {item}" for item in reasoning.caveats)
        else:
            lines.append("- None.")
    return "\n".join(lines)


def _fmt(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:,.2f}"


def _fmt_pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.2f}%"


def _fmt_delta(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:+,.2f}"


def _fmt_delta_pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:+.2f}%"


def _is_marketing_single_metric_query(requested_metrics: set[str]) -> bool:
    if not requested_metrics:
        return False
    marketing_aliases = {"marketing_costs", "ad_spend"}
    non_marketing = requested_metrics.difference(marketing_aliases).difference({"opex_total"})
    return not non_marketing and bool(requested_metrics.intersection(marketing_aliases))


def _is_marketing_trend_query(
    metric_pack: MetricPack,
    *,
    requested_metrics: set[str],
    intent_kind: str | None,
) -> bool:
    if intent_kind != "multi_period_metric_trend":
        return False
    if not _is_marketing_single_metric_query(requested_metrics):
        return False
    return any(row.marketing_cost_total is not None for row in metric_pack.monthly_rows)


def _marketing_trend_rows(metric_pack: MetricPack):
    return [
        row
        for row in metric_pack.monthly_rows
        if row.marketing_cost_total is not None
    ]
