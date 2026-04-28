from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
import re
from typing import Any

from .contracts import IntentPayload, PeriodScope
from .registry_loader import get_dimension_registry


MONTH_ALIASES: dict[str, int] = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

MONTH_PATTERN = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
RANGE_SEP_PATTERN = r"(?:to|through(?:\s+to)?|until|till|til|-)"
LEDGER_STOPWORDS = {
    "show",
    "from",
    "through",
    "with",
    "only",
    "cost",
    "costs",
    "ledger",
    "search",
    "find",
    "retrieve",
    "for",
    "the",
    "and",
    "that",
    "this",
    "month",
    "monthly",
    "period",
    "where",
    "over",
    "between",
    "using",
    "odoo",
    "odo",
    "line",
    "lines",
    "opex",
    "total",
    "totals",
}


def _normalize_planning_text(message: str) -> str:
    lowered = (message or "").casefold()
    collapsed = re.sub(r"([a-z])\1{1,}", r"\1", lowered)
    replacements = {
        "maraketing": "marketing",
        "marketting": "marketing",
        "shopfy": "shopify",
        "finacial": "financial",
        "finanical": "financial",
        "financials": "financial",
    }
    normalized = collapsed
    for source, target in replacements.items():
        normalized = normalized.replace(source, target)
    normalized = normalized.replace("gros profit", "gross profit")
    normalized = normalized.replace("gros margin", "gross margin")
    return normalized


def _normalize_fiscal_year(value: str) -> int:
    raw = str(value or "").strip()
    if len(raw) == 4:
        return int(raw)
    if len(raw) == 2:
        candidate = int(raw)
        return 2000 + candidate if candidate < 70 else 1900 + candidate
    raise ValueError(f"Unsupported fiscal year token: {value}")


def _extract_fiscal_year_ranges(message: str) -> list[tuple[date, date, str]]:
    matches = re.finditer(r"\bfy\s*(\d{2,4})(?:\s*/\s*(\d{2,4}))?\b", message.casefold())
    ranges: list[tuple[date, date, str]] = []
    seen_labels: set[str] = set()
    for match in matches:
        first = _normalize_fiscal_year(match.group(1))
        second_raw = match.group(2)
        if second_raw:
            second = _normalize_fiscal_year(second_raw)
            start_year = first
            end_year = second
            label = f"FY{str(first)[-2:]}/{str(second)[-2:]}"
        else:
            end_year = first
            start_year = end_year - 1
            label = f"FY{str(end_year)[-2:]}"
        if end_year <= start_year:
            continue
        if label in seen_labels:
            continue
        seen_labels.add(label)
        ranges.append((date(start_year, 7, 1), date(end_year, 7, 1), label))
    ranges.sort(key=lambda item: item[0])
    return ranges


def _month_start(year: int, month: int) -> date:
    return date(year, month, 1)


def _month_end_exclusive(year: int, month: int) -> date:
    if month == 12:
        return date(year + 1, 1, 1)
    return date(year, month + 1, 1)


def _parse_month_token(token: str) -> int | None:
    return MONTH_ALIASES.get(str(token or "").strip().casefold())


def _parse_iso_date_range(text: str) -> tuple[date, date] | None:
    matches = re.findall(r"\b\d{4}-\d{2}-\d{2}\b", text)
    if len(matches) < 2:
        return None
    try:
        first = date.fromisoformat(matches[0])
        second = date.fromisoformat(matches[1])
    except ValueError:
        return None
    start, end = (first, second) if first <= second else (second, first)
    if start == end:
        return (start, start + timedelta(days=1))
    return (start, end + timedelta(days=1))


