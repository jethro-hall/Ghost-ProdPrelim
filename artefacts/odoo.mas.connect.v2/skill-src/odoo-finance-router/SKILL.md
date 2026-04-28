---
name: odoo-finance-router
description: route finance and accounting questions onto configured odoo accounting reports, business-unit mappings, and external metric dependencies. use when chatgpt needs to turn business-language requests into deterministic source plans, metric packs, or board-ready finance outputs for odoo-based reporting workflows.
---

# Odoo Finance Router

## Overview

Use this skill to convert natural-language finance requests into a deterministic routing and assembly workflow for Odoo accounting. Favor configured mappings, exact business-unit values, and existing Odoo reports over free-form query generation.

## Workflow

1. Parse the request into:
   - metrics
   - dimensions
   - period
   - presentation mode
   - ambiguities
2. Consult `references/metric-registry.json`, `references/dimension-registry.json`, and `references/source-registry.json`.
3. Build a source plan that prefers existing Odoo accounting reports and only adds external sources when a metric requires them.
4. Normalize source outputs into a compact metric pack.
5. Reason over the metric pack.
6. Compose the requested output format.

## Rules

- Never write custom SQL for standard accounting-report questions.
- Never guess business-unit mappings.
- Never use screenshots or OCR when structured Odoo report data is available.
- Never answer a metric that has missing dependencies without a caveat.
- Treat ROAS as unavailable unless ad spend is available and attributable for the requested scope.
- Treat NET as ambiguous unless a business definition is configured.

## Required references

- `references/metric-registry.json`
- `references/dimension-registry.json`
- `references/source-registry.json`
- `references/agent-contracts.md`

## Output expectations

Prefer these internal artifacts:
- `IntentPayload`
- `SourcePlan`
- `NormalizedReport`
- `MetricPack`

When the user asks for a final answer:
- produce board-ready output only after the metric pack is complete
- do not add new calculations during composition
