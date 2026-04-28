# Odoo Correctness, Presentation, and Cache Implementation (2026-04-22)

## Scope implemented

This implementation completed three lanes:

1. Cache key isolation across conversations.
2. Odoo operation routing/prompt alignment for products, sales orders, and finance pathways.
3. Canonical business-structure grounding embedded in runtime profiles.

## Changes delivered

### 1) Cache isolation fix

- Updated `backend/src/ghostdash_api/agent_memory.py`:
  - `build_response_cache_key(...)` now includes `conversation_id` in the key payload.
- Updated `backend/src/ghostdash_api/agent_ingress.py`:
  - Both sync and stream cache key call sites now pass `conversation.id`.
- Added `backend/tests/test_agent_memory_cache_key.py`:
  - Verifies identical prompts in different conversations produce different cache keys.
  - Verifies key stability when conversation id is unchanged.
- Updated `docs/AGENT_MEMORY_AND_CACHE_ARTIFACT.md`:
  - Cache key contract now explicitly includes conversation id.

### 2) Odoo operation-choice alignment

- Updated `backend/src/ghostdash_api/workflows.py` planner:
  - Added product-catalog intent routing to `odoo.products.search_read`.
  - Added period sales-order lookup routing to `odoo.sales.orders.search_read`.
  - Added extraction helpers for product lookup query terms.
- Updated specialist prompt surfaces:
  - `backend/src/ghostdash_api/odoo_agentic.py` tool-loop guidance now explicitly maps:
    - product catalog -> `odoo.products.search_read`
    - order-book checks -> `odoo.sales.orders.search_read`
    - ranked product GP -> `odoo.sales.products_gp.period_top`
  - `backend/src/ghostdash_api/agent_ingress.py` workflow directives now reinforce the same mapping.
- Expanded planner test coverage in `backend/tests/test_workflows_odoo_planning.py`:
  - New test for product catalog routing.
  - New test for period sales-order routing.

### 3) Business structure grounding via runtime profiles

- Updated `backend/src/ghostdash_api/runtime_profiles.py`:
  - Added `CANONICAL_BUSINESS_STRUCTURE_CONTEXT` constant with explicit canonical names:
    - Ride Electric Retail
    - Ride Electric Burleigh
    - Ride Electric Brisbane
    - Shopify as channel/ledger scope (not standalone legal company id)
  - Embedded this context into `DEFAULT_SYSTEM_PROMPT`.
  - Embedded this context into `ODOO_SPECIALIST_SYSTEM_PROMPT`.
  - Added strategist rule to follow canonical grounding.

## Diagnostic evidence run

- `git status -sb` at `/var/llamaindex` returned not-a-repo.
- `git status -sb` at `/var/llamaindex/ghoststack-rag` succeeded (repo confirmed).
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'` executed successfully.
- `docker logs --tail=120 ghost-edge-gateway` and `ghost-control-plane` returned `No such container` (stack uses `ghoststack-rag-*` names).

## Test evidence

Executed:

```bash
cd /var/llamaindex/ghoststack-rag && pytest backend/tests/test_agent_memory_cache_key.py backend/tests/test_agent_ingress_prompt_hotfix.py -q
```

Result: `34 passed`.

Executed:

```bash
cd /var/llamaindex/ghoststack-rag && pytest backend/tests/test_workflows_odoo_planning.py backend/tests/test_odoo_agentic.py backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_agent_memory_cache_key.py backend/tests/test_runtime_profiles.py -q
```

Result: `80 passed`.

## Acceptance criteria status

- Cross-conversation cache collisions for identical first-turn prompts are prevented by conversation-scoped keying: **met**.
- Odoo routing for product catalog, sales orders, and finance helper selection is explicit and tested: **met**.
- Canonical business structure context is encoded in runtime prompts for grounded answer framing: **met**.

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag && pytest backend/tests/test_agent_memory_cache_key.py backend/tests/test_workflows_odoo_planning.py backend/tests/test_odoo_agentic.py backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_runtime_profiles.py -q
```

```bash
cd /var/llamaindex/ghoststack-rag && pytest -q
```