def _parse_named_date_range(text: str) -> tuple[date, date] | None:
    pattern = re.compile(
        rf"from\s+(\d{{1,2}})?\s*({MONTH_PATTERN})\s+(\d{{4}})\s+{RANGE_SEP_PATTERN}\s+(\d{{1,2}})?\s*({MONTH_PATTERN})\s+(\d{{4}})",
        re.IGNORECASE,
    )
    match = pattern.search(text)
    if not match:
        return None

    start_day_raw, start_month_raw, start_year_raw, end_day_raw, end_month_raw, end_year_raw = match.groups()
    start_month = _parse_month_token(start_month_raw)
    end_month = _parse_month_token(end_month_raw)
    if start_month is None or end_month is None:
        return None

    try:
        start_year = int(start_year_raw)
        end_year = int(end_year_raw)
        start_day = int(start_day_raw) if start_day_raw else 1
        start = date(start_year, start_month, start_day)
    except ValueError:
        return None

    if end_day_raw:
        try:
            end_inclusive = date(end_year, end_month, int(end_day_raw))
        except ValueError:
            return None
        end_exclusive = end_inclusive + timedelta(days=1)
    else:
        end_exclusive = _month_end_exclusive(end_year, end_month)

    if start >= end_exclusive:
        return None
    return (start, end_exclusive)


def _parse_single_month_scope(text: str, *, today: date) -> tuple[date, date] | None:
    match = re.search(rf"\b({MONTH_PATTERN})(?:\s+(\d{{4}}))?\b", text, re.IGNORECASE)
    if not match:
        return None
    month_raw, year_raw = match.groups()
    month = _parse_month_token(month_raw)
    if month is None:
        return None
    year = int(year_raw) if year_raw else (today.year if today.month >= month else today.year - 1)
    return (_month_start(year, month), _month_end_exclusive(year, month))


def _month_span_from_scope(period: PeriodScope) -> int:
    start = date.fromisoformat(period.date_from)
    end_exclusive = date.fromisoformat(period.date_to)
    end_inclusive = end_exclusive - timedelta(days=1)
    return ((end_inclusive.year - start.year) * 12 + (end_inclusive.month - start.month)) + 1


def _resolve_period_scope(message: str, *, now: date | None = None) -> PeriodScope:
    today = now or datetime.now(UTC).date()
    normalized = _normalize_planning_text(message)

    iso_range = _parse_iso_date_range(normalized)
    if iso_range is not None:
        return PeriodScope(date_from=iso_range[0].isoformat(), date_to=iso_range[1].isoformat())

    named_range = _parse_named_date_range(normalized)
    if named_range is not None:
        return PeriodScope(date_from=named_range[0].isoformat(), date_to=named_range[1].isoformat())

    fiscal_year_ranges = _extract_fiscal_year_ranges(normalized)
    if fiscal_year_ranges:
        return PeriodScope(
            date_from=fiscal_year_ranges[0][0].isoformat(),
            date_to=fiscal_year_ranges[-1][1].isoformat(),
        )

    if "last month" in normalized:
        month_end = _month_start(today.year, today.month)
        prev_year = month_end.year if month_end.month > 1 else month_end.year - 1
        prev_month = 12 if month_end.month == 1 else month_end.month - 1
        month_start = _month_start(prev_year, prev_month)
        return PeriodScope(date_from=month_start.isoformat(), date_to=month_end.isoformat())

    single_month = _parse_single_month_scope(normalized, today=today)
    if single_month is not None:
        return PeriodScope(date_from=single_month[0].isoformat(), date_to=single_month[1].isoformat())

    return PeriodScope(date_from=(today - timedelta(days=30)).isoformat(), date_to=(today + timedelta(days=1)).isoformat())


def _resolve_business_units(message: str) -> tuple[list[str], list[str]]:
    registry = get_dimension_registry()
    values = ((registry.get("business_unit") or {}).get("supported_values") or {})
    resolved: list[str] = []
    missing: list[str] = []
    text = _normalize_planning_text(message)
    for value in values.values():
        aliases = [str(item).casefold() for item in list(value.get("aliases") or [])]
        for alias in aliases:
            if alias and alias in text:
                resolved.append(str(value.get("value") or ""))
                break
    if not resolved and any(keyword in text for keyword in ("burleigh", "brisbane", "retail", "wholesale", "ebd")):
        missing.append("business_unit_mapping_missing")
    return sorted(set(filter(None, resolved))), missing


def _extract_ledger_terms(message: str) -> list[str]:
    text = _normalize_planning_text(message)
    quoted = [item.strip().casefold() for item in re.findall(r'"([^"]+)"', message or "") if item.strip()]
    tokens = re.findall(r"[a-z][a-z0-9_-]{2,}", text)
    dynamic_terms: list[str] = []
    for token in tokens:
        if token in LEDGER_STOPWORDS:
            continue
        if token in MONTH_ALIASES:
            continue
        if token.isdigit():
            continue
        dynamic_terms.append(token)
    if "marketing" in text and "marketing" not in dynamic_terms:
        dynamic_terms.append("marketing")
    return sorted(set([*quoted, *dynamic_terms]))[:8]


