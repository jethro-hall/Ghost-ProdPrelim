from __future__ import annotations

import re

from .contracts import NormalizedReport, NormalizedReportLine, PeriodScope
from .registry_loader import get_account_classification_map


def normalize_source_result(source_key: str, raw_result: dict) -> NormalizedReport:
    data = dict(raw_result.get("data") or {})
    date_from = str(data.get("date_from") or "")
    date_to = str(data.get("date_to") or "")
    if not date_from or not date_to:
        period = data.get("period") or {}
        date_from = str(period.get("date_from") or "1970-01-01")
        date_to = str(period.get("date_to") or "1970-01-02")

    lines: list[NormalizedReportLine] = []
    ledger_rows_meta: list[dict[str, object]] = []
    expected_marketing_accounts: list[str] = []
    if source_key == "profit_and_loss":
        rows = list(data.get("rows") or [])
        if rows:
            row = dict(rows[0])
            lines.extend(
                [
                    NormalizedReportLine(code="revenue", label="Revenue", section="income", value=_to_float(row.get("revenue"))),
                    NormalizedReportLine(code="cogs", label="COGS", section="expense", value=_to_float(row.get("cogs"))),
                    NormalizedReportLine(
                        code="gross_profit",
                        label="Gross Profit",
                        section="profitability",
                        value=_to_float(row.get("gp")),
                    ),
                    NormalizedReportLine(
                        code="net_profit",
                        label="Net Profit",
                        section="profitability",
                        value=_to_float(row.get("net_profit")),
                    ),
                    NormalizedReportLine(code="ad_spend", label="Ad Spend", section="marketing", value=_to_float(row.get("ad_spend"))),
                    NormalizedReportLine(code="roas", label="ROAS", section="marketing", value=_to_float(row.get("roas"))),
                ]
            )
    elif source_key == "profit_and_loss_monthly_margin_comparison":
        companies = list(data.get("companies") or [])
        if companies:
            company = dict(companies[0])
            lines.extend(
                [
                    NormalizedReportLine(
                        code="revenue",
                        label="Revenue",
                        section="income",
                        value=_to_float(company.get("total_revenue")),
                    ),
                    NormalizedReportLine(code="cogs", label="COGS", section="expense", value=_to_float(company.get("total_cogs"))),
                    NormalizedReportLine(
                        code="gross_profit",
                        label="Gross Profit",
                        section="profitability",
                        value=_to_float(company.get("total_gp")),
                    ),
                ]
            )
    elif source_key == "cash_flow":
        lines.append(
            NormalizedReportLine(
                code="cash_balance",
                label="Cash Balance",
                section="cash",
                value=_to_float(data.get("cash_position")),
            )
        )
    elif source_key == "aged_receivables":
        lines.append(
            NormalizedReportLine(
                code="ar_balance",
                label="Accounts Receivable",
                section="receivables",
                value=_to_float(data.get("total_residual")),
            )
        )
    elif source_key == "aged_payables":
        lines.append(
            NormalizedReportLine(
                code="ap_balance",
                label="Accounts Payable",
                section="payables",
                value=_to_float(data.get("total_residual")),
            )
        )
    elif source_key == "opex_ledger_search":
        ledger_rows, expected_marketing_accounts = _extract_ledger_rows(data)
        ledger_rows_meta = ledger_rows
        if ledger_rows:
            total_opex = sum(float(item.get("amount") or 0.0) for item in ledger_rows)
            marketing_costs = sum(
                float(item.get("amount") or 0.0)
                for item in ledger_rows
                if str(item.get("account_class") or "").strip() == "marketing_direct"
                and bool(item.get("include_in_metric"))
            )
            lines.extend(
                [
                    NormalizedReportLine(
                        code="opex_total",
                        label="Operating Expenses",
                        section="expense",
                        value=_to_float(total_opex),
                    ),
                    NormalizedReportLine(
                        code="marketing_costs",
                        label="Marketing Costs",
                        section="marketing",
                        value=_to_float(marketing_costs),
                    ),
                    NormalizedReportLine(
                        code="ad_spend",
                        label="Ad Spend",
                        section="marketing",
                        value=_to_float(marketing_costs),
                    ),
                ]
            )

    return NormalizedReport(
        report_key=source_key,
        dimension_scope=_dimension_scope(data),
        period=PeriodScope(date_from=date_from, date_to=date_to),
        lines=lines,
        metadata={
            "source_mode": data.get("evidence_source_mode", "live_odoo"),
            "monthly_rows": _extract_monthly_rows(data),
            "ledger_rows": ledger_rows_meta,
            "expected_marketing_accounts": expected_marketing_accounts,
            "policy_overrides": dict(data.get("policy_overrides") or {}),
            "requested_business_units": [
                _canonicalize_business_unit_label(str(item))
                for item in list(data.get("requested_business_units") or [])
                if str(item).strip()
            ],
        },
    )


