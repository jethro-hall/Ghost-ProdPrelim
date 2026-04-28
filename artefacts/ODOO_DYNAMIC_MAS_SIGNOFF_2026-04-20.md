# Odoo Dynamic Retrieval + MAS Signoff

Date: 2026-04-20

## Scope delivered

1. Deterministic finance intent scope parsing for weekend/day windows.
2. Single-company name resolution path for period finance operations.
3. Read-only cash runway summary contract with insufficiency behavior.
4. Dynamic Odoo query-spec compiler/executor (`odoo.rpc.query_spec`) without raw SQL.
5. GhostDASH evidence mirror persistence and retrieval endpoints.
6. MAS role model: one lead architect + two programming workers + one testing worker.
7. GhostChat execution-truth payload enrichment and UI trace surfacing.

## Acceptance criteria outcomes

- `Burleigh weekend 18th/19th April 2026` now maps to exact `date_from=2026-04-18` and `date_to=2026-04-20`.
- Single-name branch prompts now carry explicit company scope hints (`company_name_terms`) and resolve in connector.
- Cash runway operation returns either runway outputs with assumptions or `insufficient_inputs` with missing fields.
- Dynamic requests compile to a validated query spec contract and execute read-only methods only.
- Successful Odoo executions are mirrored with trace metadata in `odoo_evidence_mirror`.
- Seeded hierarchy includes `Llama Architect` + exactly three sub-agents (`[SA] Programming Agent 1`, `[SA] Programming Agent 2`, `[SA] Testing Agent`).
- Chat tool trace now exposes execution truth fields (status, operation, scope window, company scope, evidence source mode).

## Verification evidence (automated)

Executed test/build slices:

```bash
cd /var/llamaindex/ghoststack-rag
pytest -q backend/tests/test_workflows_odoo_planning.py -k "weekend or burleigh or runway or dynamic"
pytest -q backend/tests/test_tools_api.py -k "query_spec_operation or cash_runway_summary or company_name_terms or odoo_tool_settings_test_and_execute_round_trip"
pytest -q backend/tests/test_agent_hierarchy_phase1.py backend/tests/test_agent_seed_persistence.py
pytest -q backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_tools_api.py -k "tool or odoo or prompt"
docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run build"
```

Observed status: all listed tests passed; UI production build passed in container.

## Human-flow validation script (CEO-style)

Use this exact sequence in GhostChat UI with `Llama Architect` selected:

1. Ask: `Using Odoo only, Burleigh weekend 18th/19th April 2026 revenue, COGS, gross margin and cash runway.`
2. Ask: `Run a dynamic deep dive custom query for Burleigh last month and show anomaly drivers.`
3. Ask: `Compare Retail, Burleigh, Brisbane for month-to-date and identify underperformer.`
4. In each response, confirm the execution legend shows:
   - executed/blocked status
   - operation identity
   - exact date window
   - company scope
   - evidence source mode
5. Open `/api/odoo/evidence/mirror` and verify matching entries are persisted for successful Odoo calls.

## Runtime drift checks (canonical names)

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-caddy-1
docker logs --tail=120 ghoststack-rag-control-api-1
```
