# Legacy Odoo API Reference (Retired)

Date: 2026-04-23

The legacy `odoo_primary` agent-visible connector contract is retired.

## What changed

- LLM-facing discovery and direct invocation of `odoo_primary` is no longer supported.
- Operator/tooling workflows must use the MAS v2 server-side path.

## Canonical path now

- API: `POST /api/odoo/mas/answer`
- Input: `{ "message": "<finance question>" }`
- Behavior: deterministic routing -> governed extraction -> normalization -> metric assembly -> reasoning -> composition

## Policy notes

- `NET` remains blocked until explicit business definition approval.
- ROAS is caveated/unsupported when spend dependency is missing.
- Unknown business-unit aliases fail closed.
# Odoo API reference for agents (Ghoststack RAG control plane)

This document describes how an **autonomous agent** (or any HTTP client) should call Odoo **through this repository’s implementation**. It is derived from the running code paths in `backend/src/ghostdash_api/odoo_connector.py`, `tool_registry.py`, and `control_api.py`. Treat Odoo’s own documentation as the source of truth for model fields; treat this file as the source of truth for **allowed operations, envelopes, and guardrails** in this stack.

---

## 1. Architecture at a glance

```
Agent / UI / script
        │  POST /api/tools/odoo_primary/execute
        │  { "operation": "…", "payload": { … } }
        ▼
FastAPI control plane (`control_api.py`)
        │
        ▼
`execute_tool_operation` → `execute_odoo_operation` (`odoo_connector.py`)
        │  httpx POST {base_url}/jsonrpc
        │  Odoo JSON-RPC: common.login + object.execute_kw
        ▼
Odoo instance (customer ERP)
```

**Credentials** live in the GhostDash tool registry (`ToolRegistryRecord` for `odoo_primary`), not in the agent’s prompt. The agent only supplies `operation` and `payload`.

**Important:** Under `ghoststack-rag/artefacts/odoo_bundle_reference/` there is an archived **Node `odoo-rpc` microservice** handover with *different* operation names (`odoo.search_read`, `odoo.current_user`, etc.). That bundle is **not** the canonical contract for the Python backend in this repo. If your deployment uses the Python connector only, use the operation names in **section 4**.

---

## 2. Tool identity and HTTP routes

| Item | Value |
|------|--------|
| Tool id | `odoo_primary` |
| Provider | `odoo` |
| Execute URL | `POST /api/tools/odoo_primary/execute` |
| Health / smoke test | `POST /api/tools/odoo_primary/test` |
| Persist settings | `POST /api/tools/odoo_primary/settings` |
| Catalog | `GET /api/tools/catalog` (includes this tool when registered) |

**Execute request body** (`ToolExecutePayload`):

```json
{
  "operation": "odoo.rpc.search_read",
  "payload": {
    "model": "sale.order",
    "domain": [["state", "=", "sale"]],
    "fields": ["id", "name", "amount_total"],
    "limit": 20,
    "offset": 0,
    "order": "date_order desc"
  }
}
```

**Execute response** (`ToolExecuteResponse`): `success`, `message`, optional `trace_id`, `latency_ms`, `operation`, `read_only`, and `data` (operation-specific). On configuration errors, `success` is `false` and `data` may include `missing_config`.

---

## 3. Odoo connection configuration (operator / integrator)

Settings are merged server-side (`_merge_odoo_config`). Required non-empty string keys:

| Key | Meaning |
|-----|--------|
| `base_url` | Odoo root URL, e.g. `https://erp.example.com` (trailing slash optional; `/jsonrpc` is appended if missing) |
| `database` | Odoo database name |
| `username` | Login |
| `password` | Password **or** Odoo user API key (Odoo accepts API keys in the password slot for `common.login` in supported versions) |

Optional / behavioural:

