# Business-unit dimension discovery

Date: 2026-04-23
Status: complete

## Objective

Verify whether visible business selector values map to machine-scoped Odoo report parameters and confirm Burleigh/Brisbane can be queried independently.

## Live checks run

### Burleigh check

- Request operation: `odoo.finance.pnl.period_summary`
- Payload: `{"relative_period":"last_month","company_name_terms":["burleigh"]}`
- Result: success
- Resolved scope: `company_ids: [5]`
- Resolved label: `Ride Electric Burleigh`

### Brisbane check

- Request operation: `odoo.finance.pnl.period_summary`
- Payload: `{"relative_period":"last_month","company_name_terms":["brisbane"]}`
- Result: success
- Resolved scope: `company_ids: [4]`
- Resolved label: `Ride Electric Brisbane`

## Conclusion

- The selector terms are mapped into company scope in current runtime behavior (`company_ids` in response).
- Burleigh and Brisbane are independently queryable and return different scoped finance totals.
- Dimension inference must remain controlled by explicit mapping, not unconstrained LLM guessing.

## Canonical mappings confirmed in this run

- `burleigh` -> `Ride Electric Burleigh` -> `company_id: 5`
- `brisbane` -> `Ride Electric Brisbane` -> `company_id: 4`

## Follow-up action for registry

Persist alias-to-exact mapping in `dimension_registry` and fail closed for unknown aliases.
