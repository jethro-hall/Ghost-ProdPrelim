from __future__ import annotations

import time
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
]


class OdooConfig(BaseModel):
    base_url: str = Field(min_length=1)
    database: str = Field(min_length=1)
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)
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
        "read_only": True,
        "data": data,
    }