| Key | Default | Notes |
|-----|---------|--------|
| `read_only` | `true` | When true, `odoo.rpc.execute_kw` may only call methods listed in **section 7** |
| `timeout_ms` | `20000` | Bounded between `1000` and `120000` in `OdooConfig` |
| `health_path` / `execute_path` | `/api/tools/odoo_primary/…` | Informational paths for UIs; actual routing is FastAPI |

**Read-only mode** is enforced in Python for `odoo.rpc.execute_kw` before JSON-RPC is called. Named helpers that internally use `write`, `create`, `unlink`, etc. are not exposed as separate operations—there is no approved mutation path in `ODOO_SAFE_OPERATIONS`.

---

## 4. Allowed operations (`ODOO_SAFE_OPERATIONS`)

Only these `operation` strings are accepted. Any other value returns `Unsupported Odoo operation`.

### 4.1 `odoo.meta.current_user`

**Purpose:** Sanity check auth and resolve default company / user context.

**Payload:**

| Field | Type | Notes |
|-------|------|--------|
| `fields` | string[] optional | Subset of `id`, `name`, `login`, `company_id`, `partner_id` |

**Implementation:** `res.users` `read` for the authenticated `uid`.

---

### 4.2 `odoo.products.search_read`

**Model:** `product.template`

**Payload:**

| Field | Type | Notes |
|-------|------|--------|
| `domain` | list | Odoo domain; see **section 8** |
| `query` | string | If set, adds `[["name","ilike", query]]` |
| `fields` | string[] | Allowed: `id`, `name`, `default_code`, `list_price`, `currency_id`, `qty_available`, `sale_ok` |
| `limit` | int | Default 20, max **100** |
| `offset` | int | Default 0 |

**Ordering:** `write_date desc`

---

### 4.3 `odoo.customers.search_read`

**Model:** `res.partner` with base domain `[["customer_rank", ">", 0]]`.

**Payload:** same pattern as products (`domain`, `query` on `name`, `fields`, `limit`, `offset`).

**Allowed fields:** `id`, `name`, `email`, `phone`, `customer_rank`, `city`, `country_id`

---

### 4.4 `odoo.sales.orders.search_read`

**Model:** `sale.order`

**Payload:**

| Field | Type | Notes |
|-------|------|--------|
| `domain` | list | Merged after coercion |
| `state` | string | If set, adds `["state","=", state]` |
| `partner_query` | string | If set, adds `["partner_id.name","ilike", partner_query]` |
| `fields` | string[] | Allowed: `id`, `name`, `state`, `partner_id`, `date_order`, `amount_total`, `currency_id` |
| `limit` / `offset` | int | limit max 100 |

**Ordering:** `date_order desc`

---

### 4.5 `odoo.finance.invoices.search_read`

**Model:** `account.move` restricted to **customer invoices**: `[["move_type","=","out_invoice"]]`.

**Payload:**

| Field | Type | Notes |
|-------|------|--------|
| `domain` | list | Additional filters |
| `state` | string | Move workflow state |
| `payment_state` | string | Odoo payment state |
| `fields` | string[] | Allowed: `id`, `name`, `invoice_date`, `invoice_date_due`, `state`, `payment_state`, `partner_id`, `amount_total`, `amount_residual`, `currency_id` |
| `limit` / `offset` | int | limit max 100 |

**Ordering:** `invoice_date desc`

---

### 4.6 `odoo.finance.receivables.open`

**Model:** `account.move` — posted out-invoices with residual &gt; 0.

**Base domain:** `out_invoice`, `state = posted`, `amount_residual > 0`.

**Payload:**

| Field | Type | Notes |
|-------|------|--------|
| `due_before` | string (date) | Adds `invoice_date_due <= due_before` |
| `partner_query` | string | `partner_id.name ilike` |
| `domain` | list | Extra clauses |
| `fields` | string[] | Same allowed set as invoices |
| `limit` / `offset` | int | limit max 100 |

