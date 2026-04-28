---
name: finance-semantic-guard
description: stop finance tasks from degrading into ledger search, keyword matching, or unsupported narrative fallback. use when chatgpt needs to route finance, accounting, budgeting, forecasting, workshop-margin, or business-plan requests through a metric-first semantic workflow with classified evidence, deterministic assembly, and fail-closed behavior.
---

# Finance Semantic Guard

## Overview

Use this skill when a finance-related request risks being answered from row dumps, keyword matches, raw ledger output, or unsupported narrative fallback. Enforce metric-first planning and treat ledger rows as supporting evidence only.

## Workflow

1. Parse the request into semantic finance intent.
2. Determine whether the request asks for a metric, a comparison, a trend, a forecast, an anomaly, or supporting ledger evidence.
3. For any semantic metric request, require a metric-first path.
4. Load the registries in `references/`.
5. Build or validate a source plan that resolves the request to semantic metrics.
6. Require a metric pack before allowing composition.
7. Include ledger evidence only as support, never as the primary answer path.

## Non-negotiable rules

- Never use keyword matching as the finance classifier of record.
- Never let `matches_query_terms` drive totals or semantic classification.
- Never answer a finance metric request from ledger search alone.
- Never allow finance/Odoo/accounting/planning requests to fall back to free narrative when governed evidence is unavailable.
- Always fail closed when the metric mapping or account classification is unsupported.
- Always explain policy exclusions if they affect totals.

## Registry use

Use these reference files:
- `references/account-classification.json`
- `references/metric-request-rules.json`
- `references/brief.md`

## Output discipline

For finance answers:
- metric total first
- classified breakdown second
- policy notes third
- supporting ledger rows only if requested

When blocked:
- say the request cannot be answered safely
- state whether the missing piece is metric mapping, account classification, or source-plan support
