# Odoo dynamic product search + GP recovery (2026-04-21)

## Objective

Repair Odoo MAS behavior for:

1. Product search flow aligned with Odoo UI (`Can be Sold` + product text search)
2. Top-N products with per-product GP breakdown for scoped revenue questions
3. Human validation loop with evidence and performance notes

## Build changes

- Added operation: `odoo.sales.products_gp.period_top`
  - Uses `sale_ok` filter by default (`can_be_sold=true`) to mirror Odoo product kanban filter.
  - Supports `product_query` against `name` / `default_code`.
  - Returns top products by revenue from `sale.order.line`.
  - Returns GP from `sale.order.line.margin` when available; otherwise purchase-cost estimate; otherwise explicit null with note.
- Enhanced `odoo.products.search_read`
  - New request options: `can_be_sold`, `product_type`, and broader search (`query`/`search`) across name + default code.
- Planner routes top-products-GP prompts to `odoo.sales.products_gp.period_top`.

## Dynamic query contract (TODO 1)

This contract maps natural-language requests to Odoo-safe query payloads using the discovered view/model surface from `View (ir.ui.view) (2).xlsx`.

### Supported business axes

- **Company axis**: `company_id` / `company_name_terms` (e.g. Ride Electric Brisbane).
- **Time axis**: explicit `date_from`/`date_to` windows (or relative period).
- **Product axis**: `product_query` + `can_be_sold=true` (`sale_ok=true`).
- **People axis**: salesperson (`sale.order.user_id`) where model supports grouping.
- **Document status axis**: `state` / order-state controls (`sale`, `done`, etc.).

### Supported dimensions (group-by)

- `company`
- `order_date` (day/month)
- `salesperson`
- `product`
- `product_variant`
- `product_category` (where exposed by tenant view/model)

### Supported measures

- `count`
- `amount_total`
- `amount_untaxed`
- `price_subtotal`
- `qty` (`product_uom_qty`)
- `gp` (from `margin` when available, else purchase-cost estimate fallback)

### Model routing rules

1. **Sales analysis / aggregated chart intent** -> prefer `sale.report` (read_group-style analytics).
2. **Top sold products + per-product GP** -> `sale.order.line` via `odoo.sales.products_gp.period_top`.
3. **Sales agent + payment + product leader drilldown** -> `sale.order` + `sale.order.line` + payment sources via `odoo.sales.drilldown.period`.
4. **Product catalog search** -> `product.template`/`product.product` via `odoo.products.search_read` with `sale_ok` filter.

### Query compiler shape (normalized)

```json
{
  "intent": "top_products_gp",
  "scope": {
    "company_name_terms": ["brisbane"],
    "date_from": "2026-04-13",
    "date_to": "2026-04-20"
  },
  "filters": {
    "can_be_sold": true,
    "product_query": "fatfish"
  },
  "groupby": ["product"],
  "measures": ["revenue", "gp", "qty"],
  "top_n": 5
}
```

## Human test protocol (same style, repeatable)

### Test A (7-day Burleigh drilldown)

Prompt:

`After receiving revenue numbers for previous 7 days from 20/04/2026 for Burleigh, show leading sales agent/payment method/product sold.`

Expected operation:

- `odoo.sales.drilldown.period`

Acceptance:

- Explicit date window + company scope in answer
- Leaders for sales agent/payment/product populated when source data available

### Test B (independent top products + GP)

Prompt:

`out of the 23,074.70 revenue for Brisbane, show me what was the top 5 products sold and each products GP`

Expected operation:

- `odoo.sales.products_gp.period_top`

Acceptance:

- Top 5 products listed
- GP shown per product OR explicit null with source limitation note
- `can_be_sold` filter surfaced in tool payload/evidence
- Reconciliation block compares top-products revenue with `23074.70`

## Performance breakdown

- Fast path:
  - `read_group` over `sale.order.line` for ranking (`price_subtotal:sum`) is O(aggregates) and preferred.
- GP field availability branch:
  1. `margin` present -> single read_group pass (fastest).
  2. `margin` absent + `purchase_price` present -> paginated `search_read` fallback (heavier).
  3. no GP fields -> no heavy fallback; explicit null GP.
- Guardrails:
  - `top_n` capped at 20.
  - Product matches bounded (`product.template` + variants capped).
  - Accuracy notes communicate when GP is estimate vs authoritative.

## External schema handover note

Parsed input available in repo:

- `docs/View (ir.ui.view) (2).xlsx` (2710 rows, single sheet)
- Sale-related view coverage detected:
  - `sale.order` (46)
  - `sale.report` (10)
  - `sale.order.line` (6)
  - `product.template` (11)
  - `product.product` (4)

Not yet available in this runtime workspace:

- `View (ir.ui.view) (1).xlsx` (the second workbook referenced by user)

Once the second workbook is uploaded, extend this document with:

- exact model-field matrix per tenant view
- field-level confidence for GP source (`margin` vs purchase-cost estimate)
- final dynamic-search prompt contracts for smaller LLMs