**Response:** `count`, `records`, and **`total_residual`** (sum of `amount_residual` on returned rows only—not global AR if `limit` truncates).

**Ordering:** `invoice_date_due asc`

---

### 4.7 `odoo.finance.payables.open`

**Model:** `account.move` — posted vendor bills with residual > 0.

**Base domain:** `in_invoice`, `state = posted`, `amount_residual > 0`.

**Payload:**

| Field | Type | Notes |
|-------|------|--------|
| `due_before` | string (date) | Adds `invoice_date_due <= due_before` |
| `partner_query` | string | `partner_id.name ilike` |
| `domain` | list | Extra clauses |
| `fields` | string[] | Same allowed set as invoices |
| `limit` / `offset` | int | limit max 100 |

**Response:** `count`, `records`, and **`total_residual`** for the returned rows.

**Ordering:** `invoice_date_due asc`

---

### 4.8 `odoo.rpc.search_read` (escape hatch)

**Payload:**

| Field | Required | Notes |
|-------|----------|--------|
| `model` | yes | Any model name string |
| `domain` | no | Coerced list |
| `fields` | no | List of strings; **empty list means Odoo returns default fields** (can be large) |
| `limit` | no | Default 20, **max 1000** |
| `offset` | no | Default 0 |
| `order` | no | String or omitted |

**Returns:** `model`, `method`: `search_read`, `result_type`: `records`, `count`, `records`.

Use this for stock moves, products variants, CRM, etc., while respecting Odoo access rights for the configured user.

---

### 4.9 `odoo.rpc.read_group` (aggregations)

**Payload:**

| Field | Required | Notes |
|-------|----------|--------|
| `model` | yes | |
| `fields` | yes | Non-empty list of strings, e.g. `["amount_total:sum"]` — must be valid for `read_group` on that model |
| `groupby` | yes | Non-empty list, e.g. `["invoice_date:month"]` |
| `domain` | no | |
| `orderby` | no | String |
| `lazy` | no | Boolean, default `false` |

**Returns:** `rows` (list of dicts), `groupby`, `count`, etc.

**Agent tip:** Prefer `read_group` over huge `search_read` pulls for dashboards and KPIs.

---

### 4.10 `odoo.rpc.execute_kw` (generic read)

**Payload:**

| Field | Required | Notes |
|-------|----------|--------|
| `model` | yes | |
| `method` | yes | Must pass **section 7** when `read_only` is true |
| `args` | no | JSON array, default `[]` |
| `kwargs` | no | JSON object, default `{}` |

**Returns:** `_result_envelope`: `result_type` one of `records` | `list` | `object` | `scalar`, plus `model`, `method`, and either `records`, `items`, `result`, or `result` key for scalar.

When `read_only` is `true`, any method not in the allowlist raises **`OdooConnectorError`** before RPC executes.

---

### 4.11 `odoo.finance.revenue.period`

**Purpose:** Posted revenue over an explicit period on `account.move.line`, aligned to ledger accounts instead of invoice headers.

**Payload highlights:**

| Field | Notes |
|-------|--------|
| `date_from` / `date_to` | Required ISO date window unless `relative_period` is provided |
| `relative_period` | Supported: `last_month`, `this_month` |
| `company_id` | If set, adds `["company_id","=", company_id]` |
| `revenue_account_ids` | Optional explicit revenue accounts to include |
| `revenue_account_types` | Optional override for account-type selection, default `["income", "income_other"]` |
| `domain` | Extra domain clauses |

**Response:** period aggregate with `total`, `basis = posted_ledger_lines`, account scope metadata, and grouped source rows by account.

---

### 4.12 `odoo.finance.cogs.period`

**Purpose:** COGS-style expense lines over an explicit period on `account.move.line`.

**Payload:** Same period and company knobs as revenue, plus optional `cogs_account_ids` or `cogs_account_types`.

