# Ride Electric Margin And Movement Analysis

## Purpose
Test whether changes in revenue are being matched by COGS, GP, and marketing-spend movements, using live Odoo actuals for all entities.

Included entities:

- `EBD`
- `Ride Electric Wholesale`
- `Ride Electric Retail`
- `Ride Electric Brisbane`
- `Ride Electric Burleigh`

## Important Caveat
- Revenue, COGS, and GP are direct Odoo actuals.
- `Marketing Spend Proxy` is Odoo-ledger-derived from marketing-coded accounts and vendors. It is useful for movement analysis, but it is not direct platform spend from Google, Meta, Shopify, or Klaviyo APIs.
- The current Shopify ROI helper undercounts Shopify revenue, but the marketing-spend proxy is still usable for directional movement analysis.

## Period Summary
| Period | Revenue (A$) | COGS (A$) | GP (A$) | GP % | Marketing Spend Proxy (A$) | Marketing % of Revenue |
|---|---:|---:|---:|---:|---:|---:|
| FY2024 | 10,740,240.76 | 9,000,490.38 | 1,739,750.38 | 16.20% | 462,019.05 | 4.30% |
| FY2025 | 20,080,619.73 | 15,929,127.52 | 4,151,492.21 | 20.67% | 717,090.97 | 3.57% |
| FY2026_YTD | 18,464,860.31 | 13,484,938.91 | 4,979,921.40 | 26.97% | 683,481.36 | 3.70% |
| FY2025_YTD_COMPARABLE | 15,344,002.69 | 12,828,637.16 | 2,515,365.53 | 16.39% | 561,673.99 | 3.66% |

## What The Data Says
1. `FY2025 vs FY2024`: revenue `87.0%`, COGS `77.0%`, GP `138.6%`, marketing proxy `55.2%`.
2. GP grew faster than revenue in `FY2025`, and GP% improved by `4.48` points from `16.20%` to `20.67%`. That means COGS did not rise as fast as revenue overall.
3. Marketing proxy rose by `55.2%` in `FY2025`, but revenue still grew faster than marketing and GP grew materially faster than both. Marketing % of revenue moved from `4.30%` to `3.57%`, a change of `-0.73` points.
4. `FY2026 YTD vs comparable FY2025 YTD`: revenue `20.3%`, COGS `5.1%`, GP `98.0%`, marketing proxy `21.7%`.
5. In `FY2026 YTD`, GP% improved by `10.58` points versus the comparable prior-year period, while marketing % of revenue moved by `0.04` points.
6. Correlation check on the full monthly series: group revenue vs GP `0.743`; group revenue vs COGS `0.942`; group revenue vs marketing proxy `0.715`. For `Retail`, revenue vs GP `0.853` and revenue vs marketing proxy `0.705`.

## Interpretation
- Revenue and COGS move together strongly, which is expected in a stock-led business. The important question is whether COGS is rising faster or slower than revenue.
- Across the annual and comparable-YTD cuts, revenue growth has outpaced COGS growth, and GP has grown faster than revenue. That is genuine margin improvement, not just top-line inflation.
- Marketing proxy does not appear to be the sole driver of group growth because it is concentrated mainly in Retail and it does not move one-for-one with group revenue or GP every month.
- At the monthly level there are still mismatch months where revenue, GP, COGS, and marketing do not move cleanly together. Those months are more likely to reflect product-mix changes, timing, accounting allocation, or cost-recognition effects than simple demand changes.

## FY2026 YTD Monthly Movement Table
| Month | Revenue (A$) | COGS (A$) | GP (A$) | GP % | Marketing Proxy (A$) | Rev MoM | COGS MoM | GP MoM | Mkt MoM | Flags |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 2025-07 | 1,929,670.67 | 1,431,743.57 | 497,927.10 | 25.80% | 66,015.13 | -8.9% | 29.7% | -50.9% | -2.6% | cogs_not_matching_revenue |
| 2025-08 | 1,282,572.68 | 916,462.44 | 366,110.24 | 28.54% | 72,570.12 | -33.5% | -36.0% | -26.5% | 9.9% | mkt_up_rev_down, mkt_up_gp_down |
| 2025-09 | 1,450,750.14 | 1,143,565.38 | 307,184.76 | 21.17% | 66,635.83 | 13.1% | 24.8% | -16.1% | -8.2% | rev_up_gp_down |
| 2025-10 | 2,771,330.50 | 2,066,018.39 | 705,312.11 | 25.45% | 73,274.08 | 91.0% | 80.7% | 129.6% | 10.0% |  |
| 2025-11 | 2,145,803.01 | 1,555,715.17 | 590,087.84 | 27.50% | 83,580.61 | -22.6% | -24.7% | -16.3% | 14.1% | mkt_up_rev_down, mkt_up_gp_down |
| 2025-12 | 3,083,478.11 | 2,315,061.67 | 768,416.44 | 24.92% | 85,138.58 | 43.7% | 48.8% | 30.2% | 1.9% |  |
| 2026-01 | 1,567,565.47 | 1,155,357.63 | 412,207.84 | 26.30% | 80,961.75 | -49.2% | -50.1% | -46.4% | -4.9% |  |
| 2026-02 | 2,020,515.17 | 1,363,343.95 | 657,171.22 | 32.52% | 65,147.37 | 28.9% | 18.0% | 59.4% | -19.5% |  |
| 2026-03 | 1,452,258.87 | 965,888.94 | 486,369.93 | 33.49% | 77,500.97 | -28.1% | -29.2% | -26.0% | 19.0% | mkt_up_rev_down, mkt_up_gp_down |
| 2026-04 | 760,915.69 | 571,781.77 | 189,133.92 | 24.86% | 12,656.92 | -47.6% | -40.8% | -61.1% | -83.7% |  |