def _include_ledger_evidence_requested(text: str) -> bool:
    explicit_terms = (
        "include ledger",
        "include ledger lines",
        "ledger lines",
        "ledger evidence",
        "show ledger",
        "show supporting ledger",
        "drill down",
        "drill-down",
    )
    return any(term in text for term in explicit_terms)


def _is_multi_period_trend_request(text: str, *, period: PeriodScope) -> bool:
    span_months = _month_span_from_scope(period)
    if span_months <= 1:
        return False

    trend_terms = (
        "increase",
        "trend",
        "over time",
        "month over month",
        "mom",
        "month-by-month",
        "by month",
        "monthly values",
    )
    range_terms = (
        "from ",
        " between ",
        " til ",
        " till ",
        " until ",
        " through ",
        " to ",
    )
    return any(term in text for term in trend_terms) or any(term in text for term in range_terms)


def route_intent(message: str) -> IntentPayload:
    text = _normalize_planning_text(message)
    requested_metrics = []
    for key in (
        "revenue",
        "cogs",
        "gp",
        "gross profit",
        "net",
        "roas",
        "cash",
        "receivable",
        "payable",
        "opex",
        "operating expense",
        "operating expenses",
        "marketing cost",
        "marketing costs",
        "marketing spend",
        "ledger",
    ):
        if key in text:
            requested_metrics.append(key)
    canonical_metrics: list[str] = []
    map_metric: dict[str, str] = {
        "gp": "gross_profit",
        "gross profit": "gross_profit",
        "net": "net",
        "revenue": "revenue",
        "cogs": "cogs",
        "roas": "roas",
        "cash": "cash_balance",
        "receivable": "ar_balance",
        "payable": "ap_balance",
        "opex": "opex_total",
        "operating expense": "opex_total",
        "operating expenses": "opex_total",
        "marketing cost": "marketing_costs",
        "marketing costs": "marketing_costs",
        "marketing spend": "marketing_costs",
        "ledger": "opex_total",
    }
    for item in requested_metrics:
        metric = map_metric[item]
        if metric not in canonical_metrics:
            canonical_metrics.append(metric)
    if not canonical_metrics:
        canonical_metrics = ["revenue", "cogs", "gross_profit", "net", "roas"]

    business_units, missing = _resolve_business_units(message)
    ambiguities = list(missing)
    if "net" in canonical_metrics:
        ambiguities.append("net_definition_required")

    period = _resolve_period_scope(message)
    is_multi_period_trend = _is_multi_period_trend_request(text, period=period)
    intent = "comparative_branch_performance" if len(business_units) > 1 else "finance_lookup"
    if is_multi_period_trend:
        intent = "multi_period_metric_trend"

    presentation_mode = "board_ready" if any(token in text for token in ("board", "summary", "table")) else "analyst"
    output = "trend_table" if is_multi_period_trend else presentation_mode
    if is_multi_period_trend:
        presentation_mode = "table_only"

    granularity = "monthly" if is_multi_period_trend or any(
        token in text for token in ("monthly", "month-by-month", "by month", "monthly values")
    ) else "period"
    include_ledger_evidence = _include_ledger_evidence_requested(text)

    dimensions: dict[str, list[str]] = {"business_unit": business_units} if business_units else {}
    if any(metric in canonical_metrics for metric in ("opex_total", "marketing_costs", "ad_spend")):
        ledger_terms = _extract_ledger_terms(message)
        if ledger_terms:
            dimensions["ledger_terms"] = ledger_terms

    return IntentPayload(
        intent=intent,
        metrics=canonical_metrics,
        dimensions=dimensions,
        period=period,
        granularity=granularity,
        presentation_mode=presentation_mode,
        output=output,
        include_ledger_evidence=include_ledger_evidence,
        ambiguities=sorted(set(ambiguities)),
        confidence=0.9 if not ambiguities else 0.5,
    )
