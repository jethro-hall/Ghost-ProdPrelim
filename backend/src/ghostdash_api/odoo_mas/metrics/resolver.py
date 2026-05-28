from __future__ import annotations

from typing import Any

from ..contracts import MetricPack
from ..registry_loader import get_policy_config
from .definitions import get_metric_definitions
from .formulas import calculate_contribution_margin, calculate_gross_margin_pct, calculate_gross_profit, calculate_roas


def resolve_metrics_from_metric_pack(metric_pack: MetricPack) -> list[dict[str, Any]]:
    definitions = dict(get_metric_definitions().get("metrics") or {})
    policy = get_policy_config()
    resolved: list[dict[str, Any]] = []
    for row in metric_pack.rows:
        revenue = _to_float(row.revenue)
        cogs = _to_float(row.cogs)
        gross_profit = _to_float(row.gross_profit)
        marketing_cost = _to_float(row.marketing_cost_total)
        net_profit = _to_float(row.net_profit)
        if not _is_metric_enabled(definitions, "net_profit"):
            net_profit = None

        if gross_profit is None and _is_metric_enabled(definitions, "gross_profit"):
            gross_profit = calculate_gross_profit(revenue, cogs)

        gross_margin_pct = None
        if _is_metric_enabled(definitions, "gross_margin_pct"):
            gross_margin_pct = calculate_gross_margin_pct(gross_profit, revenue)

        contribution_margin = None
        if _is_metric_enabled(definitions, "contribution_margin"):
            contribution_margin = calculate_contribution_margin(gross_profit, marketing_cost)

        roas = None
        if _is_metric_enabled(definitions, "roas"):
            roas = calculate_roas(revenue, marketing_cost)

        resolved.append(
            {
                "business_unit": row.business_unit,
                "revenue": revenue,
                "cogs": cogs,
                "gross_profit": gross_profit,
                "gross_margin_pct": gross_margin_pct,
                "marketing_cost": marketing_cost,
                "contribution_margin": contribution_margin,
                "roas": roas,
                "net_profit": net_profit,
            }
        )
    return _apply_centralized_roas(resolved, definitions, policy)


def _apply_centralized_roas(
    rows: list[dict[str, Any]], definitions: dict[str, Any], policy: dict[str, Any]
) -> list[dict[str, Any]]:
    roas_cfg = dict(definitions.get("roas") or {})
    for r in rows:
        r["centralized_roas"] = None
        r["roas_mode"] = None
    if str(roas_cfg.get("mode", "")).strip() != "central_marketing_vs_entity_revenue":
        for r in rows:
            r["centralized_roas"] = r.get("roas")
            r["roas_mode"] = "row_marketing_in_denominator" if r.get("roas") is not None else None
        return rows
    if str(policy.get("marketing_mode", "")).strip().casefold() != "centralized":
        for r in rows:
            r["centralized_roas"] = r.get("roas")
            r["roas_mode"] = "not_centralized"
        return rows
    pe = str(policy.get("primary_entity", "")).strip().casefold()
    if not pe:
        for r in rows:
            r["centralized_roas"] = r.get("roas")
        return rows
    central: float | None = None
    for r in rows:
        if _is_primary_business_unit(str(r.get("business_unit", "")), pe):
            m = r.get("marketing_cost")
            if m is not None:
                central = float(m)
                break
    if central in (None, 0) or central == 0.0:
        cands: list[float] = []
        for r in rows:
            m = r.get("marketing_cost")
            if m is not None and float(m) > 0:
                cands.append(float(m))
        if cands:
            central = max(cands)
    allocation_method = str(policy.get("centralized_marketing_allocation_method") or "revenue_weighted").strip().casefold()
    bases: list[float] = []
    for r in rows:
        if allocation_method == "gross_profit_weighted":
            basis = _positive_float(r.get("gross_profit"))
        elif allocation_method == "equal_split":
            basis = 1.0
        else:
            allocation_method = "revenue_weighted"
            basis = _positive_float(r.get("revenue"))
        bases.append(basis or 0.0)
    total_basis = sum(bases)
    for idx, r in enumerate(rows):
        rev = _to_float(r.get("revenue"))
        gp = _to_float(r.get("gross_profit"))
        allocated = None
        share = None
        if central is not None and float(central) not in (0, 0.0) and total_basis not in (0, 0.0):
            share = bases[idx] / total_basis
            allocated = float(central) * share
        revenue_roas = calculate_roas(rev, allocated)
        gp_roas = calculate_roas(gp, allocated)
        contribution_margin = calculate_contribution_margin(gp, allocated)
        r["centralized_marketing_pool"] = float(central) if central is not None else None
        r["allocation_method"] = allocation_method
        r["allocation_basis"] = "gross_profit" if allocation_method == "gross_profit_weighted" else ("entity_count" if allocation_method == "equal_split" else "revenue")
        r["allocation_share"] = share
        r["allocated_marketing_cost"] = allocated
        r["marketing_cost"] = allocated
        r["contribution_margin"] = contribution_margin
        r["revenue_roas"] = revenue_roas
        r["gp_roas"] = gp_roas
        r["roas"] = revenue_roas
        r["centralized_roas"] = revenue_roas
        r["roas_mode"] = "central_marketing_allocated"
    return rows


def _is_primary_business_unit(business_unit: str, primary_entity: str) -> bool:
    p = str(primary_entity or "").strip().casefold()
    if not p:
        return False
    b = " ".join(str(business_unit or "").split()).casefold()
    if b == f"ride electric {p}":
        return True
    if p == "retail" and b == "ride electric retail":
        return True
    return False


def _is_metric_enabled(definitions: dict[str, Any], metric_name: str) -> bool:
    metric_cfg = dict(definitions.get(metric_name) or {})
    if not metric_cfg:
        return False
    if str(metric_cfg.get("status") or "").strip().casefold() == "blocked_until_defined":
        return False
    return True


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _positive_float(value: Any) -> float | None:
    parsed = _to_float(value)
    if parsed is None or parsed < 0:
        return None
    return parsed
