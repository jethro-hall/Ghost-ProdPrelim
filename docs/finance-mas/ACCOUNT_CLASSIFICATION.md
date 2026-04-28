# Account Classification

Phase 1 canonical rule: finance classification is explicit and deterministic.

## Source of truth

- `backend/src/ghostdash_api/odoo_mas/config/account_classification/retail.json`
- `backend/src/ghostdash_api/odoo_mas/config/account_classification/brisbane.json`
- `backend/src/ghostdash_api/odoo_mas/config/account_classification/burleigh.json`

## Hard guarantees

- Classification is `entity + account_name` based.
- No prefix-only classification is used.
- No keyword fallback classification is used.
- Unmapped accounts default to:
  - `account_class = null`
  - `include_in_metric = false`

## Mapping rationale

- Marketing totals are sensitive and must not absorb workshop or labor expense.
- `520 Contract Mechanic` is explicitly mapped to `workshop_cost` and excluded.
- Merchant fees, wages, and advisor spend remain classified but excluded from the metric.

## Validation checklist

- `520 Contract Mechanic` never contributes to `marketing_cost_total`.
- Only `marketing_direct` rows with `include_in_metric=true` contribute.
