# Metric availability matrix

Date: 2026-04-23
Status: complete
Scope: live stack behavior through `odoo_primary` operations

## Matrix

| Metric | Status | Source operation/key | Formula (if derived) | Notes |
|---|---|---|---|---|
| revenue | explicit | `odoo.finance.pnl.period_summary` -> `revenue` | n/a | returned as posted-ledger-normalized value |
| cogs | explicit | `odoo.finance.pnl.period_summary` -> `cogs` | n/a | returned as posted-ledger-normalized value |
| gross_profit | explicit | `odoo.finance.pnl.period_summary` -> `gp` | `revenue - cogs` (cross-check) | helper already returns `gp`; formula still deterministic fallback |
| gross_margin_pct | derived | period summary rows | `gross_profit / revenue` | not emitted directly in PnL helper payload |
| net_profit | explicit (semantic pending) | `odoo.finance.pnl.period_summary` -> `net_profit` | n/a | output exists but business meaning for user term `NET` still requires approval |
| cash_balance | explicit | `odoo.finance.cash.runway_summary` -> `cash_position` | n/a | runway helper exposes cash position from asset cash lines |
| ar_balance | explicit | `odoo.finance.receivables.open` -> `total_residual` | n/a | currently reflects returned row set (limit-sensitive) |
| ap_balance | explicit | `odoo.finance.payables.open` -> `total_residual` | n/a | currently reflects returned row set (limit-sensitive) |
| tax_payable | unavailable (current helper set) | none dedicated | n/a | requires dedicated tax report extraction path |
| ad_spend | explicit but heuristic | `odoo.finance.pnl.period_summary` -> `ad_spend` | n/a | inferred by keyword matching on expense accounts |
| roas | explicit but low confidence | `odoo.finance.pnl.period_summary` -> `roas` | `revenue / ad_spend` | often null when inferred spend is zero; external spend source not yet bound |

## Summary

- Core accounting metrics are currently available from named finance helpers.
- `tax_payable` is not currently exposed as a dedicated deterministic helper metric.
- `NET` output exists technically but should remain blocked for end-user semantic interpretation until definition approval.
- ROAS must remain caveated because spend attribution is currently heuristic and no confirmed external spend source is wired.