**Note:** Default account filter remains `account_id.account_type = expense_direct_cost` when neither `cogs_account_ids` nor `cogs_account_types` is provided.

---

### 4.13 `odoo.finance.margin.period_summary`

**Purpose:** Combines period revenue and period COGS into `revenue`, `cogs`, `gp`, and `gp_pct` for the requested date window.

**Payload:** Same as `odoo.finance.revenue.period` / `odoo.finance.cogs.period`.

**Response notes:** Includes `lookup_basis = posted_ledger_lines`, `revenue_source`, `cogs_source`, and `accuracy_notes` so operators can reconcile the exact finance basis against Odoo P&L lines.

---

### 4.14 `odoo.finance.revenue.monthly`

**Purpose:** Posted revenue grouped by month for one or more companies.

**Payload highlights:**

| Field | Notes |
|-------|--------|
| `months` | Number of completed months to include, default `4`, max `24` |
| `include_current_month` | bool, default `false` |
| `company_ids` | Optional list of companies to compare |
| `company_id` | Optional single-company fallback |
| `date_from` / `date_to` | Optional explicit override |
| `domain` | Extra domain clauses |

**Response:** monthly grouped revenue rows with `company_name_by_id`.

---

### 4.15 `odoo.finance.cogs.monthly`

**Purpose:** COGS-style expense lines grouped by month for one or more companies.

**Payload:** Same month/date/company knobs as monthly revenue, plus optional `cogs_account_ids`.

---

### 4.16 `odoo.finance.margin.monthly_comparison`

**Purpose:** Combine monthly revenue and monthly COGS into company-by-company monthly GP comparison rows, totals, and anomaly candidates.

**Payload:** Same as the monthly revenue / COGS helpers.

**Response:** `companies`, `rows`, `anomalies`, `revenue_source`, and `cogs_source`.

---

### 4.17 `odoo.finance.revenue.quarterly`

**Purpose:** Posted revenue moves on `account.move`, grouped by `invoice_date:quarter`.

**Payload highlights:**

| Field | Notes |
|-------|--------|
| `fiscal_year_start_month` | 1–12, default `1` |
| `quarters` | 1–12, default `3` |
| `include_current_quarter` | bool, default `false` |
| `date_from` / `date_to` | Optional ISO date strings overriding inferred quarter window |
| `company_id` | If set, adds `["company_id","=", company_id]` |
| `domain` | Extra domain clauses |

**Internal domain:** `state=posted`, `move_type in (out_invoice, out_refund)`, date range on `invoice_date`.

---

### 4.18 `odoo.finance.cogs.quarterly`

**Purpose:** COGS-style lines on `account.move.line` via `read_group` by `date:quarter`.

**Payload:** Same fiscal / quarter / company / extra `domain` as revenue.

**Account filter:** Either `cogs_account_ids` (list) if provided, else `account_id.account_type = expense_direct_cost`.

**Note:** Odoo version and chart-of-accounts layout determine whether `expense_direct_cost` matches your COGS. Validate once per tenant.

---

### 4.19 `odoo.finance.margin.quarterly_summary`

**Purpose:** Combines **4.10** and **4.11** and returns merged quarter rows with `revenue`, `cogs`, `gp`, `gp_pct`, and running totals.

**Payload:** Same knobs as the quarterly helpers.

---

### 4.20 `odoo.sales.drilldown.period`

**Purpose:** Return a period drilldown with leading sales agent, leading product sold, and leading payment method.

**Payload highlights:**

| Field | Notes |
|-------|--------|
| `date_from` / `date_to` | Preferred explicit ISO date range; if omitted, connector defaults to a recent 7-day lookback window |
| `relative_period` | Optional (same support as period helpers when provided) |
| `company_id` | Optional single-company scope |
| `company_name_terms` | Optional resolver for a single named company |
| `source_surface` | Optional: `auto` (default), `sale_order`, `invoice`, `pos` |
| `order_states` | Optional sale.order state list, default `["sale","done"]` |
| `top_n` | Optional number of ranked rows returned in samples (default 5, max 20) |

