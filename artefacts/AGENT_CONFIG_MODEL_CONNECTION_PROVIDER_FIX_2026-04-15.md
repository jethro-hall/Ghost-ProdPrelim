# Agent Config Model Connection Provider Fix

## Problem

GhostDASH operators reported they could not reliably:

- create new agents
- edit an agent's model and connection together
- trust the provider section when testing a connection

## Root Causes

### 1. New-agent draft looked broken

`New` created a draft with required fields blank:

- `first_message`
- `system_prompt`
- `insufficient_context_behavior`

That immediately disabled `Save`, which made the create flow feel dead.

### 2. Model editing was hidden in the wrong place

The model field only existed inside the identity edit card, while the connection lived in the right-hand `Connection` section.

Operator consequence:

- changing provider connection and model required jumping between separate UI zones
- the relationship between model and connection was unclear

### 3. Provider testing was using the wrong model source

The provider panel test path could fall back to the default runtime profile model instead of an explicit test model.

Observed live symptom:

- `gemini-3.1-pro-preview` was being used during provider test calls
- control API logs showed upstream `404` / model-not-found failures

## Fix Applied

### Agent Config

- Moved practical model editing into the `Connection` section beside the provider connection selector.
- Reduced the identity card edit mode to agent naming only.
- Added a provider/model mismatch warning when the selected connection and model appear incompatible.
- Changed new-agent draft creation to start from a valid runtime baseline instead of blank required fields.

### Provider Section

- Added an explicit `Test model id` field for provider testing.
- Clarified that connections store credentials/base URL only, while model selection belongs to the runtime profile.
- Improved surfaced API error messaging.

### Backend Contract

- Stopped `/api/connections/test` from silently injecting the default runtime profile model when no explicit model was supplied.

## Human-Style QA Findings

### Live deployed UI observations before fix

- `Agent Config` initially exposed an invalid-feeling create state.
- `New` produced a draft where save was disabled until several hidden-required decisions were manually repaired.
- Provider testing was failing in control API logs because the test path used a stale invalid Gemini model.

### Workspace verification after fix

- UI typecheck passed.
- UI production build passed.
- The create/edit/provider code path now has a single visible place to edit model + connection together.

## Remaining Verification Gap

The live browser tab available during this task was the currently deployed app, not this workspace's freshly built result, so post-fix browser validation against the edited workspace could not be completed from that remote tab alone.

## Acceptance Criteria

- New agent draft opens in a save-ready state.
- Agent model is editable in the same section as provider connection.
- Provider section tests use an explicit model id instead of a hidden runtime default.
- Operator sees a warning when model and selected provider connection look mismatched.

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag && git status -sb
```

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

```bash
docker logs --tail=120 ghoststack-rag-control-api-1
```

```bash
docker logs --tail=120 ghoststack-rag-agent-ingress-1
```

```bash
cd /var/llamaindex/ghoststack-rag && docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"
```
