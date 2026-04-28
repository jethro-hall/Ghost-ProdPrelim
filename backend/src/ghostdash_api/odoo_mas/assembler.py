from __future__ import annotations

from .contracts import MetricPack, MetricRow, MonthlyMetricRow, NormalizedReport, OpexLedgerRow
from .registry_loader import get_policy_config

MARKETING_EVIDENCE_CLASSES = {"marketing_direct", "merchant_fees", "marketing_wages", "business_advisor"}


def build_metric_pack(reports: list[NormalizedReport]) -> MetricPack:
    default_policy = dict(get_policy_config())
    effective_policy = _resolve_effective_policy(default_policy=default_policy, reports=reports)
    rows_by_key: dict[str, MetricRow] = {}
    monthly_rows: list[MonthlyMetricRow] = []
    ledger_rows: list[OpexLedgerRow] = []
    confidence: dict[str, str] = {}
    gaps: list[str] = []

    for report in reports:
        requested_units = [
            _canonicalize_business_unit_label(str(item))
            for item in list(report.metadata.get("requested_business_units") or [])
            if str(item).strip()
        ]
        row_label = requested_units[0] if requested_units else _canonicalize_business_unit_label(report.dimension_scope.get("business_unit", "group"))
        row_key = row_label.casefold()
        row = rows_by_key.get(row_key) or MetricRow(business_unit=row_label)
        rows_by_key[row_key] = row
        values = {line.code: line.value for line in report.lines}
        if values.get("revenue") is not None:
            row.revenue = values.get("revenue")
        if values.get("cogs") is not None:
            row.cogs = values.get("cogs")
        if values.get("gross_profit") is not None:
            row.gross_profit = values.get("gross_profit")
        if values.get("net_profit") is not None:
            row.net_profit = values.get("net_profit")
        if values.get("ad_spend") is not None:
            row.ad_spend = values.get("ad_spend")
        if row.ad_spend is None:
            row.ad_spend = values.get("marketing_costs") if values.get("marketing_costs") is not None else row.ad_spend
        row.marketing_cost_total = row.ad_spend
        if row.ad_spend is not None:
            row.ad_spend = _apply_output_sign_policy(float(row.ad_spend), effective_policy=effective_policy)
            row.marketing_cost_total = row.ad_spend
        row.roas = values.get("roas")

        if row.gross_profit is None and row.revenue is not None and row.cogs is not None:
            row.gross_profit = row.revenue - row.cogs
        if row.roas is None and row.revenue is not None and row.ad_spend not in (None, 0):
            row.roas = row.revenue / float(row.ad_spend)

        has_scalar_values = any(
            value is not None
            for value in (row.revenue, row.cogs, row.gross_profit, row.net_profit, row.ad_spend, row.roas)
        )
        for monthly in list(report.metadata.get("monthly_rows") or []):
            if not isinstance(monthly, dict):
                continue
            monthly_rows.append(
                MonthlyMetricRow(
                    business_unit=_canonicalize_business_unit_label(str(monthly.get("business_unit") or row.business_unit)),
                    month=str(monthly.get("month") or "unknown"),
                    revenue=_to_float(monthly.get("revenue")),
                    cogs=_to_float(monthly.get("cogs")),
                    gross_profit=_to_float(monthly.get("gross_profit")),
                    gross_margin_pct=_to_float(monthly.get("gross_margin_pct")),
                )
            )
        for ledger in list(report.metadata.get("ledger_rows") or []):
            if not isinstance(ledger, dict):
                continue
            amount = _to_float(ledger.get("amount"))
            if amount is None:
                continue
            account_name = str(ledger.get("account") or "unknown")
            account_class = str(ledger.get("account_class") or "").strip() or None
            if account_class not in MARKETING_EVIDENCE_CLASSES:
                continue
            include_in_metric = _include_ledger_row_in_metric(
                account_class=account_class,
                account_name=account_name,
                account_code=_to_int(ledger.get("account_code")),
                include_flag=bool(ledger.get("include_in_metric", False)),
                effective_policy=effective_policy,
            )
            ledger_rows.append(
                OpexLedgerRow(
                    business_unit=_canonicalize_business_unit_label(str(ledger.get("business_unit") or row.business_unit)),
                    month=str(ledger.get("month") or "unknown"),
                    account=account_name,
                    amount=_apply_output_sign_policy(amount, effective_policy=effective_policy),
                    account_class=account_class,
                    include_in_metric=include_in_metric,
                    status=str(ledger.get("status") or "active_in_period"),
                )
            )

    marketing_spend_by_bu: dict[str, float] = {}
    marketing_spend_by_month: dict[tuple[str, str], float] = {}
    business_unit_labels: dict[str, str] = {}
    for report in reports:
        target_units = [
            _canonicalize_business_unit_label(str(item))
            for item in list(report.metadata.get("requested_business_units") or [])
            if str(item).strip()
        ]
        if not target_units:
            target_units = [
                _canonicalize_business_unit_label(report.dimension_scope.get("business_unit", "group"))
            ]
        for target in target_units:
            business_unit_labels[str(target or "").strip().casefold()] = target
        for ledger in list(report.metadata.get("ledger_rows") or []):
            if not isinstance(ledger, dict):
                continue
            account_class = str(ledger.get("account_class") or "").strip() or None
            if account_class not in MARKETING_EVIDENCE_CLASSES:
                continue
            include_in_metric = _include_ledger_row_in_metric(
                account_class=account_class,
                account_name=str(ledger.get("account") or ""),
                account_code=_to_int(ledger.get("account_code")),
                include_flag=bool(ledger.get("include_in_metric", False)),
                effective_policy=effective_policy,
            )
            if not include_in_metric:
                continue
            amount = _to_float(ledger.get("amount"))
            if amount is None:
                continue
            signed_amount = _apply_output_sign_policy(amount, effective_policy=effective_policy)
            month = str(ledger.get("month") or report.period.date_from[:7] or "unknown")
            for target in target_units:
                key = str(target or "").strip().casefold()
                marketing_spend_by_bu[key] = marketing_spend_by_bu.get(key, 0.0) + float(signed_amount)
                marketing_spend_by_month[(key, month)] = marketing_spend_by_month.get((key, month), 0.0) + float(signed_amount)
    if marketing_spend_by_bu:
        for row in rows_by_key.values():
            key = str(row.business_unit or "").strip().casefold()
            if key in marketing_spend_by_bu:
                row.marketing_cost_total = marketing_spend_by_bu[key]
                row.ad_spend = marketing_spend_by_bu[key]
                if row.revenue not in (None, 0) and row.ad_spend not in (None, 0):
                    row.roas = float(row.revenue) / float(row.ad_spend)

    monthly_rows.extend(
        _build_marketing_monthly_rows(
            marketing_spend_by_month=marketing_spend_by_month,
            business_unit_labels=business_unit_labels,
        )
    )
    monthly_rows = _annotate_marketing_monthly_changes(monthly_rows)
    rows = [row for row in rows_by_key.values() if _row_has_scalar_values(row)]

    for metric in ("revenue", "cogs", "gross_profit", "net_profit", "marketing_cost_total", "roas"):
        metric_values = [getattr(row, metric) for row in rows]
        if any(value is not None for value in metric_values):
            confidence[metric] = "high" if all(value is not None for value in metric_values) else "medium"
        else:
            confidence[metric] = "low"
            gaps.append(f"missing:{metric}")

    if any(row.roas is None for row in rows):
        gaps.append("roas_status:unavailable")

    period = _resolve_metric_pack_period(reports=reports, monthly_rows=monthly_rows)
    return MetricPack(
        period=period,
        rows=rows,
        monthly_rows=monthly_rows,
        ledger_rows=ledger_rows,
        confidence=confidence,
        gaps=sorted(set(gaps)),
    )


