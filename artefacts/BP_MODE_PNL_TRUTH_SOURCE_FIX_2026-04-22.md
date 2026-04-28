# BP Mode P&L Truth Source Fix (2026-04-22)

## Objective

Ensure BP-mode and finance planner paths use Odoo Profit & Loss-backed evidence whenever the request includes P&L metrics (especially Net Profit), instead of relying on margin-only helpers that cannot provide complete P&L totals.

## Problem

- Existing BP scorecard planning routed to `odoo.finance.margin.monthly_comparison`.
- That operation provides Revenue/COGS/GP and GP%, but not full P&L totals.
- This created a mismatch risk against Odoo P&L values (for example Net Profit).

## Implementation

### 1) New governed Odoo operation

- Added new safe operation: `odoo.finance.pnl.period_summary`
- Implemented in connector to aggregate posted `account.move.line` data and classify into:
  - operating income
  - other income
  - cost of revenue
  - expenses
  - depreciation
  - total gross profit
  - total income
  - total expenses
  - net profit
- Includes cross-company output (`rows` + `companies`) for Burleigh vs Brisbane style branch comparisons.
- Includes ROAS as `operating_income / ad_spend` where ad spend is inferred from expense account names containing ad/marketing tokens.

### 2) Planner hardening

- Updated BP scorecard route in planner to use:
  - `odoo.finance.pnl.period_summary` (primary)
  - Shopify helper only as optional follow-up where strict Shopify-channel ROAS is requested.
- Added broader P&L intent detection so P&L/net-profit prompts route to the P&L operation instead of margin summaries.

### 3) Tool policy + runtime prompt updates

- Added `odoo.finance.pnl.period_summary` to consumer-chat allowed operation list.
- Updated tool evidence formatting and answer constraints to include explicit multi-company P&L output contracts.
- Included P&L operation in company-name resolution pass for canonical company scoping.

### 4) BP board UI extraction hardening

- Updated BP metric extraction to parse both `response.rows` and `response.companies`.
- Added fallback mappings for P&L keys:
  - revenue <- `operating_income`
  - cogs <- `cost_of_revenue`
  - gp <- `total_gross_profit`
  - net <- `net_profit`
  - roas <- `roas`

## Files Changed

- `backend/src/ghostdash_api/odoo_connector.py`
- `backend/src/ghostdash_api/tool_registry.py`
- `backend/src/ghostdash_api/workflows.py`
- `backend/src/ghostdash_api/agent_ingress.py`
- `ui/src/pages/chat/MessageList.tsx`
- `backend/tests/test_workflows_odoo_planning.py`

## Test Evidence

### Automated

- `pytest backend/tests/test_workflows_odoo_planning.py -k "bp_scorecard or pnl_prompt"` -> passed
- `pytest backend/tests/test_agent_ingress_prompt_hotfix.py -k "tool_evidence or monthly_comparison or normalize_business_abbreviations"` -> passed
- `npm --prefix ui run lint` (`tsc --noEmit`) -> passed

### Runtime Health

- Checked container logs:
  - `ghoststack-rag-agent-ingress-1`
  - `ghoststack-rag-control-api-1`
- Health traces are green; no new crash loop from this change.

## Human E2E Test Protocol (Required)

1. Launch BP mode in UI.
2. Ask:
   - "Please give me COGS/GP/REV/NET and ROAS for Burleigh and Brisbane for March, board-ready with tables and graphs."
3. Expand BP Running List and verify executed operation includes:
   - `odoo.finance.pnl.period_summary`
4. Confirm board output shows both branches and all metrics:
   - COGS, GP, Revenue, Net, ROAS
5. Cross-check March values against Odoo P&L report.
6. If ROAS differs from expected marketing convention, check whether Shopify-channel ROAS is needed and request follow-up with `odoo.finance.shopify.monthly_roi`.

## Acceptance Criteria

- BP-mode P&L requests execute `odoo.finance.pnl.period_summary`.
- Net Profit is sourced from P&L-derived totals, not margin-only output.
- Burleigh/Brisbane board pack table and graphs can render from tool event payload.
- Planner test coverage includes BP scorecard and explicit P&L routing.
- No lint/type/test regressions in touched areas.

## Verify Commands

- `pytest backend/tests/test_workflows_odoo_planning.py -k "bp_scorecard or pnl_prompt"`
- `pytest backend/tests/test_agent_ingress_prompt_hotfix.py -k "tool_evidence or monthly_comparison or normalize_business_abbreviations"`
- `npm --prefix ui run lint`
- `docker logs --tail=120 ghoststack-rag-agent-ingress-1`
- `docker logs --tail=120 ghoststack-rag-control-api-1`
