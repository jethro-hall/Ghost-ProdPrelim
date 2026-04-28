from __future__ import annotations

from typing import Any

STANDARD_METRICS: tuple[str, ...] = (
    "revenue",
    "cogs",
    "gross_profit",
    "gross_margin_pct",
    "marketing_cost",
    "contribution_margin",
    "roas",
    "centralized_roas",
    "net_profit",
)


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _metric_keys_in_rows(resolved_rows: list[dict[str, Any]]) -> list[str]:
    found: set[str] = set()
    for r in resolved_rows:
        for k in STANDARD_METRICS:
            if k in r:
                found.add(k)
    return [k for k in STANDARD_METRICS if k in found]


def compare_entities(
    resolved_rows: list[dict[str, Any]],
    *,
    label_key: str = "business_unit",
    period_label: str = "unknown",
) -> dict[str, Any]:
    """Build a VariancePack-shaped dict for side-by-side entity comparison.

    All inputs must be Phase 2 resolved metric dicts (deterministic; no new math here).
    """
    caveats: list[str] = []
    if len(resolved_rows) < 2:
        caveats.append("entity_vs_entity: fewer than two rows; spreads are limited.")
    metrics = _metric_keys_in_rows(resolved_rows)
    entity_table: dict[str, dict[str, float | None]] = {}
    for r in resolved_rows:
        label = str(r.get(label_key) or "unknown")
        entity_table[label] = {m: _to_float(r.get(m)) for m in metrics}
    metric_spreads: dict[str, Any] = {}
    for m in metrics:
        nums: list[tuple[str, float]] = []
        for ent, row in entity_table.items():
            v = row.get(m)
            if v is not None:
                nums.append((ent, v))
        if len(nums) < 2:
            continue
        vmin = min(nums, key=lambda x: x[1])
        vmax = max(nums, key=lambda x: x[1])
        metric_spreads[m] = {
            "min": {"entity": vmin[0], "value": vmin[1]},
            "max": {"entity": vmax[0], "value": vmax[1]},
            "spread": float(vmax[1] - vmin[1]),
        }
    pairwise: list[dict[str, Any]] = []
    labels = list(entity_table.keys())
    for i, a in enumerate(labels):
        for b in labels[i + 1 :]:
            for m in metrics:
                va, vb = entity_table[a].get(m), entity_table[b].get(m)
                if va is None or vb is None:
                    continue
                delta = float(va) - float(vb)
                denom = float(vb) if vb not in (0, 0.0) else None
                pct = (delta / denom) if denom is not None and denom != 0.0 else None
                pairwise.append(
                    {
                        "a": a,
                        "b": b,
                        "metric": m,
                        "delta_abs": delta,
                        "delta_pct": pct,
                    }
                )
    return {
        "comparison_type": "entity_vs_entity",
        "period_label": period_label,
        "caveats": caveats,
        "entity_table": entity_table,
        "metric_spreads": metric_spreads,
        "pairwise_deltas": pairwise,
    }


def compare_month_over_month(
    current: dict[str, Any],
    prior: dict[str, Any],
    *,
    current_period: str,
    prior_period: str,
) -> dict[str, Any]:
    """Per-entity (or per-scope) current vs prior month. Expects the same keys on both dicts."""
    shared = set(current.keys()) & set(prior.keys()) - {str(k) for k in ("period", "business_unit")}
    changes: dict[str, Any] = {}
    for k in sorted(shared):
        c_f, p_f = _to_float(current.get(k)), _to_float(prior.get(k))
        if c_f is None and p_f is None:
            continue
        if c_f is None or p_f is None:
            changes[k] = {"current": c_f, "prior": p_f, "delta": None, "pct_change": None}
            continue
        delta = c_f - p_f
        pct = (delta / p_f) if p_f not in (0, 0.0) else None
        changes[k] = {
            "current": c_f,
            "prior": p_f,
            "delta": delta,
            "pct_change": pct,
        }
    return {
        "comparison_type": "month_over_month",
        "period_label": current_period,
        "context": {"prior_period": prior_period, "entity": str(current.get("business_unit", prior.get("business_unit", "")))},
        "caveats": [],
        "changes": changes,
    }
