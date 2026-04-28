from __future__ import annotations

from typing import Any

from ..registry_loader import get_anomaly_rules


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _eval_rule(
    *,
    rule: dict[str, Any],
    current: dict[str, Any],
    prior: dict[str, Any],
    entity_label: str,
) -> dict[str, Any] | None:
    metric = str(rule.get("metric", ""))
    check = str(rule.get("check", "")).strip()
    cur, ref = _to_float(current.get(metric)), _to_float(prior.get(metric))
    if cur is None or ref is None:
        return None
    if check == "relative_drop_vs_prior":
        th = float(rule.get("min_change_pct", 0) or 0)
        if ref in (0, 0.0) or ref < 0:
            return None
        drop = (ref - cur) / ref
        if drop < th or cur > ref:
            return None
        return {
            "anomaly_id": str(rule.get("anomaly_id", "unknown")),
            "metric": metric,
            "severity": str(rule.get("severity", "medium")),
            "message": f"{metric} fell more than {th:.0%} vs prior (MoM) for {entity_label or 'scope'}.",
            "entity": entity_label,
            "current": cur,
            "reference": ref,
            "threshold": f">= {th:.0%} relative drop",
        }
    if check == "relative_increase_vs_prior":
        th = float(rule.get("min_change_pct", 0) or 0)
        if ref in (0, 0.0) or ref < 0:
            return None
        increase = (cur - ref) / ref
        if increase < th or cur <= ref:
            return None
        return {
            "anomaly_id": str(rule.get("anomaly_id", "unknown")),
            "metric": metric,
            "severity": str(rule.get("severity", "medium")),
            "message": f"{metric} rose more than {th:.0%} vs prior (MoM) for {entity_label or 'scope'}.",
            "entity": entity_label,
            "current": cur,
            "reference": ref,
            "threshold": f">= {th:.0%} relative increase",
        }
    if check == "absolute_drop_points_vs_prior":
        th = float(rule.get("min_change_points", 0) or 0)
        drop = ref - cur
        if drop < th or cur > ref:
            return None
        return {
            "anomaly_id": str(rule.get("anomaly_id", "unknown")),
            "metric": metric,
            "severity": str(rule.get("severity", "medium")),
            "message": f"{metric} fell by more than {th} points vs prior (MoM) for {entity_label or 'scope'}.",
            "entity": entity_label,
            "current": cur,
            "reference": ref,
            "threshold": f">= {th} absolute drop",
        }
    return None


def detect_month_over_month_anomalies(
    current: dict[str, Any],
    prior: dict[str, Any],
    *,
    entity: str = "",
) -> dict[str, Any]:
    """Rule-based flags from a single entity's current and prior month resolved metrics."""
    rules_payload = get_anomaly_rules()
    version = int(rules_payload.get("version") or 0)
    flags: list[dict[str, Any]] = []
    entity_label = str(entity or current.get("business_unit") or prior.get("business_unit") or "")
    for rule in list(rules_payload.get("rules") or []):
        if not isinstance(rule, dict):
            continue
        hit = _eval_rule(rule=rule, current=current, prior=prior, entity_label=entity_label)
        if hit is not None:
            flags.append(hit)
    caveats: list[str] = []
    for mk in ("revenue", "cogs", "roas", "gross_margin_pct", "centralized_roas", "marketing_cost"):
        if current.get(mk) is None or prior.get(mk) is None:
            caveats.append(f"{mk}_partial_history")
    return {
        "source_rules_version": version,
        "flags": flags,
        "caveats": sorted(set(c for c in caveats if c)),
    }


def detect_series_anomalies(
    values_by_period: list[tuple[str, dict[str, Any]]],
    *,
    rule_metric: str,
    min_change_pct: float,
    check: str = "relative_increase_vs_prior",
) -> dict[str, Any]:
    """Consecutive-period scan for a single series (e.g. custom workshop / freight if present)."""
    if len(values_by_period) < 2:
        return {
            "source_rules_version": 0,
            "flags": [],
            "caveats": ["insufficient history for series anomaly check"],
        }
    flags: list[dict[str, Any]] = []
    for i in range(1, len(values_by_period)):
        p0, p1 = values_by_period[i - 1], values_by_period[i]
        prior, current = p0[1], p1[1]
        r = {
            "anomaly_id": f"series_{rule_metric}_{i}",
            "metric": rule_metric,
            "check": check,
            "min_change_pct": min_change_pct,
            "min_change_points": 0,
            "severity": "medium",
        }
        hit = _eval_rule(
            rule=r, current=current, prior=prior, entity_label=str(current.get("business_unit", ""))
        )
        if hit is not None:
            hit["anomaly_id"] = str(r.get("anomaly_id"))
            hit["message"] = f"{rule_metric} between {p0[0]} and {p1[0]}: {hit.get('message', '')}"
            flags.append(hit)
    return {"source_rules_version": 1, "flags": flags, "caveats": []}
