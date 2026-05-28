# Owner-Buyer Validation Protocol (Human-Centric)

## Goal
- Validate purchase confidence from an owner-operator perspective, not only technical correctness.
- Confirm deterministic Odoo behavior, decisive answer quality, chat readability, document flow quality, and guardrail lock behavior.

## Pre-Flight
1. Stack is healthy:
   - `cd /var/llamaindex/ghoststack-rag && docker ps --format 'table {{.Names}}\t{{.Status}}'`
2. Control and ingress are healthy:
   - `cd /var/llamaindex/ghoststack-rag && curl -sf http://localhost/health`
3. UI build integrity:
   - `cd /var/llamaindex/ghoststack-rag/ui && npm run lint && npm run build -- --outDir dist-verify-interactive-chat`
4. Backend regression guard:
   - `cd /var/llamaindex/ghoststack-rag/backend && pytest -q tests/test_workflows_odoo_planning.py tests/test_agent_ingress_prompt_hotfix.py tests/test_runtime_profiles.py`

## Human Validation Scenarios

### A) Mixed finance owner prompt (buyer issue #1)
- Prompt:
  - "As of today give me revenue, COGS and gross margin for Retail and tell me what matters now and what to do next."
- Pass:
  - Odoo route is `odoo.finance.margin.period_summary`.
  - Reply is decisive and includes facts/inferences/assumptions.
  - Reply includes evidence window/freshness.

### B) Branch underperformer prompt (buyer issue #2)
- Prompt:
  - "Which branch is underperforming MTD across Retail, Burleigh and Brisbane?"
- Pass:
  - Odoo route is `odoo.finance.margin.monthly_comparison`.
  - Ranking is explicit, not generic prose.

### C) Shopify + orders + AOV closeout
- Prompt:
  - "Give me up-to-date Shopify revenue, marketing spend, orders and AOV for Retail and Burleigh."
- Pass:
  - Dashboard completes in one turn.
  - Missing metrics are marked `PROVISIONAL` without blocking the answer.

### D) Chat UX readability and interaction
- Validate:
  - Markdown headings, bullet actions, table blocks, code blocks, and image blocks render cleanly.
  - Streaming response does not flicker heavily or collapse layout.

### E) Apryse/doc flow
- Validate:
  - Enable doc mode, run preview and finalize.
  - Artifacts are returned with reachable `/docx-artifacts/*` URLs.
  - Diagnostics show deterministic codes for missing template/binding issues.

### F) Guardrail lock behavior
- Validate:
  - Set policy mode to `admin_approval_required`.
  - Attempt guardrail/tool-policy edit without token => blocked with clear error.
  - Retry with approval token + reason => update accepted and audit row created.

## Acceptance Gates
- Deterministic planner routing passes scenarios A and B.
- Owner response contract is present in scenarios A-C.
- Chat renderer supports business formatting and remains readable under stream.
- Doc pipeline returns resolvable artifacts and actionable diagnostics.
- Policy enforcement blocks unauthorized edits and records audit trail.

## Automated Verification Outputs Collected
- Smoke load:
  - `cd /var/llamaindex/ghoststack-rag && python3 scripts/load/workflow_run_smoke_load.py --base-url http://localhost --iterations 6 --concurrency 2`
  - Result: all iterations succeeded (`2/2` per iteration).

## Human Sign-Off Template
- Tester name:
- Date/time:
- Scenarios passed (A-F):
- Blockers observed:
- Purchase confidence score (1-10):
- Recommended next action:
