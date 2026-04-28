# Odoo Planning Typo Tolerance Hardening (2026-04-18)

## Problem

Operator prompts that clearly requested Odoo-backed finance analysis were not always producing an Odoo tool execution plan.

Observed pattern:
- Prompt contained typo-heavy wording such as `lasst monthss`, `maraketing`, and `saless`.
- Query planning stayed in semantic retrieval mode.
- Answer generation emitted a "No Odoo result returned" style warning because no Odoo tool event existed in the turn.

## Root Cause

`_plan_odoo_tool_usage` and period extraction logic in `backend/src/ghostdash_api/workflows.py` depended on exact keyword matches:
- `last month`
- `marketing`
- `financial` and strict finance tokens

Typos prevented:
1. period detection (`has_period == False`)
2. Shopify/marketing ROI intent detection
3. finance-actual intent detection

With those misses, the tool plan often stayed `mode=none`.

## Implemented Fix

### 1) Added planner text normalization

Introduced `_normalize_planning_text(message)`:
- casefold input
- collapse repeated letters (`lasst` -> `last`, `monthss` -> `months`, `saless` -> `sales`)
- normalize common misspellings:
  - `maraketing` / `marketting` -> `marketing`
  - `shopfy` -> `shopify`
  - `finacial` / `finanical` -> `financial`
  - `financials` -> `financial`

### 2) Applied normalization at decision points

Used normalized text in:
- `_extract_period_scope(...)`
- `_extract_month_span(...)`
- `_plan_odoo_tool_usage(...)`

### 3) Broadened finance intent token

Added `financial` to `finance_actual_terms` in `_plan_odoo_tool_usage`.

## Regression Coverage

Added test in `backend/tests/test_workflows_odoo_planning.py`:
- `test_plan_odoo_tool_usage_handles_typos_for_last_month_shopify_marketing_request`

Assertions verify:
- `operation == "odoo.finance.shopify.monthly_roi"`
- `relative_period == "last_month"`
- `company_name_terms == ["retail", "burleigh", "brisbane"]`
- `mode == "required"`

## Verification

Executed:
- `pytest backend/tests/test_workflows_odoo_planning.py -q`

Result:
- `10 passed`

## Operator Impact

For typo-heavy finance prompts, the planner now reliably generates a governed Odoo operation plan instead of falling back to KB-only semantic context.

