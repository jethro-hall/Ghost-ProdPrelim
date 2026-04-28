from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any
from uuid import uuid4

import httpx
from pydantic import BaseModel, Field

ODOO_TOOL_ID = "odoo_primary"
ODOO_PROVIDER = "odoo"
ODOO_GATEWAY = "ghoststack-rag"
ODOO_RPC_TIMEOUT_MS = 20000
ODOO_HEALTH_PATH = "/api/tools/odoo_primary/test"
ODOO_EXECUTE_PATH = "/api/tools/odoo_primary/execute"
ODOO_SAFE_OPERATIONS = [
    "odoo.meta.current_user",
    "odoo.meta.model_catalog",
    "odoo.products.search_read",
    "odoo.customers.search_read",
    "odoo.sales.orders.search_read",
    "odoo.finance.invoices.search_read",
    "odoo.finance.receivables.open",
    "odoo.finance.payables.open",
    "odoo.rpc.search_read",
    "odoo.rpc.read_group",
    "odoo.rpc.execute_kw",
    "odoo.rpc.query_spec",
    "odoo.finance.revenue.period",
    "odoo.finance.cogs.period",
    "odoo.finance.margin.period_summary",
    "odoo.finance.pnl.period_summary",
    "odoo.finance.revenue.monthly",
    "odoo.finance.cogs.monthly",
    "odoo.finance.cogs.monthly_code_breakdown",
    "odoo.finance.margin.monthly_comparison",
    "odoo.finance.revenue.quarterly",
    "odoo.finance.cogs.quarterly",
    "odoo.finance.margin.quarterly_summary",
    "odoo.finance.shopify.monthly_roi",
    "odoo.finance.cash.runway_summary",
    "odoo.exploration.product_branch_sales",
    "odoo.sales.drilldown.period",
    "odoo.sales.products_gp.period_top",
]

ODOO_READ_ONLY_METHODS = {
    "fields_get",
    "name_get",
    "name_search",
    "read",
    "read_group",
    "search",
    "search_count",
    "search_read",
}


class OdooConfig(BaseModel):
    base_url: str = Field(min_length=1)
    database: str = Field(min_length=1)
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)
    read_only: bool = True
    timeout_ms: int = Field(default=ODOO_RPC_TIMEOUT_MS, ge=1000, le=120000)


class OdooConnectorError(RuntimeError):
    pass


def default_odoo_config() -> dict[str, Any]:
    return {
        "base_url": "",
        "database": "",
        "username": "",
        "password": "",
        "auth_source": "direct_credentials",
        "read_only": True,
        "timeout_ms": ODOO_RPC_TIMEOUT_MS,
        "health_path": ODOO_HEALTH_PATH,
        "execute_path": ODOO_EXECUTE_PATH,
    }


def missing_odoo_config(config: dict[str, Any] | None) -> list[str]:
    settings = dict(config or {})
    missing: list[str] = []
    for key in ("base_url", "database", "username", "password"):
        if not str(settings.get(key) or "").strip():
            missing.append(key)
    return missing


def mask_identity(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if len(raw) <= 4:
        return "*" * len(raw)
    return f"{raw[:2]}{'*' * max(2, len(raw) - 4)}{raw[-2:]}"


def config_from_dict(config: dict[str, Any] | None) -> OdooConfig:
    merged = default_odoo_config()
    merged.update(dict(config or {}))
    return OdooConfig(
        base_url=str(merged["base_url"]).strip(),
        database=str(merged["database"]).strip(),
        username=str(merged["username"]).strip(),
        password=str(merged["password"]).strip(),
        read_only=bool(merged.get("read_only", True)),
        timeout_ms=int(merged.get("timeout_ms") or ODOO_RPC_TIMEOUT_MS),
    )


def _jsonrpc_url(base_url: str) -> str:
    trimmed = base_url.rstrip("/")
    if trimmed.endswith("/jsonrpc"):
        return trimmed
    return f"{trimmed}/jsonrpc"


def _coerce_domain(domain: Any) -> list[Any]:
    if not isinstance(domain, list):
        return []
    safe_domain: list[Any] = []
    for clause in domain:
        if isinstance(clause, str):
            if clause in {"&", "|", "!"}:
                safe_domain.append(clause)
            continue
        if not isinstance(clause, (list, tuple)) or len(clause) != 3:
            continue
        field_name, operator, value = clause
        if not isinstance(field_name, str) or not isinstance(operator, str):
            continue
        safe_domain.append([field_name, operator, value])
    return safe_domain


def _coerce_limit(value: Any, default: int = 20, maximum: int = 100) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(parsed, maximum))


