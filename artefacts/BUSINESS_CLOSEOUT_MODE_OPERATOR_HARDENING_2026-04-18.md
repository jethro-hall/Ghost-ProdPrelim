# Business Closeout Mode Operator Hardening (2026-04-18)

## Goal

Ensure Ian/operator-style financial requests return a decisive, board-ready result in the same turn, even when some metrics are missing.

## Implemented Changes

1. Added finance closeout directives in `agent_ingress` so executed Odoo evidence forces a complete closeout response (no blocker-only output).
2. Added blocker-response normalization in `agent_ingress` to rewrite "I can't produce..." style outputs into a provisional executive dashboard when Odoo evidence exists.
3. Added Shopify supplemental order/AOV pull in `agent_ingress`:
  - For Shopify requests asking orders/AOV, execute `odoo.sales.orders.search_read` in the same turn.
  - Attach `shopify_order_metrics` (order count, order total, AOV, per-company breakdown) to the evidence bundle.
4. Expanded `odoo_connector` sales order fields to include `company_id` for per-company order metrics.
5. Hardened Odoo planning period extraction in `workflows`:
  - Supports `month-to-date`/`mtd`.
  - Supports `last N days` (including `last 30 days`).
  - Defaults `as of today`/`up-to-date` style phrasing to month-to-date through today.

## Quickpass Regression Fix (same date)

After validating the user Quickpass flow, two additional gaps were fixed:

1. **Planner default for generic real-time BI prompts**
  `workflows._plan_odoo_tool_usage` now routes generic "real-time business intelligence / current financial reality" prompts (without explicit GP/revenue/cogs wording) to `odoo.finance.margin.period_summary` using MTD-through-today scope.
2. **UI tool-event truth source correction**
  In `Ghost-chatUI`, persisted message mapping now prefers `tool_events` from the API response before deriving events from citations.  
   This prevents false red banners ("No Odoo result returned") when Odoo actually executed but citations are non-tool.

## Test and Validation Evidence

- `pytest -q tests/test_workflows_odoo_planning.py tests/test_agent_ingress_prompt_hotfix.py`
  - Result: `32 passed`
- `pytest -q tests/test_workflows_odoo_planning.py`
  - Result: `14 passed` (post-Quickpass planner regression pass)
- `npm run build` in `Ghost-chatUI`
  - Result: success (production build completed)
- `docker compose up -d --build workflow-runtime agent-ingress control-api`
  - Result: services rebuilt and started successfully.
- `docker compose up -d --build workflow-runtime ghost-chatui`
  - Result: workflow runtime and Ghost-chatUI rebuilt and started successfully.

## Acceptance Criteria

1. Ian-style "as-of-today" financial requests do not terminate in blocker-only clarifications if at least one Odoo execution succeeded.
2. Shopify requests that ask for orders/AOV include same-turn supplemental order metrics.
3. Up-to-date phrasing resolves to deterministic date windows (MTD or explicit last-N-days).
4. Prompt-level and post-generation safeguards both enforce provisional-closeout behavior.
5. Quickpass generic "real-time BI" prompts trigger an Odoo tool plan (`margin.period_summary`) rather than semantic-only fallback.
6. Ghost-chatUI no longer flags missing Odoo execution when `tool_events` includes an executed Odoo event.

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag/backend
pytest -q tests/test_workflows_odoo_planning.py tests/test_agent_ingress_prompt_hotfix.py
```

```bash
cd /var/llamaindex/ghoststack-rag
docker compose up -d --build workflow-runtime agent-ingress control-api
```

