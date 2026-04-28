# Ride Electric Board Summary Rewrite

## Scope
This rewrite replaces assumption-based commentary with live Odoo data for all current entities returned by `res.company`:

- `EBD`
- `Ride Electric Brisbane`
- `Ride Electric Burleigh`
- `Ride Electric Retail`
- `Ride Electric Wholesale`

Periods covered:

- `1 July 2023 - 30 June 2024` represented as `2023-07-01` to `2024-07-01`
- `1 July 2024 - 30 June 2025` represented as `2024-07-01` to `2025-07-01`
- `1 July 2025 - current` represented as `2025-07-01` to `2026-04-16`

Important method notes:

- Revenue, COGS, gross profit, and GP% are direct live Odoo finance actuals.
- `Marketing Spend Proxy` is Odoo-ledger-derived spend mapped from marketing-coded accounts and vendors. It is useful directionally, but it is not the same as direct Google, Meta, Shopify, or Klaviyo platform actuals.
- `Direct Shopify Net Receipts` is derived from posted Shopify journal movements in Odoo on Accounts Receivable. This is the safest Shopify signal currently available in the stack.
- The existing `odoo.finance.shopify.monthly_roi` helper is not reliable enough to use as the primary Shopify revenue source for the board paper, so it is not the source of the Shopify values below.

## Transition Note: Wholesale / EBD / Retail
The trend data supports a strong statement that `Ride Electric Wholesale` was materially wound down and that `Ride Electric Retail` took over the dominant trading role from the second half of calendar 2025 onward.

What the monthly trend shows:

- `Ride Electric Wholesale` was still active through `July 2025` at `A$526k` revenue.
- It then collapsed to `A$39k` in `August 2025`, `A$86k` in `September 2025`, `-A$3k` in `October 2025`, `A$26k` in `November 2025`, `A$8k` in `December 2025`, `A$4k` in `January 2026`, and effectively `A$0` from `February 2026`.
- Over the same period, `Ride Electric Retail` stepped up sharply, including `A$555k` in `July 2025`, `A$622k` in `August 2025`, `A$1.11m` in `October 2025`, `A$1.08m` in `November 2025`, and `A$1.43m` in `December 2025`.

That is consistent with a Wholesale-to-Retail handover.

For `EBD`, the data does **not** support a clean “stopped operating” statement:

- `EBD` remained active in FY2026 year to date with `A$4.98m` revenue and `A$748k` gross profit.
- Monthly `EBD` revenue remains visible through the current period, including `A$345k` in `July 2025`, `A$1.14m` in `October 2025`, `A$899k` in `December 2025`, `A$782k` in `February 2026`, and `A$220k` in partial `April 2026`.

Board-safe wording:

`The data supports a clear operational and commercial shift from Wholesale into Retail from around August to October 2025.`

`The data does not support saying EBD ceased operating; if management believes EBD's operating role changed, that should be described as a structural or booking change rather than a full cessation unless a formal legal or management transition date is separately confirmed.`

## Executive Summary
Ride Electric’s live Odoo actuals show a clear improvement in earnings quality across the group over the last three reporting periods. Group revenue increased from `A$10.74m` in FY2024 to `A$20.08m` in FY2025, while gross profit increased from `A$1.74m` to `A$4.15m`. On a year-to-date basis from `1 July 2025` to `15 April 2026`, the group has already delivered `A$18.46m` in revenue and `A$4.98m` in gross profit, with group GP% improving to `26.97%`.

The strongest operating earnings engine remains `Ride Electric Retail`, which delivered `A$2.58m` gross profit year to date and is also the only entity currently showing material Shopify journal activity in Odoo. `Ride Electric Burleigh` remains the strongest margin business among the store-led entities, with GP% of `70.25%` in FY2024, `31.59%` in FY2025, and `32.95%` FY2026 year to date. `Ride Electric Brisbane` has improved materially from a loss-making FY2024 position to positive gross profit in FY2025 and FY2026 year to date, but it still remains the lowest-margin operating store in the current mix.

The data also shows that `Ride Electric Wholesale` and `EBD` should be treated differently in the board narrative. Wholesale appears to have been substantially absorbed into Retail from around `August to October 2025`, whereas `EBD` remains an active trading entity in the Odoo actuals. That means Retail and Burleigh remain the strongest contributors to gross profit quality, Wholesale appears to have been operationally superseded by Retail, and EBD still adds scale but at lower margin density than the best-performing store-led entities.

