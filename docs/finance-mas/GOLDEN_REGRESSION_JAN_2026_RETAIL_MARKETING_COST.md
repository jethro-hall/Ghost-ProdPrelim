# Golden Regression: Jan 2026 Retail Marketing Cost

## Query

`Using Odoo only, show marketing costs for Ride Electric Retail in Jan 2026 and include ledger lines.`

## Expected behavior

- No block.
- `marketing_cost_total` is computed from included `marketing_direct` rows with period activity.
- Configured marketing accounts with no period activity are returned as `0.00` with `status = no_activity_in_period`.
- Merchant fees, marketing wages, and Shopify Fees are excluded from metric aggregation.
- No invented values.

## Golden expected total

- `49,706.17`

Computed from active included rows:

- `518 Marketing - Advertising` = `37,149.55`
- `520 Klaviyo` = `953.98`
- `522 Facebook` = `6,957.96`
- `524 Marketing - Advertising - Billboards` = `1,900.00`
- `527 Marketing - Advertising - AWS` = `2,744.68`

Excluded (supporting evidence only):

- `510 Wages - Marketing` (`marketing_wages`, excluded)
- `523 Merchant Fees - Bunnings` (`merchant_fees`, excluded)
- `526 Shopify Fees` (`merchant_fees`, excluded)

Inactive configured accounts in this period:

- `528 Marketing - Graphic Design` = `0.00` (`no_activity_in_period`)
- `536 Marketing - Commission Factory` = `0.00` (`no_activity_in_period`)

## Regression test reference

- `backend/tests/test_odoo_mas_pipeline.py::test_golden_january_2026_retail_marketing_cost`