**Implementation shape:**

- `sale.order` `read_group` by `user_id` for top sales agent (`amount_total:sum`)
- `sale.order.line` `read_group` by `product_id` for top product (`price_subtotal:sum`, `product_uom_qty:sum`)
- payment method grouping via:
  - `account.payment` (`payment_method_line_id` then `journal_id`) and
  - fallback `pos.payment.payment_method_id` when `source_surface=auto`

**Response:** `result_type = sales_drilldown_period`, `leaders`, `samples`, `payment_source_used`, `payment_errors`, and `accuracy_notes`.

---

### 4.21 `odoo.sales.products_gp.period_top`

**Purpose:** Return top-N sold products for a period, including per-product GP where tenant fields allow it.

**Payload highlights:**

| Field | Notes |
|-------|--------|
| `date_from` / `date_to` | Optional ISO window; if omitted, defaults to month-to-date |
| `company_id` / `company_name_terms` | Single-company scope (recommended for reliable ranking) |
| `top_n` | Default 5, max 20 |
| `can_be_sold` | Product filter mirroring Odoo UI filter “Can be Sold”; defaults `true` |
| `product_query` / `query` | Optional text filter against `name`/`default_code` |
| `order_states` | Defaults to `["sale","done"]` |
| `revenue_reference_total` | Optional revenue checkpoint for reconciliation (e.g. `23074.70`) |

**Implementation shape:**

- Product scope filter: `product.template` with `sale_ok = true` (unless overridden), plus search text.
- Ranking source: `sale.order.line` `read_group` by `product_id` with revenue and quantity.
- GP source precedence:
  1. `sale.order.line.margin` (when available in tenant),
  2. fallback estimate from `purchase_price * qty` aggregation,
  3. `null` GP with explicit accuracy note when neither is available.

**Response:** `result_type = sales_products_gp_period_top`, `rows`, `product_filters`, optional `reconciliation`, and `accuracy_notes`.

---

## 5. Underlying Odoo JSON-RPC (what the connector actually does)

1. **Endpoint:** `POST {base_url}/jsonrpc` (or full URL if `base_url` already ends with `/jsonrpc`).

2. **Envelope:**

```json
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "service": "common",
    "method": "login",
    "args": ["{database}", "{username}", "{password}"]
  },
  "id": "{uuid}"
}
```

3. After `login` returns a positive integer `uid`, business calls use:

- **Service:** `object`
- **Method:** `execute_kw`
- **Args:** `[database, uid, password, model, method, positional_args, keyword_dict]`

Errors from Odoo appear in JSON-RPC `error`; the connector maps them to `OdooConnectorError` with a message string.

---

## 6. Multi-company and security (agent behaviour)

- **Company scope:** Many models carry `company_id`. If the user can see multiple companies, queries may **cross-company** unless you filter `company_id`. Always set `company_id` in `domain` when the business question is store-specific.
- **Record rules:** Odoo enforces row-level security for the authenticated user. Missing rows does not mean “data does not exist”—it may mean **no access**.
- **PII and finance:** Treat `res.partner`, invoices, and payroll-related models as sensitive. Minimize `fields` and `limit` in exploratory calls.

---

## 7. Read-only method allowlist (`odoo.rpc.execute_kw`)

When `read_only` is `true`, only these **method names** are permitted:

`fields_get`, `name_get`, `name_search`, `read`, `read_group`, `search`, `search_count`, `search_read`

Anything else (e.g. `create`, `write`, `unlink`, `button_confirm`) is **blocked** at the connector.

---

## 8. Domain coercion (security and robustness)

User-supplied domains are normalised:

- Top-level connectors `&`, `|`, `!` are kept if they appear as strings.
- Triplets must be `[field: str, operator: str, value]`. Malformed tuples are dropped.
- Wrong types yield empty or partial domains—**never assume** silent `[]` means “no filter”.

