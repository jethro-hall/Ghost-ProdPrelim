from __future__ import annotations

from typing import Any

from .contracts import MetricPack
from .intelligence import compare_entities
from .metrics import resolve_metrics_from_metric_pack


def build_phase2_payload(metric_pack: MetricPack) -> dict[str, Any]:
    """
    Deterministic Phase 2: resolved metrics and optional cross-entity variance. No new math
    beyond resolver + comparison_engine (all config-backed in metrics/).
    """
    resolved = resolve_metrics_from_metric_pack(metric_pack)
    out: dict[str, Any] = {
        "version": 1,
        "resolved_metrics": resolved,
        "variance_pack": None,
    }
    if len(resolved) >= 2:
        out["variance_pack"] = compare_entities(
            _variance_rows(resolved),
            period_label=metric_pack.period,
        )
    return out


def _variance_rows(resolved: list[dict[str, Any]]) -> list[dict[str, Any]]:
    has_allocated_marketing = any(row.get("allocated_marketing_cost") is not None for row in resolved)
    if not has_allocated_marketing:
        return resolved
    keep = {
        "business_unit",
        "revenue",
        "cogs",
        "gross_profit",
        "gross_margin_pct",
        "allocated_marketing_cost",
        "contribution_margin",
        "revenue_roas",
        "gp_roas",
    }
    return [{key: row.get(key) for key in keep if key in row} for row in resolved]


def apply_phase2_resolved_metrics_to_metric_pack(metric_pack: MetricPack, phase2: dict[str, Any]) -> MetricPack:
    """Make the rendered MetricPack match the deterministic Phase 2 values."""
    by_bu = {
        str(row.get("business_unit") or "").strip().casefold(): row
        for row in list(phase2.get("resolved_metrics") or [])
        if isinstance(row, dict)
    }
    for row in metric_pack.rows:
        resolved = by_bu.get(str(row.business_unit or "").strip().casefold())
        if not resolved:
            row.net_profit = None
            continue
        allocated = resolved.get("allocated_marketing_cost", resolved.get("marketing_cost"))
        if allocated is not None:
            row.marketing_cost_total = float(allocated)
            row.ad_spend = float(allocated)
        revenue_roas = resolved.get("revenue_roas", resolved.get("roas"))
        row.roas = float(revenue_roas) if revenue_roas is not None else None
        row.revenue_roas = float(revenue_roas) if revenue_roas is not None else None
        gp_roas = resolved.get("gp_roas")
        row.gp_roas = float(gp_roas) if gp_roas is not None else None
        gross_margin_pct = resolved.get("gross_margin_pct")
        row.gross_margin_pct = float(gross_margin_pct) if gross_margin_pct is not None else row.gross_margin_pct
        contribution_margin = resolved.get("contribution_margin")
        row.contribution_margin = float(contribution_margin) if contribution_margin is not None else None
        # Net profit is blocked until defined; do not render near-zero accounting residue.
        row.net_profit = None
    return metric_pack


def format_phase2_markdown_append(phase2: dict[str, Any] | None) -> str:
    """
    Appended to MAS board markdown so chat surfaces Phase 2 without LLM recompute.
    """
    if not phase2 or not phase2.get("resolved_metrics"):
        return ""
    rows: list[dict[str, Any]] = phase2.get("resolved_metrics") or []
    if not rows:
        return ""
    has_allocated_marketing = any(row.get("allocated_marketing_cost") is not None for row in rows)
    # Collect union of keys in stable order
    keys: list[str] = []
    preferred = (
        "business_unit",
        "revenue",
        "cogs",
        "gross_profit",
        "gross_margin_pct",
        "centralized_marketing_pool",
        "allocation_method",
        "allocation_share",
        "allocated_marketing_cost",
        "contribution_margin",
        "revenue_roas",
        "gp_roas",
        "roas_mode",
    )
    excluded = {"net_profit"}
    if has_allocated_marketing:
        excluded.update({"marketing_cost", "roas", "centralized_roas"})
    seen: set[str] = set()
    for k in preferred:
        if k not in excluded and any(k in r and r.get(k) is not None for r in rows):
            keys.append(k)
            seen.add(k)
    for r in rows:
        for k in r:
            if k not in seen and k not in excluded and r.get(k) is not None:
                keys.append(k)
                seen.add(k)

    def _cell(v: object) -> str:
        if v is None:
            return "—"
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            s = f"{float(v):.4f}"
            s = s.rstrip("0").rstrip(".")
            return s if s not in ("", "-") else "0"
        return str(v)

    head = " | ".join(k.replace("_", " ") for k in keys)
    sep = " | ".join("---" for _ in keys)
    body: list[str] = []
    for r in rows:
        body.append(" | ".join(_cell(r.get(k)) for k in keys))
    table = "\n".join([head, sep] + body)
    out = (
        "\n\n---\n## Finance intelligence (Phase 2 — deterministic)\n"
        + "_Derived in code from the same metric pack as above. Not recomputed by the model._\n\n"
        + f"{table}\n"
    )
    var = phase2.get("variance_pack")
    if var and str(var.get("comparison_type") or "") == "entity_vs_entity":
        spreads = var.get("metric_spreads") or {}
        if spreads:
            out += "\n**Entity spread (max − min, same period):** "
            parts: list[str] = []
            for m, s in list(spreads.items())[:8]:
                sp = s.get("spread")
                if sp is not None and isinstance(sp, (int, float)):
                    parts.append(f"{m}={sp:g}")
            out += ", ".join(parts) if parts else "—"
            out += "\n"
    return out
