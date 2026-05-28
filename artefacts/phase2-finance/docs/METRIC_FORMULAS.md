# Metric Formulas and Business Rules

## Revenue
Use configured revenue classes. Present as positive absolute value.

## COGS
Use configured COGS classes. Present as positive absolute value.

## Gross Profit
`gross_profit = revenue - cogs`

## Gross Margin %
`gross_margin_pct = gross_profit / revenue`

If revenue is zero, return null with caveat.

## Marketing Cost
Use Phase 1 semantic classification.

Included:
- `marketing_direct`

Excluded:
- `merchant_fees`
- `marketing_wages`
- `business_advisory`
- `software_general`
- `workshop_cost`
- `payroll_non_marketing`

## Contribution Margin
`contribution_margin = gross_profit - marketing_cost`

## Contribution Margin %
`contribution_margin_pct = contribution_margin / revenue`

## ROAS
Default central marketing mode:
`roas = revenue(entity) / marketing_cost(primary_marketing_entity)`

If marketing_cost is zero or null, return null with caveat.

## Net Profit
Blocked until approved business definition exists.
