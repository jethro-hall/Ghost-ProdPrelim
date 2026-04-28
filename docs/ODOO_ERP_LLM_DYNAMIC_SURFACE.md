# Odoo Dynamic Surface (Retired)

Date: 2026-04-23

This dynamic Odoo LLM surface is retired and is preserved only as historical context.

## Active design

Use Odoo MAS Connect v2 with deterministic, server-side orchestration. LLM agents should not discover or call legacy Odoo connector operations directly.

## Active execution entrypoint

- `POST /api/odoo/mas/answer`

## Guardrails

- No direct `odoo_primary` operation planning from agent prompts.
- No per-agent Odoo enable toggles in UI.
- No assumptions for `NET` semantics until explicit business approval.
# Odoo ERP surface for LLM dynamic exploration (GhostDASH)

This document is the **authoritative mental model** for how an LLM should treat Odoo inside GhostDASH: not as a single fixed script with dynamic dates, but as a **searchable, multi-pass system** (similar in spirit to iterative vector retrieval).

All access remains **read-only**. Nothing here authorizes writes, deletes, or raw SQL.

---

## 1. Doctrine: what “dynamic” means here

1. **Discover** — find the right *things* (products, accounts, journals, companies) using `ilike`, lists, or small `search_read` samples.
2. **Narrow** — constrain by `id` / `company_id` / date window once you know what you matched.
3. **Aggregate** — use `read_group` for sums, counts, and branch cuts.
4. **Explain** — state models, domains, row counts, date window, company scope, and what could still be missing (tax, refunds, unposted moves, RMAs, intercompany).

One user question may require **multiple tool calls across chat turns**, or a **single exploration operation** that already executed several internal RPCs (see `odoo.exploration.product_branch_sales`).

---

## 2. Core companies (`res.company`)


| Use                                    | Typical fields | Notes                                                                               |
| -------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| Resolve “Brisbane / Burleigh / Retail” | `id`, `name`   | Ghost maps name hints to companies; always echo `company_id` in answers when known. |


Operations: `odoo.rpc.search_read` / `query_spec` on `res.company`, or helpers that embed scope.

---

## 3. Products (`product.template`, `product.product`)


| Model              | Role                      | Typical fields                                        |
| ------------------ | ------------------------- | ----------------------------------------------------- |
| `product.template` | Sellable product “header” | `id`, `name`, `default_code`, `list_price`, `sale_ok` |
| `product.product`  | Variants (SKU-level)      | `id`, `name`, `default_code`, `product_tmpl_id`       |


**Discovery pattern:** substring / wildcard semantics via Odoo domains, e.g. `["name", "ilike", "%fatfish%"]` or `default_code` matches.

---

## 4. Sales documents


| Model             | Role                           | Typical fields                                                                                   |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `sale.order`      | Quotation / SO header          | `name`, `state`, `partner_id`, `company_id`, `date_order`, `amount_total`                        |
| `sale.order.line` | Line-level revenue and product | `order_id`, `product_id`, `company_id`, `price_subtotal`, `product_uom_qty`, `state` (via order) |


**Aggregation pattern:** `read_group` on `sale.order.line` with `groupby=["company_id"]` (or product, month) and `fields` like `price_subtotal:sum`, filtered by order date and state.

---

## 5. Accounting (finance actuals)


| Model               | Role                                    |
| ------------------- | --------------------------------------- |
| `account.move`      | Posted invoices/bills/journals (header) |
| `account.move.line` | Ledger lines — revenue, COGS, expenses  |


Used heavily by **named finance helpers** (`odoo.finance.`*) and by `odoo.rpc.query_spec` for governed `read_group` / `search_read`.

For period finance truth, prefer posted `account.move.line` ledger lines with explicit account scopes over invoice-header totals whenever you need numbers that should reconcile with Odoo P&L reporting.

---

## 6. Governed operations (tool `odoo_primary`)

- **Named helpers:** revenue/COGS/margin period and monthly helpers, cash runway, Shopify ROI, etc.
- **Named drilldown helper:** `odoo.sales.drilldown.period` — one governed call for top sales agent, payment method, and product in a period.
- **Named product GP helper:** `odoo.sales.products_gp.period_top` — top-N sold products with GP and Odoo-style product filters.
- **Low-level read:** `odoo.rpc.search_read`, `odoo.rpc.read_group`, `odoo.rpc.query_spec` (validated `search_read` / `read_group` only).
- **Multi-step exploration:** `odoo.exploration.product_branch_sales` — product discovery → variant collection → `sale.order.line` aggregation by company (see backend implementation).

