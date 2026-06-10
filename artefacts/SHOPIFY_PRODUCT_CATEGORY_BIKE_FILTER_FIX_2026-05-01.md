# Shopify product_search bike category filter fix — 2026-05-01

## 1) Summary of requirement
- Fix `product_search` so `category=Bike` does not return parts/accessories when store-level Shopify category env filters are not configured.

## 2) Files changed
- `services/shopify-mcp/index.js`
- `services/shopify-mcp/index.test.js`
- `scripts/shopify/elevenlabs-tools/SHOPIFY_MCP_TOOL_product_search.json`

## 3) Architecture impact
- Kept existing primary category filtering path (env-configured Shopify query fragments).
- Added deterministic fallback post-filter in `shopify-mcp` when category is requested but no env fragment exists.
- This reduces noisy category leakage and avoids requiring immediate env/config deploys for basic category correctness.

## 4) Tests run
- Unit tests:
  - `node --test services/shopify-mcp/index.test.js`
- Live endpoint verification:
  - `curl -sS https://ghoststack.rideai.com.au/api/elevenlabs/shopify/tool ... {"function":"product_search","payload":{"search":"fatfish","category":"Bike"}}`

## 5) Test output
- Unit tests passed: 13/13.
- Live check changed from mixed bikes+parts to bike-only:
  - Before: `count=5`, included accessories/parts.
  - After redeploy: `count=2`, bike products only.
  - Response now includes:
    - `category_heuristic_applied: true`
    - `category_heuristic_filtered_out: 3`

## 6) Manual verification steps
- In ElevenLabs Tool Test:
  - `function=product_search`
  - `payload.search=fatfish`
  - `payload.category=Bike`
- Confirm returned products are bike products and no parts/accessories appear in the list.

## 7) Cleanup performed
- No dead paths removed; change is additive and backward-compatible.
- Updated tool JSON description so operators know `bike` is accepted and normalized to `ebike`.

## 8) Known risks
- Heuristic fallback depends on product title/type/tag quality; edge products with poor metadata may still need store-specific env fragments.
- Best long-term precision remains configuring:
  - `SHOPIFY_SEARCH_FILTER_PART`
  - `SHOPIFY_SEARCH_FILTER_EBIKE`
  - `SHOPIFY_SEARCH_FILTER_SCOOTER`
