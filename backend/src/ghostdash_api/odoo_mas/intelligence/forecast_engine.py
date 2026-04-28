from __future__ import annotations

from typing import Any

from ..registry_loader import get_forecast_rules


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def trailing_average(values: list[float | None], n: int) -> float | None:
    """Last n **defined** values (non-None) — requires at least n non-null samples."""
    nums: list[float] = []
    for v in values:
        if v is not None:
            nums.append(float(v))
    if len(nums) < n:
        return None
    return float(sum(nums[-n:]) / n)


def flat_last_actual(values: list[float | None]) -> float | None:
    for v in reversed(values):
        if v is not None:
            return float(v)
    return None


def linear_trend_next(
    y_values: list[float | None],
) -> float | None:
    """Extrapolate one step forward using OLS; requires 6+ numeric points in rules default."""
    pts: list[tuple[int, float]] = []
    for i, y in enumerate(y_values):
        v = _to_float(y)
        if v is not None:
            pts.append((len(pts), v))
    if len(pts) < 2:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    n = float(len(pts))
    x_bar = sum(xs) / n
    y_bar = sum(ys) / n
    sxx = sum((x - x_bar) ** 2 for x in xs)
    if sxx in (0, 0.0):
        return None
    sxy = sum((xs[i] - x_bar) * (ys[i] - y_bar) for i in range(len(pts)))
    b = sxy / sxx
    a = y_bar - b * x_bar
    # next x index is max(xs) + 1? Use sequential 0..len(pts) so next is len(pts)
    x_next = max(xs) + 1
    return float(a + b * x_next)


def build_metric_series(
    values_by_period: list[tuple[str, dict[str, Any]]], metric: str
) -> list[tuple[str, float | None]]:
    out: list[tuple[str, float | None]] = []
    for period, payload in values_by_period:
        out.append((period, _to_float(payload.get(metric))))
    return out


def forecast_from_history(
    values_by_period: list[tuple[str, dict[str, Any]]],
    metrics: list[str],
    method: str | None = None,
    horizon: int = 3,
) -> dict[str, Any]:
    """
    `values_by_period` must be sorted by period (YYYY-MM).
    Produces a ForecastPack-shaped dict. Does not fabricate data — insufficient history is surfaced as caveats.
    """
    rules = get_forecast_rules()
    eff_method = (method or str(rules.get("default_method", "trailing_average_3m") or "trailing_average_3m")).strip()
    min3 = int(rules.get("min_periods_for_trailing_3m", 3) or 3)
    min6 = int(rules.get("min_periods_for_trailing_6m", 6) or 6)
    min_lin = int(rules.get("min_periods_for_linear_trend", 6) or 6)
    allow_short = bool(rules.get("allow_short_history_override", False))

    caveats: list[str] = []
    forecasts: list[dict[str, Any]] = []
    series_by_metric: dict[str, list[Any]] = {}

    for metric in metrics:
        series = [v for _p, v in build_metric_series(values_by_period, metric)]
        series_by_metric[metric] = series
        nums = [s for s in series if s is not None]
        n_valid = len(nums)
        if not allow_short and n_valid < min3:
            caveats.append(f"insufficient_history_for_forecast: {metric} (need>={min3} points)")
            forecasts.append({"label": f"{metric}_+1 (avg)", "value": None, "method": eff_method, "status": "blocked"})
            continue
        v_next: float | None = None
        status = "ok"
        if eff_method == "trailing_average_3m":
            v_next = trailing_average(series, min3) if n_valid >= min3 else None
        elif eff_method == "trailing_average_6m":
            v_next = trailing_average(series, min6) if n_valid >= min6 else None
            if v_next is None and n_valid >= min3 and not allow_short:
                caveats.append(f"trailing_6m not available for {metric}; {n_valid} points only")
        elif eff_method == "flat_last_actual":
            v_next = flat_last_actual(series)
        elif eff_method == "linear_trend":
            n_pts = len([s for s in series if s is not None])
            v_next = linear_trend_next(series) if n_pts >= min_lin else None
            if v_next is None and n_valid < min_lin and not allow_short:
                caveats.append(f"linear_trend not available for {metric}; need>={min_lin} points")
        else:
            caveats.append(f"unknown method {eff_method}")
            status = "error"
        if v_next is None and status == "ok":
            caveats.append(f"no_forecast_value_for: {metric}")
        forecasts.append(
            {
                "label": f"{metric}_+1 (avg)" if "trailing" in eff_method or eff_method == "flat_last_actual" else f"{metric}_+1 (trend)",
                "value": v_next,
                "method": eff_method,
                "status": "ok" if v_next is not None else "blocked",
            }
        )
    return {
        "method": eff_method,
        "horizon": int(horizon),
        "forecasts": forecasts,
        "series_by_metric": {k: v for k, v in series_by_metric.items() if v},
        "caveats": sorted(set(caveats)),
    }
