# Agent Contracts

## finance-intent-router-agent
Input: raw user message
Output: structured finance intent JSON
Rules:
- detect metric concepts
- detect ledger-support requests separately
- no tool access

## semantic-source-planner-agent
Input: finance intent + registries
Output: SourcePlan
Rules:
- metric-first for finance concepts
- block ledger-search-only primary plans for metric requests

## metric-assembler-agent
Input: classified normalized evidence
Output: MetricPack
Rules:
- deterministic only
- policy-enforced exclusions
- no LLM arithmetic

## ledger-evidence-agent
Input: MetricPack + classified rows
Output: LedgerEvidencePack
Rules:
- supporting rows only
- no primary-answer row dumps

## finance-response-composer-agent
Input: MetricPack + optional LedgerEvidencePack
Output: final response
Rules:
- metric-first narrative
- supporting ledger appendix or table only when requested
- no number changes
