# MAS Runtime Redeploy Odoo Execution Recovery (2026-04-18)

## Issue

User reported no behavioral change:

- `No Odoo result returned`
- `route_type` effectively behaved as direct answer flow
- output referenced Odoo but lacked tool execution evidence

## Diagnosis

Required evidence captured first:

1. `git status -sb`
2. `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
3. `docker logs --tail=120 ghoststack-rag-caddy-1`
4. `docker logs --tail=120 ghoststack-rag-control-api-1`

Additional runtime verification:

- Reproduced failing prompt against `Business Planning Orchestrator`.
- Stream `start` payload showed:
  - `tool_summary.odoo_primary.status = ready`
  - `route_decision.route_type = direct`
  - `tool_expectations.tool_plan = null`
  - `tool_events = []`

This confirmed that live services were not reflecting the latest orchestration/planning changes.

## Root Cause

Backend containers were running stale builds. Source changes existed in workspace, but runtime services had not been rebuilt/restarted to load updated planner/orchestrator code.

## Fix Applied

Redeployed backend services with fresh builds:

- `docker compose up -d --build workflow-runtime agent-ingress control-api`

## Validation (same failing prompt, post-redeploy)

Re-ran:

- `POST /agent/chat/stream` with typo-heavy Odoo + sub-agent prompt using `Business Planning Orchestrator`.

Observed in stream:

- `route_decision.route_type = workers`
- `tool_plan.operation = odoo.finance.shopify.monthly_roi`
- Odoo tool events executed:
  - `odoo.rpc.search_read` (company resolution)
  - `odoo.finance.shopify.monthly_roi` (period + scope)
- Delegation events executed:
  - `agent.finance_analyst` planned/executed
  - `agent.business_documenter` planned (and stream continued with synthesis)

## Acceptance Criteria

- User prompt triggers real Odoo execution evidence in the same turn.
- Route decision escalates to worker orchestration for this finance/document intent.
- Stream includes staged delegated sub-agent events, not direct opaque-only output.

## Exact Verify Commands

1. `cd /var/llamaindex/ghoststack-rag && git status -sb`
2. `cd /var/llamaindex && docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
3. `cd /var/llamaindex && docker compose -f /var/llamaindex/ghoststack-rag/docker-compose.yml up -d --build workflow-runtime agent-ingress control-api`
4. `cd /var/llamaindex && curl -sS -N http://localhost/agent/chat/stream -H 'content-type: application/json' -d '{"message":"Using Odooo via your subagent finance pleasae provide once formatted by your subaagent Businesss DOccumenter provide an indepth report on lasst monthss financials, foor all of group and individual thats RIde Electric Retail, Burleigh & Brisbane, look into maraketing spend and shopify saless.","agent_id":"bb4ab3ce-e0b5-4437-9c0e-5ccfb7a99e75","api_mode":"responses"}'`

## Human Testing Request

Run the same chat prompt from UI and confirm:

1. Odoo cards appear as executed (`odoo.rpc.search_read`, `odoo.finance.shopify.monthly_roi`).
2. Sub-agent cards appear in sequence (Finance Analyst, then Business Documenter).
3. Final response arrives after those stages, with tool-backed citations.