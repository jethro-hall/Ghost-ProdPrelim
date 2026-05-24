# Shopify MCP (Admin GraphQL sidecar)

Lean internal service for GhostDASH: **connection check** and **product search** via the [Shopify Admin GraphQL API](https://shopify.dev/docs/api/admin-graphql).

## Responsibilities

- Hold `SHOPIFY_*` secrets (never exposed to browsers or ElevenLabs tool bodies).
- Expose `GET /health` and `POST /execute` for `control-api`.
- Emit structured JSON logs (`trace_id`, `service`, `route`, `latency_ms`, `status`, `error`).

## Operations (`POST /execute`)

Body:

```json
{ "operation": "connection_check", "payload": {}, "trace_id": "optional-uuid" }
```

```json
{
  "operation": "product_search",
  "payload": {
    "search": "Fatfish OG",
    "category": "ebike",
    "first": 5,
    "variants_first": 20
  }
}
```

Use **`search`** (or `query` / `q`) plus optional **`category`**: `part` | `ebike` | `scooter` | `all`. Category drives AND-ed Shopify query fragments from env (`SHOPIFY_SEARCH_FILTER_*`) or from **`category_query`** on the payload. Response `data` includes `query`, `shopify_query`, `search_term`, `category`, and `category_filter_applied`.

**Caching:** Product search uses an **in-memory catalog cache** (titles, handles, options, images, SKUs, etc.) with TTL `SHOPIFY_MCP_CATALOG_CACHE_TTL_SECONDS`. **Pricing, availability, aggregate inventory, and per-location inventory rows are never cached** — each `product_search` loads them via a fresh Admin `nodes` query. `connection_check` may be cached for `SHOPIFY_MCP_PING_CACHE_TTL_SECONDS`. Pass **`cache_mode`: `bypass`** on the payload to skip catalog/ping caches.

`product_search` returns up to **`SHOPIFY_MCP_MAX_PRODUCTS`** products (default **5**). Each product includes **variants** (price, options, colour, per-location rows) plus **`inventory_display`**: `{ lines, summary }` — e.g. summary `2x Brisbane · Army Green; 1x Burleigh · White`.

### Shopify access scopes

- **`read_products`** — required for search + variant prices/options.
- **`read_inventory`** — required for per-location stock (`variants[].inventory_by_location`) and reliable `inventory_quantity`; without it those fields may be empty or `null`.
- **`read_locations`** — recommended so location names resolve for `inventory_by_location[].location_name`.

Variant **colour / size / options** come from `selectedOptions` on each variant (`variants[].options`, `variants[].colour` when a Colour/Color option exists). **Stock by site** is `variants[].inventory_by_location[]`: `location_name`, `available` (Shopify **available** quantity state).

Response:

```json
{ "ok": true, "operation": "connection_check", "message": "...", "data": { ... } }
```

## Environment

| Variable | Required for live Shopify | Description |
|----------|---------------------------|-------------|
| `SHOPIFY_MCP_PORT` | No | Listen port (default `8097`). |
| `SHOPIFY_STORE_DOMAIN` | Yes | Shop domain, e.g. `your-store.myshopify.com`. |
| `SHOPIFY_ADMIN_API_ACCESS_TOKEN` | Yes | Admin API access token (server-side only). |
| `SHOPIFY_API_VERSION` | No | API version path segment (default `2025-01`). |
| `SHOPIFY_MCP_READ_TIMEOUT_MS` | No | Upstream HTTP timeout (default `12000`). |
| `SHOPIFY_MCP_MAX_PRODUCTS` | No | Cap for `product_search` `first` (default `5`, max `50`). |
| `SHOPIFY_SEARCH_FILTER_PART` | No | Admin search fragment when `category` is `part`. |
| `SHOPIFY_SEARCH_FILTER_EBIKE` | No | Fragment when `category` is `ebike`. |
| `SHOPIFY_SEARCH_FILTER_SCOOTER` | No | Fragment when `category` is `scooter`. |
| `SHOPIFY_MCP_CATALOG_CACHE_TTL_SECONDS` | No | Catalog-only cache TTL (default `60`; `0` disables). |
| `SHOPIFY_MCP_CATALOG_CACHE_MAX_ENTRIES` | No | Max cached search keys (default `200`). |
| `SHOPIFY_MCP_PING_CACHE_TTL_SECONDS` | No | `connection_check` cache TTL (default `15`; `0` disables). |
| `SHOPIFY_MCP_VARIANT_PRICING_CHUNK` | No | Variant IDs per pricing `nodes` batch (default `80`, max `250`). |
| `SHOPIFY_MCP_INVENTORY_LEVELS_FIRST` | No | Max inventory levels per variant in the volatile query (default `50`, max `250`). |

## Required Shopify scopes (v1)

- `read_products` for `product_search` and minimal shop read for `connection_check`.

## ElevenLabs

Voice agents call **`control-api`** only:

- `POST /api/elevenlabs/shopify/tool`
- Header: `X-Ghost-Voice-Key: <ELEVENLABS_SHOPIFY_WEBHOOK_SECRET>` (and optionally `APP_VOICE_INGRESS_SECRET` for ops).

See `docs/SHOPIFY_ELEVENLABS_CONNECTOR.md` in the repo root.