def _to_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: object) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _resolve_effective_policy(*, default_policy: dict[str, object], reports: list[NormalizedReport]) -> dict[str, object]:
    effective = dict(default_policy)
    allowed_keys = set(str(item) for item in list(default_policy.get("allowed_override_keys") or []))
    for report in reports:
        overrides = report.metadata.get("policy_overrides")
        if not isinstance(overrides, dict):
            continue
        for key, value in overrides.items():
            if str(key) in allowed_keys:
                effective[str(key)] = value
    return effective


def _apply_output_sign_policy(amount: float, *, effective_policy: dict[str, object]) -> float:
    if str(effective_policy.get("output_sign_mode") or "").strip().casefold() == "absolute":
        return abs(float(amount))
    return float(amount)


def _include_ledger_row_in_metric(
    *,
    account_class: str | None,
    account_name: str,
    account_code: int | None,
    include_flag: bool,
    effective_policy: dict[str, object],
) -> bool:
    if account_class != "marketing_direct":
        return False
    if not include_flag:
        return False
    if (
        not bool(effective_policy.get("include_merchant_fees_in_marketing", False))
        and _is_merchant_fee_account(
            account_name=account_name,
            account_code=account_code,
            merchant_terms=list(effective_policy.get("merchant_fee_match_terms") or []),
        )
    ):
        return False
    if (
        not bool(effective_policy.get("include_marketing_wages_in_marketing", False))
        and _is_marketing_wage_account(
            account_name=account_name,
            account_code=account_code,
            wage_terms=list(effective_policy.get("marketing_wage_match_terms") or []),
        )
    ):
        return False
    # Centralized policy can still forcefully disable marketing aggregation.
    if str(effective_policy.get("marketing_mode") or "").strip().casefold() not in {"", "centralized"}:
        return False
    return True


