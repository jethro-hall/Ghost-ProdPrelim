# SHOPIFY product_search scope fix — 2026-05-01

## Requirement

Make `product_search` work now in production despite current Shopify scope limitations.

## Root cause

`shopify-mcp` volatile variant GraphQL query requested `inventoryLevels.node.location.name`, which requires additional Shopify scope (`read_locations` / equivalent). That caused GraphQL errors and forced `product_search` to return `success=false`.

## Correct layer

Service integration layer: `services/shopify-mcp/index.js` GraphQL query shape.

## Existing component reused

Kept existing `product_search` operation and response contract; only narrowed GraphQL fields.

## Files changed

- `services/shopify-mcp/index.js`

## Change implemented

- Removed `location.name` from `QUERY_VARIANTS_VOLATILE`:
  - kept `location.id`
  - kept availability quantities
- This allows live price/availability retrieval to succeed without failing on location-name scope checks.

## Tests run

- `npm test` in `services/shopify-mcp` ✅ (12 passed)
- Live smoke:
  - `POST /api/elevenlabs/shopify/tool` with `function=product_search` ✅ (`success=true`, `count=3`)

## Human verification script

1. Open production voice/chat operator surface.
2. Ask: "Do you have Fatfish OG in stock?"
3. Confirm response is returned (no failure fallback).
4. Ask stale follow-up: "That sounds old, refresh please."
5. Confirm fresh re-check path responds successfully.

## Acceptance criteria

1. `product_search` returns HTTP 200 and `success=true` on production.
2. No `shopify_graphql_errors` in response data for standard product query.
3. Customer-safe response text (no internal diagnostics).

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag/services/shopify-mcp
npm test

cd /var/llamaindex/ghoststack-rag
set -a && source .env && set +a
curl -sS -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: ${ELEVENLABS_SHOPIFY_WEBHOOK_SECRET}" \
  -d '{"function":"product_search","payload":{"search":"fatfish","first":3}}' \
  https://ghoststack.rideai.com.au/api/elevenlabs/shopify/tool
```
