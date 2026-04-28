from __future__ import annotations


def calculate_gross_profit(revenue: float | None, cogs: float | None) -> float | None:
    if revenue is None or cogs is None:
        return None
    return float(revenue) - float(cogs)


def calculate_gross_margin_pct(gross_profit: float | None, revenue: float | None) -> float | None:
    if gross_profit is None or revenue in (None, 0):
        return None
    return float(gross_profit) / float(revenue)


def calculate_contribution_margin(gross_profit: float | None, marketing_cost: float | None) -> float | None:
    if gross_profit is None or marketing_cost is None:
        return None
    return float(gross_profit) - float(marketing_cost)


def calculate_roas(revenue: float | None, marketing_cost: float | None) -> float | None:
    if revenue is None or marketing_cost in (None, 0):
        return None
    return float(revenue) / float(marketing_cost)
