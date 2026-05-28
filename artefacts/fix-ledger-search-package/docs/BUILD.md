# Build Document: Stop Ledger-Search Drift in Finance MAS

Version: 1.0
Date: 2026-04-24
Status: Ready for Cursor implementation

## Executive Summary

The current MAS pipeline is governed, but it is still behaving like a ledger search engine instead of a finance engine. The visible symptom is that finance questions such as "show marketing costs" return flat ledger-row dumps with keyword matching (`matches_query_terms`) rather than a semantic metric, classification-backed breakdown, and supporting ledger evidence.

This document defines the architecture, agent logic, runtime guardrails, and implementation sequence required to stop that failure mode permanently.

## Problem Statement

The current path still allows this anti-pattern:

1. user asks for a metric or finance concept
2. planner falls back to ledger search or keyword matching
3. runtime returns rows that *sound related*
4. assembler does not resolve the requested metric from a semantic definition
5. user receives `n/a` metrics and a misleading ledger dump

This is a semantic failure, not a routing failure.

## Root Cause

### What is working
- MAS routing executes
- Odoo evidence retrieval executes
- policy exclusions for merchant fees / wages execute
- fail-closed behavior on missing NET / ROAS partially executes

### What is failing
- metric-first planning is not enforced
- account classification is not authoritative
- keyword matching is still influencing extraction and/or result shaping
- ledger search is being treated as a primary answer path
- semantic metric assembly is not required before response composition

## Architecture Error

The pipeline still contains a hidden branch like this:

`finance concept request -> ledger search -> row dump -> narrative`

That branch must be removed.

The correct branch is:

`finance concept request -> semantic metric plan -> classified evidence -> deterministic metric assembly -> optional ledger evidence -> response`

## Design Goal

For any finance request containing a semantic metric or business concept, the system must:
- resolve the request to a configured metric, not a string search
- require a semantic classification layer
- assemble totals and breakdowns before narrative generation
- only include ledger rows as supporting evidence
- fail closed when semantic resolution is unavailable

## Non-Negotiable Rules

1. Ledger search is never the primary path for metric requests.
2. `matches_query_terms` cannot drive classification or totals.
3. Every metric-facing answer must come from the metric assembly layer.
4. Ledger rows may only appear after a valid metric pack exists.
5. Unknown account classification fails closed.
6. Unknown metric mapping fails closed.
7. Finance/Odoo requests cannot fall back to free narrative.

## Canonical Solution

Add a semantic finance layer between extraction and response composition.

### Required components
- account classification registry
- metric definition registry
- metric-first planner rules
- metric assembly gate
- ledger evidence reducer
- MAS-only finance enforcement

## Target Runtime Flow

1. intent-router-agent extracts:
   - question type
   - requested metrics
   - dimensions
   - period
   - output mode
2. source-planner-agent determines whether this is:
   - metric request
   - ledger evidence request
   - anomaly request
   - forecast request
3. metric-gate checks:
   - if request implies a configured metric, planner must route to metric assembly
   - ledger-search fallback is blocked
4. extractors pull classified source evidence
5. normalizer maps raw rows to canonical account classes
6. metric-assembler resolves totals, breakdowns, and derived metrics
7. ledger-evidence-agent selects only supporting rows
8. composer responds with metric pack first, ledger proof second

## Account Classification Layer

This is the missing core.

The runtime must classify accounts by configured semantic role, for example:
- marketing_direct
- merchant_fees
- marketing_wages
- cogs
- revenue
- workshop_cost
- workshop_revenue
- freight
- warranty
- software_general
- software_marketing

This classification must be config-backed and versioned.

Keyword matching may exist only as a debugging aid, never as the classifier of record.

## Metric-First Planning Rules

The planner must treat the following as metric requests by default:
- revenue
- sales
- cogs
- gross profit
- gross margin
- net profit / net
- ad spend / marketing costs
- roas
- workshop revenue / cost / margin
- ar / ap / cash
- anomaly / variance / outlier requests

If a request contains any of the above, the planner must:
- request a metric plan
- request semantic evidence
- require assembly
- allow ledger lines only as optional support

