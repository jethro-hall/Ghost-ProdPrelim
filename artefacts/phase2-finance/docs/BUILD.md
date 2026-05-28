# Phase 2 Build Document — Finance Intelligence Layer

**Version:** 1.0  
**Date:** 2026-04-24  
**Status:** Ready for Cursor implementation  
**Scope:** Build on Phase 1. Do not alter Phase 1 classification, policy, centralized marketing, dynamic period handling, or fail-closed behavior except through approved extension points.

## Objective

Phase 2 turns the now-correct finance data path into an intelligence layer.

It must answer questions such as:
- Which entity is performing best and why?
- Why is COGS out?
- Is marketing efficiency improving or deteriorating?
- Are we leaking GP through product mix, freight, workshop cost, warranty, or discounting?
- What does the next quarter look like if the current trend continues?
- What should go into a board-ready summary?

## Non-negotiable rules

1. All financial math is deterministic code.
2. The LLM never computes financial truth.
3. The LLM never reads raw ledger dumps as primary context.
4. No finance answer is composed without a valid evidence pack.
5. No keyword-ledger matching returns.
6. No free narrative fallback for Odoo/finance intents.
7. Phase 1 tests must continue passing.

## Target flow

```text
request
  -> intent router
  -> metric planner
  -> metric resolver
  -> comparison engine
  -> anomaly engine
  -> forecast engine
  -> evidence pack builder
  -> finance reasoner
  -> board composer
```

## Backend module layout

```text
backend/src/ghostdash_api/odoo_mas/
  metrics/
    definitions.py
    formulas.py
    resolver.py
  intelligence/
    comparison_engine.py
    anomaly_engine.py
    forecast_engine.py
    evidence_pack_builder.py
  composers/
    board_pack_composer.py
  config/
    metric_definitions.json
    anomaly_rules.json
    forecast_rules.json
    board_output_templates.json
  schemas/
    variance_pack.schema.json
    anomaly_pack.schema.json
    forecast_pack.schema.json
    board_pack.schema.json
```

## Required metrics

| Metric | Rule |
|---|---|
| revenue | from Odoo/P&L revenue classes; output positive |
| cogs | from Odoo/P&L COGS classes; output positive |
| gross_profit | revenue - cogs |
| gross_margin_pct | gross_profit / revenue |
| marketing_cost | Phase 1 semantic marketing metric |
| contribution_margin | gross_profit - marketing_cost |
| contribution_margin_pct | contribution_margin / revenue |
| roas | revenue / marketing_cost |
| net_profit | blocked until approved definition |

## Central marketing ROAS

Retail carries central marketing. For branch efficiency:

```text
ROAS(entity, period) = revenue(entity, period) / marketing_cost(Ride Electric Retail, period)
```

This is a management efficiency metric, not pure attribution.

## Comparison engine

Support:
- entity vs entity
- month vs prior month
- requested period vs trailing average
- same month prior year if available

Output: `VariancePack`.

## Anomaly engine

Start rules-based, no ML.

Default anomaly rules:
- revenue MoM drop > 20%
- COGS MoM spike > 20%
- gross margin drop > 5 percentage points
- marketing spend spike > 25%
- ROAS drop > 20%
- workshop cost spike > 20%
- freight spike > 20%
- warranty spike > 20%

Output: `AnomalyPack`.

## Forecast engine

Start simple and deterministic.

Methods:
- trailing_average_3m
- trailing_average_6m
- linear_trend
- flat_last_actual
- manual_assumption_override

Default:
- use trailing 3-month average for short-term base case
- use linear trend only if at least 6 valid periods exist
- never forecast from fewer than 3 valid periods unless explicitly allowed

Output: `ForecastPack`.

## Board composer

Required sections:
1. Executive summary
2. KPI table
3. Performance drivers
4. Anomalies
5. Forecast
6. Risks
7. Recommended actions
8. Caveats

The composer cannot invent numbers or do new math.

## Acceptance criteria

Phase 2 is complete when:
1. Core metrics compute deterministically.
2. Entity comparison works for Retail, Burleigh, and Brisbane.
3. Central marketing ROAS works.
4. Anomaly engine flags major changes.
5. Forecast engine produces deterministic forecasts.
6. Board composer produces executive-ready output.
7. No LLM output occurs without evidence packs.
8. Phase 1 regression suite remains green.
