# Shopify ElevenLabs Import JSON Pack — 2026-05-01

## 1) Summary of requirement
- Generate Shopify tool JSON scripts in the exact ElevenLabs webhook format for direct import.

## 2) Files changed
- `scripts/shopify/elevenlabs-tools/SHOPIFY_MCP_TOOL_connection_check.json`
- `scripts/shopify/elevenlabs-tools/SHOPIFY_MCP_TOOL_product_search.json`

## 3) Architecture impact
- No service/runtime logic changed.
- Adds standalone import artifacts that call:
  - `POST https://ghoststack.rideai.com.au/api/elevenlabs/shopify/tool`

## 4) Tests run
- JSON syntax validation for both Shopify tool files.

## 5) Test output
- `python3 -m json.tool scripts/shopify/elevenlabs-tools/SHOPIFY_MCP_TOOL_connection_check.json >/dev/null` -> exit `0`
- `python3 -m json.tool scripts/shopify/elevenlabs-tools/SHOPIFY_MCP_TOOL_product_search.json >/dev/null` -> exit `0`

## 6) Manual verification steps
- Import `SHOPIFY_MCP_TOOL_connection_check.json` into ElevenLabs and confirm acceptance.
- Import `SHOPIFY_MCP_TOOL_product_search.json` into ElevenLabs and confirm acceptance.
- Run one call for each:
  - connection check request
  - product search request with `payload.search`.

## 7) Cleanup performed
- None required; this is additive and isolated under `scripts/shopify/elevenlabs-tools/`.

## 8) Known risks
- Only two Shopify tools are packaged in this pass.
- If you also need `inventory_check` and `order_lookup`, they should be added in the same schema shape as follow-up files.
