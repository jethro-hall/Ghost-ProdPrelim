from __future__ import annotations

from .anomaly_engine import detect_month_over_month_anomalies, detect_series_anomalies
from .comparison_engine import compare_entities, compare_month_over_month
from .evidence_pack_builder import build_finance_evidence_pack
from .forecast_engine import (
    build_metric_series,
    flat_last_actual,
    forecast_from_history,
    linear_trend_next,
    trailing_average,
)

__all__ = [
    "build_finance_evidence_pack",
    "build_metric_series",
    "compare_entities",
    "compare_month_over_month",
    "detect_month_over_month_anomalies",
    "detect_series_anomalies",
    "flat_last_actual",
    "forecast_from_history",
    "linear_trend_next",
    "trailing_average",
]
