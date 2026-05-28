from __future__ import annotations

from typing import Any

from ..contracts import MetricPack


def build_finance_evidence_pack(
    *,
    metric_pack: MetricPack | None = None,
    resolved_rows: list[dict[str, Any]] | None = None,
    variance_pack: dict[str, Any] | None = None,
    anomaly_pack: dict[str, Any] | None = None,
    forecast_pack: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Stitches deterministic sub-packs for LLM or board composer. Does not recompute values.
    """
    comp: dict[str, Any] = {
        "version": 1,
    }
    if metric_pack is not None:
        comp["metric_pack_period"] = metric_pack.period
        comp["gaps"] = list(metric_pack.gaps or [])
    if resolved_rows is not None:
        comp["resolved_row_count"] = len(resolved_rows)
    if variance_pack is not None:
        comp["variance_type"] = variance_pack.get("comparison_type")
    if anomaly_pack is not None:
        comp["anomaly_flag_count"] = len(anomaly_pack.get("flags") or [])
    if forecast_pack is not None:
        comp["forecast_caveat_count"] = len(forecast_pack.get("caveats") or [])
    return {
        "version": 1,
        "has_metric_pack": metric_pack is not None,
        "has_resolved": resolved_rows is not None and len(resolved_rows) > 0,
        "has_variance": variance_pack is not None,
        "has_anomaly": anomaly_pack is not None,
        "has_forecast": forecast_pack is not None,
        "summary": comp,
    }
