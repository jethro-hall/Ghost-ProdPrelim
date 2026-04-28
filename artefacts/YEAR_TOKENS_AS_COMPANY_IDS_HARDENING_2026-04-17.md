# Year tokens as company IDs hardening (2026-04-17)

## Symptom

Some board/ROI prompts produced:

- `company_ids: [2024, 2026]`
- `line_count: 0`
- misleading downstream explanation that no company data existed

## Why this happened

Two conditions could combine:

1. Planner-level parsing could infer numbers near company-list language.
2. Ingress trusted prefilled `company_ids` and skipped named-company resolution when IDs already existed.

If those IDs were fiscal-year values from date scope, Odoo execution returned empty records.

## Hardening implemented

File: `backend/src/ghostdash_api/agent_ingress.py`

- Added `_extract_year_from_iso_date()` helper.
- In `_resolve_company_terms_for_payload()`:
  - detect suspicious `company_ids` when all IDs match request years from `date_from`/`date_to`,
  - remove those IDs before resolution,
  - force canonical name resolution via `odoo.rpc.search_read` using `company_name_terms`.

This ensures `company_name_terms` can recover from year-like ID pollution instead of blindly executing with invalid IDs.

## Regression test

File: `backend/tests/test_agent_ingress_prompt_hotfix.py`

- Added `test_prepare_tool_evidence_replaces_year_like_company_ids_with_named_company_resolution`.
- Test feeds:
  - `date_from=2024-07-01`, `date_to=2026-07-01`
  - `company_ids=[2024, 2026]`
  - `company_name_terms=["retail"]`
- Verifies execution payload is corrected to resolved IDs (`company_ids=[3]`, `company_id=3`) before Shopify ROI helper runs.

## Verification

```bash
cd /var/llamaindex/ghoststack-rag/backend
pytest tests/test_agent_ingress_prompt_hotfix.py -q
```

Result: `14 passed`.
