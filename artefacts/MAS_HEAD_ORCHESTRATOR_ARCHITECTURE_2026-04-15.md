# MAS Head Orchestrator Architecture

## Intent

Make GhostDASH feel simple to MAS at the top layer while remaining truthful and inspectable underneath.

The operator interacts with one visible head agent. The head agent decides one of three outcomes per turn:

1. answer directly
2. suggest or scaffold a new specialist
3. orchestrate worker agents and synthesize their output

## Core Rule

Do **not** expose raw chain-of-thought.

Expose:

- route decision
- rationale summary
- workflow run id
- worker step status
- tool events
- evidence summaries
- approval state

This is the only stable way to provide "thinking visibility" without turning the UI into fiction.

## Ownership Model

- `runtime_profiles` own model, tool, and guardrail settings
- `workflow_runs` and `workflow_step_runs` own orchestration state
- `agent_messages` own persisted turn-level output, tool events, and usage
- `document_frame` owns approved drafting state
- UI owns presentation only

## Head / Worker Shape

- Head agent:
  - default operator entrypoint
  - likely `mistral3-8b`
  - decides route and synthesizes final response
- Worker agent 1:
  - finance / Odoo / evidence heavy
  - likely stronger model
- Worker agent 2:
  - strategy / business narrative / recommendation heavy
  - likely stronger model

## Execution Rule

Backend owns orchestration.

The browser sends the operator turn once, then renders persisted route/run/step truth. The browser must never be responsible for coordinating worker execution.

## Transparency Rule

Every routed turn should be inspectable from one chat message and one workflow run:

- why this route was chosen
- what workers were called
- what tools actually ran
- what evidence came back
- what failed or was blocked
- what was promoted to document state

## Document Rule

Worker outputs can inform the document flow, but no fragment enters shared document state without explicit operator approval.

## Main Risk To Avoid

If implementation duplicates agent/runtime ownership or hides routing in prompts, GhostDASH will become harder to use, not easier.

The success condition is:

- simple at the top
- durable in the middle
- truthful at the bottom