## Example: Marketing Cost Request

### Bad output
- flat ledger rows
- `matches_query_terms`
- no total marketing spend
- no classified breakdown

### Required output
- total marketing cost for scope
- classified breakdown by marketing account class
- explicit note that merchant fees and marketing wages are excluded by default
- optional ledger rows for included classes only

## New Agent Set

### 1. `finance-intent-router-agent`
Purpose: detect semantic finance concepts and output strict structured intent.

### 2. `semantic-source-planner-agent`
Purpose: select metric-first source plans and block ledger-search primary path.

### 3. `account-classifier-agent` (deterministic runtime module, not LLM)
Purpose: map extracted accounts to canonical semantic classes via config.

### 4. `metric-assembler-agent`
Purpose: compute totals, breakdowns, derivations, policy-aware exclusions.

### 5. `ledger-evidence-agent`
Purpose: return supporting rows only after a valid metric pack exists.

### 6. `finance-response-composer-agent`
Purpose: render board/analyst/ledger-support outputs without changing numbers.

## Acceptance Criteria

A request like "Using Odoo only, show marketing costs for Entity X in March 2026 and include ledger lines" must:
- return `marketing_cost_total`
- return a classified breakdown
- exclude merchant fees by default
- exclude marketing wages by default
- include only supporting ledger rows from included classes unless explicitly requested otherwise
- never emit `matches_query_terms` in end-user output
- never return all primary metrics as `n/a` if classified source data exists

## Implementation Order

1. add account classification registry
2. add metric-first planner gate
3. block ledger-search primary path
4. add metric assembly gate before composer
5. add ledger evidence reducer
6. add MAS-only finance enforcement
7. add regression tests

## How to Prevent This Ever Happening Again

### Governance controls
- ban keyword matching as a finance classification mechanism
- ban metric answers without metric assembly provenance
- ban finance narrative fallback outside MAS
- require registry-backed metric and account definitions

### Test controls
Add regression tests for:
- marketing cost request
- cogs by entity request
- workshop margin request
- finance request with ledger lines requested
- finance request with unsupported metric

## Multi-Period Trend Hardening

### Problem
The planner was treating a request like `Using Odoo only, show marketing costs increase for Ride Electric Retail from Jan 2025 till April 2026` as a single-period lookup.

That caused three failures:
- router collapsed the prompt to `2025-01`
- planner emitted one OPEX request for the full range instead of a multi-period plan
- composer defaulted to marketing-total output shape instead of a monthly trend table

### Root cause
- date-range parsing did not recognize `till` after normalization
- trend cues such as `increase`, `from X to Y`, `between`, and `over time` did not promote the request into a dedicated multi-period intent
- marketing monthly aggregation existed only for profit and loss monthly helper data, not for month-sliced ledger-backed marketing totals
- ledger evidence suppression was not scoped to long-range trend output

### Implemented fix
1. Router now upgrades qualifying range/trend prompts to `multi_period_metric_trend`
2. Router forces `granularity = monthly` and `output = trend_table` for that intent
3. Planner expands marketing trend requests into month-by-month `opex_ledger_search` requests from start month through end month
4. Assembler derives monthly marketing totals and deterministic month-over-month deltas
5. Composer renders a `Month | Marketing Cost | Change vs Prior Month | % Change` table
6. Pipeline suppresses ledger-row dumps for multi-period trend responses by default

### Verified example
Prompt:
`Using Odoo only, show marketing costs increase for Ride Electric Retail from Jan 2025 till April 2026`

Expected verified behavior:
- 16 monthly rows from `2025-01` through `2026-04`
- no collapse to a single-period answer
- deterministic month-over-month delta fields
- no ledger dump in final response unless a specific drill-down month is requested

### Verification evidence
- `python3.12 -m pytest backend/tests/test_odoo_mas_trend_queries.py -q`
- `python3.12 -m pytest backend/tests/test_odoo_mas_pipeline.py -q`
- `python3.12 -m compileall backend/src`

### Review controls
All finance-path changes must prove:
- metric path used
- classification path used
- evidence pack generated
- fallback blocked