Online trading is currently concentrated in `Ride Electric Retail`. Direct Shopify journal analysis shows Retail net Shopify receipts of `A$728k` in FY2024, `A$2.17m` in FY2025, and `A$2.21m` year to date in FY2026. Marketing spend, as represented in Odoo’s coded expense lines, is also overwhelmingly concentrated in Retail. That means any board narrative around online growth, paid media efficiency, or digital return on investment should be framed as a Retail-led story unless more complete direct platform connectors are added.

## Group Comparison
| Period | Revenue (A$) | COGS (A$) | Gross Profit (A$) | GP % | Marketing Spend Proxy (A$) | Direct Shopify Net Receipts (A$) |
|---|---:|---:|---:|---:|---:|---:|
| FY2024 | 10,740,240.76 | 9,000,490.38 | 1,739,750.38 | 16.20% | 462,019.05 | 728,382.95 |
| FY2025 | 20,080,619.73 | 15,929,127.52 | 4,151,492.21 | 20.67% | 717,090.97 | 2,165,587.42 |
| FY2026 YTD | 18,464,860.31 | 13,484,938.91 | 4,979,921.40 | 26.97% | 683,481.36 | 2,209,968.39 |

## FY2024
Period covered: `1 July 2023 - 30 June 2024`

| Entity | Revenue (A$) | COGS (A$) | Gross Profit (A$) | GP % | Marketing Spend Proxy (A$) | Direct Shopify Net Receipts (A$) |
|---|---:|---:|---:|---:|---:|---:|
| EBD | 2,582,915.31 | 2,352,985.49 | 229,929.82 | 8.90% | 0.00 | 0.00 |
| Ride Electric Brisbane | 356,866.03 | 659,732.96 | -302,866.93 | -84.87% | 415.82 | 0.00 |
| Ride Electric Burleigh | 548,580.97 | 163,176.15 | 385,404.82 | 70.25% | 40,920.42 | 0.00 |
| Ride Electric Retail | 2,706,390.92 | 1,679,157.62 | 1,027,233.30 | 37.96% | 407,385.99 | 728,382.95 |
| Ride Electric Wholesale | 4,545,487.53 | 4,145,438.16 | 400,049.37 | 8.80% | 13,296.82 | 0.00 |
| **TOTAL** | **10,740,240.76** | **9,000,490.38** | **1,739,750.38** | **16.20%** | **462,019.05** | **728,382.95** |

## FY2025
Period covered: `1 July 2024 - 30 June 2025`

| Entity | Revenue (A$) | COGS (A$) | Gross Profit (A$) | GP % | Marketing Spend Proxy (A$) | Direct Shopify Net Receipts (A$) |
|---|---:|---:|---:|---:|---:|---:|
| EBD | 3,839,406.35 | 3,585,140.32 | 254,266.03 | 6.62% | 0.00 | 0.00 |
| Ride Electric Brisbane | 722,580.45 | 691,134.13 | 31,446.32 | 4.35% | 155.73 | 0.00 |
| Ride Electric Burleigh | 3,393,458.76 | 2,321,522.21 | 1,071,936.55 | 31.59% | 11,349.18 | 0.00 |
| Ride Electric Retail | 4,632,947.96 | 3,020,698.53 | 1,612,249.43 | 34.80% | 694,866.06 | 2,165,587.42 |
| Ride Electric Wholesale | 7,492,226.21 | 6,310,632.33 | 1,181,593.88 | 15.77% | 10,720.00 | 0.00 |
| **TOTAL** | **20,080,619.73** | **15,929,127.52** | **4,151,492.21** | **20.67%** | **717,090.97** | **2,165,587.42** |

## FY2026 YTD
Period covered: `1 July 2025 - 15 April 2026`

| Entity | Revenue (A$) | COGS (A$) | Gross Profit (A$) | GP % | Marketing Spend Proxy (A$) | Direct Shopify Net Receipts (A$) |
|---|---:|---:|---:|---:|---:|---:|
| EBD | 4,979,477.65 | 4,231,810.30 | 747,667.35 | 15.01% | 0.00 | 0.00 |
| Ride Electric Brisbane | 1,097,659.00 | 826,042.62 | 271,616.38 | 24.75% | 739.77 | 0.00 |
| Ride Electric Burleigh | 3,648,873.76 | 2,446,399.55 | 1,202,474.21 | 32.95% | 2,000.00 | 0.00 |
| Ride Electric Retail | 8,051,069.47 | 5,469,964.44 | 2,581,105.03 | 32.06% | 680,741.59 | 2,209,968.39 |
| Ride Electric Wholesale | 687,780.43 | 510,722.00 | 177,058.43 | 25.74% | 0.00 | 0.00 |
| **TOTAL** | **18,464,860.31** | **13,484,938.91** | **4,979,921.40** | **26.97%** | **683,481.36** | **2,209,968.39** |