def _dimension_scope(data: dict) -> dict[str, str]:
    names = list(data.get("company_name_terms") or [])
    if names:
        return {"business_unit": ", ".join(_canonicalize_business_unit_label(str(item)) for item in names)}
    company_ids = list(data.get("company_ids") or [])
    if company_ids:
        return {"company_ids": ",".join(str(item) for item in company_ids)}
    return {}


def _to_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _extract_monthly_rows(data: dict) -> list[dict[str, object]]:
    extracted: list[dict[str, object]] = []
    for company in list(data.get("companies") or []):
        if not isinstance(company, dict):
            continue
        company_name = _canonicalize_business_unit_label(str(company.get("company_name") or company.get("company_id") or "unknown"))
        for month in list(company.get("months") or []):
            if not isinstance(month, dict):
                continue
            extracted.append(
                {
                    "business_unit": company_name,
                    "month": str(month.get("month") or "unknown"),
                    "revenue": _to_float(month.get("revenue")),
                    "cogs": _to_float(month.get("cogs")),
                    "gross_profit": _to_float(month.get("gp")),
                    "gross_margin_pct": _to_float(month.get("gp_pct")),
                }
            )
    return extracted


def _extract_ledger_rows(data: dict) -> tuple[list[dict[str, object]], list[str]]:
    rows = list(data.get("rows") or [])
    business_unit = ", ".join(_canonicalize_business_unit_label(str(item)) for item in list(data.get("company_name_terms") or [])) or "group"
    entity_key = _resolve_entity_key(business_unit)
    classifier = _build_account_classifier(entity_key=entity_key)
    expected_marketing_accounts = _expected_marketing_accounts(entity_key=entity_key)
    extracted: list[dict[str, object]] = []
    source_present_keys: set[str] = set()
    source_present_codes: set[int] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        account_field = row.get("account_id")
        account_name = ""
        account_code: int | None = None
        if isinstance(account_field, (list, tuple)) and len(account_field) > 1:
            if isinstance(account_field[0], int):
                account_code = int(account_field[0])
            elif isinstance(account_field[0], str) and account_field[0].strip().isdigit():
                account_code = int(account_field[0].strip())
            account_name = str(account_field[1] or "")
        elif isinstance(account_field, (list, tuple)) and account_field:
            if isinstance(account_field[0], int):
                account_code = int(account_field[0])
            elif isinstance(account_field[0], str) and account_field[0].strip().isdigit():
                account_code = int(account_field[0].strip())
            account_name = str(account_field[0] or "")
        elif isinstance(account_field, str):
            account_name = account_field
        month_key = str(row.get("date:month") or "unknown")
        if month_key == "unknown":
            range_meta = row.get("__range")
            if isinstance(range_meta, dict):
                date_range = range_meta.get("date:month")
                if isinstance(date_range, dict):
                    month_key = str(date_range.get("from") or month_key)
        amount = _to_float(row.get("balance"))
        if amount is None:
            continue
        # If account_id carries an internal Odoo id, prefer code parsed from account label.
        if account_code is not None and account_code > 9999:
            parsed_code = re.match(r"^\s*(\d{3,4})\b", account_name)
            if parsed_code:
                account_code = int(parsed_code.group(1))
        if account_code is None:
            code_match = re.match(r"^\s*(\d{3,4})\b", account_name)
            account_code = int(code_match.group(1)) if code_match else None
        classification = classifier(account_name=account_name, account_code=account_code)
        account_class = classification.get("class")
        include_in_metric = bool(classification.get("include_in_metric"))
        extracted.append(
            {
                "business_unit": business_unit,
                "month": _normalize_month_key(month_key),
                "account": account_name or "unknown",
                "amount_accounting_signed": amount,
                "amount": amount,
                "account_code": account_code,
                "account_class": account_class,
                "include_in_metric": include_in_metric,
                "source_present": True,
                "status": "active_in_period",
            }
        )
        source_present_keys.add(" ".join(str(account_name).strip().casefold().split()))
        if isinstance(account_code, int):
            source_present_codes.add(account_code)

    for expected in expected_marketing_accounts:
        key = " ".join(expected.strip().casefold().split())
        code_match = re.match(r"^\s*(\d{3,4})\b", expected)
        expected_code = int(code_match.group(1)) if code_match else None
        if key in source_present_keys or (expected_code is not None and expected_code in source_present_codes):
            continue
        extracted.append(
            {
                "business_unit": business_unit,
                "month": _normalize_month_key(str(data.get("date_from") or "")),
                "account": expected,
                "amount_accounting_signed": 0.0,
                "amount": 0.0,
                "account_code": expected_code,
                "account_class": "marketing_direct",
                "include_in_metric": True,
                "source_present": False,
                "status": "no_activity_in_period",
            }
        )
    return extracted, expected_marketing_accounts


