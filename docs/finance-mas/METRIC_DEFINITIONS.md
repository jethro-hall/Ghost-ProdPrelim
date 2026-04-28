# Metric Definitions

## Phase 1 finance metric contract

- Planner must produce a metric-first source plan for finance metric requests.
- Composer is blocked when required metrics are missing.
- No ledger-only response path is allowed for finance metric requests.

## Blocking contract

When required metric evidence is absent:

```json
{
  "status": "blocked",
  "reason": "metric_missing"
}
```

Marketing-cost requests also block when required marketing-direct accounts are missing from the extracted Odoo source dataset for the requested period.

## Metrics

- `marketing_cost_total`
  - Derived from explicit classified ledger rows.
  - Formula: sum of included `marketing_direct` rows.
  - Extraction source: Odoo accounting report engine (`odoo.finance.pnl.period_summary` account rows), not query-spec ledger pulls.
- `marketing_costs`
  - Alias to `marketing_cost_total` for request compatibility.

## Legacy fields removed from response semantics

- `Matches Query Terms`
- `OPEX Ledger Search`

Supporting rows are surfaced only as `Supporting Ledger Evidence` with:

- `account`
- `amount`
- `account_class`
- `include_in_metric`
