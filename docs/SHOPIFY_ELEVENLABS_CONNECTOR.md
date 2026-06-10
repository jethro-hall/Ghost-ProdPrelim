# Shopify ElevenLabs connector (Phase 3)

Lean, Hubtiger-style integration: **ElevenLabs webhook** → GhostDASH **`control-api`** → internal **`shopify-mcp`** → Shopify **Admin GraphQL API**.

## URLs

| Surface | Method | Path |
|--------|--------|------|
| **Production webhook (primary)** | POST | `https://<your-host>/api/elevenlabs/shopify/tool` |
| Health | GET | `https://<your-host>/api/elevenlabs/shopify/health` |
| Agent-ingress mirror | POST | `https://<your-host>/agent/integrations/elevenlabs/shopify/tool` |
| Discovery | GET | `https://<your-host>/agent/integrations/elevenlabs/shopify` |

Caddy already routes `/api/*` to `control-api` and `/agent/*` to `agent-ingress` (see `Caddyfile`).

## Authentication

- Header: `X-Ghost-Voice-Key: <secret>` or `Authorization: Bearer <secret>`.
- **Shopify tools use a dedicated secret:** `ELEVENLABS_SHOPIFY_WEBHOOK_SECRET` (separate from Hubtiger).
- For local ops, `APP_VOICE_INGRESS_SECRET` is also accepted (same pattern as Hubtiger).

Never put `SHOPIFY_ADMIN_API_ACCESS_TOKEN` in ElevenLabs tool definitions or browser code.

## Request body

```json
{
  "function": "connection_check",
  "payload": {}
}
```

```json
{
  "function": "product_search",
  "payload": {
    "search": "Fatfish OG",
    "category": "ebike",
    "first": 5,
    "variants_first": 20
  }
}
```

Use **`search`** (recommended) or **`query`** / **`q`** for the customer text. Use **`category`** so bikes are not mixed with parts that share a name:

| `category` value | Meaning |
|------------------|---------|
| `part` | Parts / accessories (env `SHOPIFY_SEARCH_FILTER_PART`) |
| `ebike` | E-bikes (`e-bike`, `e_bike` accepted; env `SHOPIFY_SEARCH_FILTER_EBIKE`) |
| `scooter` | Scooters (env `SHOPIFY_SEARCH_FILTER_SCOOTER`) |
| `all` | No category fragment (search text only) |

Optional **`category_query`** (alias **`category_filter`**) overrides env for one call (Admin search syntax). If `category` is not `all` but no fragment is configured, `data.category_filter_note` explains what to set.

**Caching (shopify-mcp):** Catalog matches (product + variant metadata) may be served from an **in-process TTL cache**. **Price, compare-at, availability, and inventory are always loaded fresh** from Shopify on every `product_search`. Optional payload **`cache_mode`: `bypass`** skips catalog and ping caches.

**Payload fields**

| Field | Description |
|--------|-------------|
| `search` / `query` / `q` | Shopify catalog search string (required). |
| `category` | `part` \| `ebike` \| `scooter` \| `all` (optional; default `all`). |
| `category_query` / `category_filter` | Optional per-request Shopify query fragment instead of env. |
| `cache_mode` | `bypass` / `no_cache` / `fresh` — skip catalog + ping caches for this call. |
| `first` | Max products to return (default **5**, capped by `SHOPIFY_MCP_MAX_PRODUCTS`, max **50**). |
| `variants_first` | Max variants per product (capped by `SHOPIFY_MCP_MAX_VARIANTS_PER_PRODUCT`). |

**Response `data` highlights**

- `query` / `shopify_query` — composed string sent to Shopify `products(query: …)`.
- `search_term` — raw search text from the payload.
- `category`, `category_filter_applied`, optional `category_filter_note`.
- `products[]`: `title`, `handle`, `vendor`, `product_type`, `tags`, `storefront_path`, `featured_image`, **`inventory_display`** — `{ lines: [{ quantity, location_name, colour, descriptor, variant_title, sku }] , summary }` for voice-friendly stock rollups (e.g. `2x Brisbane · Army Green; 1x Burleigh · White`).
- `products[].variants[]`: `price` (`amount`, `currency_code`), `compare_at_price`, `options` (`name`/`value`), `colour` (when a Colour/Color option exists), `available_for_sale`, `inventory_quantity` (may be `null` without inventory scope), **`inventory_by_location`** — `[{ inventory_level_id, location_id, location_name, available }]` per Shopify location (**`available`** quantity state); empty when inventory is not exposed or not tracked.
- `llm_evidence_rule`: short reminder to only use returned fields for voice answers.

