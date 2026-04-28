# FY year parsed as company_id bugfix (2026-04-17)

## Issue

Shopify ROI planning sometimes produced empty results because year tokens (for example `2024`, `2026`) were parsed as `company_ids` when the planner interpreted loose company list text.

## Root cause

`_extract_company_ids()` in `backend/src/ghostdash_api/workflows.py` used list parsing that accepted any nearby digits after "company/companies". In finance prompts, this could absorb fiscal-year values.

## Change

- Updated list parsing guard in `_extract_company_ids()`:
  - keep explicit `company_id` captures unchanged,
  - ignore year-like values (`1900..2100`) when they only come from loose list parsing.

## Regression coverage

Added test in `backend/tests/test_workflows_odoo_planning.py`:

- `test_plan_odoo_tool_usage_does_not_treat_fiscal_years_as_company_ids`
  - verifies a FY25/FY26 Shopify question keeps date scope,
  - ensures no `company_id` / `company_ids` are injected from fiscal-year tokens.

## Validation

```bash
cd /var/llamaindex/ghoststack-rag/backend
pytest tests/test_workflows_odoo_planning.py -q
```

Result: `9 passed`.
