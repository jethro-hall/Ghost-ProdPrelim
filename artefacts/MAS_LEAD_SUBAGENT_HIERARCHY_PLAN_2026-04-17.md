# MAS Lead + Sub-Agent Hierarchy Plan (2026-04-17)

## Objective

Introduce a clearer MAS agent structure in Agent Config:

- lead agents are top-level
- sub-agents are attached under a lead agent
- sub-agents are visually indented and grouped
- sub-agent names are human-friendly but must always be prefixed with `[SA] `

This improves operator understanding of "what is a lead agent" vs "what is a worker/sub-agent".

## Problem Statement

Current agent management is flat. MAS orchestration exists in workflow runs, but the UI does not show parent/child ownership at agent-config level, so "worker selection" looks ambiguous.

## Non-Negotiable Rules

1. A sub-agent must belong to exactly one lead agent.
2. A lead agent can have zero or many sub-agents.
3. Sub-agent display and stored `name` must start with `[SA] `.
4. Lead agents cannot be prefixed with `[SA] `.
5. Do not infer hierarchy from name alone; persist explicit relationship in DB.

## Data Model Plan (Backend)

### 1) `agent_profiles` hierarchy fields

Add fields:

- `agent_role` (enum/string): `lead` or `sub`
- `parent_agent_id` (nullable string FK-like reference to `agent_profiles.id`)
- `position` (int, default 0) for ordered display under a lead

Validation constraints in service layer:

- `sub` must have `parent_agent_id`
- `lead` must have `parent_agent_id = null`
- prevent parent cycles
- prevent parent pointing to a sub-agent if you want strict 2-level model

### 2) migration / backfill

Backfill all existing agents:

- `agent_role = lead`
- `parent_agent_id = null`
- `position = 0`

No destructive change. Fully backward compatible.

## API Contract Plan

### Read APIs

Extend agent view payload to include:

- `agent_role`
- `parent_agent_id`
- `position`
- optional `sub_agents` (nested) for dedicated hierarchy endpoint

New endpoint (recommended):

- `GET /api/agents/hierarchy`
  - returns lead agents with nested ordered sub-agents
  - keeps existing `GET /api/agents` flat for compatibility

### Write APIs

Extend save payload:

- `agent_role`
- `parent_agent_id`
- `position`

Add dedicated sub-agent creation helper endpoint (optional but cleaner):

- `POST /api/agents/{lead_agent_id}/sub-agents`
  - server auto-enforces `agent_role=sub`
  - server auto-normalizes name prefix to `[SA] `

## Validation + Guardrails

### Name normalization

On create/update for sub-agents:

- trim input
- if missing `[SA] ` prefix, prepend it
- collapse accidental double prefixes (`[SA] [SA] Name` -> `[SA] Name`)

On lead-agent rename:

- reject names that start with `[SA] `

### Delete/move semantics

When deleting lead agent:

- if sub-agents exist, block delete with reason `lead_has_sub_agents`
- require explicit reassignment or cascade option (recommend block by default)

When moving sub-agent between leads:

- update `parent_agent_id` + reorder `position`
- preserve runtime profile/tool settings

## UI Plan (Agent Config)

### Left panel structure

Replace flat selector with hierarchy panel:

- `Lead Agents` section
  - lead row
  - nested `Sub-Agents` block under each lead (indented)
  - each sub-agent row displayed as `[SA] Name`

### Interaction model

- selecting lead opens lead config
- selecting sub-agent opens sub-agent config
- "Add Sub-Agent" button appears on selected lead
- sub-agent form should lock/disable parent changes unless user intentionally uses "Move to Lead"

### Visual rules

- sub-agent rows smaller/indented to communicate hierarchy
- role badge:
  - `LEAD`
  - `SUB`

## MAS Runtime Integration Plan

Current MAS worker selection should reference explicit sub-agent IDs attached to chosen lead.

Execution selection rule:

- when operator chooses lead and worker mode, worker picker defaults to that lead's sub-agents only
- allow opt-in escape hatch later for "global workers", but default must be scoped to selected lead

## Test Plan

### Backend tests

1. create lead agent -> success
2. create sub-agent without parent -> reject
3. create sub-agent with parent lead -> success + `[SA]` normalization
4. rename lead to `[SA] X` -> reject
5. delete lead with sub-agents -> blocked
6. hierarchy endpoint returns deterministic ordering

### UI tests

1. lead/sub hierarchy renders with indentation
2. add sub-agent flow prefixes `[SA]`
3. selecting lead/sub swaps right-pane form correctly
4. blocked delete for lead with sub-agents shows clear reason

## Rollout Phases

### Phase 1: schema + API compatibility

- migration and backfill
- flat endpoints still work
- hierarchy endpoint available

### Phase 2: Agent Config hierarchy UI

- left panel hierarchy + add sub-agent CTA
- role badges and indentation

### Phase 3: MAS worker scoping

- sub-agent-only worker selection from selected lead
- workflow launch defaults updated

## Risks and Mitigations

1. **Risk:** hierarchy inferred from names only
   - **Mitigation:** explicit `agent_role` + `parent_agent_id`
2. **Risk:** accidental data ambiguity from mixed old/new payloads
   - **Mitigation:** keep flat endpoint + strict server normalization
3. **Risk:** lead delete causing orphaned workers
   - **Mitigation:** default delete block unless explicit reassignment/cascade

## Acceptance Criteria

1. Agent Config displays lead agents with indented sub-agents under each lead.
2. Sub-agents always persist with `[SA] ` prefixed names.
3. MAS worker selection defaults to sub-agents of selected lead.
4. Existing agents continue to function after migration (backfilled as lead).
5. Delete guardrails prevent orphaned sub-agent structures.

## Verify Commands (post-implementation)

1. `cd /var/llamaindex/ghoststack-rag/backend && pytest -q`
2. `cd /var/llamaindex/ghoststack-rag/ui && npm run build -- --outDir dist-verify-mas-subagents`
3. `cd /var/llamaindex/ghoststack-rag && docker compose ps`
4. `curl -sS http://localhost/api/agents/hierarchy | jq`
5. `curl -sS -X POST http://localhost/api/agents/<lead_id>/sub-agents -H 'content-type: application/json' -d '{"name":"Finance Worker"}' | jq`