def _normalize_month_key(value: str) -> str:
    month_key = str(value or "").strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", month_key):
        return month_key[:7]
    if re.match(r"^\d{4}-\d{2}$", month_key):
        return month_key
    return month_key or "unknown"


def _canonicalize_business_unit_label(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "group"
    # Normalize case/spacing so "ride electric brisbane" and
    # "Ride Electric Brisbane" resolve to the same row label.
    normalized = re.sub(r"\s+", " ", raw)
    return normalized.title()


def _build_account_classifier(*, entity_key: str):
    maps = get_account_classification_map()
    account_map = dict(maps.get(entity_key) or {})
    account_code_map: dict[int, list[dict[str, object]]] = {}
    for mapping in account_map.values():
        raw_code = mapping.get("account_code")
        if isinstance(raw_code, int):
            account_code_map.setdefault(raw_code, []).append(mapping)

    def classify(*, account_name: str, account_code: int | None = None) -> dict[str, object]:
        mapping: dict[str, object] = {}
        key = " ".join(str(account_name or "").strip().casefold().split())
        resolved_code = account_code
        if resolved_code is None:
            code_match = re.match(r"^\s*(\d{3,4})\b", str(account_name or ""))
            if code_match:
                resolved_code = int(code_match.group(1))
        mapping = dict(account_map.get(key) or {})
        if not mapping:
            if isinstance(resolved_code, int):
                candidates = list(account_code_map.get(resolved_code) or [])
                if len(candidates) == 1:
                    mapping = dict(candidates[0])
                elif len(candidates) > 1:
                    name_tokens = set(re.findall(r"[a-z0-9]+", key))
                    best: dict[str, object] | None = None
                    best_score = -1
                    for candidate in candidates:
                        candidate_name = " ".join(
                            str(candidate.get("display_name") or "").strip().casefold().split()
                        )
                        candidate_tokens = set(re.findall(r"[a-z0-9]+", candidate_name))
                        score = len(name_tokens.intersection(candidate_tokens))
                        if score > best_score:
                            best = candidate
                            best_score = score
                    if best is not None and best_score > 0:
                        mapping = dict(best)
        # Safety-net: merchant fee accounts must never be treated as marketing_direct
        # even if mapping drift or label variance causes misclassification.
        if _looks_like_merchant_fee(account_name=account_name, account_code=resolved_code):
            return {"class": "merchant_fees", "include_in_metric": False}
        if not mapping:
            return {"class": None, "include_in_metric": False}
        return {
            "class": str(mapping.get("class") or "").strip() or None,
            "include_in_metric": bool(mapping.get("include_in_metric", False)),
        }

    return classify


def _resolve_entity_key(business_unit: str) -> str:
    normalized = str(business_unit or "").casefold()
    if "retail" in normalized:
        return "retail"
    if "brisbane" in normalized:
        return "brisbane"
    if "burleigh" in normalized:
        return "burleigh"
    return "retail"


def _looks_like_merchant_fee(*, account_name: str, account_code: int | None) -> bool:
    normalized = str(account_name or "").casefold()
    if account_code in {445, 519, 523, 526}:
        return True
    return ("merchant fee" in normalized) or ("shopify fee" in normalized)


def _expected_marketing_accounts(*, entity_key: str) -> list[str]:
    maps = get_account_classification_map()
    account_map = dict(maps.get(entity_key) or {})
    expected: list[str] = []
    for _account_name, cfg in account_map.items():
        if str(cfg.get("class") or "").strip() == "marketing_direct" and bool(cfg.get("include_in_metric", False)):
            expected.append(str(cfg.get("display_name") or ""))
    return sorted(set(expected))