def _coerce_offset(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return bool(value)


def _coerce_float(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        normalized = value.strip().replace(",", "")
        if not normalized:
            return None
        try:
            return float(normalized)
        except ValueError:
            return None
    return None


def _coerce_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item.strip()]


def _coerce_kwargs(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return dict(value)


def _coerce_args(value: Any) -> list[Any]:
    if not isinstance(value, list):
        return []
    return list(value)


def _coerce_order(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _build_or_domain(clauses: list[list[Any]]) -> list[Any]:
    if not clauses:
        return []
    if len(clauses) == 1:
        return list(clauses[0])
    output: list[Any] = ["|"] * (len(clauses) - 1)
    output.extend(clauses)
    return output


def _ensure_model_name(payload: dict[str, Any]) -> str:
    model = str(payload.get("model") or "").strip()
    if not model:
        raise OdooConnectorError("Odoo model is required")
    return model


def _ensure_method_name(payload: dict[str, Any]) -> str:
    method = str(payload.get("method") or "").strip()
    if not method:
        raise OdooConnectorError("Odoo method is required")
    return method


def _result_envelope(*, model: str, method: str, result: Any) -> dict[str, Any]:
    if isinstance(result, list):
        if all(isinstance(item, dict) for item in result):
            return {
                "model": model,
                "method": method,
                "result_type": "records",
                "count": len(result),
                "records": result,
            }
        return {
            "model": model,
            "method": method,
            "result_type": "list",
            "count": len(result),
            "items": result,
        }
    if isinstance(result, dict):
        return {"model": model, "method": method, "result_type": "object", "result": result}
    return {"model": model, "method": method, "result_type": "scalar", "result": result}


def _assert_read_only_allowed(config: OdooConfig, *, method: str) -> None:
    if config.read_only and method not in ODOO_READ_ONLY_METHODS:
        raise OdooConnectorError(
            f"Odoo method '{method}' is blocked while the connector is in read-only mode"
        )


def _add_months(value: date, months: int) -> date:
    zero_indexed = (value.year * 12) + (value.month - 1) + months
    year = zero_indexed // 12
    month = (zero_indexed % 12) + 1
    return date(year, month, 1)


def _quarter_start(value: date, fiscal_year_start_month: int) -> date:
    offset = (value.month - fiscal_year_start_month) % 12
    quarter_index = offset // 3
    start_month = ((fiscal_year_start_month - 1) + (quarter_index * 3)) % 12 + 1
    year = value.year
    if start_month > value.month:
        year -= 1
    return date(year, start_month, 1)


def _quarter_ranges(*, quarters: int, fiscal_year_start_month: int, include_current_quarter: bool) -> list[tuple[date, date]]:
    anchor = _quarter_start(date.today(), fiscal_year_start_month)
    if not include_current_quarter:
        anchor = _add_months(anchor, -3)
    ranges: list[tuple[date, date]] = []
    start = _add_months(anchor, -3 * (quarters - 1))
    for index in range(quarters):
        quarter_start = _add_months(start, index * 3)
        quarter_end = _add_months(quarter_start, 3)
        ranges.append((quarter_start, quarter_end))
    return ranges


def _resolve_period_window(payload: dict[str, Any]) -> tuple[str, str]:
    date_from = str(payload.get("date_from") or "").strip()
    date_to = str(payload.get("date_to") or "").strip()
    if date_from and date_to:
        return date_from, date_to

    relative_period = str(payload.get("relative_period") or "").strip().lower()
    today = date.today()
    current_month_start = date(today.year, today.month, 1)
    if relative_period == "last_month":
        month_end = current_month_start
        month_start = _add_months(current_month_start, -1)
        return month_start.isoformat(), month_end.isoformat()
    if relative_period == "this_month":
        return current_month_start.isoformat(), _add_months(current_month_start, 1).isoformat()

    raise OdooConnectorError("Odoo period helpers require `date_from` and `date_to`, or a supported `relative_period`.")


def _resolve_monthly_window(payload: dict[str, Any]) -> tuple[str, str, int]:
    date_from = str(payload.get("date_from") or "").strip()
    date_to = str(payload.get("date_to") or "").strip()
    if date_from and date_to:
        months = max(1, min(24, int(payload.get("months") or 4)))
        return date_from, date_to, months

    months = max(1, min(24, int(payload.get("months") or 4)))
    include_current_month = _coerce_bool(payload.get("include_current_month"), default=False)
    today = date.today()
    current_month_start = date(today.year, today.month, 1)
    end_month_start = current_month_start if not include_current_month else _add_months(current_month_start, 1)
    start_month = _add_months(end_month_start, -months)
    return start_month.isoformat(), end_month_start.isoformat(), months


def _extract_group_label(row: dict[str, Any], groupby_key: str, fallback: str) -> str:
    value = row.get(groupby_key)
    if isinstance(value, str) and value.strip():
        return value
    if isinstance(value, (list, tuple)) and value:
        return str(value[0])
    return fallback


def _extract_quarter_key(row: dict[str, Any], groupby_key: str, fallback: str) -> str:
    range_meta = row.get("__range")
    if isinstance(range_meta, dict):
        group_range = range_meta.get(groupby_key)
        if isinstance(group_range, dict):
            from_value = group_range.get("from")
            if isinstance(from_value, str):
                try:
                    quarter_start = date.fromisoformat(from_value)
                except ValueError:
                    pass
                else:
                    return f"{quarter_start.year}-Q{(((quarter_start.month - 1) // 3) + 1)}"
    domain = row.get("__domain")
    if isinstance(domain, list):
        for clause in domain:
            if not isinstance(clause, (list, tuple)) or len(clause) != 3:
                continue
            field_name, operator, value = clause
            if operator == ">=" and isinstance(value, str):
                try:
                    quarter_start = date.fromisoformat(value)
                except ValueError:
                    continue
                return f"{quarter_start.year}-Q{(((quarter_start.month - 1) // 3) + 1)}"
    return _extract_group_label(row, groupby_key, fallback)


def _extract_month_key(row: dict[str, Any], groupby_key: str, fallback: str) -> str:
    range_meta = row.get("__range")
    if isinstance(range_meta, dict):
        group_range = range_meta.get(groupby_key)
        if isinstance(group_range, dict):
            from_value = group_range.get("from")
            if isinstance(from_value, str):
                try:
                    month_start = date.fromisoformat(from_value)
                except ValueError:
                    pass
                else:
                    return month_start.strftime("%Y-%m")
    domain = row.get("__domain")
    if isinstance(domain, list):
        for clause in domain:
            if not isinstance(clause, (list, tuple)) or len(clause) != 3:
                continue
            field_name, operator, value = clause
            if operator == ">=" and isinstance(value, str):
                try:
                    month_start = date.fromisoformat(value)
                except ValueError:
                    continue
                return month_start.strftime("%Y-%m")
    return _extract_group_label(row, groupby_key, fallback)


def _coerce_company_ids(payload: dict[str, Any]) -> list[int]:
    raw = payload.get("company_ids")
    if not isinstance(raw, list):
        company_id = payload.get("company_id")
        try:
            return [int(company_id)] if company_id is not None else []
        except (TypeError, ValueError):
            return []
    output: list[int] = []
    for value in raw:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            continue
        if parsed not in output:
            output.append(parsed)
    return output


def _normalize_company_scope_lock_payload(payload: dict[str, Any]) -> None:
    """Enforce single-outlet intent: drop inherited multi-company id lists and pin canonical name terms."""
    if payload.get("company_scope_lock") != "single_exact":
        return
    explicit_ids = _coerce_company_ids(payload)
    if len(explicit_ids) == 1:
        payload["company_id"] = explicit_ids[0]
        payload.pop("company_ids", None)
        payload.pop("company_name_terms", None)
        return
    if len(explicit_ids) > 1:
        payload.pop("company_ids", None)
        payload.pop("company_id", None)
    canonical = str(payload.get("company_scope_lock_canonical") or "").strip().casefold()
    if canonical in ("brisbane", "burleigh", "retail"):
        payload["company_name_terms"] = [canonical]


def _domain_pins_company_id(domain: Any, company_id: int) -> bool:
    clauses = _coerce_domain(domain)
    for clause in clauses:
        if not isinstance(clause, (list, tuple)) or len(clause) != 3:
            continue
        field_name, operator, value = clause[0], str(clause[1]).strip().lower(), clause[2]
        if str(field_name) != "company_id":
            continue
        if operator == "=":
            try:
                if int(value) == company_id:
                    return True
            except (TypeError, ValueError):
                continue
        if operator == "in" and isinstance(value, (list, tuple)):
            parsed: list[int] = []
            for entry in value:
                try:
                    parsed.append(int(entry))
                except (TypeError, ValueError):
                    continue
            if len(parsed) == 1 and parsed[0] == company_id:
                return True
    return False


def _coerce_company_name_terms(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("company_name_terms")
    if not isinstance(raw, list):
        return []
    output: list[str] = []
    for value in raw:
        term = str(value or "").strip()
        if not term:
            continue
        normalized = term.casefold()
        if normalized not in output:
            output.append(normalized)
    return output


def _resolve_company_ids_from_name_terms(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    company_name_terms: list[str],
) -> list[int]:
    if not company_name_terms:
        return []
    output: list[int] = []
    for term in company_name_terms:
        records = _search_read(
            client,
            config=config,
            uid=uid,
            model="res.company",
            domain=[["name", "ilike", term]],
            fields=["id", "name"],
            limit=100,
            offset=0,
            order="name asc",
        )
        for record in records:
            try:
                parsed = int(record.get("id"))
            except (TypeError, ValueError):
                continue
            if parsed not in output:
                output.append(parsed)
    return output


def _resolve_company_scope(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    payload: dict[str, Any],
    allow_multiple: bool,
) -> tuple[list[int], list[str]]:
    _normalize_company_scope_lock_payload(payload)
    company_ids = _coerce_company_ids(payload)
    company_name_terms = _coerce_company_name_terms(payload)
    if not company_ids and company_name_terms:
        company_ids = _resolve_company_ids_from_name_terms(
            client,
            config=config,
            uid=uid,
            company_name_terms=company_name_terms,
        )
        if not company_ids:
            raise OdooConnectorError(
                "No Odoo companies matched company_name_terms: " + ", ".join(company_name_terms)
            )
    if not allow_multiple and len(company_ids) > 1:
        raise OdooConnectorError(
            "company_name_terms resolved to multiple companies; provide explicit company_id."
        )
    return company_ids, company_name_terms


def _company_name_map(client: httpx.Client, *, config: OdooConfig, uid: int, company_ids: list[int]) -> dict[int, str]:
    if not company_ids:
        return {}
    records = _search_read(
        client,
        config=config,
        uid=uid,
        model="res.company",
        domain=[["id", "in", company_ids]],
        fields=["id", "name"],
        limit=max(len(company_ids), 1),
        offset=0,
        order="id asc",
    )
    output: dict[int, str] = {}
    for record in records:
        try:
            company_id = int(record.get("id"))
        except (TypeError, ValueError):
            continue
        output[company_id] = str(record.get("name") or company_id)
    return output


def _account_identity_map(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    account_ids: list[int],
) -> dict[int, dict[str, str]]:
    if not account_ids:
        return {}
    records = _search_read(
        client,
        config=config,
        uid=uid,
        model="account.account",
        domain=[["id", "in", account_ids]],
        fields=["id", "code", "name"],
        limit=max(len(account_ids), 1),
        offset=0,
        order="code asc",
    )
    output: dict[int, dict[str, str]] = {}
    for record in records:
        try:
            account_id = int(record.get("id"))
        except (TypeError, ValueError):
            continue
        output[account_id] = {
            "code": str(record.get("code") or account_id),
            "name": str(record.get("name") or account_id),
        }
    return output


SHOPIFY_REVENUE_ACCOUNT_TERMS = (
    "shopify sales",
    "shopify discount",
    "shopify refunds",
    "shopify shipping",
)

SHOPIFY_FEE_ACCOUNT_TERMS = (
    "shopify fees",
    "merchant fees - shopify",
)

MARKETING_ACCOUNT_TERMS = (
    "marketing",
    "advert",
    "facebook",
    "meta",
    "google",
    "tiktok",
    "commission factory",
    "website",
    "wages - marketing",
)

MARKETING_VENDOR_KEYWORDS: dict[str, tuple[str, ...]] = {
    "Google": ("google", "adwords"),
    "Meta/Facebook": ("meta", "facebook"),
    "TikTok": ("tiktok",),
    "Commission Factory": ("commission factory",),
    "Website": ("website", "hosting", "design"),
    "Marketing Wages": ("wages - marketing", "marketing wages"),
    "Shopify": ("shopify",),
}


def _account_lookup_by_terms(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    terms: tuple[str, ...],
) -> list[dict[str, Any]]:
    clauses = [[ "name", "ilike", term ] for term in terms]
    records = _search_read(
        client,
        config=config,
        uid=uid,
        model="account.account",
        domain=_build_or_domain(clauses),
        fields=["id", "code", "name", "account_type"],
        limit=200,
        offset=0,
        order="code asc",
    )
    deduped: dict[int, dict[str, Any]] = {}
    for record in records:
        try:
            account_id = int(record.get("id"))
        except (TypeError, ValueError):
            continue
        deduped[account_id] = record
    return list(deduped.values())


def _classify_shopify_account(record: dict[str, Any]) -> str | None:
    lowered = str(record.get("name") or "").strip().casefold()
    if "shopify sales" in lowered:
        return "shopify_revenue"
    if "shopify discount" in lowered:
        return "shopify_discounts"
    if "shopify refund" in lowered:
        return "shopify_refunds"
    if "shopify shipping" in lowered:
        return "shopify_shipping"
    if "shopify fees" in lowered or "merchant fees - shopify" in lowered:
        return "shopify_fees"
    return None


def _looks_like_shopify_journal(record: dict[str, Any]) -> bool:
    lowered = " ".join(
        str(record.get(key) or "")
        for key in ("name", "code")
    ).casefold()
    return "shopify" in lowered


def _extract_vendor_label(record: dict[str, Any]) -> str | None:
    partner = record.get("partner_id")
    if isinstance(partner, (list, tuple)) and len(partner) > 1 and str(partner[1]).strip():
        return str(partner[1]).strip()
    haystack = " ".join(
        str(record.get(key) or "")
        for key in ("name", "ref", "move_name")
    ).casefold()
    for label, keywords in MARKETING_VENDOR_KEYWORDS.items():
        if any(keyword in haystack for keyword in keywords):
            return label
    return None


def _record_month(record: dict[str, Any]) -> str:
    raw = str(record.get("date") or "").strip()
    return raw[:7] if len(raw) >= 7 else "unknown"


def _shopify_metric_amount(record: dict[str, Any]) -> float:
    try:
        return abs(float(record.get("balance") or 0.0))
    except (TypeError, ValueError):
        return 0.0

def _normalize_fields(requested: Any, allowed_fields: list[str], default_fields: list[str]) -> list[str]:
    if not isinstance(requested, list):
        return list(default_fields)
    allowed_set = set(allowed_fields)
    normalized = [field for field in requested if isinstance(field, str) and field in allowed_set]
    return normalized or list(default_fields)


def _odoo_json_rpc(
    client: httpx.Client,
    *,
    config: OdooConfig,
    service: str,
    method: str,
    args: list[Any],
) -> Any:
    request_id = uuid4().hex
    response = client.post(
        _jsonrpc_url(config.base_url),
        json={
            "jsonrpc": "2.0",
            "method": "call",
            "params": {"service": service, "method": method, "args": args},
            "id": request_id,
        },
    )
    response.raise_for_status()
    body = response.json()
    if body.get("error"):
        message = str(body["error"].get("data", {}).get("message") or body["error"].get("message") or "Unknown Odoo error")
        raise OdooConnectorError(message)
    return body.get("result")


def _authenticate(client: httpx.Client, config: OdooConfig) -> int:
    result = _odoo_json_rpc(
        client,
        config=config,
        service="common",
        method="login",
        args=[config.database, config.username, config.password],
    )
    try:
        uid = int(result)
    except (TypeError, ValueError) as exc:
        raise OdooConnectorError("Authentication failed") from exc
    if uid <= 0:
        raise OdooConnectorError("Authentication failed")
    return uid


def _execute_kw(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    model: str,
    method: str,
    args: list[Any] | None = None,
    kwargs: dict[str, Any] | None = None,
) -> Any:
    return _odoo_json_rpc(
        client,
        config=config,
        service="object",
        method="execute_kw",
        args=[
            config.database,
            uid,
            config.password,
            model,
            method,
            list(args or []),
            dict(kwargs or {}),
        ],
    )


def _search_read(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    model: str,
    domain: list[Any] | None = None,
    fields: list[str] | None = None,
    limit: int = 20,
    offset: int = 0,
    order: str | None = None,
) -> list[dict[str, Any]]:
    kwargs: dict[str, Any] = {
        "domain": list(domain or []),
        "fields": list(fields or []),
        "limit": limit,
        "offset": offset,
    }
    if order:
        kwargs["order"] = order
    result = _execute_kw(
        client,
        config=config,
        uid=uid,
        model=model,
        method="search_read",
        kwargs=kwargs,
    )
    if not isinstance(result, list):
        raise OdooConnectorError(f"Unexpected response for {model}.search_read")
    return [item for item in result if isinstance(item, dict)]


def _search_read_paginated(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    model: str,
    domain: list[Any] | None = None,
    fields: list[str] | None = None,
    limit: int = 200,
    max_records: int = 5000,
    order: str | None = None,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    offset = 0
    normalized_limit = max(1, min(limit, 1000))
    while len(records) < max_records:
        batch = _search_read(
            client,
            config=config,
            uid=uid,
            model=model,
            domain=domain,
            fields=fields,
            limit=min(normalized_limit, max_records - len(records)),
            offset=offset,
            order=order,
        )
        if not batch:
            break
        records.extend(batch)
        if len(batch) < normalized_limit:
            break
        offset += len(batch)
    return records[:max_records]


def _apply_name_filter(payload: dict[str, Any], field_name: str = "name") -> list[Any]:
    query = str(payload.get("query") or "").strip()
    if not query:
        return []
    return [[field_name, "ilike", query]]


def _run_current_user(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    fields = _normalize_fields(
        payload.get("fields"),
        ["id", "name", "login", "company_id", "partner_id"],
        ["id", "name", "login", "company_id", "partner_id"],
    )
    result = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="res.users",
        method="read",
        args=[[uid]],
        kwargs={"fields": fields},
    )
    records = result if isinstance(result, list) else []
    return {"count": len(records), "records": [item for item in records if isinstance(item, dict)]}


def _run_products(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    allowed_fields = ["id", "name", "default_code", "list_price", "currency_id", "qty_available", "sale_ok"]
    default_fields = ["id", "name", "default_code", "list_price", "currency_id", "qty_available"]
    domain = _coerce_domain(payload.get("domain"))
    product_query = str(payload.get("query") or payload.get("search") or "").strip()
    if product_query:
        like_term = f"%{product_query}%"
        domain.extend(
            [
                "|",
                ["name", "ilike", like_term],
                ["default_code", "ilike", like_term],
            ]
        )
    can_be_sold = payload.get("can_be_sold")
    if can_be_sold is not None:
        domain.append(["sale_ok", "=", _coerce_bool(can_be_sold, default=True)])
    product_type = str(payload.get("product_type") or "").strip()
    if product_type:
        # Odoo product.template uses `type` values such as product/consu/service.
        domain.append(["type", "=", product_type])
    records = _search_read(
        client,
        config=config,
        uid=uid,
        model="product.template",
        domain=domain,
        fields=_normalize_fields(payload.get("fields"), allowed_fields, default_fields),
        limit=_coerce_limit(payload.get("limit")),
        offset=_coerce_offset(payload.get("offset")),
        order="write_date desc",
    )
    return {"count": len(records), "records": records}


def _run_customers(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    allowed_fields = ["id", "name", "email", "phone", "customer_rank", "city", "country_id"]
    default_fields = ["id", "name", "email", "phone", "customer_rank", "city", "country_id"]
    domain = [["customer_rank", ">", 0]]
    domain.extend(_coerce_domain(payload.get("domain")))
    domain.extend(_apply_name_filter(payload))
    records = _search_read(
        client,
        config=config,
        uid=uid,
        model="res.partner",
        domain=domain,
        fields=_normalize_fields(payload.get("fields"), allowed_fields, default_fields),
        limit=_coerce_limit(payload.get("limit")),
        offset=_coerce_offset(payload.get("offset")),
        order="write_date desc",
    )
    return {"count": len(records), "records": records}


def _run_sales_orders(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    allowed_fields = ["id", "name", "state", "partner_id", "company_id", "date_order", "amount_total", "currency_id"]
    default_fields = ["id", "name", "state", "partner_id", "company_id", "date_order", "amount_total", "currency_id"]
    domain = _coerce_domain(payload.get("domain"))
    state = str(payload.get("state") or "").strip()
    if state:
        domain.append(["state", "=", state])
    partner_query = str(payload.get("partner_query") or "").strip()
    if partner_query:
        domain.append(["partner_id.name", "ilike", partner_query])
    records = _search_read(
        client,
        config=config,
        uid=uid,
        model="sale.order",
        domain=domain,
        fields=_normalize_fields(payload.get("fields"), allowed_fields, default_fields),
        limit=_coerce_limit(payload.get("limit")),
        offset=_coerce_offset(payload.get("offset")),
        order="date_order desc",
    )
    return {"count": len(records), "records": records}


def _run_invoices(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    allowed_fields = [
        "id",
        "name",
        "invoice_date",
        "invoice_date_due",
        "state",
        "payment_state",
        "partner_id",
        "amount_total",
        "amount_residual",
        "currency_id",
    ]
    default_fields = [
        "id",
        "name",
        "invoice_date",
        "invoice_date_due",
        "state",
        "payment_state",
        "partner_id",
        "amount_total",
        "amount_residual",
        "currency_id",
    ]
    domain: list[Any] = [["move_type", "=", "out_invoice"]]
    domain.extend(_coerce_domain(payload.get("domain")))
    state = str(payload.get("state") or "").strip()
    if state:
        domain.append(["state", "=", state])
    payment_state = str(payload.get("payment_state") or "").strip()
    if payment_state:
        domain.append(["payment_state", "=", payment_state])
    records = _search_read(
        client,
        config=config,
        uid=uid,
        model="account.move",
        domain=domain,
        fields=_normalize_fields(payload.get("fields"), allowed_fields, default_fields),
        limit=_coerce_limit(payload.get("limit")),
        offset=_coerce_offset(payload.get("offset")),
        order="invoice_date desc",
    )
    return {"count": len(records), "records": records}


def _run_receivables(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    allowed_fields = [
        "id",
        "name",
        "invoice_date",
        "invoice_date_due",
        "state",
        "payment_state",
        "partner_id",
        "amount_total",
        "amount_residual",
        "currency_id",
    ]
    default_fields = allowed_fields
    domain: list[Any] = [
        ["move_type", "=", "out_invoice"],
        ["state", "=", "posted"],
        ["amount_residual", ">", 0],
    ]
    due_before = str(payload.get("due_before") or "").strip()
    if due_before:
        domain.append(["invoice_date_due", "<=", due_before])
    partner_query = str(payload.get("partner_query") or "").strip()
    if partner_query:
        domain.append(["partner_id.name", "ilike", partner_query])
    domain.extend(_coerce_domain(payload.get("domain")))
    records = _search_read(
        client,
        config=config,
        uid=uid,
        model="account.move",
        domain=domain,
        fields=_normalize_fields(payload.get("fields"), allowed_fields, default_fields),
        limit=_coerce_limit(payload.get("limit")),
        offset=_coerce_offset(payload.get("offset")),
        order="invoice_date_due asc",
    )
    total_residual = 0.0
    for record in records:
        try:
            total_residual += float(record.get("amount_residual") or 0)
        except (TypeError, ValueError):
            continue
    return {"count": len(records), "total_residual": total_residual, "records": records}


def _run_payables(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    allowed_fields = [
        "id",
        "name",
        "invoice_date",
        "invoice_date_due",
        "state",
        "payment_state",
        "partner_id",
        "amount_total",
        "amount_residual",
        "currency_id",
    ]
    default_fields = allowed_fields
    domain: list[Any] = [
        ["move_type", "=", "in_invoice"],
        ["state", "=", "posted"],
        ["amount_residual", ">", 0],
    ]
    due_before = str(payload.get("due_before") or "").strip()
    if due_before:
        domain.append(["invoice_date_due", "<=", due_before])
    partner_query = str(payload.get("partner_query") or "").strip()
    if partner_query:
        domain.append(["partner_id.name", "ilike", partner_query])
    domain.extend(_coerce_domain(payload.get("domain")))
    records = _search_read(
        client,
        config=config,
        uid=uid,
        model="account.move",
        domain=domain,
        fields=_normalize_fields(payload.get("fields"), allowed_fields, default_fields),
        limit=_coerce_limit(payload.get("limit")),
        offset=_coerce_offset(payload.get("offset")),
        order="invoice_date_due asc",
    )
    total_residual = 0.0
    for record in records:
        try:
            total_residual += float(record.get("amount_residual") or 0)
        except (TypeError, ValueError):
            continue
    return {"count": len(records), "total_residual": total_residual, "records": records}


def _run_rpc_search_read(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    model = _ensure_model_name(payload)
    records = _search_read(
        client,
        config=config,
        uid=uid,
        model=model,
        domain=_coerce_domain(payload.get("domain")),
        fields=_coerce_string_list(payload.get("fields")),
        limit=_coerce_limit(payload.get("limit"), default=20, maximum=1000),
        offset=_coerce_offset(payload.get("offset")),
        order=_coerce_order(payload.get("order")),
    )
    return {
        "model": model,
        "method": "search_read",
        "result_type": "records",
        "count": len(records),
        "records": records,
    }


def _run_rpc_read_group(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    model = _ensure_model_name(payload)
    fields = _coerce_string_list(payload.get("fields"))
    groupby = _coerce_string_list(payload.get("groupby"))
    if not fields:
        raise OdooConnectorError("Odoo read_group requires at least one field")
    if not groupby:
        raise OdooConnectorError("Odoo read_group requires at least one groupby field")
    rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model=model,
        method="read_group",
        kwargs={
            "domain": _coerce_domain(payload.get("domain")),
            "fields": fields,
            "groupby": groupby,
            "orderby": _coerce_order(payload.get("orderby")),
            "lazy": _coerce_bool(payload.get("lazy"), default=False),
        },
    )
    if not isinstance(rows, list):
        raise OdooConnectorError(f"Unexpected response for {model}.read_group")
    return {
        "model": model,
        "method": "read_group",
        "result_type": "aggregate",
        "count": len(rows),
        "groupby": groupby,
        "rows": [row for row in rows if isinstance(row, dict)],
    }


def _run_rpc_execute_kw(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    model = _ensure_model_name(payload)
    method = _ensure_method_name(payload)
    _assert_read_only_allowed(config, method=method)
    result = _execute_kw(
        client,
        config=config,
        uid=uid,
        model=model,
        method=method,
        args=_coerce_args(payload.get("args")),
        kwargs=_coerce_kwargs(payload.get("kwargs")),
    )
    return _result_envelope(model=model, method=method, result=result)


def _run_rpc_query_spec(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    _normalize_company_scope_lock_payload(payload)
    raw_spec = payload.get("query_spec")
    if isinstance(raw_spec, dict):
        spec = dict(raw_spec)
    else:
        spec = dict(payload)
    model = _ensure_model_name(spec)
    method = str(spec.get("method") or "").strip().lower()
    if method not in {"search_read", "read_group"}:
        raise OdooConnectorError("query_spec method must be one of: search_read, read_group")

    compiled_payload: dict[str, Any] = {
        "model": model,
        "domain": _coerce_domain(spec.get("domain")),
    }
    if payload.get("company_scope_lock") == "single_exact":
        expect_id: int | None = None
        ids_only = _coerce_company_ids(payload)
        if len(ids_only) == 1:
            expect_id = ids_only[0]
        else:
            terms = _coerce_company_name_terms(payload)
            if terms:
                resolved_ids = _resolve_company_ids_from_name_terms(
                    client,
                    config=config,
                    uid=uid,
                    company_name_terms=terms,
                )
                if len(resolved_ids) == 1:
                    expect_id = resolved_ids[0]
        if expect_id is None:
            raise OdooConnectorError(
                "company_scope_lock=single_exact requires a single resolvable Odoo company (company_id or company_name_terms)."
            )
        domain_list = list(compiled_payload.get("domain") or [])
        if not _domain_pins_company_id(domain_list, expect_id):
            domain_list = domain_list + [["company_id", "=", expect_id]]
            compiled_payload["domain"] = domain_list
    if method == "search_read":
        compiled_payload.update(
            {
                "fields": _coerce_string_list(spec.get("fields")),
                "limit": _coerce_limit(spec.get("limit"), default=50, maximum=1000),
                "offset": _coerce_offset(spec.get("offset")),
                "order": _coerce_order(spec.get("order")),
            }
        )
        result = _run_rpc_search_read(client, config=config, uid=uid, payload=compiled_payload)
    else:
        compiled_payload.update(
            {
                "fields": _coerce_string_list(spec.get("fields")),
                "groupby": _coerce_string_list(spec.get("groupby")),
                "orderby": _coerce_order(spec.get("orderby")),
                "lazy": _coerce_bool(spec.get("lazy"), default=False),
            }
        )
        result = _run_rpc_read_group(client, config=config, uid=uid, payload=compiled_payload)

    return {
        **result,
        "result_type": "query_spec_result",
        "query_spec": {
            "model": model,
            "method": method,
            "domain": compiled_payload.get("domain", []),
            "fields": compiled_payload.get("fields", []),
            "groupby": compiled_payload.get("groupby", []),
            "limit": compiled_payload.get("limit"),
            "offset": compiled_payload.get("offset"),
            "order": compiled_payload.get("order"),
            "orderby": compiled_payload.get("orderby"),
            "lazy": compiled_payload.get("lazy"),
        },
    }


DEFAULT_REVENUE_ACCOUNT_TYPES = ("income", "income_other")
DEFAULT_COGS_ACCOUNT_TYPES = ("expense_direct_cost",)
P_AND_L_COGS_NAME_TERMS = ("cost of revenue", "cost of goods", "cogs")
P_AND_L_AD_SPEND_NAME_TERMS = ("advert", "ad spend", "marketing", "meta", "facebook", "google", "tiktok")


def _finance_account_type_scope(value: Any, *, default: tuple[str, ...]) -> list[str]:
    raw_values = _coerce_string_list(value)
    normalized = [item.strip() for item in raw_values if item.strip()]
    return normalized or list(default)


def _finance_period_ledger_summary(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    payload: dict[str, Any],
    metric: str,
    account_ids_key: str,
    account_types_key: str,
    default_account_types: tuple[str, ...],
    sign_multiplier: int,
) -> dict[str, Any]:
    date_from, date_to = _resolve_period_window(payload)
    resolved_company_ids, company_name_terms = _resolve_company_scope(
        client,
        config=config,
        uid=uid,
        payload=payload,
        allow_multiple=False,
    )
    company_id = resolved_company_ids[0] if resolved_company_ids else None
    domain: list[Any] = [
        ["parent_state", "=", "posted"],
        ["date", ">=", date_from],
        ["date", "<", date_to],
    ]
    if company_id is not None:
        domain.append(["company_id", "=", company_id])

    requested_account_ids = payload.get(account_ids_key)
    account_ids_scope = [int(item) for item in requested_account_ids if isinstance(item, int)] if isinstance(requested_account_ids, list) else []
    account_type_scope: list[str] = []
    if account_ids_scope:
        domain.append(["account_id", "in", account_ids_scope])
    else:
        account_type_scope = _finance_account_type_scope(payload.get(account_types_key), default=default_account_types)
        if len(account_type_scope) == 1:
            domain.append(["account_id.account_type", "=", account_type_scope[0]])
        else:
            domain.append(["account_id.account_type", "in", account_type_scope])
    domain.extend(_coerce_domain(payload.get("domain")))

    rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="account.move.line",
        method="read_group",
        kwargs={
            "domain": domain,
            "fields": ["balance:sum"],
            "groupby": ["company_id", "account_id"],
            "lazy": False,
        },
    )
    if not isinstance(rows, list):
        raise OdooConnectorError("Unexpected response for account.move.line.read_group")

    clean_rows = [row for row in rows if isinstance(row, dict)]
    account_ids_in_rows: list[int] = []
    company_ids_in_rows: list[int] = []
    parsed_rows: list[dict[str, Any]] = []
    total = 0.0

    for row in clean_rows:
        company_field = row.get("company_id")
        account_field = row.get("account_id")
        if not isinstance(account_field, (list, tuple)) or not account_field:
            continue
        try:
            raw_balance = float(row.get("balance") or 0.0)
            account_id = int(account_field[0])
        except (TypeError, ValueError):
            continue
        amount = raw_balance * sign_multiplier
        account_name = str(account_field[1]) if len(account_field) > 1 and account_field[1] else str(account_id)
        parsed_row: dict[str, Any] = {
            "account_id": account_id,
            "account_name": account_name,
            "raw_balance": raw_balance,
            "amount": amount,
        }
        if account_id not in account_ids_in_rows:
            account_ids_in_rows.append(account_id)
        if isinstance(company_field, (list, tuple)) and company_field:
            try:
                parsed_company_id = int(company_field[0])
            except (TypeError, ValueError):
                parsed_company_id = None
            if parsed_company_id is not None:
                parsed_row["company_id"] = parsed_company_id
                parsed_row["company_name"] = (
                    str(company_field[1]) if len(company_field) > 1 and company_field[1] else str(parsed_company_id)
                )
                if parsed_company_id not in company_ids_in_rows:
                    company_ids_in_rows.append(parsed_company_id)
        parsed_rows.append(parsed_row)
        total += amount

    account_identity_by_id = _account_identity_map(client, config=config, uid=uid, account_ids=account_ids_in_rows)
    company_name_by_id = _company_name_map(client, config=config, uid=uid, company_ids=company_ids_in_rows)
    for row in parsed_rows:
        parsed_company_id = row.get("company_id")
        if isinstance(parsed_company_id, int):
            row["company_name"] = company_name_by_id.get(parsed_company_id, row.get("company_name", str(parsed_company_id)))
        account_meta = account_identity_by_id.get(row["account_id"], {})
        row["account_code"] = account_meta.get("code", str(row["account_id"]))
        row["account_name"] = account_meta.get("name", row["account_name"])

    parsed_rows.sort(key=lambda item: abs(float(item.get("amount") or 0.0)), reverse=True)
    scope_mode = "account_ids" if account_ids_scope else "account_types"
    return {
        "model": "account.move.line",
        "method": "read_group",
        "metric": metric,
        "result_type": "period_aggregate",
        "basis": "posted_ledger_lines",
        "scope_mode": scope_mode,
        "sign_normalization": "amount = balance * sign_multiplier",
        "date_from": date_from,
        "date_to": date_to,
        "company_id": company_id,
        "company_name_terms": company_name_terms,
        "count": len(parsed_rows),
        "total": total,
        "account_ids_scope": account_ids_scope,
        "account_type_scope": account_type_scope,
        "rows": parsed_rows,
    }


def _run_finance_revenue_period(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    return _finance_period_ledger_summary(
        client,
        config=config,
        uid=uid,
        payload=payload,
        metric="revenue",
        account_ids_key="revenue_account_ids",
        account_types_key="revenue_account_types",
        default_account_types=DEFAULT_REVENUE_ACCOUNT_TYPES,
        sign_multiplier=-1,
    )


def _run_finance_cogs_period(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    return _finance_period_ledger_summary(
        client,
        config=config,
        uid=uid,
        payload=payload,
        metric="cogs",
        account_ids_key="cogs_account_ids",
        account_types_key="cogs_account_types",
        default_account_types=DEFAULT_COGS_ACCOUNT_TYPES,
        sign_multiplier=1,
    )


def _run_finance_margin_period_summary(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    revenue_data = _run_finance_revenue_period(client, config=config, uid=uid, payload=payload)
    cogs_data = _run_finance_cogs_period(client, config=config, uid=uid, payload=payload)
    revenue = float(revenue_data.get("total") or 0.0)
    cogs = float(cogs_data.get("total") or 0.0)
    gp = revenue - cogs
    return {
        "result_type": "period_margin_summary",
        "date_from": revenue_data.get("date_from"),
        "date_to": revenue_data.get("date_to"),
        "company_id": revenue_data.get("company_id"),
        "company_name_terms": revenue_data.get("company_name_terms") or [],
        "revenue": revenue,
        "cogs": cogs,
        "gp": gp,
        "gp_pct": (gp / revenue) if revenue else 0.0,
        "revenue_source": revenue_data,
        "cogs_source": cogs_data,
        "lookup_basis": "posted_ledger_lines",
        "accuracy_notes": [
            "Revenue now comes from posted account.move.line revenue accounts, not invoice header untaxed totals.",
            "COGS still defaults to account_type expense_direct_cost unless cogs_account_ids or cogs_account_types are provided.",
        ],
    }


def _classify_pnl_bucket(*, account_type: str, account_name: str) -> str:
    lowered_type = account_type.strip().casefold()
    lowered_name = account_name.strip().casefold()
    if lowered_type.startswith("income"):
        if lowered_type == "income_other" or "other income" in lowered_name:
            return "other_income"
        return "operating_income"
    if lowered_type == "expense_direct_cost" or any(term in lowered_name for term in P_AND_L_COGS_NAME_TERMS):
        return "cost_of_revenue"
    if lowered_type == "expense_depreciation" or "depreciat" in lowered_name:
        return "depreciation"
    if lowered_type.startswith("expense"):
        return "expenses"
    if "income" in lowered_name:
        return "operating_income"
    if any(term in lowered_name for term in P_AND_L_COGS_NAME_TERMS):
        return "cost_of_revenue"
    return "expenses"


def _run_finance_pnl_period_summary(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    date_from, date_to = _resolve_period_window(payload)
    company_ids, company_name_terms = _resolve_company_scope(
        client,
        config=config,
        uid=uid,
        payload=payload,
        allow_multiple=True,
    )
    domain: list[Any] = [
        ["parent_state", "=", "posted"],
        ["date", ">=", date_from],
        ["date", "<", date_to],
    ]
    if company_ids:
        domain.append(["company_id", "in", company_ids])
    domain.extend(_coerce_domain(payload.get("domain")))
    rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="account.move.line",
        method="read_group",
        kwargs={
            "domain": domain,
            "fields": ["balance:sum"],
            "groupby": ["company_id", "account_id"],
            "lazy": False,
        },
    )
    if not isinstance(rows, list):
        raise OdooConnectorError("Unexpected response for account.move.line.read_group")

    clean_rows = [row for row in rows if isinstance(row, dict)]
    account_ids_in_rows: list[int] = []
    resolved_company_ids: list[int] = []
    parsed_rows: list[dict[str, Any]] = []
    for row in clean_rows:
        company_field = row.get("company_id")
        account_field = row.get("account_id")
        if not isinstance(account_field, (list, tuple)) or not account_field:
            continue
        if not isinstance(company_field, (list, tuple)) or not company_field:
            continue
        try:
            account_id = int(account_field[0])
            parsed_company_id = int(company_field[0])
            raw_balance = float(row.get("balance") or 0.0)
        except (TypeError, ValueError):
            continue
        if account_id not in account_ids_in_rows:
            account_ids_in_rows.append(account_id)
        if parsed_company_id not in resolved_company_ids:
            resolved_company_ids.append(parsed_company_id)
        parsed_rows.append(
            {
                "company_id": parsed_company_id,
                "company_name": str(company_field[1]) if len(company_field) > 1 and company_field[1] else str(parsed_company_id),
                "account_id": account_id,
                "account_name": str(account_field[1]) if len(account_field) > 1 and account_field[1] else str(account_id),
                "raw_balance": raw_balance,
            }
        )

    account_meta_records = _search_read(
        client,
        config=config,
        uid=uid,
        model="account.account",
        domain=[["id", "in", account_ids_in_rows]] if account_ids_in_rows else [],
        fields=["id", "code", "name", "account_type"],
        limit=max(len(account_ids_in_rows), 1),
        offset=0,
        order="code asc",
    )
    account_meta_by_id: dict[int, dict[str, str]] = {}
    for record in account_meta_records:
        try:
            account_id = int(record.get("id"))
        except (TypeError, ValueError):
            continue
        account_meta_by_id[account_id] = {
            "code": str(record.get("code") or account_id),
            "name": str(record.get("name") or account_id),
            "account_type": str(record.get("account_type") or ""),
        }
    company_name_by_id = _company_name_map(client, config=config, uid=uid, company_ids=resolved_company_ids)
    company_totals: dict[int, dict[str, float | int | str | None]] = {}
    account_rows: list[dict[str, Any]] = []
    for row in parsed_rows:
        company_id = int(row["company_id"])
        company_bucket = company_totals.setdefault(
            company_id,
            {
                "company_id": company_id,
                "company_name": company_name_by_id.get(company_id, str(company_id)),
                "operating_income": 0.0,
                "other_income": 0.0,
                "cost_of_revenue": 0.0,
                "expenses": 0.0,
                "depreciation": 0.0,
                "ad_spend": 0.0,
            },
        )
        account_meta = account_meta_by_id.get(int(row["account_id"]), {})
        account_name = str(account_meta.get("name") or row["account_name"])
        account_type = str(account_meta.get("account_type") or "")
        raw_balance = float(row.get("raw_balance") or 0.0)
        normalized_amount = -raw_balance if account_type.casefold().startswith("income") else raw_balance
        bucket = _classify_pnl_bucket(account_type=account_type, account_name=account_name)
        company_bucket[bucket] = float(company_bucket[bucket] or 0.0) + normalized_amount
        lowered_name = account_name.casefold()
        if bucket in {"expenses", "depreciation"} and any(term in lowered_name for term in P_AND_L_AD_SPEND_NAME_TERMS):
            company_bucket["ad_spend"] = float(company_bucket["ad_spend"] or 0.0) + normalized_amount
        account_rows.append(
            {
                "company_id": company_id,
                "company_name": company_bucket.get("company_name") or str(company_id),
                "account_id": int(row["account_id"]),
                "account_code": str(account_meta.get("code") or row["account_id"]),
                "account_name": account_name,
                "account_type": account_type,
                "bucket": bucket,
                "raw_balance": raw_balance,
                "normalized_amount": normalized_amount,
            }
        )

    companies: list[dict[str, Any]] = []
    for company_id, totals in sorted(company_totals.items(), key=lambda item: item[0]):
        operating_income = float(totals.get("operating_income") or 0.0)
        other_income = float(totals.get("other_income") or 0.0)
        cost_of_revenue = float(totals.get("cost_of_revenue") or 0.0)
        expenses = float(totals.get("expenses") or 0.0)
        depreciation = float(totals.get("depreciation") or 0.0)
        ad_spend = float(totals.get("ad_spend") or 0.0)
        total_income = operating_income + other_income
        total_gross_profit = total_income - cost_of_revenue
        total_expenses = expenses + depreciation
        net_profit = total_gross_profit - total_expenses
        companies.append(
            {
                "company_id": company_id,
                "company_name": totals.get("company_name") or str(company_id),
                "operating_income": operating_income,
                "other_income": other_income,
                "cost_of_revenue": cost_of_revenue,
                "total_gross_profit": total_gross_profit,
                "total_income": total_income,
                "expenses": expenses,
                "depreciation": depreciation,
                "total_expenses": total_expenses,
                "net_profit": net_profit,
                "revenue": operating_income,
                "cogs": cost_of_revenue,
                "gp": total_gross_profit,
                "ad_spend": ad_spend,
                "roas": (operating_income / ad_spend) if ad_spend else None,
            }
        )

    group_totals = {
        "operating_income": sum(float(company.get("operating_income") or 0.0) for company in companies),
        "other_income": sum(float(company.get("other_income") or 0.0) for company in companies),
        "cost_of_revenue": sum(float(company.get("cost_of_revenue") or 0.0) for company in companies),
        "total_gross_profit": sum(float(company.get("total_gross_profit") or 0.0) for company in companies),
        "total_income": sum(float(company.get("total_income") or 0.0) for company in companies),
        "expenses": sum(float(company.get("expenses") or 0.0) for company in companies),
        "depreciation": sum(float(company.get("depreciation") or 0.0) for company in companies),
        "total_expenses": sum(float(company.get("total_expenses") or 0.0) for company in companies),
        "net_profit": sum(float(company.get("net_profit") or 0.0) for company in companies),
        "revenue": sum(float(company.get("revenue") or 0.0) for company in companies),
        "cogs": sum(float(company.get("cogs") or 0.0) for company in companies),
        "gp": sum(float(company.get("gp") or 0.0) for company in companies),
        "ad_spend": sum(float(company.get("ad_spend") or 0.0) for company in companies),
    }
    group_totals["roas"] = (
        group_totals["revenue"] / group_totals["ad_spend"] if float(group_totals["ad_spend"] or 0.0) else None
    )
    response: dict[str, Any] = {
        "result_type": "period_pnl_summary",
        "basis": "posted_ledger_lines",
        "date_from": date_from,
        "date_to": date_to,
        "company_ids": [int(company["company_id"]) for company in companies],
        "company_name_terms": company_name_terms,
        "rows": companies,
        "companies": companies,
        "account_rows": account_rows,
        "group_totals": group_totals,
        "lookup_basis": "odoo_profit_and_loss_from_posted_move_lines",
        "classification_notes": [
            "Income-based figures are normalized from account.move.line balance using account.account.account_type.",
            "ROAS is computed as operating_income / ad_spend where ad_spend is inferred from expense accounts containing ad/marketing keywords.",
        ],
    }
    if len(companies) == 1:
        company = companies[0]
        response.update(
            {
                "company_id": company.get("company_id"),
                "operating_income": company.get("operating_income"),
                "other_income": company.get("other_income"),
                "cost_of_revenue": company.get("cost_of_revenue"),
                "total_gross_profit": company.get("total_gross_profit"),
                "total_income": company.get("total_income"),
                "expenses": company.get("expenses"),
                "depreciation": company.get("depreciation"),
                "total_expenses": company.get("total_expenses"),
                "net_profit": company.get("net_profit"),
                "revenue": company.get("revenue"),
                "cogs": company.get("cogs"),
                "gp": company.get("gp"),
                "roas": company.get("roas"),
            }
        )
    return response


def _run_finance_revenue_monthly(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    date_from, date_to, months = _resolve_monthly_window(payload)
    domain: list[Any] = [
        ["state", "=", "posted"],
        ["move_type", "in", ["out_invoice", "out_refund"]],
        ["invoice_date", ">=", date_from],
        ["invoice_date", "<", date_to],
    ]
    company_ids, company_name_terms = _resolve_company_scope(
        client,
        config=config,
        uid=uid,
        payload=payload,
        allow_multiple=True,
    )
    if company_ids:
        domain.append(["company_id", "in", company_ids])
    domain.extend(_coerce_domain(payload.get("domain")))
    rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="account.move",
        method="read_group",
        kwargs={
            "domain": domain,
            "fields": ["amount_untaxed_signed:sum"],
            "groupby": ["company_id", "invoice_date:month"],
            "orderby": "invoice_date asc",
            "lazy": False,
        },
    )
    if not isinstance(rows, list):
        raise OdooConnectorError("Unexpected response for account.move.read_group")
    company_name_by_id = _company_name_map(client, config=config, uid=uid, company_ids=company_ids)
    clean_rows = [row for row in rows if isinstance(row, dict)]
    return {
        "model": "account.move",
        "method": "read_group",
        "metric": "revenue",
        "result_type": "monthly_aggregate",
        "date_from": date_from,
        "date_to": date_to,
        "months": months,
        "company_ids": company_ids,
        "company_name_terms": company_name_terms,
        "company_name_by_id": company_name_by_id,
        "count": len(clean_rows),
        "rows": clean_rows,
    }


def _run_finance_cogs_monthly(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    date_from, date_to, months = _resolve_monthly_window(payload)
    domain: list[Any] = [
        ["parent_state", "=", "posted"],
        ["date", ">=", date_from],
        ["date", "<", date_to],
    ]
    company_ids, company_name_terms = _resolve_company_scope(
        client,
        config=config,
        uid=uid,
        payload=payload,
        allow_multiple=True,
    )
    if company_ids:
        domain.append(["company_id", "in", company_ids])
    cogs_account_ids = payload.get("cogs_account_ids")
    if isinstance(cogs_account_ids, list) and cogs_account_ids:
        domain.append(["account_id", "in", cogs_account_ids])
    else:
        domain.append(["account_id.account_type", "=", "expense_direct_cost"])
    domain.extend(_coerce_domain(payload.get("domain")))
    rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="account.move.line",
        method="read_group",
        kwargs={
            "domain": domain,
            "fields": ["balance:sum"],
            "groupby": ["company_id", "date:month"],
            "orderby": "date asc",
            "lazy": False,
        },
    )
    if not isinstance(rows, list):
        raise OdooConnectorError("Unexpected response for account.move.line.read_group")
    company_name_by_id = _company_name_map(client, config=config, uid=uid, company_ids=company_ids)
    clean_rows = [row for row in rows if isinstance(row, dict)]
    return {
        "model": "account.move.line",
        "method": "read_group",
        "metric": "cogs",
        "result_type": "monthly_aggregate",
        "date_from": date_from,
        "date_to": date_to,
        "months": months,
        "company_ids": company_ids,
        "company_name_terms": company_name_terms,
        "company_name_by_id": company_name_by_id,
        "count": len(clean_rows),
        "rows": clean_rows,
    }


def _run_finance_cogs_monthly_code_breakdown(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    date_from, date_to, months = _resolve_monthly_window(payload)
    domain: list[Any] = [
        ["parent_state", "=", "posted"],
        ["date", ">=", date_from],
        ["date", "<", date_to],
    ]
    company_ids = _coerce_company_ids(payload)
    if company_ids:
        domain.append(["company_id", "in", company_ids])
    elif payload.get("company_id") is not None:
        domain.append(["company_id", "=", payload.get("company_id")])
    cogs_account_ids = payload.get("cogs_account_ids")
    if isinstance(cogs_account_ids, list) and cogs_account_ids:
        domain.append(["account_id", "in", cogs_account_ids])
    else:
        domain.append(["account_id.account_type", "=", "expense_direct_cost"])
    domain.extend(_coerce_domain(payload.get("domain")))
    rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="account.move.line",
        method="read_group",
        kwargs={
            "domain": domain,
            "fields": ["balance:sum"],
            "groupby": ["company_id", "date:month", "account_id"],
            "orderby": "date asc",
            "lazy": False,
        },
    )
    if not isinstance(rows, list):
        raise OdooConnectorError("Unexpected response for account.move.line.read_group")

    top_n = _coerce_limit(payload.get("top_n"), default=8, maximum=25)
    clean_rows = [row for row in rows if isinstance(row, dict)]
    parsed_rows: list[dict[str, Any]] = []
    account_ids: list[int] = []
    company_name_by_id = _company_name_map(client, config=config, uid=uid, company_ids=company_ids)

    for row in clean_rows:
        company_field = row.get("company_id")
        if not isinstance(company_field, (list, tuple)) or not company_field:
            continue
        account_field = row.get("account_id")
        if not isinstance(account_field, (list, tuple)) or not account_field:
            continue
        try:
            company_id = int(company_field[0])
            account_id = int(account_field[0])
            balance = float(row.get("balance") or 0.0)
        except (TypeError, ValueError):
            continue
        month_key = _extract_month_key(row, "date:month", fallback="unknown")
        if account_id not in account_ids:
            account_ids.append(account_id)
        parsed_rows.append(
            {
                "company_id": company_id,
                "company_name": str(company_field[1]) if len(company_field) > 1 and company_field[1] else str(company_id),
                "month": month_key,
                "account_id": account_id,
                "account_name": str(account_field[1]) if len(account_field) > 1 and account_field[1] else str(account_id),
                "cogs": balance,
            }
        )

    company_name_by_id = _company_name_map(client, config=config, uid=uid, company_ids=[row["company_id"] for row in parsed_rows])
    account_identity_by_id = _account_identity_map(client, config=config, uid=uid, account_ids=account_ids)

    buckets_by_key: dict[tuple[int, str], dict[str, Any]] = {}
    previous_by_account: dict[tuple[int, int], dict[str, Any]] = {}
    anomalies: list[dict[str, Any]] = []

    for row in parsed_rows:
        account_meta = account_identity_by_id.get(row["account_id"], {})
        row["account_code"] = account_meta.get("code", str(row["account_id"]))
        row["account_name"] = account_meta.get("name", row["account_name"])
        row["company_name"] = company_name_by_id.get(row["company_id"], row["company_name"])

        bucket_key = (row["company_id"], row["month"])
        bucket = buckets_by_key.setdefault(
            bucket_key,
            {
                "company_id": row["company_id"],
                "company_name": row["company_name"],
                "month": row["month"],
                "total_cogs": 0.0,
                "rows": [],
            },
        )
        bucket["total_cogs"] += row["cogs"]
        bucket["rows"].append(row)

        previous_key = (row["company_id"], row["account_id"])
        previous = previous_by_account.get(previous_key)
        if previous and previous.get("cogs"):
            delta_pct = (row["cogs"] - previous["cogs"]) / abs(previous["cogs"])
            if abs(delta_pct) >= 0.2:
                anomalies.append(
                    {
                        "company_id": row["company_id"],
                        "company_name": row["company_name"],
                        "month": row["month"],
                        "account_id": row["account_id"],
                        "account_code": row["account_code"],
                        "account_name": row["account_name"],
                        "cogs": row["cogs"],
                        "previous_cogs": previous["cogs"],
                        "delta_pct": delta_pct,
                        "reason": "COGS code moved more than 20% versus the prior visible month.",
                    }
                )
        previous_by_account[previous_key] = row

    buckets = []
    for (_company_id, _month), bucket in sorted(buckets_by_key.items(), key=lambda item: (item[0][0], item[0][1])):
        sorted_rows = sorted(bucket["rows"], key=lambda item: abs(float(item.get("cogs") or 0.0)), reverse=True)
        buckets.append(
            {
                "company_id": bucket["company_id"],
                "company_name": bucket["company_name"],
                "month": bucket["month"],
                "total_cogs": bucket["total_cogs"],
                "top_codes": sorted_rows[:top_n],
                "row_count": len(sorted_rows),
            }
        )

    anomalies.sort(key=lambda item: abs(float(item.get("delta_pct") or 0.0)), reverse=True)

    return {
        "model": "account.move.line",
        "method": "read_group",
        "metric": "cogs_code_breakdown",
        "result_type": "monthly_cogs_code_breakdown",
        "date_from": date_from,
        "date_to": date_to,
        "months": months,
        "company_ids": company_ids,
        "top_n": top_n,
        "count": len(parsed_rows),
        "buckets": buckets,
        "anomalies": anomalies[:12],
    }


def _run_finance_margin_monthly_comparison(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    revenue_data = _run_finance_revenue_monthly(client, config=config, uid=uid, payload=payload)
    cogs_data = _run_finance_cogs_monthly(client, config=config, uid=uid, payload=payload)
    revenue_rows = revenue_data.get("rows") if isinstance(revenue_data.get("rows"), list) else []
    cogs_rows = cogs_data.get("rows") if isinstance(cogs_data.get("rows"), list) else []
    company_name_by_id = dict(revenue_data.get("company_name_by_id") or cogs_data.get("company_name_by_id") or {})

    revenue_by_key: dict[tuple[int, str], float] = {}
    for row in revenue_rows:
        if not isinstance(row, dict):
            continue
        company_field = row.get("company_id")
        if not isinstance(company_field, (list, tuple)) or not company_field:
            continue
        try:
            company_id = int(company_field[0])
            month_key = _extract_month_key(row, "invoice_date:month", fallback="unknown")
            revenue_by_key[(company_id, month_key)] = float(row.get("amount_untaxed_signed") or 0.0)
            if len(company_field) > 1 and company_field[1]:
                company_name_by_id.setdefault(company_id, str(company_field[1]))
        except (TypeError, ValueError):
            continue

    cogs_by_key: dict[tuple[int, str], float] = {}
    for row in cogs_rows:
        if not isinstance(row, dict):
            continue
        company_field = row.get("company_id")
        if not isinstance(company_field, (list, tuple)) or not company_field:
            continue
        try:
            company_id = int(company_field[0])
            month_key = _extract_month_key(row, "date:month", fallback="unknown")
            cogs_by_key[(company_id, month_key)] = float(row.get("balance") or 0.0)
            if len(company_field) > 1 and company_field[1]:
                company_name_by_id.setdefault(company_id, str(company_field[1]))
        except (TypeError, ValueError):
            continue

    months_seen = sorted({month for (_company_id, month) in {*revenue_by_key.keys(), *cogs_by_key.keys()}})
    company_ids = _coerce_company_ids(payload)
    if not company_ids:
        fallback_ids = revenue_data.get("company_ids")
        if isinstance(fallback_ids, list) and fallback_ids:
            company_ids = [int(value) for value in fallback_ids if value is not None]
    if not company_ids:
        company_ids = sorted({company_id for (company_id, _month) in {*revenue_by_key.keys(), *cogs_by_key.keys()}})
    comparison_rows: list[dict[str, Any]] = []
    company_summaries: list[dict[str, Any]] = []
    for company_id in company_ids:
        running_gp = 0.0
        monthly_rows: list[dict[str, Any]] = []
        previous_gp: float | None = None
        anomalies: list[dict[str, Any]] = []
        for month_key in months_seen:
            revenue = revenue_by_key.get((company_id, month_key), 0.0)
            cogs = cogs_by_key.get((company_id, month_key), 0.0)
            gp = revenue - cogs
            gp_pct = (gp / revenue) if revenue else 0.0
            row = {
                "company_id": company_id,
                "company_name": company_name_by_id.get(company_id, str(company_id)),
                "month": month_key,
                "revenue": revenue,
                "cogs": cogs,
                "gp": gp,
                "gp_pct": gp_pct,
            }
            if previous_gp is not None and previous_gp:
                gp_delta_pct = (gp - previous_gp) / abs(previous_gp)
                row["gp_delta_pct"] = gp_delta_pct
                if abs(gp_delta_pct) >= 0.2:
                    anomalies.append(
                        {
                            "company_id": company_id,
                            "company_name": company_name_by_id.get(company_id, str(company_id)),
                            "month": month_key,
                            "metric": "gp",
                            "delta_pct": gp_delta_pct,
                            "reason": "GP moved more than 20% versus prior month.",
                        }
                    )
            monthly_rows.append(row)
            comparison_rows.append(row)
            running_gp += gp
            previous_gp = gp
        company_summaries.append(
            {
                "company_id": company_id,
                "company_name": company_name_by_id.get(company_id, str(company_id)),
                "months": monthly_rows,
                "total_revenue": sum(item["revenue"] for item in monthly_rows),
                "total_cogs": sum(item["cogs"] for item in monthly_rows),
                "total_gp": running_gp,
                "avg_gp_pct": (
                    sum(item["gp"] for item in monthly_rows) / sum(item["revenue"] for item in monthly_rows)
                    if sum(item["revenue"] for item in monthly_rows)
                    else 0.0
                ),
                "anomalies": anomalies,
            }
        )

    return {
        "result_type": "monthly_margin_comparison",
        "date_from": revenue_data.get("date_from"),
        "date_to": revenue_data.get("date_to"),
        "months": revenue_data.get("months"),
        "company_ids": company_ids,
        "company_name_by_id": company_name_by_id,
        "rows": comparison_rows,
        "companies": company_summaries,
        "anomalies": [item for company in company_summaries for item in company.get("anomalies", [])],
        "revenue_source": revenue_data,
        "cogs_source": cogs_data,
    }


def _run_finance_shopify_monthly_roi(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    date_from, date_to = _resolve_period_window(payload)
    company_ids, company_name_terms = _resolve_company_scope(
        client,
        config=config,
        uid=uid,
        payload=payload,
        allow_multiple=True,
    )
    if not company_ids:
        raise OdooConnectorError("Shopify ROI helper requires company_id, company_ids, or company_name_terms")

    shopify_accounts = _account_lookup_by_terms(
        client,
        config=config,
        uid=uid,
        terms=SHOPIFY_REVENUE_ACCOUNT_TERMS + SHOPIFY_FEE_ACCOUNT_TERMS,
    )
    marketing_accounts = _account_lookup_by_terms(
        client,
        config=config,
        uid=uid,
        terms=MARKETING_ACCOUNT_TERMS,
    )
    shopify_journals = _search_read(
        client,
        config=config,
        uid=uid,
        model="account.journal",
        domain=_build_or_domain([["name", "ilike", "shopify"], ["code", "ilike", "shopify"]]),
        fields=["id", "name", "code", "type", "company_id"],
        limit=100,
        offset=0,
        order="name asc",
    )
    shopify_journal_ids: list[int] = []
    for record in shopify_journals:
        if not _looks_like_shopify_journal(record):
            continue
        company_field = record.get("company_id")
        if isinstance(company_field, (list, tuple)) and company_field:
            try:
                journal_company_id = int(company_field[0])
            except (TypeError, ValueError):
                journal_company_id = None
            if journal_company_id is not None and journal_company_id not in company_ids:
                continue
        try:
            journal_id = int(record.get("id"))
        except (TypeError, ValueError):
            continue
        if journal_id not in shopify_journal_ids:
            shopify_journal_ids.append(journal_id)

    shopify_account_map: dict[int, dict[str, Any]] = {}
    category_account_ids: dict[str, list[int]] = {
        "shopify_revenue": [],
        "shopify_discounts": [],
        "shopify_refunds": [],
        "shopify_shipping": [],
        "shopify_fees": [],
    }
    for record in shopify_accounts:
        category = _classify_shopify_account(record)
        if category is None:
            continue
        try:
            account_id = int(record.get("id"))
        except (TypeError, ValueError):
            continue
        shopify_account_map[account_id] = record
        if account_id not in category_account_ids[category]:
            category_account_ids[category].append(account_id)

    marketing_account_map: dict[int, dict[str, Any]] = {}
    marketing_account_ids: list[int] = []
    for record in marketing_accounts:
        try:
            account_id = int(record.get("id"))
        except (TypeError, ValueError):
            continue
        marketing_account_map[account_id] = record
        if account_id not in marketing_account_ids:
            marketing_account_ids.append(account_id)

    tracked_account_ids = [
        *category_account_ids["shopify_revenue"],
        *category_account_ids["shopify_discounts"],
        *category_account_ids["shopify_refunds"],
        *category_account_ids["shopify_shipping"],
        *category_account_ids["shopify_fees"],
        *marketing_account_ids,
    ]
    if not tracked_account_ids:
        raise OdooConnectorError("No Shopify or marketing accounts were found in Odoo for the ROI helper")

    domain: list[Any] = [
        ["parent_state", "=", "posted"],
        ["date", ">=", date_from],
        ["date", "<", date_to],
        ["company_id", "in", company_ids],
        ["account_id", "in", tracked_account_ids],
    ]

    lines = _search_read_paginated(
        client,
        config=config,
        uid=uid,
        model="account.move.line",
        domain=domain,
        fields=["id", "date", "name", "ref", "move_name", "journal_id", "account_id", "partner_id", "balance", "credit", "debit", "company_id"],
        limit=500,
        max_records=5000,
        order="date asc",
    )
    revenue_fallback_mode = "account_mapping"

    company_name_by_id = _company_name_map(client, config=config, uid=uid, company_ids=company_ids)
    month_rows: dict[tuple[int, str], dict[str, Any]] = {}
    journal_names: set[str] = set()
    vendor_names: set[str] = set()
    marketing_vendor_samples: list[dict[str, Any]] = []
    used_accounts: dict[str, set[str]] = {
        "shopify_revenue": set(),
        "shopify_discounts": set(),
        "shopify_refunds": set(),
        "shopify_shipping": set(),
        "shopify_fees": set(),
        "marketing_spend": set(),
    }

    for line in lines:
        company_field = line.get("company_id")
        account_field = line.get("account_id")
        journal_field = line.get("journal_id")
        if not isinstance(company_field, (list, tuple)) or not company_field:
            continue
        if not isinstance(account_field, (list, tuple)) or not account_field:
            continue
        try:
            company_id = int(company_field[0])
            account_id = int(account_field[0])
        except (TypeError, ValueError):
            continue
        month_key = _record_month(line)
        bucket = month_rows.setdefault(
            (company_id, month_key),
            {
                "company_id": company_id,
                "company_name": company_name_by_id.get(company_id, str(company_id)),
                "month": month_key,
                "shopify_revenue": 0.0,
                "shopify_discounts": 0.0,
                "shopify_refunds": 0.0,
                "shopify_shipping": 0.0,
                "shopify_fees": 0.0,
                "marketing_spend": 0.0,
            },
        )
        amount = _shopify_metric_amount(line)
        category = _classify_shopify_account(shopify_account_map.get(account_id, {}))
        if category is not None:
            bucket[category] += amount
            account_name = str(account_field[1]) if len(account_field) > 1 else str(account_id)
            used_accounts[category].add(account_name)
        elif account_id in marketing_account_map:
            bucket["marketing_spend"] += amount
            account_name = str(account_field[1]) if len(account_field) > 1 else str(account_id)
            used_accounts["marketing_spend"].add(account_name)
            vendor_label = _extract_vendor_label(line)
            if vendor_label:
                vendor_names.add(vendor_label)
                if len(marketing_vendor_samples) < 20:
                    marketing_vendor_samples.append(
                        {
                            "date": line.get("date"),
                            "vendor": vendor_label,
                            "journal": journal_field[1] if isinstance(journal_field, (list, tuple)) and len(journal_field) > 1 else None,
                            "account": account_name,
                            "amount": amount,
                            "name": line.get("name"),
                            "ref": line.get("ref"),
                            "move_name": line.get("move_name"),
                            "company_name": bucket["company_name"],
                        }
                    )
        if isinstance(journal_field, (list, tuple)) and len(journal_field) > 1 and str(journal_field[1]).strip():
            journal_names.add(str(journal_field[1]).strip())

    if not any(float(row["shopify_revenue"]) for row in month_rows.values()) and shopify_journal_ids:
        revenue_fallback_lines = _search_read_paginated(
            client,
            config=config,
            uid=uid,
            model="account.move.line",
            domain=[
                ["parent_state", "=", "posted"],
                ["date", ">=", date_from],
                ["date", "<", date_to],
                ["company_id", "in", company_ids],
                ["journal_id", "in", shopify_journal_ids],
            ],
            fields=["id", "date", "name", "ref", "move_name", "journal_id", "account_id", "partner_id", "balance", "credit", "debit", "company_id"],
            limit=500,
            max_records=5000,
            order="date asc",
        )
        for line in revenue_fallback_lines:
            company_field = line.get("company_id")
            account_field = line.get("account_id")
            journal_field = line.get("journal_id")
            if not isinstance(company_field, (list, tuple)) or not company_field:
                continue
            if not isinstance(account_field, (list, tuple)) or len(account_field) < 2:
                continue
            try:
                company_id = int(company_field[0])
            except (TypeError, ValueError):
                continue
            account_name = str(account_field[1] or "").strip().casefold()
            entry_name = " ".join(
                str(line.get(key) or "")
                for key in ("name", "ref", "move_name")
            ).casefold()
            month_key = _record_month(line)
            bucket = month_rows.setdefault(
                (company_id, month_key),
                {
                    "company_id": company_id,
                    "company_name": company_name_by_id.get(company_id, str(company_id)),
                    "month": month_key,
                    "shopify_revenue": 0.0,
                    "shopify_discounts": 0.0,
                    "shopify_refunds": 0.0,
                    "shopify_shipping": 0.0,
                    "shopify_fees": 0.0,
                    "marketing_spend": 0.0,
                },
            )
            amount = _shopify_metric_amount(line)
            if "accounts receivable" in account_name and "customer payment" in entry_name:
                bucket["shopify_revenue"] += amount
                used_accounts["shopify_revenue"].add(str(account_field[1]))
                revenue_fallback_mode = "shopify_journal_ar_lines"
            elif "accounts receivable" in account_name and (
                "customer reimbursement" in entry_name or "reversal of" in entry_name
            ):
                bucket["shopify_refunds"] += amount
                used_accounts["shopify_refunds"].add(str(account_field[1]))
                revenue_fallback_mode = "shopify_journal_ar_lines"
            if isinstance(journal_field, (list, tuple)) and len(journal_field) > 1 and str(journal_field[1]).strip():
                journal_names.add(str(journal_field[1]).strip())

    rows = sorted(month_rows.values(), key=lambda row: (int(row["company_id"]), str(row["month"])))
    for row in rows:
        shopify_revenue = float(row["shopify_revenue"])
        discounts = float(row["shopify_discounts"])
        refunds = float(row["shopify_refunds"])
        shipping = float(row["shopify_shipping"])
        fees = float(row["shopify_fees"])
        marketing_spend = float(row["marketing_spend"])
        net_revenue = shopify_revenue - discounts - refunds + shipping - fees
        row["net_shopify_revenue"] = net_revenue
        row["roas"] = (shopify_revenue / marketing_spend) if marketing_spend else None
        row["contribution_after_marketing"] = net_revenue - marketing_spend

    company_summaries: list[dict[str, Any]] = []
    for company_id in company_ids:
        company_rows = [row for row in rows if int(row["company_id"]) == company_id]
        summary = {
            "company_id": company_id,
            "company_name": company_name_by_id.get(company_id, str(company_id)),
            "months": company_rows,
            "shopify_revenue": sum(float(row["shopify_revenue"]) for row in company_rows),
            "shopify_discounts": sum(float(row["shopify_discounts"]) for row in company_rows),
            "shopify_refunds": sum(float(row["shopify_refunds"]) for row in company_rows),
            "shopify_shipping": sum(float(row["shopify_shipping"]) for row in company_rows),
            "shopify_fees": sum(float(row["shopify_fees"]) for row in company_rows),
            "marketing_spend": sum(float(row["marketing_spend"]) for row in company_rows),
        }
        summary["net_shopify_revenue"] = (
            summary["shopify_revenue"]
            - summary["shopify_discounts"]
            - summary["shopify_refunds"]
            + summary["shopify_shipping"]
            - summary["shopify_fees"]
        )
        summary["roas"] = (
            summary["shopify_revenue"] / summary["marketing_spend"]
            if summary["marketing_spend"]
            else None
        )
        summary["contribution_after_marketing"] = summary["net_shopify_revenue"] - summary["marketing_spend"]
        company_summaries.append(summary)

    group_totals = {
        "shopify_revenue": sum(float(item["shopify_revenue"]) for item in company_summaries),
        "shopify_discounts": sum(float(item["shopify_discounts"]) for item in company_summaries),
        "shopify_refunds": sum(float(item["shopify_refunds"]) for item in company_summaries),
        "shopify_shipping": sum(float(item["shopify_shipping"]) for item in company_summaries),
        "shopify_fees": sum(float(item["shopify_fees"]) for item in company_summaries),
        "marketing_spend": sum(float(item["marketing_spend"]) for item in company_summaries),
    }
    group_totals["net_shopify_revenue"] = (
        group_totals["shopify_revenue"]
        - group_totals["shopify_discounts"]
        - group_totals["shopify_refunds"]
        + group_totals["shopify_shipping"]
        - group_totals["shopify_fees"]
    )
    group_totals["roas"] = (
        group_totals["shopify_revenue"] / group_totals["marketing_spend"]
        if group_totals["marketing_spend"]
        else None
    )
    group_totals["contribution_after_marketing"] = (
        group_totals["net_shopify_revenue"] - group_totals["marketing_spend"]
    )

    attribution_note = (
        "Marketing spend is mapped from marketing-coded expense accounts and detected vendor ledger lines in the selected company scope. "
        "This is channel-proxy attribution, not campaign-perfect Shopify attribution, unless analytic tagging in Odoo explicitly isolates Shopify."
    )

    return {
        "result_type": "shopify_monthly_roi",
        "date_from": date_from,
        "date_to": date_to,
        "company_ids": company_ids,
        "company_name_terms": company_name_terms,
        "company_name_by_id": company_name_by_id,
        "companies": company_summaries,
        "group_totals": group_totals,
        "rows": rows,
        "journals_used": sorted(journal_names),
        "vendors_used": sorted(vendor_names),
        "marketing_vendor_samples": marketing_vendor_samples,
        "accounts_used": {key: sorted(values) for key, values in used_accounts.items() if values},
        "attribution_note": attribution_note,
        "revenue_source_mode": revenue_fallback_mode,
        "line_count": len(lines),
    }


def _run_finance_revenue_quarterly(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    fiscal_year_start_month = max(1, min(12, int(payload.get("fiscal_year_start_month") or 1)))
    quarters = max(1, min(12, int(payload.get("quarters") or 3)))
    ranges = _quarter_ranges(
        quarters=quarters,
        fiscal_year_start_month=fiscal_year_start_month,
        include_current_quarter=_coerce_bool(payload.get("include_current_quarter"), default=False),
    )
    date_from = str(payload.get("date_from") or ranges[0][0].isoformat()).strip()
    date_to = str(payload.get("date_to") or ranges[-1][1].isoformat()).strip()
    domain: list[Any] = [
        ["state", "=", "posted"],
        ["move_type", "in", ["out_invoice", "out_refund"]],
        ["invoice_date", ">=", date_from],
        ["invoice_date", "<", date_to],
    ]
    company_id = payload.get("company_id")
    if company_id is not None:
        domain.append(["company_id", "=", company_id])
    domain.extend(_coerce_domain(payload.get("domain")))
    rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="account.move",
        method="read_group",
        kwargs={
            "domain": domain,
            "fields": ["amount_untaxed_signed:sum"],
            "groupby": ["invoice_date:quarter"],
            "orderby": "invoice_date asc",
            "lazy": False,
        },
    )
    if not isinstance(rows, list):
        raise OdooConnectorError("Unexpected response for account.move.read_group")
    return {
        "model": "account.move",
        "method": "read_group",
        "metric": "revenue",
        "result_type": "aggregate",
        "count": len(rows),
        "date_from": date_from,
        "date_to": date_to,
        "rows": [row for row in rows if isinstance(row, dict)],
    }


def _run_finance_cogs_quarterly(client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]) -> dict[str, Any]:
    fiscal_year_start_month = max(1, min(12, int(payload.get("fiscal_year_start_month") or 1)))
    quarters = max(1, min(12, int(payload.get("quarters") or 3)))
    ranges = _quarter_ranges(
        quarters=quarters,
        fiscal_year_start_month=fiscal_year_start_month,
        include_current_quarter=_coerce_bool(payload.get("include_current_quarter"), default=False),
    )
    date_from = str(payload.get("date_from") or ranges[0][0].isoformat()).strip()
    date_to = str(payload.get("date_to") or ranges[-1][1].isoformat()).strip()
    domain: list[Any] = [
        ["parent_state", "=", "posted"],
        ["date", ">=", date_from],
        ["date", "<", date_to],
    ]
    company_id = payload.get("company_id")
    if company_id is not None:
        domain.append(["company_id", "=", company_id])
    cogs_account_ids = payload.get("cogs_account_ids")
    if isinstance(cogs_account_ids, list) and cogs_account_ids:
        domain.append(["account_id", "in", cogs_account_ids])
    else:
        domain.append(["account_id.account_type", "=", "expense_direct_cost"])
    domain.extend(_coerce_domain(payload.get("domain")))
    rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="account.move.line",
        method="read_group",
        kwargs={
            "domain": domain,
            "fields": ["balance:sum"],
            "groupby": ["date:quarter"],
            "orderby": "date asc",
            "lazy": False,
        },
    )
    if not isinstance(rows, list):
        raise OdooConnectorError("Unexpected response for account.move.line.read_group")
    return {
        "model": "account.move.line",
        "method": "read_group",
        "metric": "cogs",
        "result_type": "aggregate",
        "count": len(rows),
        "date_from": date_from,
        "date_to": date_to,
        "rows": [row for row in rows if isinstance(row, dict)],
    }


def _run_finance_margin_quarterly_summary(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    fiscal_year_start_month = max(1, min(12, int(payload.get("fiscal_year_start_month") or 1)))
    quarters = max(1, min(12, int(payload.get("quarters") or 3)))
    include_current_quarter = _coerce_bool(payload.get("include_current_quarter"), default=False)
    ranges = _quarter_ranges(
        quarters=quarters,
        fiscal_year_start_month=fiscal_year_start_month,
        include_current_quarter=include_current_quarter,
    )
    revenue_data = _run_finance_revenue_quarterly(client, config=config, uid=uid, payload=payload)
    cogs_data = _run_finance_cogs_quarterly(client, config=config, uid=uid, payload=payload)
    revenue_rows = revenue_data.get("rows") if isinstance(revenue_data.get("rows"), list) else []
    cogs_rows = cogs_data.get("rows") if isinstance(cogs_data.get("rows"), list) else []
    revenue_by_label: dict[str, float] = {}
    for row in revenue_rows:
        if not isinstance(row, dict):
            continue
        label = _extract_quarter_key(row, "invoice_date:quarter", fallback="unknown")
        revenue_by_label[label] = float(row.get("amount_untaxed_signed", 0) or 0)
    cogs_by_label: dict[str, float] = {}
    for row in cogs_rows:
        if not isinstance(row, dict):
            continue
        label = _extract_quarter_key(row, "date:quarter", fallback="unknown")
        cogs_by_label[label] = float(row.get("balance", 0) or 0)

    quarters_output: list[dict[str, Any]] = []
    running_revenue = 0.0
    running_cogs = 0.0
    running_gp = 0.0
    for quarter_start, _quarter_end in ranges:
        fallback_label = f"{quarter_start.year}-Q{(((quarter_start.month - 1) // 3) + 1)}"
        revenue = revenue_by_label.get(fallback_label, 0.0)
        cogs = cogs_by_label.get(fallback_label, 0.0)
        gp = revenue - cogs
        running_revenue += revenue
        running_cogs += cogs
        running_gp += gp
        quarters_output.append(
            {
                "quarter": fallback_label,
                "revenue": revenue,
                "cogs": cogs,
                "gp": gp,
                "gp_pct": (gp / revenue) if revenue else 0.0,
                "running_revenue": running_revenue,
                "running_cogs": running_cogs,
                "running_gp": running_gp,
            }
        )

    return {
        "result_type": "quarterly_margin_summary",
        "quarters": quarters_output,
        "revenue_source": revenue_data,
        "cogs_source": cogs_data,
    }


def _run_finance_cash_runway_summary(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    date_from, date_to = _resolve_period_window(payload)
    scope_payload = dict(payload)
    scope_payload.setdefault("date_from", date_from)
    scope_payload.setdefault("date_to", date_to)
    company_ids, company_name_terms = _resolve_company_scope(
        client,
        config=config,
        uid=uid,
        payload=scope_payload,
        allow_multiple=True,
    )
    if len(company_ids) == 1:
        scope_payload["company_id"] = company_ids[0]
    elif company_ids:
        scope_payload["company_ids"] = company_ids
    if company_name_terms:
        scope_payload["company_name_terms"] = company_name_terms

    margin_data = _run_finance_margin_period_summary(client, config=config, uid=uid, payload=scope_payload)

    cash_domain: list[Any] = [
        ["parent_state", "=", "posted"],
        ["date", "<", date_to],
        ["account_id.account_type", "=", "asset_cash"],
    ]
    burn_domain: list[Any] = [
        ["parent_state", "=", "posted"],
        ["date", ">=", date_from],
        ["date", "<", date_to],
        ["account_id.account_type", "in", ["expense", "expense_direct_cost", "expense_depreciation"]],
    ]
    if company_ids:
        cash_domain.append(["company_id", "in", company_ids])
        burn_domain.append(["company_id", "in", company_ids])
    elif scope_payload.get("company_id") is not None:
        cash_domain.append(["company_id", "=", scope_payload.get("company_id")])
        burn_domain.append(["company_id", "=", scope_payload.get("company_id")])

    cash_rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="account.move.line",
        method="read_group",
        kwargs={
            "domain": cash_domain,
            "fields": ["balance:sum"],
            "groupby": ["company_id"],
            "lazy": False,
        },
    )
    burn_rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="account.move.line",
        method="read_group",
        kwargs={
            "domain": burn_domain,
            "fields": ["balance:sum"],
            "groupby": ["company_id"],
            "lazy": False,
        },
    )
    if not isinstance(cash_rows, list):
        raise OdooConnectorError("Unexpected response for account.move.line.read_group cash query")
    if not isinstance(burn_rows, list):
        raise OdooConnectorError("Unexpected response for account.move.line.read_group burn query")

    closing_cash = 0.0
    for row in cash_rows:
        if not isinstance(row, dict):
            continue
        try:
            closing_cash += float(row.get("balance") or 0.0)
        except (TypeError, ValueError):
            continue

    period_expense = 0.0
    for row in burn_rows:
        if not isinstance(row, dict):
            continue
        try:
            period_expense += abs(float(row.get("balance") or 0.0))
        except (TypeError, ValueError):
            continue

    period_days = max(1, (date.fromisoformat(date_to) - date.fromisoformat(date_from)).days)
    daily_burn = period_expense / period_days if period_days else 0.0
    runway_days = (closing_cash / daily_burn) if daily_burn > 0 else None

    insufficient_inputs: list[str] = []
    if closing_cash <= 0:
        insufficient_inputs.append("cash_position")
    if period_expense <= 0:
        insufficient_inputs.append("burn_rate")

    assumptions = [
        "cash_position uses posted balance sums from account.move.line where account_type=asset_cash up to date_to.",
        "daily_burn uses absolute posted expense balance sums for the requested period divided by period day count.",
        "runway_days = cash_position / daily_burn when daily_burn > 0.",
    ]

    return {
        "result_type": "cash_runway_summary",
        "date_from": date_from,
        "date_to": date_to,
        "company_id": margin_data.get("company_id"),
        "company_name_terms": company_name_terms,
        "company_ids": company_ids,
        "revenue": margin_data.get("revenue"),
        "cogs": margin_data.get("cogs"),
        "gp": margin_data.get("gp"),
        "gp_pct": margin_data.get("gp_pct"),
        "cash_position": closing_cash,
        "period_expense": period_expense,
        "period_days": period_days,
        "daily_burn": daily_burn,
        "runway_days": runway_days,
        "insufficient_inputs": insufficient_inputs,
        "status": "insufficient_inputs" if insufficient_inputs else "ok",
        "assumptions": assumptions,
        "cash_source_rows": [row for row in cash_rows if isinstance(row, dict)],
        "burn_source_rows": [row for row in burn_rows if isinstance(row, dict)],
        "margin_source": margin_data,
    }


def _run_exploration_product_branch_sales(
    client: httpx.Client, *, config: OdooConfig, uid: int, payload: dict[str, Any]
) -> dict[str, Any]:
    """
    Multi-step read-only exploration: match products by substring, then aggregate sale.order.line by company.

    This is intentionally not a single canned finance helper — it mirrors “search then drill” behavior
    (similar in spirit to iterative vector retrieval) while staying inside governed RPCs.
    """
    _normalize_company_scope_lock_payload(payload)
    substring = str(payload.get("product_name_substring") or payload.get("query") or "").strip()
    if len(substring) < 2:
        raise OdooConnectorError("exploration requires `product_name_substring` (or `query`) with length >= 2")

    date_from = str(payload.get("date_from") or "").strip()
    date_to = str(payload.get("date_to") or "").strip()
    if not date_from or not date_to:
        today = date.today()
        start = date(today.year, 1, 1)
        date_from = start.isoformat()
        date_to = (today + timedelta(days=1)).isoformat()

    company_ids, company_name_terms = _resolve_company_scope(
        client,
        config=config,
        uid=uid,
        payload=payload,
        allow_multiple=True,
    )
    exploration_trace: list[dict[str, Any]] = []
    ilike = f"%{substring}%"
    tmpl_domain: list[Any] = ["|", ["name", "ilike", ilike], ["default_code", "ilike", ilike]]
    tmpl_rows = _search_read(
        client,
        config=config,
        uid=uid,
        model="product.template",
        domain=tmpl_domain,
        fields=["id", "name", "default_code"],
        limit=100,
        offset=0,
        order="id asc",
    )
    exploration_trace.append(
        {
            "step": 1,
            "action": "product.template search_read",
            "domain": tmpl_domain,
            "match_count": len(tmpl_rows),
            "sample": tmpl_rows[:5],
        }
    )
    tmpl_ids = [int(r["id"]) for r in tmpl_rows if r.get("id") is not None]
    product_ids: list[int] = []
    if tmpl_ids:
        variants = _search_read(
            client,
            config=config,
            uid=uid,
            model="product.product",
            domain=[["product_tmpl_id", "in", tmpl_ids]],
            fields=["id", "name"],
            limit=500,
            offset=0,
            order="id asc",
        )
        product_ids.extend(int(v["id"]) for v in variants if v.get("id") is not None)
    pp_domain: list[Any] = ["|", ["name", "ilike", ilike], ["default_code", "ilike", ilike]]
    pp_rows = _search_read(
        client,
        config=config,
        uid=uid,
        model="product.product",
        domain=pp_domain,
        fields=["id", "name", "product_tmpl_id"],
        limit=120,
        offset=0,
        order="id asc",
    )
    exploration_trace.append(
        {
            "step": 2,
            "action": "product.product search_read",
            "domain": pp_domain,
            "match_count": len(pp_rows),
            "sample": pp_rows[:5],
        }
    )
    for row in pp_rows:
        if not isinstance(row, dict):
            continue
        try:
            pid = int(row.get("id"))
        except (TypeError, ValueError):
            continue
        if pid not in product_ids:
            product_ids.append(pid)
    product_ids = product_ids[:400]

    if not product_ids:
        return {
            "result_type": "exploration_product_branch_sales",
            "date_from": date_from,
            "date_to": date_to,
            "product_name_substring": substring,
            "company_ids": company_ids,
            "company_name_terms": company_name_terms,
            "exploration_trace": exploration_trace,
            "comparison_rows": [],
            "accuracy_notes": [
                "No product.template / product.product rows matched the substring.",
                "Try a shorter brand token, check default_code, or confirm the SKU exists in Odoo.",
            ],
        }

    sol_domain: list[Any] = [
        ["order_id.state", "in", ["sale", "done"]],
        ["order_id.date_order", ">=", date_from],
        ["order_id.date_order", "<", date_to],
        ["product_id", "in", product_ids],
    ]
    if company_ids:
        sol_domain.append(["company_id", "in", company_ids])

    rows = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="sale.order.line",
        method="read_group",
        kwargs={
            "domain": sol_domain,
            "fields": ["price_subtotal:sum", "product_uom_qty:sum"],
            "groupby": ["company_id"],
            "lazy": False,
        },
    )
    exploration_trace.append(
        {
            "step": 3,
            "action": "sale.order.line read_group",
            "domain": sol_domain,
            "groupby": ["company_id"],
            "row_count": len(rows) if isinstance(rows, list) else 0,
        }
    )
    if not isinstance(rows, list):
        raise OdooConnectorError("Unexpected response for sale.order.line.read_group exploration aggregate")

    parsed: list[tuple[int | None, dict[str, Any]]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        company_field = row.get("company_id")
        cid: int | None = None
        if isinstance(company_field, (list, tuple)) and company_field:
            try:
                cid = int(company_field[0])
            except (TypeError, ValueError):
                cid = None
        parsed.append(
            (
                cid,
                {
                    "price_subtotal_sum": float(row.get("price_subtotal") or 0.0),
                    "product_uom_qty_sum": float(row.get("product_uom_qty") or 0.0),
                },
            )
        )
    name_ids = sorted({cid for cid, _ in parsed if cid is not None})
    cmap = _company_name_map(client, config=config, uid=uid, company_ids=name_ids if name_ids else (company_ids or []))
    comparison_rows = [
        {
            "company_id": cid,
            "company_name": cmap.get(cid, str(cid)) if cid is not None else None,
            **metrics,
        }
        for cid, metrics in parsed
    ]

    return {
        "result_type": "exploration_product_branch_sales",
        "date_from": date_from,
        "date_to": date_to,
        "product_name_substring": substring,
        "company_ids": company_ids,
        "company_name_terms": company_name_terms,
        "product_ids_matched": product_ids[:80],
        "product_match_count": len(product_ids),
        "exploration_trace": exploration_trace,
        "comparison_rows": comparison_rows,
        "evidence_source_mode": "live_odoo",
        "accuracy_notes": [
            "Step 1–2: product discovery via ilike on template and variant (name + default_code).",
            "Step 3: sale.order.line sums filtered by order state in sale/done and order date window on the linked sale.order.",
            "Revenue uses line price_subtotal; tax/rounding follows Odoo company configuration.",
            f"Matched {len(product_ids)} product ids before aggregation (capped for safety).",
        ],
    }


def _many2one_label_id(value: Any) -> tuple[int | None, str | None]:
    if not isinstance(value, (list, tuple)) or not value:
        return None, None
    try:
        item_id = int(value[0])
    except (TypeError, ValueError):
        item_id = None
    label = str(value[1]) if len(value) > 1 and value[1] else None
    return item_id, label


def _model_has_field(client: httpx.Client, *, config: OdooConfig, uid: int, model: str, field_name: str) -> bool:
    result = _execute_kw(
        client,
        config=config,
        uid=uid,
        model=model,
        method="fields_get",
        args=[[field_name]],
        kwargs={"attributes": ["type"]},
    )
    return isinstance(result, dict) and field_name in result


def _run_sales_products_gp_period_top(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    _normalize_company_scope_lock_payload(payload)
    date_from = str(payload.get("date_from") or "").strip()
    date_to = str(payload.get("date_to") or "").strip()
    if not date_from or not date_to:
        today = date.today()
        date_from = date(today.year, today.month, 1).isoformat()
        date_to = (today + timedelta(days=1)).isoformat()
    company_ids, company_name_terms = _resolve_company_scope(
        client,
        config=config,
        uid=uid,
        payload=payload,
        allow_multiple=False,
    )
    company_id = company_ids[0] if company_ids else None
    top_n = _coerce_limit(payload.get("top_n"), default=5, maximum=20)
    order_states_raw = payload.get("order_states")
    order_states = _coerce_string_list(order_states_raw) if isinstance(order_states_raw, list) else ["sale", "done"]
    if not order_states:
        order_states = ["sale", "done"]

    # Product filter mirrors the Odoo product kanban/search pattern (Can be Sold + text search).
    product_domain: list[Any] = []
    can_be_sold = payload.get("can_be_sold")
    if can_be_sold is None:
        can_be_sold = True
    product_domain.append(["sale_ok", "=", _coerce_bool(can_be_sold, default=True)])
    product_query = str(payload.get("product_query") or payload.get("query") or "").strip()
    if product_query:
        like_term = f"%{product_query}%"
        product_domain.extend(["|", ["name", "ilike", like_term], ["default_code", "ilike", like_term]])
    templates = _search_read(
        client,
        config=config,
        uid=uid,
        model="product.template",
        domain=product_domain,
        fields=["id", "name", "default_code", "sale_ok"],
        limit=300,
        offset=0,
        order="name asc",
    )
    template_ids = [int(item["id"]) for item in templates if item.get("id") is not None]
    variant_ids: list[int] = []
    if template_ids:
        variants = _search_read(
            client,
            config=config,
            uid=uid,
            model="product.product",
            domain=[["product_tmpl_id", "in", template_ids]],
            fields=["id", "name", "default_code", "product_tmpl_id"],
            limit=800,
            offset=0,
            order="name asc",
        )
        variant_ids = [int(item["id"]) for item in variants if item.get("id") is not None]

    sol_domain: list[Any] = [
        ["order_id.state", "in", order_states],
        ["order_id.date_order", ">=", date_from],
        ["order_id.date_order", "<", date_to],
    ]
    if company_id is not None:
        sol_domain.append(["company_id", "=", company_id])
    if variant_ids:
        sol_domain.append(["product_id", "in", variant_ids[:1000]])

    has_margin_field = _model_has_field(client, config=config, uid=uid, model="sale.order.line", field_name="margin")
    has_purchase_price_field = _model_has_field(
        client, config=config, uid=uid, model="sale.order.line", field_name="purchase_price"
    )
    use_margin = has_margin_field

    fields = ["price_subtotal:sum", "product_uom_qty:sum"]
    if use_margin:
        fields.append("margin:sum")
    grouped_raw = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="sale.order.line",
        method="read_group",
        kwargs={
            "domain": sol_domain,
            "fields": fields,
            "groupby": ["product_id"],
            "orderby": "price_subtotal desc",
            "lazy": False,
        },
    )
    if not isinstance(grouped_raw, list):
        raise OdooConnectorError("Unexpected response for sale.order.line.read_group in product GP operation")
    grouped_rows: list[dict[str, Any]] = [row for row in grouped_raw if isinstance(row, dict)]

    gp_by_product_id: dict[int, float] = {}
    if not use_margin and has_purchase_price_field:
        lines = _search_read_paginated(
            client,
            config=config,
            uid=uid,
            model="sale.order.line",
            domain=sol_domain,
            fields=["product_id", "price_subtotal", "product_uom_qty", "purchase_price"],
            limit=200,
            max_records=6000,
            order="id asc",
        )
        revenue_by_product: dict[int, float] = {}
        cogs_by_product: dict[int, float] = {}
        for line in lines:
            product_field = line.get("product_id")
            pid, _ = _many2one_label_id(product_field)
            if pid is None:
                continue
            qty = float(line.get("product_uom_qty") or 0.0)
            unit_cost = float(line.get("purchase_price") or 0.0)
            revenue_by_product[pid] = revenue_by_product.get(pid, 0.0) + float(line.get("price_subtotal") or 0.0)
            cogs_by_product[pid] = cogs_by_product.get(pid, 0.0) + (unit_cost * qty)
        for pid, revenue in revenue_by_product.items():
            gp_by_product_id[pid] = revenue - cogs_by_product.get(pid, 0.0)

    product_ids = sorted(
        {
            pid
            for row in grouped_rows
            for pid in [_many2one_label_id(row.get("product_id"))[0]]
            if pid is not None
        }
    )
    product_meta_rows = _search_read(
        client,
        config=config,
        uid=uid,
        model="product.product",
        domain=[["id", "in", product_ids]] if product_ids else [["id", "=", -1]],
        fields=["id", "name", "default_code"],
        limit=max(len(product_ids), 1),
        offset=0,
        order="id asc",
    )
    product_meta = {
        int(item["id"]): {
            "name": str(item.get("name") or item["id"]),
            "default_code": item.get("default_code"),
        }
        for item in product_meta_rows
        if item.get("id") is not None
    }

    ranked_rows: list[dict[str, Any]] = []
    for row in grouped_rows:
        pid, label = _many2one_label_id(row.get("product_id"))
        if pid is None:
            continue
        revenue = float(row.get("price_subtotal") or 0.0)
        gp_value: float | None = None
        gp_source = "unavailable"
        if use_margin:
            gp_value = float(row.get("margin") or 0.0)
            gp_source = "sale.order.line.margin"
        elif pid in gp_by_product_id:
            gp_value = gp_by_product_id[pid]
            gp_source = "sale.order.line.purchase_price_estimate"
        ranked_rows.append(
            {
                "product_id": pid,
                "product_name": product_meta.get(pid, {}).get("name") or label or str(pid),
                "default_code": product_meta.get(pid, {}).get("default_code"),
                "revenue": revenue,
                "quantity": float(row.get("product_uom_qty") or 0.0),
                "gp": gp_value,
                "gp_pct": (gp_value / revenue) if gp_value is not None and revenue else None,
                "gp_source": gp_source,
            }
        )
    ranked_rows.sort(key=lambda item: float(item.get("revenue") or 0.0), reverse=True)
    top_rows = ranked_rows[:top_n]

    revenue_reference = _coerce_float(payload.get("revenue_reference_total"))
    top_revenue_total = sum(float(item.get("revenue") or 0.0) for item in top_rows)
    reconciliation = None
    if revenue_reference is not None:
        reconciliation = {
            "revenue_reference_total": revenue_reference,
            "top_products_revenue_total": top_revenue_total,
            "difference": revenue_reference - top_revenue_total,
        }

    return {
        "result_type": "sales_products_gp_period_top",
        "date_from": date_from,
        "date_to": date_to,
        "company_id": company_id,
        "company_name_terms": company_name_terms,
        "top_n": top_n,
        "order_states": order_states,
        "product_filters": {
            "can_be_sold": _coerce_bool(can_be_sold, default=True),
            "product_query": product_query,
            "matched_template_count": len(template_ids),
            "matched_variant_count": len(variant_ids),
        },
        "rows": top_rows,
        "row_count": len(top_rows),
        "reconciliation": reconciliation,
        "accuracy_notes": [
            "Product ranking uses sale.order.line grouped by product and revenue in the requested date window.",
            "Filter behavior mirrors Odoo product search: `sale_ok` (Can be Sold) plus text match on name/default_code.",
            "GP source uses sale.order.line.margin when available, otherwise purchase_price-based estimate when possible.",
            "When GP is null, this tenant/model does not expose margin or purchase-cost inputs for reliable per-product GP.",
        ],
    }


def _run_sales_drilldown_period(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    _normalize_company_scope_lock_payload(payload)
    try:
        date_from, date_to = _resolve_period_window(payload)
    except OdooConnectorError:
        today = date.today()
        date_from = (today - timedelta(days=7)).isoformat()
        date_to = (today + timedelta(days=1)).isoformat()
    company_ids, company_name_terms = _resolve_company_scope(
        client,
        config=config,
        uid=uid,
        payload=payload,
        allow_multiple=False,
    )
    company_id = company_ids[0] if company_ids else None
    source_surface = str(payload.get("source_surface") or "auto").strip().lower()
    if source_surface not in {"auto", "sale_order", "invoice", "pos"}:
        raise OdooConnectorError("source_surface must be one of: auto, sale_order, invoice, pos")

    order_states_raw = payload.get("order_states")
    order_states = _coerce_string_list(order_states_raw) if isinstance(order_states_raw, list) else ["sale", "done"]
    if not order_states:
        order_states = ["sale", "done"]
    top_n = _coerce_limit(payload.get("top_n"), default=5, maximum=20)

    order_domain: list[Any] = [
        ["state", "in", order_states],
        ["date_order", ">=", date_from],
        ["date_order", "<", date_to],
    ]
    line_domain: list[Any] = [
        ["order_id.state", "in", order_states],
        ["order_id.date_order", ">=", date_from],
        ["order_id.date_order", "<", date_to],
    ]
    if company_id is not None:
        order_domain.append(["company_id", "=", company_id])
        line_domain.append(["company_id", "=", company_id])

    sales_rows_raw = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="sale.order",
        method="read_group",
        kwargs={
            "domain": order_domain,
            "fields": ["amount_total:sum"],
            "groupby": ["user_id"],
            "orderby": "amount_total desc",
            "lazy": False,
        },
    )
    if not isinstance(sales_rows_raw, list):
        raise OdooConnectorError("Unexpected response for sale.order.read_group in sales drilldown")
    sales_rows: list[dict[str, Any]] = [row for row in sales_rows_raw if isinstance(row, dict)]
    sales_rows.sort(key=lambda row: float(row.get("amount_total") or 0.0), reverse=True)
    sales_rows = sales_rows[:top_n]

    top_sales_agent = None
    if sales_rows:
        user_id, user_name = _many2one_label_id(sales_rows[0].get("user_id"))
        top_sales_agent = {
            "user_id": user_id,
            "user_name": user_name or str(user_id) if user_id is not None else "unassigned",
            "amount_total_sum": float(sales_rows[0].get("amount_total") or 0.0),
            "order_count": int(sales_rows[0].get("__count") or 0),
        }

    product_rows_raw = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="sale.order.line",
        method="read_group",
        kwargs={
            "domain": line_domain,
            "fields": ["price_subtotal:sum", "product_uom_qty:sum"],
            "groupby": ["product_id"],
            "orderby": "price_subtotal desc",
            "lazy": False,
        },
    )
    if not isinstance(product_rows_raw, list):
        raise OdooConnectorError("Unexpected response for sale.order.line.read_group in sales drilldown")
    product_rows: list[dict[str, Any]] = [row for row in product_rows_raw if isinstance(row, dict)]
    product_rows.sort(key=lambda row: float(row.get("price_subtotal") or 0.0), reverse=True)
    product_rows = product_rows[:top_n]

    top_product = None
    if product_rows:
        product_id, product_name = _many2one_label_id(product_rows[0].get("product_id"))
        top_product = {
            "product_id": product_id,
            "product_name": product_name or str(product_id) if product_id is not None else "unknown",
            "sales_amount_sum": float(product_rows[0].get("price_subtotal") or 0.0),
            "quantity_sum": float(product_rows[0].get("product_uom_qty") or 0.0),
            "line_count": int(product_rows[0].get("__count") or 0),
        }

    payment_rows: list[dict[str, Any]] = []
    payment_errors: list[str] = []
    payment_source_used = "unavailable"

    def _attempt_account_payment(group_field: str) -> list[dict[str, Any]]:
        pay_domain: list[Any] = [["date", ">=", date_from], ["date", "<", date_to], ["state", "=", "posted"]]
        if company_id is not None:
            pay_domain.append(["company_id", "=", company_id])
        rows = _execute_kw(
            client,
            config=config,
            uid=uid,
            model="account.payment",
            method="read_group",
            kwargs={
                "domain": pay_domain,
                "fields": ["amount:sum"],
                "groupby": [group_field],
                "orderby": "amount desc",
                "lazy": False,
            },
        )
        if not isinstance(rows, list):
            raise OdooConnectorError("Unexpected response for account.payment.read_group in sales drilldown")
        return [row for row in rows if isinstance(row, dict)]

    def _attempt_pos_payment() -> list[dict[str, Any]]:
        pos_domain: list[Any] = [["payment_date", ">=", date_from], ["payment_date", "<", date_to]]
        if company_id is not None:
            pos_domain.append(["company_id", "=", company_id])
        rows = _execute_kw(
            client,
            config=config,
            uid=uid,
            model="pos.payment",
            method="read_group",
            kwargs={
                "domain": pos_domain,
                "fields": ["amount:sum"],
                "groupby": ["payment_method_id"],
                "orderby": "amount desc",
                "lazy": False,
            },
        )
        if not isinstance(rows, list):
            raise OdooConnectorError("Unexpected response for pos.payment.read_group in sales drilldown")
        return [row for row in rows if isinstance(row, dict)]

    if source_surface in {"auto", "sale_order", "invoice"}:
        for group_field in ("payment_method_line_id", "journal_id"):
            try:
                payment_rows = _attempt_account_payment(group_field)
                payment_source_used = f"account.payment:{group_field}"
                break
            except OdooConnectorError as exc:
                payment_errors.append(str(exc))
        if not payment_rows and source_surface in {"auto"}:
            try:
                payment_rows = _attempt_pos_payment()
                payment_source_used = "pos.payment:payment_method_id"
            except OdooConnectorError as exc:
                payment_errors.append(str(exc))
    elif source_surface == "pos":
        try:
            payment_rows = _attempt_pos_payment()
            payment_source_used = "pos.payment:payment_method_id"
        except OdooConnectorError as exc:
            payment_errors.append(str(exc))

    payment_rows.sort(key=lambda row: float(row.get("amount") or 0.0), reverse=True)
    payment_rows = payment_rows[:top_n]

    top_payment_method = None
    if payment_rows:
        payment_field = (
            payment_rows[0].get("payment_method_id")
            or payment_rows[0].get("payment_method_line_id")
            or payment_rows[0].get("journal_id")
        )
        payment_id, payment_name = _many2one_label_id(payment_field)
        top_payment_method = {
            "method_id": payment_id,
            "method_name": payment_name or str(payment_id) if payment_id is not None else "unknown",
            "amount_sum": float(payment_rows[0].get("amount") or 0.0),
            "payment_count": int(payment_rows[0].get("__count") or 0),
            "source": payment_source_used,
        }

    company_name_map = _company_name_map(
        client,
        config=config,
        uid=uid,
        company_ids=[company_id] if company_id is not None else [],
    )
    return {
        "result_type": "sales_drilldown_period",
        "date_from": date_from,
        "date_to": date_to,
        "source_surface": source_surface,
        "payment_source_used": payment_source_used,
        "company_id": company_id,
        "company_name": company_name_map.get(company_id) if company_id is not None else None,
        "company_name_terms": company_name_terms,
        "order_states": order_states,
        "leaders": {
            "sales_agent": top_sales_agent,
            "product": top_product,
            "payment_method": top_payment_method,
        },
        "samples": {
            "sales_agents": sales_rows,
            "products": product_rows,
            "payment_methods": payment_rows,
        },
        "payment_errors": payment_errors,
        "accuracy_notes": [
            "Sales agent uses sale.order read_group by user_id and amount_total in the requested date window.",
            "Product uses sale.order.line read_group by product_id and price_subtotal (tax behavior follows Odoo config).",
            "Payment method attempts account.payment first and falls back to pos.payment in auto mode.",
            "If payment methods are empty, verify whether this tenant records payments on account.payment, pos.payment, or another custom model.",
        ],
    }


def _run_model_catalog(
    client: httpx.Client,
    *,
    config: OdooConfig,
    uid: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    limit = _coerce_limit(payload.get("limit"), default=200, maximum=500)
    offset = _coerce_offset(payload.get("offset"))
    query = str(payload.get("query") or "").strip().casefold()
    rows_raw = _execute_kw(
        client,
        config=config,
        uid=uid,
        model="ir.model",
        method="search_read",
        kwargs={
            "domain": [["transient", "=", False]],
            "fields": ["model", "name", "state"],
            "limit": limit,
            "offset": offset,
            "order": "model asc",
        },
    )
    rows = [row for row in rows_raw if isinstance(row, dict)] if isinstance(rows_raw, list) else []
    if query:
        rows = [
            row
            for row in rows
            if query in str(row.get("model") or "").casefold()
            or query in str(row.get("name") or "").casefold()
        ]
    models = [
        {
            "model": str(row.get("model") or ""),
            "name": str(row.get("name") or ""),
            "state": str(row.get("state") or ""),
        }
        for row in rows
        if str(row.get("model") or "").strip()
    ]
    return {
        "result_type": "model_catalog",
        "count": len(models),
        "models": models,
    }


def test_odoo_connection(config: dict[str, Any] | OdooConfig) -> dict[str, Any]:
    resolved = config if isinstance(config, OdooConfig) else config_from_dict(config)
    started = time.perf_counter()
    trace_id = uuid4().hex
    with httpx.Client(timeout=resolved.timeout_ms / 1000) as client:
        uid = _authenticate(client, resolved)
        current_user = _run_current_user(client, config=resolved, uid=uid, payload={})
    latency_ms = int((time.perf_counter() - started) * 1000)
    first_record = current_user.get("records", [{}])[0] if current_user.get("records") else {}
    return {
        "success": True,
        "message": "Odoo connection healthy.",
        "trace_id": trace_id,
        "latency_ms": latency_ms,
        "data": {
            "user_id": uid,
            "current_user": first_record,
            "safe_operations": list(ODOO_SAFE_OPERATIONS),
        },
    }


def execute_odoo_operation(
    config: dict[str, Any] | OdooConfig,
    *,
    operation: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resolved = config if isinstance(config, OdooConfig) else config_from_dict(config)
    if operation not in ODOO_SAFE_OPERATIONS:
        raise OdooConnectorError(f"Unsupported Odoo operation: {operation}")
    request_payload = dict(payload or {})
    handlers = {
        "odoo.meta.current_user": _run_current_user,
        "odoo.meta.model_catalog": _run_model_catalog,
        "odoo.products.search_read": _run_products,
        "odoo.customers.search_read": _run_customers,
        "odoo.sales.orders.search_read": _run_sales_orders,
        "odoo.finance.invoices.search_read": _run_invoices,
        "odoo.finance.receivables.open": _run_receivables,
        "odoo.finance.payables.open": _run_payables,
        "odoo.rpc.search_read": _run_rpc_search_read,
        "odoo.rpc.read_group": _run_rpc_read_group,
        "odoo.rpc.execute_kw": _run_rpc_execute_kw,
        "odoo.rpc.query_spec": _run_rpc_query_spec,
        "odoo.finance.revenue.period": _run_finance_revenue_period,
        "odoo.finance.cogs.period": _run_finance_cogs_period,
        "odoo.finance.margin.period_summary": _run_finance_margin_period_summary,
        "odoo.finance.pnl.period_summary": _run_finance_pnl_period_summary,
        "odoo.finance.revenue.monthly": _run_finance_revenue_monthly,
        "odoo.finance.cogs.monthly": _run_finance_cogs_monthly,
        "odoo.finance.cogs.monthly_code_breakdown": _run_finance_cogs_monthly_code_breakdown,
        "odoo.finance.margin.monthly_comparison": _run_finance_margin_monthly_comparison,
        "odoo.finance.revenue.quarterly": _run_finance_revenue_quarterly,
        "odoo.finance.cogs.quarterly": _run_finance_cogs_quarterly,
        "odoo.finance.margin.quarterly_summary": _run_finance_margin_quarterly_summary,
        "odoo.finance.shopify.monthly_roi": _run_finance_shopify_monthly_roi,
        "odoo.finance.cash.runway_summary": _run_finance_cash_runway_summary,
        "odoo.exploration.product_branch_sales": _run_exploration_product_branch_sales,
        "odoo.sales.drilldown.period": _run_sales_drilldown_period,
        "odoo.sales.products_gp.period_top": _run_sales_products_gp_period_top,
    }
    handler = handlers[operation]
    started = time.perf_counter()
    trace_id = uuid4().hex
    with httpx.Client(timeout=resolved.timeout_ms / 1000) as client:
        uid = _authenticate(client, resolved)
        data = handler(client, config=resolved, uid=uid, payload=request_payload)
    latency_ms = int((time.perf_counter() - started) * 1000)
    if isinstance(data, dict) and request_payload.get("company_scope_lock") == "single_exact":
        data.setdefault("company_scope_lock", "single_exact")
        canonical = request_payload.get("company_scope_lock_canonical")
        if isinstance(canonical, str) and canonical.strip():
            data["company_scope_lock_canonical"] = canonical.strip()
        data.setdefault("scope_enforced", True)
    return {
        "success": True,
        "message": f"{operation} completed.",
        "trace_id": trace_id,
        "latency_ms": latency_ms,
        "operation": operation,
        "read_only": resolved.read_only,
        "data": data,
    }
