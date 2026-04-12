# MAS Phase 1 Multi-Agent Orchestration

Date: 2026-04-09

## Goal

Add a real Multi-Agent Orchestration System to GhostDASH and Ghost ChatUI quickly without inventing a parallel backend stack or duplicating runtime ownership.

Phase 1 is intentionally constrained:

- use existing GhostDASH agents
- use existing `/api/chat/bootstrap`
- use existing `/agent/chat/stream`
- run selected agents sequentially
- group results into one consultation run in the UI

## Architecture Decision

Do not create a new MAS container or a second chat runtime.

Reuse the existing split:

- `control-api` owns configuration, bootstrap, and agent authoring
- `agent-ingress` owns user-facing chat streaming
- `workflow-runtime` remains the future executor for persisted workflow runs

## Phase 1 Workflow Contract

Canonical Phase 1 workflow shape is JSON-first.

```json
{
  "version": 1,
  "workflow_id": "mas_consult_v1",
  "name": "Multi-Agent Consult",
  "execution_mode": "sequential",
  "min_agents": 2,
  "max_agents": 3,
  "persist_child_conversations": true,
  "nodes": [
    {
      "id": "consult_existing_agents",
      "type": "agent_consult",
      "description": "Send the same prompt to selected existing agents in sequence."
    },
    {
      "id": "group_results",
      "type": "ui_grouped_results",
      "description": "Render each agent response as part of one grouped consultation run."
    }
  ]
}
```

YAML is supported as an operator-facing representation only:

```yaml
version: 1
workflow_id: mas_consult_v1
name: Multi-Agent Consult
execution_mode: sequential
min_agents: 2
max_agents: 3
persist_child_conversations: true
nodes:
  - id: consult_existing_agents
    type: agent_consult
    description: Send the same prompt to selected existing agents in sequence.
  - id: group_results
    type: ui_grouped_results
    description: Render each agent response as part of one grouped consultation run.
```

## Why This Shape

- It is standard enough to evolve into persisted workflow definitions later.
- It avoids pretending that phase 1 already has durable orchestration runs.
- It keeps the source of truth typed and explicit.
- It avoids making YAML a live config dependency inside the application runtime.

## GhostDASH Agent Authoring Fix

Before MAS, agent authoring must be reliable.

The broken behavior was:

- `New agent` started from a duplicate default name
- backend save could upsert by `name`
- the UI did not show validation or save failures clearly

Phase 1 fix requires:

- explicit create vs edit behavior
- unique draft names for new agents
- duplicate-name protection in backend
- visible save errors and validation feedback in the GhostDASH agent form

## Implementation Slices

### Slice 1: Fix authoring

- block ambiguous create-by-name overwrite behavior
- surface save errors in `AgentConfigPage`
- make new drafts unique and intuitive

### Slice 2: Ghost ChatUI MAS

- add MAS toggle
- select 2-3 live agents
- sequentially stream each selected agent
- keep per-agent child conversation ids for continuity
- render grouped outputs in one consult transcript

### Slice 3: Persisted orchestration

Later, not phase 1:

- `WorkflowDefinition`
- `WorkflowRun`
- `WorkflowStepRun`
- step events
- durable orchestration history
- cancel/retry at run-step level

## Acceptance Criteria

- GhostDASH can create a brand-new agent without overwriting an existing one by name.
- Save failures are visible to the operator.
- Ghost ChatUI can consult 2-3 existing live agents from one prompt.
- One agent failing does not erase the others.
- Single-agent chat remains unchanged when MAS is off.

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
docker ps --format 'table {{.Names}}\t{{.Status}}'
docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-agent-ingress-1
curl -ksS "https://ghoststack.rideai.com.au/api/chat/bootstrap?surface=ghost_chatui" | jq '{default_agent_id, agent_names:[.agents[].name]}'
curl -ksSN -X POST "https://ghoststack.rideai.com.au/agent/chat/stream" \
  -H "Content-Type: application/json" \
  --data '{"message":"Reply with exactly MAS_OK","agent_id":"2564d0e0-4cf3-4dab-8e78-91c6e4daf9cc","conversation_id":null,"api_mode":"chat_completions","use_approved_web":false}'
```

## Human Verification

1. Open `https://ghoststack.rideai.com.au/agent`
2. Create a new agent with a unique name
3. Confirm save success is visible and the agent appears in the saved list
4. Open `https://ghoststack.rideai.com.au/ghost_chatui`
5. Enable MAS
6. Select 2 or 3 live agents
7. Send one prompt
8. Confirm each selected agent returns a labeled result in one grouped consultation flow
