# Cursor Implementation Brief

Implement the permanent fix for semantic drift in the finance MAS.

## Primary objective
Eliminate ledger-search-as-answer behavior for finance metric requests.

## Required outcomes
1. semantic metrics always resolve through configured registries
2. account classification is deterministic and config-backed
3. ledger rows are supporting evidence only
4. planner blocks ledger search as primary path for metric requests
5. finance requests fail closed if semantic resolution is unavailable

## Code areas to add or modify
- backend/src/ghostdash_api/odoo_mas/config/account_classification.json
- backend/src/ghostdash_api/odoo_mas/config/metric_request_rules.json
- backend/src/ghostdash_api/odoo_mas/registry_loader.py
- backend/src/ghostdash_api/odoo_mas/planner.py
- backend/src/ghostdash_api/odoo_mas/assembler.py
- backend/src/ghostdash_api/odoo_mas/normalizers.py
- backend/src/ghostdash_api/odoo_mas/responders.py
- backend/src/ghostdash_api/odoo_mas/tests/*

## Hard rules
- do not use `matches_query_terms` for any finance classification or total
- do not return finance narrative when MAS did not produce a valid metric pack
- do not let `/agent/chat` bypass MAS for finance/Odoo/accounting/planning requests
- do not classify based on account-name keyword search in runtime logic

## Required new internal outputs
- ClassifiedLedgerRow
- MetricPack
- LedgerEvidencePack
- FinanceResponse

## Definition of done
- all new tests pass
- marketing cost request returns metric total and classified breakdown
- cogs comparison request returns entity totals and optional supporting rows
- ledger evidence path only appears after metric pack exists
- finance bypass path is blocked