## Revenue Source Deep Dive: Workshop Income
Workshop income has been analysed separately for the three operating retail/service businesses only:

- `Ride Electric Retail`
- `Ride Electric Brisbane`
- `Ride Electric Burleigh`

It excludes:

- `EBD`
- `Ride Electric Wholesale`

Reason:

- you asked to keep `EBD` in the overall entity mix, but to exclude `EBD` and `Wholesale` from the workshop-income view
- the workshop view is therefore focused on the customer-facing operating businesses where workshop/service revenue is commercially meaningful

Method:

- live posted Odoo revenue lines only
- account used: `Sales - Workshop Repairs & Service`

### Workshop Summary By Period
| Period | Retail (A$) | Brisbane (A$) | Burleigh (A$) | Total (A$) |
|---|---:|---:|---:|---:|
| FY2024 | 155,986.11 | 173,975.39 | 13,468.19 | 343,429.69 |
| FY2025 | 131,214.32 | 178,935.15 | 182,140.30 | 492,289.77 |
| FY2026 YTD | 176,199.52 | 176,268.42 | 235,406.52 | 587,874.46 |

### FY2024 Workshop Income
| Month | Retail (A$) | Brisbane (A$) | Burleigh (A$) | Total (A$) |
|---|---:|---:|---:|---:|
| 2023-07 | 12,702.24 | 6,020.05 | 0.00 | 18,722.29 |
| 2023-08 | 16,220.16 | 16,043.54 | 0.00 | 32,263.70 |
| 2023-09 | 16,599.29 | 14,132.67 | 0.00 | 30,731.96 |
| 2023-10 | 16,345.70 | 14,884.61 | 0.00 | 31,230.31 |
| 2023-11 | 10,969.29 | 15,395.12 | 180.00 | 26,544.41 |
| 2023-12 | 11,707.89 | 15,391.57 | 697.28 | 27,796.74 |
| 2024-01 | 11,387.36 | 11,826.88 | 90.91 | 23,305.15 |
| 2024-02 | 11,101.88 | 18,831.59 | 90.91 | 30,024.38 |
| 2024-03 | 11,444.75 | 17,012.71 | 1,600.03 | 30,057.49 |
| 2024-04 | 12,631.89 | 13,737.15 | 2,959.20 | 29,328.24 |
| 2024-05 | 13,041.00 | 18,904.78 | 3,941.06 | 35,886.84 |
| 2024-06 | 11,834.66 | 11,794.72 | 3,908.80 | 27,538.18 |
| **TOTAL** | **155,986.11** | **173,975.39** | **13,468.19** | **343,429.69** |

### FY2025 Workshop Income
| Month | Retail (A$) | Brisbane (A$) | Burleigh (A$) | Total (A$) |
|---|---:|---:|---:|---:|
| 2024-07 | 12,559.79 | 25,393.05 | 7,700.62 | 45,653.46 |
| 2024-08 | 9,047.52 | 10,742.40 | 7,164.59 | 26,954.51 |
| 2024-09 | 8,930.16 | 15,828.20 | 12,614.64 | 37,373.00 |
| 2024-10 | 13,291.97 | 11,602.02 | 13,621.93 | 38,515.92 |
| 2024-11 | 7,951.41 | 17,308.80 | 13,173.62 | 38,433.83 |
| 2024-12 | 7,190.15 | 14,706.79 | 10,536.51 | 32,433.45 |
| 2025-01 | 10,891.96 | 11,377.09 | 15,315.75 | 37,584.80 |
| 2025-02 | 13,751.92 | 12,377.55 | 15,014.30 | 41,143.77 |
| 2025-03 | 9,876.51 | 9,381.96 | 17,356.60 | 36,615.07 |
| 2025-04 | 8,545.55 | 11,988.39 | 20,232.16 | 40,766.10 |
| 2025-05 | 15,062.08 | 19,837.46 | 23,709.65 | 58,609.19 |
| 2025-06 | 14,115.30 | 18,391.44 | 25,699.93 | 58,206.67 |
| **TOTAL** | **131,214.32** | **178,935.15** | **182,140.30** | **492,289.77** |

