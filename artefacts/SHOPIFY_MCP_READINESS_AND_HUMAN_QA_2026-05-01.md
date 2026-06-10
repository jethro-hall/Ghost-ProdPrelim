# Shopify MCP Readiness + Human QA Status — 2026-05-01

## Requirement

Assess whether Shopify MCP is ready for testing from a human-use perspective and provide proof.

## Summary verdict

**Partial / Not human-ready yet.**

- ✅ Automated tests pass (service unit tests + backend bridge tests).
- ✅ Live `connection_check` succeeds through production edge.
- ❌ Live `product_search` currently fails (scope/auth capability gap from Shopify side), so operator/user-level flows are not production-ready.
- ❌ No completed browser/voice human interaction QA evidence yet for Shopify journey.

## Evidence collected

### Runtime state

- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'` shows:
  - `ghoststack-rag-shopify-mcp-1` running
  - `ghoststack-rag-control-api-1` running
  - `ghoststack-rag-caddy-1` running

### Automated tests

- Backend bridge tests:
  - `python3.12 -m pytest tests/test_shopify_elevenlabs_tool.py -q`
  - Result: **5 passed**
- Shopify MCP service tests:
  - `npm test` (in `services/shopify-mcp`)
  - Result: **12 passed**

### Live API smoke tests (production domain)

- `GET /api/elevenlabs/shopify/health` → HTTP 200
- `POST /api/elevenlabs/shopify/tool` with `function=connection_check` → HTTP 200, `success=true`
- `POST /api/elevenlabs/shopify/tool` with `function=product_search` → HTTP 200, `success=false`

Returned failure payload indicates Shopify GraphQL permissions problem:

- `error_code = shopify_graphql_errors`
- GraphQL errors include access denied for location name fields requiring:
  - `read_locations` (or `read_markets_home`)

## Root cause

Shopify token/app scopes are insufficient for current `product_search` data shape (which includes per-location inventory naming).

## Correct layer

External integration configuration (Shopify app scopes/tokens), not UI rendering.

## Fix list

1. Update Shopify Admin app scopes to include at least:
   - `read_products`
   - `read_inventory`
   - `read_locations` (or alternative accepted scope from Shopify policy)
2. Reinstall/reauthorize Shopify app to mint a token with updated scopes.
3. Re-run live `product_search` smoke call.
4. Run human interaction QA in Ghost flow (voice/chat prompt path) and capture evidence.

## Human QA script (required next)

1. Open production operator surface.
2. Trigger Shopify retrieval prompt from operator workflow (chat/voice).
3. Validate:
   - happy path product search
   - no results response
   - stale/refresh behavior if applicable
   - safe customer wording (no internals/traces)
4. Verify repeated use (2-3 consecutive searches) for consistency.
5. Record screenshots/log snippets as proof.

## Risks

- Until scope fix is done, operators can get failed product search despite healthy connection.
- This may be misread as MCP instability when root issue is permissions.

## Acceptance criteria

1. `product_search` returns `success=true` for known query on production.
2. No Shopify GraphQL scope errors in response payload.
3. At least one human interaction test pass documented (happy path + error path).
4. Customer-safe output (no raw backend diagnostics) maintained.

## Exact verify commands

```bash
# Backend bridge tests
cd /var/llamaindex/ghoststack-rag/backend
python3.12 -m pytest tests/test_shopify_elevenlabs_tool.py -q

# Shopify MCP unit tests
cd /var/llamaindex/ghoststack-rag/services/shopify-mcp
npm test

# Live smoke checks (requires ELEVENLABS_SHOPIFY_WEBHOOK_SECRET in env)
cd /var/llamaindex/ghoststack-rag
set -a && source .env && set +a
curl -sS -H "X-Ghost-Voice-Key: ${ELEVENLABS_SHOPIFY_WEBHOOK_SECRET}" \
  https://ghoststack.rideai.com.au/api/elevenlabs/shopify/health
curl -sS -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: ${ELEVENLABS_SHOPIFY_WEBHOOK_SECRET}" \
  -d '{"function":"connection_check","payload":{}}' \
  https://ghoststack.rideai.com.au/api/elevenlabs/shopify/tool
curl -sS -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: ${ELEVENLABS_SHOPIFY_WEBHOOK_SECRET}" \
  -d '{"function":"product_search","payload":{"search":"fatfish","first":3}}' \
  https://ghoststack.rideai.com.au/api/elevenlabs/shopify/tool
```