### Dynamic query normalization (contract)

- **Company**: use `company_id` or `company_name_terms` (single-company preferred for operator questions).
- **Date**: compile to explicit `date_from` / `date_to`.
- **Product search**: compile UI-equivalent `Can be Sold` to `sale_ok=true` and search token to `name/default_code ilike`.
- **Dimensions**: map chart/group intents to `company`, `salesperson`, `product`, `order_date`.
- **Measures**: map to `count`, `amount_total`, `amount_untaxed`, `price_subtotal`, `qty`, and `gp` when source fields exist.

---

## 7. Worked example: “Fatfish” across Brisbane vs Burleigh

**User intent:** Group-level sales context, then **compare Brisbane and Burleigh** for **all products sold** related to **“fatfish”**.

**Recommended steps (conceptual):**

1. **Company scope** — Resolve Brisbane + Burleigh → `company_id` list.
2. **Product discovery** — `product.template` and `product.product` with `ilike` on `name` / `default_code` for `%fatfish%`; collect variant IDs.
3. **Sales aggregation** — `sale.order.line` `read_group`, domain roughly:
  - `order_id.state` in `sale`, `done` (adjust if your process uses only `done`),
  - `order_id.date_order` in the requested window,
  - `product_id in (...)` from step 2,
  - `company_id in (brisbane_id, burleigh_id)`.
4. **Report** — Tabulate by `company_id`, show matched product samples, row counts, and **accuracy notes** (tax basis, refunds, cancelled orders not included if excluded by state filter).

The backend may run this as `**odoo.exploration.product_branch_sales`** when the planner detects a product token + compare + ≥2 branch terms.

---

## 8. Worked example: Ian-style 7-day drilldown

**Question pattern:** “After receiving revenue numbers for the past 7 days, show leading sales agent/payment method/product sold.”

**Recommended operation:** `odoo.sales.drilldown.period`

**Typical payload:**

```json
{
  "date_from": "2026-04-13",
  "date_to": "2026-04-20",
  "company_name_terms": ["burleigh"],
  "source_surface": "auto",
  "order_states": ["sale", "done"],
  "top_n": 5
}
```

**Why this helper first:** It removes domain-building complexity for smaller models while preserving evidence-rich samples for deeper follow-up prompts.

---

## 9. Worked example: top 5 Brisbane products + GP

**Question pattern:** “Out of 23,074.70 revenue for Brisbane, show top 5 products sold and each product GP.”

**Recommended operation:** `odoo.sales.products_gp.period_top`

**Typical payload:**

```json
{
  "date_from": "2026-04-13",
  "date_to": "2026-04-20",
  "company_name_terms": ["brisbane"],
  "top_n": 5,
  "can_be_sold": true,
  "revenue_reference_total": 23074.70
}
```

**Critical filter behavior:** `can_be_sold=true` maps to Odoo product filter `sale_ok=true`, and optional `product_query` maps to Odoo search bar semantics on product name/default code.

---

## 10. Transparency checklist (required in answers)

- **Which operations** ran (named helper vs `query_spec` vs exploration).
- **Date window** (`date_from` / `date_to`) and **timezone** assumption (usually server/AUD business default — state if unknown).
- **Company scope** (`company_id` / names).
- **Match cardinality** — how many products/orders/lines matched before aggregation.
- **Known limitations** — e.g. list price vs invoiced amount, tax excluded from `price_subtotal` depending on config.

---

## 11. What is explicitly out of scope

- Raw SQL, `execute_kw` writes, mass export “drop tables”, or destructive actions.
- Guessing SKUs not returned by a discovery step.

---

## 12. Related code

- Planner: `ghostdash_api/workflows.py` (`_plan_odoo_tool_usage`).
- Connector: `ghostdash_api/odoo_connector.py`.
- Consumer policy: `ghostdash_api/tool_registry.py` (`_consumer_chat_operation_allowed`).
- Specialist prompt: `ghostdash_api/runtime_profiles.py` (`ODOO_SPECIALIST_SYSTEM_PROMPT`).