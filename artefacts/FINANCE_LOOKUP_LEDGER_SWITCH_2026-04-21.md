# Finance Lookup Ledger Switch

Date: 2026-04-21

## Why this change exists

The prior finance period helpers used two different lookup bases:

- Revenue: `account.move` invoice headers with `amount_untaxed_signed`
- COGS: `account.move.line` with `account_id.account_type = expense_direct_cost`

That split made the app drift away from Odoo P&L logic because the P&L is fundamentally a ledger/account-classification view, not an invoice-header-only view.

## Decision

Switch period finance truth to posted ledger lines first.

Current decision for this pass:

- `odoo.finance.revenue.period` now reads posted `account.move.line`
- default revenue scope is `account_type in ["income", "income_other"]`
- `odoo.finance.cogs.period` remains ledger-based and now exposes its account scope explicitly
- `odoo.finance.margin.period_summary` now reports `lookup_basis = posted_ledger_lines`

This is not the final tenant-perfect P&L clone yet. It is the safer intermediate step because it moves both revenue and COGS onto the same accounting surface and makes the chosen scope inspectable.

## Build detail

### Connector

File: `backend/src/ghostdash_api/odoo_connector.py`

Added:

- `DEFAULT_REVENUE_ACCOUNT_TYPES = ("income", "income_other")`
- `DEFAULT_COGS_ACCOUNT_TYPES = ("expense_direct_cost",)`
- `_finance_account_type_scope(...)`
- `_finance_period_ledger_summary(...)`

Changed:

- `odoo.finance.revenue.period`
  - was invoice-header based
  - now uses `account.move.line.read_group`
  - groups by `company_id` and `account_id`
  - returns normalized `amount` per account plus raw `balance`
- `odoo.finance.cogs.period`
  - now shares the same ledger-summary path
  - supports `cogs_account_types` in addition to `cogs_account_ids`
- `odoo.finance.margin.period_summary`
  - now exposes `lookup_basis`
  - now adds `accuracy_notes`

### Response transparency

The period finance responses now expose:

- `basis`
- `scope_mode`
- `account_ids_scope`
- `account_type_scope`
- grouped source `rows` by account

This makes the reconciliation task concrete: compare the counted account rows against the Burleigh P&L account lines instead of debating totals abstractly.

## Trade-offs

### What improved

- Revenue and COGS are now derived from the same ledger surface
- Finance responses are more explainable and auditable
- The next diagnosis step can map missing/misclassified accounts directly

### What remains imperfect

- Default COGS still assumes `expense_direct_cost`
- Some tenants may classify direct costs under plain `expense`
- Odoo P&L can still differ if report lines use custom account sets, sign inversions, or report formulas

## Next diagnosis gate

To fully reconcile Burleigh, compare:

1. Odoo P&L report lines for the requested period
2. `revenue_source.rows`
3. `cogs_source.rows`

Expected outcome:

- identify exactly which accounts are counted by the app
- identify which P&L lines/accounts are still missing or grouped differently

## Acceptance criteria

- Period finance revenue no longer comes from `account.move.amount_untaxed_signed`
- `odoo.finance.margin.period_summary` reports `lookup_basis = posted_ledger_lines`
- targeted tests cover ledger-based revenue and margin summary behavior
- response exposes account scope metadata needed for reconciliation

## Verify commands

Run from repo root:

```bash
pytest backend/tests/test_tools_api.py -k "period_margin_summary or posted_ledger_lines"
```

For runtime verification after rebuild:

```bash
docker compose up -d --build control-api agent-ingress workflow-runtime
```

Then verify the live app/service by asking for a period revenue or GP summary and confirming the finance response cites ledger-based scope metadata.

## Human test gate

Ask the operator to run the same Burleigh period question again and confirm:

- whether the headline number moved closer to the Odoo P&L
- whether the returned finance basis is understandable
- whether the listed account rows reveal any obvious missing accounts
