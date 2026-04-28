# NET definition

Date: 2026-04-23
Status: blocked pending business approval

## Current technical observation

- `odoo.finance.pnl.period_summary` returns a field named `net_profit`.
- The helper output is technically available, but user-facing term `NET` is still ambiguous without approved business semantics.

## Approved policy for this implementation cycle

- `NET` remains fail-closed.
- Router/planner must treat `NET` as `requires_configuration` until one definition is approved.
- Composer must return an explicit caveat instead of choosing a silent interpretation.

## Candidate meanings (not approved)

- net profit before tax
- net profit after tax
- operating net
- net sales

## Required approval

Business owner must choose one canonical definition and it must be written into:

1. metric registry semantic entry
2. intent/router ambiguity handling
3. reasoning/composer wording

Until that approval lands, `NET` requests are blocked by design.
