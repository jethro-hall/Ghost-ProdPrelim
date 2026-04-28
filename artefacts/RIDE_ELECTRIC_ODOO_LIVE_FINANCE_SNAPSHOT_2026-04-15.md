# Ride Electric Odoo Live Finance Snapshot

## Purpose
Replace assumption-based board narrative with live Odoo-backed numbers for the three operating businesses:

- `Ride Electric Retail` (`company_id = 3`)
- `Ride Electric Brisbane` (`company_id = 4`)
- `Ride Electric Burleigh` (`company_id = 5`)

This snapshot was taken from the live `odoo_primary` tool in GhostDASH on `2026-04-15`.

## Live Connectivity
- Odoo tool status: `healthy`
- Odoo tool active: `true`
- Odoo tool configured: `true`
- Odoo base URL: `https://odoo.rideelectric.com.au`
- Odoo database: `Ride_Electric_Live`
- Authenticated user on test: `Ian LeGarth`

## Live Company List
Odoo `res.company` currently returns:

- `1` `EBD`
- `2` `Ride Electric Wholesale`
- `3` `Ride Electric Retail`
- `4` `Ride Electric Brisbane`
- `5` `Ride Electric Burleigh`

For board-trading analysis, the core three businesses used here are `Retail`, `Brisbane`, and `Burleigh`.

## FYTD Completed Months
Scope:

- `date_from = 2025-07-01`
- `date_to = 2026-04-01`
- This is the cleanest board-safe cut because it excludes partial April trading.

| Business | Revenue (A$) | COGS (A$) | Gross Profit (A$) | GP % |
|---|---:|---:|---:|---:|
| Ride Electric Retail | 7,722,504.79 | 5,234,339.70 | 2,488,165.09 | 32.22% |
| Ride Electric Brisbane | 1,046,689.04 | 796,838.21 | 249,850.83 | 23.87% |
| Ride Electric Burleigh | 3,487,696.15 | 2,326,897.70 | 1,160,798.45 | 33.28% |
| **Group total** | **12,256,889.98** | **8,358,075.61** | **3,898,814.37** | **31.81%** |

## FYTD Including April Month-To-Date
Scope:

- `date_from = 2025-07-01`
- `date_to = 2026-04-15`
- Use this only if the board wants current trading including April MTD.

| Business | Revenue (A$) | COGS (A$) | Gross Profit (A$) | GP % |
|---|---:|---:|---:|---:|
| Ride Electric Retail | 8,031,272.39 | 5,457,313.45 | 2,573,958.94 | 32.05% |
| Ride Electric Brisbane | 1,097,028.72 | 825,575.28 | 271,453.44 | 24.74% |
| Ride Electric Burleigh | 3,643,912.66 | 2,444,830.34 | 1,199,082.32 | 32.91% |
| **Group total** | **12,772,213.77** | **8,727,719.07** | **4,044,494.70** | **31.67%** |

## Performance Ranking
Using completed FYTD months to `2026-04-01`:

- `Retail` is the largest earnings pool by revenue and gross profit.
- `Burleigh` is second by gross profit and has the strongest GP% of the three at `33.28%`.
- `Brisbane` is materially smaller and structurally lower margin at `23.87%`.

## Monthly Margin Read
Live monthly comparison over `2025-07` to `2026-04` shows:

- `Retail` had strongest scale months in `2025-10`, `2025-11`, and `2025-12`.
- `Burleigh` was steadier than `Retail`, but softened through `2026-01` to `2026-04`.
- `Brisbane` remains volatile and subscale, though GP% improved in `2026-02` to `2026-04`.

## Shopify And Marketing
## Important Truth
The current helper `odoo.finance.shopify.monthly_roi` is **not presentation-safe as a source of Shopify income** in its current form.

Why:

- The helper reported `Retail` Shopify revenue of only `A$826,599.34` for `2025-07-01` to `2026-04-01`.
- It also showed Shopify revenue dropping to near-zero after `2025-11`.
- Direct live ledger inspection proves Shopify payment journal entries are still actively posting in April 2026.

Example direct evidence from live Odoo on `2026-04-14` and `2026-04-15`:

- journal `Shopify Payments (Ride Electric) - NEW`
- journal `Shopify Payments (FatFish)`
- account `610 Accounts Receivable`
- customer payment entries tied to references such as `RTINV-25855`, `RTINV-25867`, `RTINV-25892`

That means the helper is undercounting real Shopify activity and should not be used as-is in the board paper.

## Direct Shopify Journal Reality Check
Using direct Odoo ledger aggregation against Shopify journals for `Ride Electric Retail` only:

- journals used: `58`, `59`, `60`, `72`, `89`, `91`
- account used: `610 Accounts Receivable` (`account_id = 427`)
- scope: `2025-07-01` to `2026-04-01`

Direct grouped totals from posted Odoo ledger lines:

- Shopify AR credits: `A$2,226,543.52`
- Shopify AR debits / reversals: `A$95,761.72`
- Net Shopify movement: `A$2,130,781.80`

Monthly direct Shopify AR movement for `Retail`:

| Month | Credits (A$) | Debits / Refunds (A$) | Net (A$) |
|---|---:|---:|---:|
| 2025-07 | 193,437.68 | 9,355.68 | 184,082.00 |
| 2025-08 | 199,931.49 | 16,954.40 | 182,977.09 |
| 2025-09 | 185,350.04 | 11,438.57 | 173,911.47 |
| 2025-10 | 265,119.01 | 16,346.34 | 248,772.67 |
| 2025-11 | 450,379.50 | 9,266.96 | 441,112.54 |
| 2025-12 | 302,825.68 | 11,614.19 | 291,211.49 |
| 2026-01 | 227,985.19 | 7,724.74 | 220,260.45 |
| 2026-02 | 164,394.85 | 1,396.30 | 162,998.55 |
| 2026-03 | 237,120.08 | 11,664.54 | 225,455.54 |

## Marketing Spend From Odoo
The current helper is still useful as a **proxy** for marketing spend because it is reading posted Odoo expense lines. But it is not a direct Meta / Google / Shopify / Klaviyo API integration.

For `2025-07-01` to `2026-04-01`, the helper currently reports:

- `Retail` marketing spend proxy: `A$668,084.67`
- `Brisbane` marketing spend proxy: `A$739.77`
- `Burleigh` marketing spend proxy: `A$2,000.00`
- `Group` marketing spend proxy: `A$670,824.44`

Mapped spend sources include accounts such as:

- `510 Wages - Marketing`
- `512 Marketing - Website Design (Damian)`
- `518 Marketing - Advertising`
- `522 Facebook`
- `527 Marketing - Advertising - AWS`
- `528 Marketing - Graphic Design`
- `536 Marketing - Commission Factory`

Detected vendors include:

- `Google`
- `Meta Platforms, Inc.`
- `Meta/Facebook`
- `Commission Factory`
- `VASTLY DIGITAL`
- `Damian Lunson T/A En-Gn Media`

## What Is Solid Enough For Tomorrow
Safe to use in the board paper:

- live Odoo revenue by business
- live Odoo COGS by business
- live Odoo gross profit and GP%
- business ranking across `Retail`, `Brisbane`, `Burleigh`
- direct Shopify journal evidence that online trading is still active

Do not use without caveat:

- current `odoo.finance.shopify.monthly_roi` revenue output
- any ROAS statement derived from that helper
- any claim that Shopify revenue fell to zero after November
- any statement that marketing attribution is platform-perfect

## Board Wording Recommendation
Use this language:

`Financial performance is now grounded in live Odoo actuals across Retail, Brisbane, and Burleigh.`

`Shopify and marketing figures should be described as Odoo-ledger-derived channel indicators unless and until the Shopify ROI helper is corrected or direct platform connectors are added.`

## Problems Found
1. The existing Shopify ROI helper materially undercounts Retail Shopify revenue.
2. The helper therefore produces misleading ROAS and contribution-after-marketing outputs.
3. The current marketing-spend logic is ledger-derived and useful directionally, but it is not the same as direct Google, Meta, Shopify, or Klaviyo actuals.

## Solution Path
1. Use the live Odoo finance actuals immediately for the board rewrite.
2. Use direct Shopify journal aggregation for any online-income statement needed tomorrow.
3. Patch `odoo.finance.shopify.monthly_roi` after the presentation so GhostDASH stops undercounting Shopify revenue.
4. If true platform attribution is required later, add direct connectors for Shopify, Google Ads, Meta Ads, and Klaviyo instead of relying only on Odoo heuristics.

## Exact Verify Commands
```bash
cd /var/llamaindex/ghoststack-rag

curl -sS http://127.0.0.1/api/tools/catalog | jq

curl -sS http://127.0.0.1/api/tools/odoo_primary | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/test \
  -H 'Content-Type: application/json' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.rpc.search_read","payload":{"model":"res.company","domain":[],"fields":["id","name"],"limit":100,"offset":0,"order":"name asc"}}' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.finance.margin.period_summary","payload":{"company_id":3,"date_from":"2025-07-01","date_to":"2026-04-01"}}' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.finance.margin.period_summary","payload":{"company_id":4,"date_from":"2025-07-01","date_to":"2026-04-01"}}' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.finance.margin.period_summary","payload":{"company_id":5,"date_from":"2025-07-01","date_to":"2026-04-01"}}' | jq

curl -sS -X POST http://127.0.0.1/api/tools/odoo_primary/execute \
  -H 'Content-Type: application/json' \
  -d '{"operation":"odoo.rpc.read_group","payload":{"model":"account.move.line","domain":[["parent_state","=","posted"],["date",">=","2025-07-01"],["date","<","2026-04-01"],["company_id","=",3],["journal_id","in",[58,59,60,72,89,91]],["account_id","=",427]],"fields":["credit:sum","debit:sum","balance:sum"],"groupby":["date:month"],"orderby":"date:month asc","lazy":false}}' | jq
```

## Acceptance Criteria
- Live Odoo connectivity confirmed against production ERP.
- Three operating businesses identified from `res.company`.
- Real FYTD revenue, COGS, GP, and GP% captured for each operating business.
- Shopify helper defect evidenced with live ledger proof.
- A board-safe data source-of-truth artefact is stored in `artefacts/`.