Agents should **build explicit domains** and log them in natural language for auditability.

---

## 9. Latency and efficiency guidelines for agents

1. **Prefer `read_group`** for counts, sums, and histograms instead of pulling all rows.
2. **Cap payload size:** Default limits are small (20) for catalog-style operations; `odoo.rpc.search_read` allows up to 1000—use pagination (`offset`) for deep lists.
3. **Avoid N× `search_read`:** Batch with `in` domains or use `read_group` / `read` with id lists when safe.
4. **Stable field lists:** Always pass explicit `fields` on `odoo.rpc.search_read` to avoid Odoo returning heavy unrelated columns.
5. **Timeouts:** Default 20s; long analytics should be split or narrowed by date range.
6. **Stockout-style analytics:** Typically `stock.move` / `stock.quant` + `sale.order.line`—validate model names and fields for your Odoo version before automating.

---

## 10. Common failure modes

| Symptom | Likely cause |
|---------|----------------|
| `Odoo configuration incomplete` | Missing `base_url`, `database`, `username`, or `password` in registry |
| `Authentication failed` | Wrong db/user/password or API key not accepted |
| `Unsupported Odoo operation` | Typo in `operation` string |
| `Odoo method 'write' is blocked while the connector is in read-only mode` | Mutation attempted via `execute_kw` |
| Empty `read_group` / `search_read` | Access rights, wrong `company_id`, wrong model for Odoo version, or over-restrictive domain |
| SQL or Odoo “invalid field” errors | Computed fields not storable in `read_group`, or grouping on unsupported fields—simplify `groupby` / `fields` |

---

## 11. Agent tool policy (GhostDash)

Agents only **see** tools that the runtime profile’s tool policy allows. The tool id to allow is **`odoo_primary`**. Readiness summaries (`tool_summary` in chat bootstrap / stream metadata) reflect activation, configuration completeness, and policy—agents should check `status` before assuming Odoo is callable.

---

## 12. Verification

**Unit tests (no live Odoo required):**

```bash
cd /var/llamaindex/ghoststack-rag/backend && pytest ghostdash_api/tests/test_tools_api.py -q --tb=no
```

**Live smoke (requires configured `odoo_primary` and reachable API):**

```bash
curl -sS -X POST "http://127.0.0.1/api/tools/odoo_primary/test" -H "Content-Type: application/json"
curl -sS -X POST "http://127.0.0.1/api/tools/odoo_primary/execute" \
  -H "Content-Type: application/json" \
  -d '{"operation":"odoo.meta.current_user","payload":{}}'
```

Adjust the host to match your deployment (Caddy, port-forward, etc.).

---

## 13. Source map (for maintainers)

| Concern | File |
|---------|------|
| JSON-RPC, operations, limits | `backend/src/ghostdash_api/odoo_connector.py` |
| Tool registry, settings merge, execute dispatch | `backend/src/ghostdash_api/tool_registry.py` |
| HTTP routes | `backend/src/ghostdash_api/control_api.py` |
| Request/response models | `backend/src/ghostdash_api/schemas.py` (`ToolExecutePayload`, `ToolExecuteResponse`) |
| Tests | `backend/tests/test_tools_api.py` |

---

## Acceptance criteria

- An agent can select a valid `operation` from **section 4** and construct a JSON `payload` matching the tables.
- The agent respects **`read_only`** semantics for `odoo.rpc.execute_kw` (**section 7**).
- The agent uses **`company_id`** and explicit **`domain`** when answering store-scoped business questions (**section 6**).
- The agent prefers **`read_group`** over bulk **`search_read`** for analytics (**section 9**).

**Verify:** `pytest ghostdash_api/tests/test_tools_api.py::test_odoo_connector_blocks_mutation_in_read_only_mode -q` and the curl smoke commands in **section 12**.
