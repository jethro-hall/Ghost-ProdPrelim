---
title: feat: Stop Ledger-Search Drift in Finance MAS
type: feat
status: active
date: 2026-04-24
source_package: artefacts/fix-ledger-search-package
---

# feat: Stop Ledger-Search Drift in Finance MAS

## Objective

Implement the package-defined permanent fix so finance metric requests always flow:

`semantic intent -> metric-first plan -> classified evidence -> MetricPack -> optional ledger support -> response`

and never:

`metric request -> ledger search -> row dump -> narrative`

## Canonical source documents

- `artefacts/fix-ledger-search-package/BUILD.md`
- `artefacts/fix-ledger-search-package/ARCHITECTURE_BRIEF.md`
- `artefacts/fix-ledger-search-package/TASKS.md`
- `artefacts/fix-ledger-search-package/CURSOR_IMPLEMENTATION_BRIEF.md`

## Non-negotiable rules

- Ledger search is never the primary answer path for semantic metric requests.
- `matches_query_terms` is never used for finance classification or totals.
- Composer cannot produce metric-facing responses without a valid `MetricPack`.
- Unknown metric mapping or account classification fails closed.
- Finance/Odoo/accounting planning intents cannot bypass MAS into free narrative.

## Real repo targets

- `backend/src/ghostdash_api/odoo_mas/config/account_classification.json` (new)
- `backend/src/ghostdash_api/odoo_mas/config/metric_request_rules.json` (new)
- `backend/src/ghostdash_api/odoo_mas/registry_loader.py`
- `backend/src/ghostdash_api/odoo_mas/planner.py`
- `backend/src/ghostdash_api/odoo_mas/assembler.py`
- `backend/src/ghostdash_api/odoo_mas/normalizers.py`
- `backend/src/ghostdash_api/odoo_mas/composer.py` (repo uses `composer.py`; maps package's `responders.py` role)
- `backend/tests/test_odoo_mas_pipeline.py`
- `backend/tests/test_control_api_odoo_mas.py`

## Delivery sequence (TASK-001 to TASK-010)

### Stage 1: Registries and loader hardening

Implements:
- TASK-001 add account classification registry
- TASK-002 add metric request rules
- TASK-003 load new registries at runtime with fail-closed behavior

Work:
- Add `account_classification.json` with canonical class mappings.
- Add `metric_request_rules.json` with metric-concept and planner-policy gates.
- Extend `registry_loader.py` to load and validate both registries.
- Return explicit blocked statuses on missing/invalid registries.

Approval gate:
- Human review registry content and fail-closed behavior before planner changes.

Verify commands:
- `python3.12 -m compileall backend/src/ghostdash_api/odoo_mas`
- `rg -n "account_classification|metric_request_rules|fail.*closed|blocked" backend/src/ghostdash_api/odoo_mas`

### Stage 2: Planner and classifier enforcement

Implements:
- TASK-004 planner gate blocks ledger-search primary path
- TASK-005 deterministic account classifier

Work:
- In `planner.py`, detect metric-concept intents from rules and force metric-first path.
- Block ledger-search-only plans for semantic metric requests.
- In `normalizers.py` (or classifier helper), map rows to canonical classes from config.
- Remove/disable keyword-driven classification as source of truth.

Approval gate:
- Human review two concrete traces: a marketing-cost request and a cogs request, confirming metric-first routing.

Verify commands:
- `rg -n "metric-first|ledger-search|primary_path|blocked" backend/src/ghostdash_api/odoo_mas/planner.py`
- `rg -n "classification|class|account_classification|matches_query_terms" backend/src/ghostdash_api/odoo_mas/normalizers.py backend/src/ghostdash_api/odoo_mas/assembler.py`

### Stage 3: Assembly and response gates

Implements:
- TASK-006 metric assembly gate
- TASK-007 ledger evidence reducer

Work:
- Require a valid `MetricPack` before composition in `assembler.py` and `composer.py`.
- Return structured blocked response when `MetricPack` is missing for metric requests.
- Filter ledger evidence to supporting included classes only.
- Ensure `matches_query_terms` is removed from user-facing output payloads.

Approval gate:
- Human review a metric request with and without ledger-support flag to confirm evidence is supporting-only.

Verify commands:
- `rg -n "MetricPack|blocked|ledger evidence|support" backend/src/ghostdash_api/odoo_mas/assembler.py backend/src/ghostdash_api/odoo_mas/composer.py`
- `rg -n "matches_query_terms" backend/src/ghostdash_api/odoo_mas`

### Stage 4: MAS-only enforcement and regression coverage

Implements:
- TASK-008 finance requests forced through MAS
- TASK-009 regression tests
- TASK-010 operator/debug visibility metadata

Work:
- In ingress/routing integration points, block finance intent bypass to free narrative.
- Add/extend tests to cover marketing, cogs, bypass blocking, and ledger-evidence gating.
- Emit response metadata for path used, classification version, and fallback blocking.

Approval gate:
- Human E2E validation in chat UI for one marketing-cost request and one bypass-attempt request.

Verify commands:
- `pytest -q backend/tests/test_odoo_mas_pipeline.py backend/tests/test_control_api_odoo_mas.py`
- `rg -n "finance.*bypass|fallback.*blocked|classification_version|metric_path" backend/src/ghostdash_api`

## Required acceptance checks from package

For:
"Using Odoo only, show marketing costs for Entity X in March 2026 and include ledger lines"

Must produce:
- `marketing_cost_total`
- classified breakdown
- merchant fees excluded by default
- marketing wages excluded by default
- supporting ledger rows only for included classes unless explicitly overridden
- no end-user `matches_query_terms`
- no all-`n/a` metric pack when classified data exists

## Human retest protocol

After each stage:
- run verify commands
- execute one operator-path check in UI
- record pass/fail and any follow-up fixes in `docs/finance-mas-import/`

After final stage:
- execute full operator scenario for marketing cost + ledger evidence request
- execute one negative scenario where semantic resolution is unavailable and confirm fail-closed behavior
