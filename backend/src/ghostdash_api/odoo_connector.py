from __future__ import annotations

import time
from datetime import date
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
    "odoo.products.search_read",
    "odoo.customers.search_read",
    "odoo.sales.orders.search_read",
    "odoo.finance.invoices.search_read",
    "odoo.finance.receivables.open",
    "odoo.rpc.search_read",
    "odoo.rpc.read_group",
    "odoo.rpc.execute_kw",
    "odoo.finance.revenue.quarterly",
    "odoo.finance.cogs.quarterly",
    "odoo.finance.margin.quarterly_summary",
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
    domain.extend(_apply_name_filter(payload))
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
    allowed_fields = ["id", "name", "state", "partner_id", "date_order", "amount_total", "currency_id"]
    default_fields = ["id", "name", "state", "partner_id", "date_order", "amount_total", "currency_id"]
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
        "odoo.products.search_read": _run_products,
        "odoo.customers.search_read": _run_customers,
        "odoo.sales.orders.search_read": _run_sales_orders,
        "odoo.finance.invoices.search_read": _run_invoices,
        "odoo.finance.receivables.open": _run_receivables,
        "odoo.rpc.search_read": _run_rpc_search_read,
        "odoo.rpc.read_group": _run_rpc_read_group,
        "odoo.rpc.execute_kw": _run_rpc_execute_kw,
        "odoo.finance.revenue.quarterly": _run_finance_revenue_quarterly,
        "odoo.finance.cogs.quarterly": _run_finance_cogs_quarterly,
        "odoo.finance.margin.quarterly_summary": _run_finance_margin_quarterly_summary,
    }
    handler = handlers[operation]
    started = time.perf_counter()
    trace_id = uuid4().hex
    with httpx.Client(timeout=resolved.timeout_ms / 1000) as client:
        uid = _authenticate(client, resolved)
        data = handler(client, config=resolved, uid=uid, payload=request_payload)
    latency_ms = int((time.perf_counter() - started) * 1000)
    return {
        "success": True,
        "message": f"{operation} completed.",
        "trace_id": trace_id,
        "latency_ms": latency_ms,
        "operation": operation,
        "read_only": resolved.read_only,
        "data": data,
    }
