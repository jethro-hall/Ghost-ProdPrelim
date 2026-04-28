# Cursor Tasks: Stop Ledger Search Drift

## TASK-001 Add account classification registry
Acceptance:
- `account_classification.json` exists
- maps accounts or ranges to canonical semantic classes
- merchant fees and marketing wages are separate classes

## TASK-002 Add metric request rules
Acceptance:
- `metric_request_rules.json` exists
- requests containing finance concepts trigger metric-first planning

## TASK-003 Load new registries at runtime
Acceptance:
- `registry_loader.py` loads classification and metric rules
- invalid or missing registries fail closed

## TASK-004 Add planner gate blocking ledger-search primary path
Acceptance:
- planner routes marketing/cogs/revenue/gp/net/roas/workshop metrics to metric assembly
- planner cannot emit ledger-search-only primary plans for metric requests

## TASK-005 Add deterministic account classifier
Acceptance:
- extracted rows are mapped to semantic classes via config
- no keyword matching used for classification

## TASK-006 Add metric assembly gate
Acceptance:
- composer cannot run for metric requests without a valid MetricPack
- missing metric pack returns structured blocked response

## TASK-007 Add ledger evidence reducer
Acceptance:
- ledger rows are filtered to supporting classes only
- `matches_query_terms` removed from end-user output
- row dumps are not used as the main answer payload

## TASK-008 Force Finance/Odoo requests through MAS
Acceptance:
- finance/oing intents cannot bypass MAS
- `/agent/chat` narrative fallback blocked for finance requests

## TASK-009 Add regression tests
Acceptance:
- test_marketing_cost_metric_first
- test_marketing_cost_excludes_merchant_fees
- test_marketing_cost_excludes_marketing_wages
- test_cogs_by_entity_metric_first
- test_finance_bypass_blocked
- test_ledger_evidence_requires_metric_pack

## TASK-010 Add operator/debug visibility
Acceptance:
- response metadata shows metric path used
- response metadata shows classification version
- response metadata shows finance fallback blocked when applicable
