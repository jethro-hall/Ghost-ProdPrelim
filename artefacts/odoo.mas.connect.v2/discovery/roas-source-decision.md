# ROAS source decision

Date: 2026-04-23
Status: decided (interim production policy)

## Discovery findings

- Current helper `odoo.finance.pnl.period_summary` emits `ad_spend` and `roas`.
- Runtime classification notes confirm ad spend is inferred from expense account keyword matching.
- Live sample for Burleigh (last month) returned:
  - `ad_spend = 0.0`
  - `roas = null`
- No confirmed external marketing spend extractor is currently wired in the running stack.

## Decision

ROAS is **partially supportable only as a caveated metric** in current state:

- Supported mode: read from helper output when non-null and clearly sourced
- Not supported mode: if spend is missing/zero/heuristic-only, return `roas_status=unavailable` with explicit caveat

## Production behavior to enforce

1. Do not fabricate ROAS.
2. Do not backfill ad spend from LLM reasoning.
3. Return deterministic caveat when dependency is missing:
   - `missing_dependency: ad_spend`
   - `roas_status: unavailable`
4. Mark confidence medium/low unless spend source is explicitly confirmed by registry to be deterministic for the requested scope.

## Required follow-up

- Bind `marketing_spend_by_business_unit` to a confirmed source before promoting ROAS to high-confidence.
