# Agent Routing + Formatting Inconsistency Plan (2026-04-17)

## Problem statement

Operator observed 3 similar prompts with inconsistent outcomes:

1. One response returned the expected board-report style format.
2. One response did not render a PDF and pivoted into a different analytical path.
3. One response explicitly claimed Apryse agent/tool routing was unavailable.

Goal: prove why behavior diverged, then fix deterministic routing/format behavior.

## Required evidence captured

- `git status -sb` at `/var/llamaindex` failed (`not a git repository`), so repo root is `/var/llamaindex/ghoststack-rag`.
- `docker ps` confirms live stack uses names like:
  - `ghoststack-rag-agent-ingress-1`
  - `ghoststack-rag-control-api-1`
  - `ghoststack-rag-docx-templater-1`
- Runtime diagnostics should target active containers `ghoststack-rag-caddy-1` and `ghoststack-rag-control-api-1` in this environment.
- `agent-ingress` logs show repeated:
  - `UnprocessableEntityError ... guardrail: input exceeds max length`
  - `chat_stream.length_retry` then `chat_stream.length_fallback`
- `control-api` logs show healthy API endpoints and runtime/tool-policy reads returning 200.

## Confirmed code-path facts

### 1) Apryse is not activated by plain text intent alone

In `backend/src/ghostdash_api/schemas.py`, `ChatRequest.docx_mode` defaults to:

- `enabled: false`
- `operation: preview`

This means saying "use Apryse agent" in natural language does not automatically set doc mode on the request payload.

### 2) Apryse doc workflow is conditional

In `backend/src/ghostdash_api/agent_ingress.py`, Apryse tool events are appended only when `body.docx_mode.enabled` is true.

### 3) Default tool policy can leave external tools disabled

In `backend/src/ghostdash_api/runtime_profiles.py`, default tool policy starts with:

- `kb`: enabled
- `web`: disabled
- `odoo_primary`: disabled by default unless profile/overrides enable it

Runtime + session conditions decide whether `odoo_primary` is "ready" at execution time.

### 4) Length guardrail fallback can change response quality/shape

`agent-ingress` has explicit fallback builders (blank/timeout/length/context). When provider guardrails reject long prompts, fallback messaging is generated and deterministic formatting quality can degrade.

## Root-cause hypothesis (ranked)

1. **Primary:** prompt/context size intermittently exceeded upstream guardrails, triggering retry/fallback paths and reducing output consistency.
2. **Secondary:** "use Apryse Docs Specialist" phrasing was interpreted as instruction text, but request payload likely did not set `docx_mode.enabled=true`; therefore no true Apryse render workflow was executed.
3. **Tertiary:** runtime/tool readiness messaging in-model can drift if tool readiness context is present but request asks for unavailable operation (for example PDF rendering without doc mode or unavailable export path).

## Fix plan (diagnose before prescribe, then stabilize)

### Phase 1 - Instrument and reproduce (no behavior change)

1. Add trace-level logging of:
  - whether `docx_mode.enabled` was true per request,
  - selected tool plan mode,
  - fallback class used (none/blank/timeout/length/context),
  - prompt char/tokens before provider call.
2. Replay the same 3 prompts in a controlled sequence against one conversation and one fresh conversation.
3. Compare per-turn trace IDs to verify divergence point (planning vs generation vs fallback).

### Phase 2 - Routing determinism hardening

1. Add intent-to-docx guardrail:
  - if user intent includes `pdf`, `render`, `docx`, `template`, or `Apryse`, require explicit `docx_mode.enabled` confirmation or auto-enable via safe rule.
2. Add operator-visible response banner:
  - "Doc mode active: yes/no" and "tool executed: apryse_docs/odoo_primary/none".
3. Reject impossible claims:
  - if no Apryse tool event exists, response must not claim Apryse execution.

### Phase 3 - Length/fallback mitigation

1. Reduce prompt bloat for board-report turns:
  - tighter retrieval cap when user asks for formatting/export.
2. Introduce two-step generation mode:
  - Step A: compact structured payload,
  - Step B: formatted board report/render.
3. Add hard stop before fallback prose:
  - when length guardrail fires, return concise actionable error + prompt rewrite suggestion, not topic drift.

### Phase 4 - Human QA loop (required)

For each fix, execute human-style end-to-end chat tests:

- same three prompts, same order,
- verify agent/tool traces in UI,
- verify output formatting stability,
- verify PDF/export pathway only claims success when artifact is actually produced.

## Acceptance criteria

1. Same 3-prompt sequence produces deterministic tool-routing outcomes across 3 repeated runs.
2. Requests that mention Apryse/PDF explicitly either:
  - execute with `docx_mode.enabled=true` and emit Apryse tool events, or
  - return a clear blocking prompt asking for missing doc parameters.
3. No response states Apryse routing/execution without corresponding tool event evidence.
4. Length guardrail triggers produce concise diagnostic output and do not silently pivot topic/tool.
5. Human QA confirms stable UX (format, citations, and claims aligned with executed tool events).

## Exact verify commands

Run from repo root:

```bash
cd /var/llamaindex/ghoststack-rag
```

Environment and service truth:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=200 ghoststack-rag-agent-ingress-1
docker logs --tail=200 ghoststack-rag-control-api-1
```

Code sanity (if backend edits are introduced during implementation):

```bash
python -m compileall -q /var/llamaindex/ghoststack-rag/backend/src/ghostdash_api
cd /var/llamaindex/ghoststack-rag/backend && pytest backend/tests/test_agent_ingress_prompt_hotfix.py -q
```

Manual human validation loop:

1. Send the same 3 prompts in UI.
2. Confirm tool events and doc mode in chat diagnostics.
3. Export/render attempt must only claim success when artifact link/file exists.