### FY2026 YTD Workshop Income
| Month | Retail (A$) | Brisbane (A$) | Burleigh (A$) | Total (A$) |
|---|---:|---:|---:|---:|
| 2025-07 | 20,695.65 | 16,179.30 | 27,442.82 | 64,317.77 |
| 2025-08 | 17,243.14 | 21,281.53 | 28,017.22 | 66,541.89 |
| 2025-09 | 18,785.43 | 20,466.67 | 28,830.14 | 68,082.24 |
| 2025-10 | 17,919.49 | 19,728.99 | 25,431.97 | 63,080.45 |
| 2025-11 | 18,632.09 | 19,670.15 | 25,052.49 | 63,354.73 |
| 2025-12 | 17,307.63 | 20,288.62 | 20,820.10 | 58,416.35 |
| 2026-01 | 20,848.39 | 11,966.93 | 21,616.44 | 54,431.76 |
| 2026-02 | 19,973.18 | 14,171.89 | 27,314.49 | 61,459.56 |
| 2026-03 | 18,271.66 | 25,239.69 | 21,796.35 | 65,307.70 |
| 2026-04 | 6,522.86 | 7,274.65 | 9,084.50 | 22,882.01 |
| **TOTAL** | **176,199.52** | **176,268.42** | **235,406.52** | **587,874.46** |

### Workshop Readout
1. Workshop income across `Retail`, `Brisbane`, and `Burleigh` increased from `A$343k` in FY2024 to `A$492k` in FY2025, and has already reached `A$588k` in FY2026 year to date.
2. `Retail` was the largest workshop contributor in FY2024, but not by FY2025.
3. `Brisbane` was the largest workshop contributor in FY2024 and remained strong in FY2025, but it has now been overtaken by `Burleigh` in FY2026 year to date.
4. `Burleigh` shows the strongest workshop acceleration, growing from only `A$13k` in FY2024 to `A$182k` in FY2025 and `A$235k` in FY2026 year to date.
5. The workshop revenue base is now broader across the three operating businesses and appears to be a more meaningful recurring revenue stream than it was in FY2024.

## Board-Level Readout
1. The group has materially improved gross profit generation over the three periods, with GP increasing from `A$1.74m` in FY2024 to `A$4.15m` in FY2025, and already reaching `A$4.98m` in FY2026 year to date.
2. `Ride Electric Retail` is the single largest profit pool and the dominant online trading entity based on direct Shopify journal movement.
3. `Ride Electric Burleigh` is the strongest store-level margin business and remains strategically important because it combines scale with strong GP%.
4. `Ride Electric Brisbane` has improved significantly, but it still requires scrutiny because its margin base remains materially below Retail and Burleigh.
5. `Ride Electric Wholesale` appears to have been substantially wound down from `August 2025` onward, with `Retail` taking over the dominant trading role.
6. `EBD` does not show the same cessation pattern. It remains active in FY2026 year to date, so any statement that EBD stopped operating should only be made if management separately confirms a formal structural transition.
7. Retail carries almost all visible Shopify activity and almost all visible Odoo-coded marketing spend, so digital strategy should be framed primarily as a Retail-led capability unless entity mapping changes.

## What To Say In The Board Room
Use this:

`The business has moved from a mixed-margin portfolio in FY2024 to a materially stronger earnings position in FY2025 and FY2026 year to date.`

`Retail remains the primary earnings and online-commerce engine, Burleigh remains the strongest store-level margin contributor, Brisbane has improved but is still lower quality from a margin perspective, Wholesale appears to have rolled into Retail from the second half of 2025, and EBD remains active but lower-margin.`

`The board should evaluate future growth not just on revenue expansion, but on which entities are generating the best gross profit quality and the strongest recurring digital and channel economics.`

## Verify Commands
```bash
cd /var/llamaindex/ghoststack-rag

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.rpc.search_read","payload":{"model":"res.company","domain":[],"fields":["id","name"],"limit":100,"offset":0,"order":"name asc"}}' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.finance.margin.period_summary","payload":{"company_id":3,"date_from":"2023-07-01","date_to":"2024-07-01"}}' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.finance.margin.period_summary","payload":{"company_id":3,"date_from":"2024-07-01","date_to":"2025-07-01"}}' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.finance.margin.period_summary","payload":{"company_id":3,"date_from":"2025-07-01","date_to":"2026-04-16"}}' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.finance.shopify.monthly_roi","payload":{"company_ids":[1,2,3,4,5],"date_from":"2025-07-01","date_to":"2026-04-16"}}' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.rpc.read_group","payload":{"model":"account.move.line","domain":[["parent_state","=","posted"],["date",">=","2025-07-01"],["date","<","2026-04-16"],["company_id","in",[1,2,3,4,5]],["journal_id","in",[58,59,60,72,89,91]],["account_id","=",427]],"fields":["credit:sum","debit:sum","balance:sum"],"groupby":["company_id"],"orderby":"company_id asc","lazy":false}}' | jq
```

## Acceptance Criteria
- Summary rewritten in board style using live Odoo actuals.
- All Odoo entities included.
- Three requested periods included.
- Each period includes entity-level rows and a total row.
- Revenue, COGS, GP, GP%, marketing proxy, and direct Shopify signal are presented in tables.
