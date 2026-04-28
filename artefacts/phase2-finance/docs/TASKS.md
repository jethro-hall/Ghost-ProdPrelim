# TASKS.md — Phase 2 Finance Intelligence Layer

## Phase 2.0 — Guardrails

### TASK-200 — Freeze Phase 1 behavior
Acceptance:
- Phase 1 tests still pass.
- Marketing classification tests still pass.
- Dynamic no-activity handling still passes.

### TASK-201 — Add metric definitions config
Create:
- `config/metric_definitions.json`

Acceptance:
- all metric formulas are config-backed or explicit in deterministic formula module.

## Phase 2.1 — Core Metrics

### TASK-210 — Implement formulas module
Create:
- `metrics/formulas.py`

Acceptance:
- revenue, cogs, gross_profit, gross_margin_pct, marketing_cost, contribution_margin, roas implemented.
- zero division handled.

### TASK-211 — Implement metric resolver
Create:
- `metrics/resolver.py`

Acceptance:
- resolves metrics from Phase 1 MetricPack and source evidence.

### TASK-212 — Add tests for formulas
Acceptance:
- all formulas tested with normal, zero, null, and sign-normalized inputs.

## Phase 2.2 — Cross-Entity Comparison

### TASK-220 — Implement comparison engine
Create:
- `intelligence/comparison_engine.py`

Acceptance:
- entity vs entity comparison works.
- month vs prior month comparison works.

### TASK-221 — Add VariancePack schema
Create:
- `schemas/variance_pack.schema.json`

## Phase 2.3 — Anomaly Detection

### TASK-230 — Implement anomaly rules config
Create:
- `config/anomaly_rules.json`

### TASK-231 — Implement anomaly engine
Create:
- `intelligence/anomaly_engine.py`

Acceptance:
- detects revenue drop, COGS spike, margin drop, marketing spike, ROAS drop.

### TASK-232 — Add anomaly tests
Acceptance:
- deterministic test cases pass.

## Phase 2.4 — Forecasting

### TASK-240 — Implement forecast rules config
Create:
- `config/forecast_rules.json`

### TASK-241 — Implement forecast engine
Create:
- `intelligence/forecast_engine.py`

Acceptance:
- trailing 3-month, trailing 6-month, flat-last-actual, linear trend implemented.
- insufficient history returns caveat.

### TASK-242 — Add ForecastPack schema
Create:
- `schemas/forecast_pack.schema.json`

## Phase 2.5 — Board Output

### TASK-250 — Implement board pack composer
Create:
- `composers/board_pack_composer.py`

Acceptance:
- outputs executive summary, KPI table, drivers, anomalies, forecast, risks, caveats.

### TASK-251 — Add board pack golden tests
Acceptance:
- stable board-ready output for known input.

## Phase 2.6 — Live Proof

### TASK-260 — March 2026 cross-entity comparison
Prompt:
`Compare revenue, COGS, gross profit, gross margin and marketing cost across Retail, Burleigh and Brisbane for March 2026.`

### TASK-261 — ROAS centralized marketing proof
Prompt:
`Show ROAS for Brisbane and Burleigh in March 2026 using centralized marketing.`

### TASK-262 — Anomaly proof
Prompt:
`Find anomalies in COGS and gross margin across the three entities for Jan to Mar 2026.`

### TASK-263 — Forecast proof
Prompt:
`Forecast revenue, COGS and GP for the next three months using trailing 3-month average.`