## Flagged Mismatch Months
| Month | Revenue (A$) | GP (A$) | Marketing Proxy (A$) | Flags |
|---|---:|---:|---:|---|
| 2023-09 | 947,312.01 | 223,225.04 | 31,187.91 | cogs_not_matching_revenue |
| 2023-11 | 580,214.52 | 27,964.80 | 29,753.06 | rev_up_gp_down, mkt_up_gp_down |
| 2023-12 | 567,871.10 | 64,493.56 | 31,887.03 | rev_down_gp_up, mkt_up_rev_down |
| 2024-01 | 1,734,424.29 | 36,123.01 | 43,517.75 | rev_up_gp_down, mkt_up_gp_down, cogs_not_matching_revenue |
| 2024-02 | 908,477.16 | 73,037.22 | 42,443.39 | rev_down_gp_up |
| 2024-04 | 590,604.22 | 134,324.21 | 49,833.63 | rev_down_gp_up, mkt_up_rev_down |
| 2024-05 | 1,120,813.56 | 101,449.12 | 40,681.17 | rev_up_gp_down, cogs_not_matching_revenue |
| 2024-06 | 1,496,004.55 | 810,056.45 | 41,591.48 | cogs_not_matching_revenue |
| 2024-07 | 1,068,206.14 | 120,801.49 | 61,229.07 | mkt_up_rev_down, mkt_up_gp_down, cogs_not_matching_revenue |
| 2024-09 | 1,090,213.92 | 232,271.46 | 59,831.25 | rev_down_gp_up, mkt_up_rev_down |
| 2025-02 | 1,893,359.44 | 186,676.85 | 55,651.92 | rev_up_gp_down, mkt_up_gp_down |
| 2025-03 | 1,292,570.31 | 305,377.23 | 56,157.26 | rev_down_gp_up, mkt_up_rev_down |
| 2025-05 | 1,758,085.35 | 410,851.43 | 61,357.08 | mkt_up_rev_down, mkt_up_gp_down |
| 2025-06 | 2,117,672.57 | 1,013,680.41 | 67,798.03 | cogs_not_matching_revenue |
| 2025-07 | 1,929,670.67 | 497,927.10 | 66,015.13 | cogs_not_matching_revenue |
| 2025-08 | 1,282,572.68 | 366,110.24 | 72,570.12 | mkt_up_rev_down, mkt_up_gp_down |
| 2025-09 | 1,450,750.14 | 307,184.76 | 66,635.83 | rev_up_gp_down |
| 2025-11 | 2,145,803.01 | 590,087.84 | 83,580.61 | mkt_up_rev_down, mkt_up_gp_down |
| 2026-03 | 1,452,258.87 | 486,369.93 | 77,500.97 | mkt_up_rev_down, mkt_up_gp_down |

## Practical Board Answer
Use this wording:

`The data shows that revenue growth has generally been matched and exceeded by gross-profit growth at the major reporting-period level, which means the business is not just growing top line; it is converting that growth into better gross-profit performance.`

`COGS does move closely with revenue, as expected in a stock-led business, but not at the same rate. Over time, revenue growth has outpaced COGS growth, lifting GP percentage.`

`Marketing spend, viewed through the Odoo ledger proxy, does not explain revenue or GP in a simple one-for-one way. It is concentrated mainly in Retail and there are months where spend rises without an immediate matching uplift in revenue or GP, which points to timing, mix, attribution lag, or classification noise rather than a direct causal mismatch.`

`The strongest conclusion is that margin quality has improved materially, even though individual months still show volatility and accounting noise underneath the trend.`

## Verify Commands
```bash
cd /var/llamaindex/ghoststack-rag

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute -H 'Content-Type: application/json' -d '{"operation":"odoo.finance.margin.monthly_comparison","payload":{"company_ids":[1,2,3,4,5],"date_from":"2023-07-01","date_to":"2026-04-16"}}' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute -H 'Content-Type: application/json' -d '{"operation":"odoo.finance.shopify.monthly_roi","payload":{"company_ids":[1,2,3,4,5],"date_from":"2023-07-01","date_to":"2026-04-16"}}' | jq
```

## Acceptance Criteria
- All entities included in the movement analysis.
- Revenue, COGS, GP, and marketing-spend proxy pulled from live Odoo-backed sources.
- Period-over-period and comparable-YTD movements calculated.
- Month-by-month mismatch flags generated for board discussion.