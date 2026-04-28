# Cost Governance

## Goal

Reduce LLM token waste and stop expensive models being used for deterministic work.

## Runtime model routing

Use routing by task:

```text
Greeting and simple retail: deterministic handler or small model.
Intent classification: deterministic code first, small model only if needed.
Tool routing: deterministic code where possible.
Normal Magic Mike response: efficient model with low reasoning.
Warranty or legal uncertainty: stronger model with approved sources.
Formatting: deterministic code, not flagship model.
```

## Hard rules

```text
No flagship model for greetings.
No model call for deterministic policy checks.
No high reasoning for customer-service filler.
No raw full conversation history if compact state is enough.
No retrieval for greetings.
No tool planner for greetings.
```

## Production cache safety

Any production response cache must separate:

```text
agent identity
agent category
runtime profile version
guardrail version
retrieval profile version
tool policy version
route mode
model id
user query hash
```

If a cache cannot prove those fields, disable it for Magic Mike.

## Token telemetry

Capture:

```text
input tokens
cached input tokens
output tokens
model id
route reason
cache hit or miss
estimated cost
```

## Context size guard

Add preflight token estimation.

Required behaviour:

```text
If prompt/context exceeds configured threshold, warn in admin trace and compact context before calling an expensive model.
```

## Cursor build usage

Use expensive/high-reasoning Cursor model only for architecture review and final review.

Use cheaper fast model for mechanical edits, tests, and CSS.

Do not load the entire repo into context unless doing a targeted audit.
