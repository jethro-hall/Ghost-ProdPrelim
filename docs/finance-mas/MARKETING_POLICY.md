# Marketing Policy

## Canonical metric lock

`marketing_cost = SUM(amount WHERE account_class == "marketing_direct" AND include_in_metric == true)`

## Included accounts (Retail centralized source)

- `518 Marketing - Advertising - Google`
- `520 Marketing - Advertising - Klaviyo`
- `522 Marketing - Advertising - Meta`
- `524 Marketing - Advertising - Billboards`
- `526 Marketing - Advertising - Other`
- `527 Marketing - Advertising - Aws`
- `528 Marketing - Graphic Design`
- `536 Marketing - Commission Factory`

## Excluded accounts

- `510 Marketing - Wages`
- `523 Marketing - Merchant Fees - Bunnings`
- `583 Marketing - Business Advisor`
- `520 Contract Mechanic` (classified as `workshop_cost`)

## Centralized mode

Configured in `backend/src/ghostdash_api/odoo_mas/config/policy_config.json`:

```json
{
  "marketing_mode": "centralized",
  "primary_entity": "retail"
}
```

Behavior:

- For non-retail entity requests, marketing totals are computed from Retail.
- Result includes a centralized explanation note in the response payload.

## Extraction and completeness guard

- Marketing evidence is sourced from Odoo accounting report output (`P&L / account report` account rows) for the full date range.
- The pipeline fails with `{"status":"blocked","reason":"metric_missing"}` if any required included marketing account is missing from extracted source rows.
