# Phase 2 Agents and Components

## metric-resolver-agent
Deterministic component. Builds MetricPack rows.

## comparison-agent
Deterministic component. Builds VariancePack.

## anomaly-agent
Deterministic component. Builds AnomalyPack from rules.

## forecast-agent
Deterministic component. Builds ForecastPack.

## finance-reasoner-agent
LLM component. Explains validated evidence packs only.

## board-composer-agent
LLM or template component. Formats executive-ready output only.

## guardrail-agent
Ensures no finance answer is composed without required evidence packs.