Add **`read_inventory`** (and **`read_locations`** for names) on the Shopify custom app for **per-location stock** and reliable aggregates; **`read_products`** is required for catalog + variant pricing.

### Supported `function` values

| Canonical | Aliases |
|-----------|---------|
| `connection_check` | `ping`, `shop_info`, `shop_ping` |
| `product_search` | `products_search`, `search_products` |

## Response shape

Matches Hubtiger’s external contract: `PublicToolResult`

- `success` — logical outcome of the operation.
- `message` — short human-readable summary (safe for voice).
- `operation` — `connection_check` or `product_search`.
- `blocked` — reserved (always `false` for current read-only tools).
- `data` — compact JSON (no tokens, no stack traces).

## Docker service

- **Service name:** `shopify-mcp` (see `docker-compose.yml`).
- **Internal URL:** `http://shopify-mcp:8097` (wired as `SHOPIFY_MCP_URL` on `control-api` and `agent-ingress` in Compose).
- **Code:** `services/shopify-mcp/` (README inside that folder).

### Required env for live Shopify calls

- `SHOPIFY_STORE_DOMAIN` — e.g. `your-store.myshopify.com`
- `SHOPIFY_ADMIN_API_ACCESS_TOKEN` — Admin API access token with at least `read_products`.

### Optional

- `SHOPIFY_API_VERSION` (default `2025-01`)
- `SHOPIFY_MCP_READ_TIMEOUT_MS`, `SHOPIFY_MCP_MAX_PRODUCTS`
- `SHOPIFY_SEARCH_FILTER_PART`, `SHOPIFY_SEARCH_FILTER_EBIKE`, `SHOPIFY_SEARCH_FILTER_SCOOTER` — fragments AND-ed with `search` when `category` is set (must match how products are typed/tagged in Admin).
- `SHOPIFY_MCP_CATALOG_CACHE_TTL_SECONDS`, `SHOPIFY_MCP_CATALOG_CACHE_MAX_ENTRIES`, `SHOPIFY_MCP_PING_CACHE_TTL_SECONDS`, `SHOPIFY_MCP_VARIANT_PRICING_CHUNK`, `SHOPIFY_MCP_INVENTORY_LEVELS_FIRST` — see `services/shopify-mcp/README.md`.

## Python modules

| Module | Role |
|--------|------|
| `ghostdash_api/integrations/shopify_elevenlabs_tool.py` | `/api/elevenlabs/shopify/*` router |
| `ghostdash_api/integrations/shopify_elevenlabs_schemas.py` | Request models + canonical function names |
| `integrations/elevenlabs_shopify/router.py` | `/agent/integrations/elevenlabs/shopify/*` + shared executor |
| `ghostdash_api/shopify_mcp.py` | HTTP client to `shopify-mcp` `/execute` |
| `ghostdash_api/voice_ingress.py` | `_check_shopify_voice_auth` |

## Verify

```bash
docker compose config
docker compose up -d shopify-mcp control-api
curl -sS -H "X-Ghost-Voice-Key: $ELEVENLABS_SHOPIFY_WEBHOOK_SECRET" \
  http://localhost/api/elevenlabs/shopify/health
curl -sS -X POST http://localhost/api/elevenlabs/shopify/tool \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $ELEVENLABS_SHOPIFY_WEBHOOK_SECRET" \
  -d '{"function":"connection_check","payload":{}}'
```

```bash
cd backend && python3.12 -m pytest tests/test_shopify_elevenlabs_tool.py -q
```

## Scope notes

- **v1:** read-only `connection_check` + `product_search`.
- **Later:** inventory, draft orders, booking bridges — keep behind the same MCP + webhook pattern.
