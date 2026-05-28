# Brisbane-only dynamic Odoo scope lock (2026-04-20)

## Problem

Chat history could carry `company_id` lists or multi-branch name hints. A user message such as “Brisbane **ONLY**” still routed to multi-company finance helpers or produced `query_spec` payloads **without** `company_scope_lock` metadata because the dynamic branch returned `payload: {"query_spec": ...}` and never merged scope-lock fields.

## Resolution (repo)

1. `**workflows.py`**
  - `_infer_company_scope_lock_canonical()` detects phrases like `Brisbane only`, `only Brisbane`, `only for Brisbane`, etc.
  - On lock: `company_name_terms` is forced to a single canonical key; inherited multi `company_ids` from **fallback** are cleared unless the **primary user message** contains a single explicit `company_id`.
  - `_extract_company_name_terms()` uses **word-boundary** matching for `retail` / `brisbane` / `burleigh` and drops a false “retail” when the phrase is `Brisbane retail outlet`-style.
  - Dynamic `odoo.rpc.query_spec` plans now use `dynamic_payload = {**period_payload, "query_spec": ...}` and `_scoped_payload(...)` so `company_scope_lock` / `company_scope_lock_canonical` are always present when locked.
2. `**odoo_connector.py`**
  - `_normalize_company_scope_lock_payload()` narrows resolution to one canonical name or one explicit id before `_resolve_company_scope`.
  - `_run_rpc_query_spec` injects `["company_id", "=", <resolved_id>]` when the domain does not already pin the locked company.
  - `execute_odoo_operation` echoes `company_scope_lock`, `company_scope_lock_canonical`, and `scope_enforced` into result data for UI truth.
  - `_run_finance_margin_monthly_comparison` falls back to `revenue_data["company_ids"]` or row keys when `_coerce_company_ids(payload)` is empty.
3. `**tool_registry.py`**
  - Consumer chat: `single_exact` allows `query_spec` without a `company_id` clause in the **incoming** domain when a single `company_name_terms` / `company_scope_lock_canonical` pin exists (connector injects the filter).
4. `**agent_ingress.py` + `AgentToolTrace.tsx`**
  - `execution_truth` exposes lock + `scope_enforced`; the execution legend shows `lock:<canonical>` when present.

## Automated verification

```bash
cd /var/llamaindex/ghoststack-rag/backend
python3.12 -m pytest tests/test_workflows_odoo_planning.py tests/test_tools_api.py tests/test_tool_registry_policy_and_audit.py -q
```

## Human acceptance (Ian flow)

1. Redeploy API surfaces that embed planner + connector:
  `docker compose -f /var/llamaindex/ghoststack-rag/docker-compose.yml up -d --build control-api workflow-runtime agent-ingress`
2. In Ghost chat (Finance Agent), send:
  `Using Odoo only, run a dynamic custom query deep dive for Brisbane ONLY for Jan, Feb, March, April 2026 revenue and cogs anomalies.`
3. **Expect:** execution legend shows `lock:brisbane` (or equivalent), Odoo result data includes `scope_enforced: true`, and no Burleigh/Retail/Burleigh multi-company resolution unless explicitly requested.

## Note (planner text normalization)

`_normalize_planning_text` collapses repeated letters globally (e.g. “Odoo” → “odo”). This predates this change; lock detection runs after the same normalization the rest of the planner uses. If “Odoo-only” matching regresses, consider narrowing repeated-letter collapse to a safelist instead of all tokens.