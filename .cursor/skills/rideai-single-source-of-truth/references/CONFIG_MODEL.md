# Canonical Runtime Config Model

## Goal
- keep runtime behavior in one authoritative place
- avoid duplicated settings across agents, defaults, and UI state

## Recommended shape
- identity entities own identity and references
- runtime behavior lives in one canonical profile/policy record

That profile should own:
- llm config
- guardrails config
- KB / retrieval config
- tool policy config

## Constraints
- an agent should reference one canonical runtime profile
- a default is just a normal profile referenced by many agents
- summaries can appear elsewhere, but editing must stay in one place
