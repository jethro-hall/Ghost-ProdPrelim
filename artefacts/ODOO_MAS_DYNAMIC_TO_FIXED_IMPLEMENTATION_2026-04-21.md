# Odoo MAS dynamic-to-fixed implementation (2026-04-21)

## Decision log

### MAS surface choice

- **Head/orchestrator path**: use `POST /api/tools/odoo_primary/execute` (`control_api` surface) for dynamic multi-step orchestration and fallback model access.
- **Consumer/sub-agent path**: keep `consumer_chat` model allowlists tight; use named operations for common drilldowns.
- **Reason**: this preserves safety for lightweight assistants while letting the orchestrator execute broader read-only ERP analytics.

### Allowlist policy

- **Chosen**: keep allowlists tight (do **not** add `account.payment`/`pos.order` generic model access to consumer chat).
- **Mitigation**: introduce named helper `odoo.sales.drilldown.period` so payment and product drilldowns are still available on consumer surface.

## New governed operation

- `odoo.sales.drilldown.period`
  - Input: `date_from`, `date_to`, optional `company_id`/`company_name_terms`, optional `source_surface`, optional `order_states`, optional `top_n`.
  - Output: `leaders.sales_agent`, `leaders.product`, `leaders.payment_method`, plus evidence samples.

## Ian runbook payloads

### 1) Revenue for previous 7 days

```json
{
  "operation": "odoo.finance.revenue.period",
  "payload": {
    "date_from": "2026-04-13",
    "date_to": "2026-04-20",
    "company_name_terms": ["burleigh"]
  }
}
```

### 2) Drilldown: leading sales agent/payment method/product sold

```json
{
  "operation": "odoo.sales.drilldown.period",
  "payload": {
    "date_from": "2026-04-13",
    "date_to": "2026-04-20",
    "company_name_terms": ["burleigh"],
    "source_surface": "auto",
    "order_states": ["sale", "done"],
    "top_n": 5
  }
}
```

### 3) Dynamic fallback (if helper unavailable in an older deployment)

```json
{
  "operation": "odoo.rpc.read_group",
  "payload": {
    "model": "sale.order",
    "domain": [
      ["state", "in", ["sale", "done"]],
      ["date_order", ">=", "2026-04-13"],
      ["date_order", "<", "2026-04-20"]
    ],
    "fields": ["amount_total:sum"],
    "groupby": ["user_id"],
    "orderby": "amount_total desc",
    "lazy": false
  }
}
```

## Tenant mapping checklist (Ride Electric)

Before hard-locking drilldown semantics in production, confirm these per tenant:

1. **Sales source-of-truth**: `sale.order` vs `pos.order` vs posted invoice lines.
2. **Payment source-of-truth**: `account.payment.payment_method_line_id`, `account.payment.journal_id`, or `pos.payment.payment_method_id`.
3. **Order finalization states**: whether `"sale"` and `"done"` both represent completed sales for this tenant.
4. **Tax basis preference**: line `price_subtotal` vs invoice untaxed totals for product ranking consistency.

## Verification commands

```bash
cd /var/llamaindex/ghoststack-rag/backend && pytest tests/test_tools_api.py::test_odoo_connector_supports_sales_drilldown_period -q
cd /var/llamaindex/ghoststack-rag/backend && pytest tests/test_workflows_odoo_planning.py::test_plan_odoo_tool_usage_routes_sales_drilldown_prompt_to_named_helper -q
cd /var/llamaindex/ghoststack-rag/backend && pytest tests/test_tools_api.py::test_consumer_chat_allows_sales_drilldown_helper -q
```

## Acceptance criteria

- Ian-style question routes to `odoo.sales.drilldown.period` with explicit date range and company scope.
- Helper returns non-destructive, evidence-bearing `leaders` + `samples` structure.
- Consumer chat policy remains drift-intolerant (no broad new generic model access), while the helper remains allowed.