def _is_merchant_fee_account(*, account_name: str, account_code: int | None, merchant_terms: list[str]) -> bool:
    normalized = str(account_name or "").casefold()
    if account_code in {445, 519, 523, 526}:
        return True
    return any(str(term).casefold() in normalized for term in merchant_terms if str(term).strip())


def _is_marketing_wage_account(*, account_name: str, account_code: int | None, wage_terms: list[str]) -> bool:
    normalized = str(account_name or "").casefold()
    if account_code in {510}:
        return True
    return any(str(term).casefold() in normalized for term in wage_terms if str(term).strip())


def _canonicalize_business_unit_label(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "group"
    return " ".join(raw.split()).title()


def _build_marketing_monthly_rows(
    *,
    marketing_spend_by_month: dict[tuple[str, str], float],
    business_unit_labels: dict[str, str],
) -> list[MonthlyMetricRow]:
    rows: list[MonthlyMetricRow] = []
    for (business_unit_key, month), amount in sorted(marketing_spend_by_month.items(), key=lambda item: (item[0][0], item[0][1])):
        rows.append(
            MonthlyMetricRow(
                business_unit=business_unit_labels.get(business_unit_key, "group"),
                month=month,
                marketing_cost_total=amount,
            )
        )
    return rows


def _annotate_marketing_monthly_changes(monthly_rows: list[MonthlyMetricRow]) -> list[MonthlyMetricRow]:
    annotated = sorted(monthly_rows, key=lambda row: (str(row.business_unit).casefold(), row.month))
    previous_by_business_unit: dict[str, float] = {}
    for row in annotated:
        if row.marketing_cost_total is None:
            continue
        business_unit_key = str(row.business_unit or "").strip().casefold()
        previous = previous_by_business_unit.get(business_unit_key)
        if previous is not None:
            change = float(row.marketing_cost_total) - previous
            row.change_vs_prior_month = change
            row.pct_change_vs_prior_month = (change / previous) if previous != 0 else None
        previous_by_business_unit[business_unit_key] = float(row.marketing_cost_total)
    return annotated


def _resolve_metric_pack_period(*, reports: list[NormalizedReport], monthly_rows: list[MonthlyMetricRow]) -> str:
    months = sorted({row.month for row in monthly_rows if isinstance(row.month, str) and len(row.month) == 7})
    if months:
        if len(months) == 1:
            return months[0]
        return f"{months[0]} to {months[-1]}"
    if not reports:
        return "unknown"
    starts = sorted({report.period.date_from[:7] for report in reports if report.period.date_from})
    if not starts:
        return "unknown"
    if len(starts) == 1:
        return starts[0]
    return f"{starts[0]} to {starts[-1]}"


def _row_has_scalar_values(row: MetricRow) -> bool:
    return any(
        value is not None
        for value in (row.revenue, row.cogs, row.gross_profit, row.net_profit, row.marketing_cost_total, row.ad_spend, row.roas)
    )
