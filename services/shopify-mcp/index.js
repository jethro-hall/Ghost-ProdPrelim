import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.SHOPIFY_MCP_PORT || 8097);
const SHOPIFY_STORE_DOMAIN = normalizeShopDomain(process.env.SHOPIFY_STORE_DOMAIN || '');
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = String(process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN || '').trim();
const SHOPIFY_API_VERSION = String(process.env.SHOPIFY_API_VERSION || '2025-01').trim();
const READ_TIMEOUT_MS = Math.max(1000, Number(process.env.SHOPIFY_MCP_READ_TIMEOUT_MS || 12000));
const DEFAULT_PRODUCTS_LIMIT = 5;
const MAX_PRODUCTS = Math.min(50, Math.max(1, Number(process.env.SHOPIFY_MCP_MAX_PRODUCTS || DEFAULT_PRODUCTS_LIMIT)));
const MAX_VARIANTS_PER_PRODUCT = Math.min(50, Math.max(1, Number(process.env.SHOPIFY_MCP_MAX_VARIANTS_PER_PRODUCT || 20)));
const CATALOG_CACHE_TTL_SEC = Math.max(0, Number(process.env.SHOPIFY_MCP_CATALOG_CACHE_TTL_SECONDS ?? 60));
const CATALOG_CACHE_MAX = Math.min(2000, Math.max(16, Number(process.env.SHOPIFY_MCP_CATALOG_CACHE_MAX_ENTRIES ?? 200)));
const PING_CACHE_TTL_SEC = Math.max(0, Number(process.env.SHOPIFY_MCP_PING_CACHE_TTL_SECONDS ?? 15));
const VARIANT_PRICING_CHUNK = Math.min(250, Math.max(1, Number(process.env.SHOPIFY_MCP_VARIANT_PRICING_CHUNK ?? 80)));
const INVENTORY_LEVELS_FIRST = Math.min(
  250,
  Math.max(1, Number(process.env.SHOPIFY_MCP_INVENTORY_LEVELS_FIRST ?? 50)),
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** In-memory catalog cache: search shape without live price/stock (those are merged every request). */
const catalogCache = new Map();
const catalogCacheKeysFifo = [];

let pingCacheEntry = null;

export const app = express();
app.use(express.json({ limit: '512kb' }));

function jsonLog(obj) {
  console.log(JSON.stringify(obj));
}

function parseTraceId(value) {
  const v = String(value || '').trim();
  return UUID_REGEX.test(v) ? v : crypto.randomUUID();
}

function normalizeShopDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  return s.replace(/:\d+$/, '');
}

function shopifyConfigured() {
  return !!(SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_API_ACCESS_TOKEN);
}

function normalizeCacheMode(payload) {
  const raw = payload?.cache_mode ?? payload?.cacheMode;
  if (raw === undefined || raw === null || raw === '') return 'default';
  const v = String(raw).trim().toLowerCase().replace(/-/g, '_');
  if (['bypass', 'no_cache', 'nocache', 'fresh', 'force_fresh'].includes(v)) return 'bypass';
  return 'default';
}

function catalogCacheKey(q, first, variantsFirst) {
  const h = crypto.createHash('sha256').update(JSON.stringify({ q, first, variantsFirst })).digest('hex');
  return `${SHOPIFY_STORE_DOMAIN}:${SHOPIFY_API_VERSION}:${h}`;
}

function catalogCacheGet(key) {
  const row = catalogCache.get(key);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    catalogCache.delete(key);
    const ix = catalogCacheKeysFifo.indexOf(key);
    if (ix >= 0) catalogCacheKeysFifo.splice(ix, 1);
    return null;
  }
  return row.bundle;
}

function catalogCacheSet(key, bundle, ttlSec) {
  if (ttlSec <= 0) return;
  catalogCache.set(key, { expiresAt: Date.now() + ttlSec * 1000, bundle });
  if (!catalogCacheKeysFifo.includes(key)) catalogCacheKeysFifo.push(key);
  while (catalogCacheKeysFifo.length > CATALOG_CACHE_MAX) {
    const victim = catalogCacheKeysFifo.shift();
    if (victim) catalogCache.delete(victim);
  }
}

function pingCacheGet() {
  if (!pingCacheEntry || Date.now() > pingCacheEntry.expiresAt) {
    pingCacheEntry = null;
    return null;
  }
  return pingCacheEntry.payload;
}

function pingCacheSet(payload, ttlSec) {
  if (ttlSec <= 0) return;
  pingCacheEntry = { expiresAt: Date.now() + ttlSec * 1000, payload };
}

const QUERY_SHOP_PING = `#graphql
  query ShopPing {
    shop {
      id
      name
      primaryDomain {
        host
      }
    }
  }
`;

/** Catalog slice only — no price or availability (fetched fresh per request). */
const QUERY_PRODUCT_SEARCH_CATALOG = `#graphql
  query ProductSearchCatalog($q: String!, $first: Int!, $variantsFirst: Int!) {
    shop {
      currencyCode
    }
    products(first: $first, query: $q) {
      edges {
        node {
          id
          title
          handle
          status
          vendor
          productType
          tags
          featuredImage {
            url
            altText
          }
          variants(first: $variantsFirst) {
            edges {
              node {
                id
                title
                displayName
                sku
                barcode
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

const QUERY_VARIANTS_VOLATILE = `#graphql
  query VariantVolatile($ids: [ID!]!, $inventoryLevelsFirst: Int!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price
        compareAtPrice
        availableForSale
        inventoryQuantity
        inventoryItem {
          id
          tracked
          inventoryLevels(first: $inventoryLevelsFirst) {
            edges {
              node {
                id
                quantities(names: ["available"]) {
                  name
                  quantity
                }
                location {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function adminGraphql({ query, variables, trace_id }) {
  if (!shopifyConfigured()) {
    return {
      ok: false,
      status_code: null,
      latency_ms: 0,
      graphql_errors: [],
      data: null,
      error_code: 'shopify_env_missing',
    };
  }
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const latency_ms = Date.now() - start;
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    const graphql_errors = Array.isArray(body.errors) ? body.errors : [];
    const data = body.data ?? null;
    const ok = res.ok && graphql_errors.length === 0 && data !== null;
    if (!res.ok) {
      jsonLog({
        trace_id,
        span_id: trace_id,
        service: 'shopify-mcp',
        route: 'shopify_admin_graphql',
        start_ts: start / 1000,
        end_ts: Date.now() / 1000,
        latency_ms,
        status: res.status,
        error: 'shopify_http_error',
      });
      return {
        ok: false,
        status_code: res.status,
        latency_ms,
        graphql_errors,
        data,
        error_code: 'shopify_http_error',
      };
    }
    if (graphql_errors.length > 0) {
      jsonLog({
        trace_id,
        span_id: trace_id,
        service: 'shopify-mcp',
        route: 'shopify_admin_graphql',
        start_ts: start / 1000,
        end_ts: Date.now() / 1000,
        latency_ms,
        status: 200,
        error: 'shopify_graphql_errors',
      });
      return {
        ok: false,
        status_code: 200,
        latency_ms,
        graphql_errors,
        data,
        error_code: 'shopify_graphql_errors',
      };
    }
    jsonLog({
      trace_id,
      span_id: trace_id,
      service: 'shopify-mcp',
      route: 'shopify_admin_graphql',
      start_ts: start / 1000,
      end_ts: Date.now() / 1000,
      latency_ms,
      status: 200,
      error: null,
    });
    return { ok: true, status_code: 200, latency_ms, graphql_errors: [], data, error_code: null };
  } catch (err) {
    const latency_ms = Date.now() - start;
    const name = err && err.name;
    const error = name === 'AbortError' ? 'shopify_timeout' : 'shopify_request_failed';
    jsonLog({
      trace_id,
      span_id: trace_id,
      service: 'shopify-mcp',
      route: 'shopify_admin_graphql',
      start_ts: start / 1000,
      end_ts: Date.now() / 1000,
      latency_ms,
      status: 0,
      error,
    });
    return {
      ok: false,
      status_code: null,
      latency_ms,
      graphql_errors: [],
      data: null,
      error_code: error,
    };
  } finally {
    clearTimeout(timer);
  }
}

function compactGraphqlErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, 5).map((e) => ({
    message: String(e?.message || 'error'),
  }));
}

/** Admin API `Money` is a scalar (decimal string); legacy responses used `{ amount, currencyCode }`. */
function shapeMoney(m, shopCurrency) {
  const cc = shopCurrency != null ? String(shopCurrency) : null;
  if (m === null || m === undefined) return null;
  if (typeof m === 'string' || typeof m === 'number') {
    const amount = String(m).trim();
    if (!amount) return null;
    return { amount, currency_code: cc };
  }
  if (typeof m !== 'object') return null;
  if (m.amount == null && m.amount !== 0) return null;
  return {
    amount: String(m.amount),
    currency_code: m.currencyCode != null ? String(m.currencyCode) : cc,
  };
}

function shapeInventoryByLocation(inventoryItem) {
  const edges = inventoryItem?.inventoryLevels?.edges;
  if (!Array.isArray(edges)) return [];
  const rows = [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node?.location) continue;
    const loc = node.location;
    let available = null;
    const qs = Array.isArray(node.quantities) ? node.quantities : [];
    const availQ = qs.find((q) => String(q?.name || '').toLowerCase() === 'available');
    if (availQ != null && availQ.quantity != null) available = Number(availQ.quantity);
    rows.push({
      inventory_level_id: node.id,
      location_id: loc.id,
      location_name: String(loc.name || ''),
      available,
    });
  }
  return rows;
}

function shapeVariant(node, shopCurrency) {
  if (!node || typeof node !== 'object') return null;
  const options = Array.isArray(node.selectedOptions)
    ? node.selectedOptions.map((o) => ({
        name: String(o?.name || ''),
        value: String(o?.value || ''),
      }))
    : [];
  const colourOption = options.find((o) => /colour|color/i.test(o.name));
  return {
    id: node.id,
    title: node.displayName || node.title || '',
    sku: node.sku || '',
    barcode: node.barcode || '',
    price: shapeMoney(node.price, shopCurrency),
    compare_at_price: shapeMoney(node.compareAtPrice, shopCurrency),
    available_for_sale: Boolean(node.availableForSale),
    inventory_quantity:
      node.inventoryQuantity === null || node.inventoryQuantity === undefined
        ? null
        : Number(node.inventoryQuantity),
    inventory_by_location: node.inventoryItem ? shapeInventoryByLocation(node.inventoryItem) : [],
    options,
    colour: colourOption?.value || null,
  };
}

function shapeProductSearchData(data) {
  const edges = data?.products?.edges;
  const shopCurrency = data?.shop?.currencyCode ?? null;
  if (!Array.isArray(edges)) return { products: [], count: 0 };
  const products = edges
    .map((e) => e && e.node)
    .filter(Boolean)
    .map((node) => {
      const vEdges = node.variants?.edges;
      const variants = Array.isArray(vEdges)
        ? vEdges.map((ve) => shapeVariant(ve && ve.node, shopCurrency)).filter(Boolean)
        : [];
      const tags = Array.isArray(node.tags) ? node.tags.slice(0, 20).map(String) : [];
      return {
        id: node.id,
        title: node.title,
        handle: node.handle,
        status: node.status,
        vendor: node.vendor || '',
        product_type: node.productType || '',
        tags,
        storefront_path: node.handle ? `/products/${node.handle}` : null,
        featured_image: node.featuredImage
          ? { url: node.featuredImage.url, alt_text: node.featuredImage.altText }
          : null,
        variants,
        variant_count: variants.length,
      };
    });
  return { products, count: products.length };
}

function shapeCatalogVariant(node) {
  if (!node || typeof node !== 'object') return null;
  const options = Array.isArray(node.selectedOptions)
    ? node.selectedOptions.map((o) => ({
        name: String(o?.name || ''),
        value: String(o?.value || ''),
      }))
    : [];
  const colourOption = options.find((o) => /colour|color/i.test(o.name));
  return {
    id: node.id,
    title: node.displayName || node.title || '',
    sku: node.sku || '',
    barcode: node.barcode || '',
    price: null,
    compare_at_price: null,
    available_for_sale: null,
    inventory_quantity: null,
    inventory_by_location: null,
    options,
    colour: colourOption?.value || null,
  };
}

/** Shape catalog GraphQL (no price/stock on variants). */
export function shapeCatalogProductSearchData(data) {
  const edges = data?.products?.edges;
  const shopCurrency = data?.shop?.currencyCode ?? null;
  if (!Array.isArray(edges)) return { products: [], count: 0, shopCurrency };
  const products = edges
    .map((e) => e && e.node)
    .filter(Boolean)
    .map((node) => {
      const vEdges = node.variants?.edges;
      const variants = Array.isArray(vEdges)
        ? vEdges.map((ve) => shapeCatalogVariant(ve && ve.node)).filter(Boolean)
        : [];
      const tags = Array.isArray(node.tags) ? node.tags.slice(0, 20).map(String) : [];
      return {
        id: node.id,
        title: node.title,
        handle: node.handle,
        status: node.status,
        vendor: node.vendor || '',
        product_type: node.productType || '',
        tags,
        storefront_path: node.handle ? `/products/${node.handle}` : null,
        featured_image: node.featuredImage
          ? { url: node.featuredImage.url, alt_text: node.featuredImage.altText }
          : null,
        variants,
        variant_count: variants.length,
      };
    });
  return { products, count: products.length, shopCurrency };
}

export function buildVolatileMapFromNodes(nodes, shopCurrency) {
  const map = new Map();
  if (!Array.isArray(nodes)) return map;
  for (const n of nodes) {
    if (!n || !n.id) continue;
    map.set(String(n.id), {
      price: shapeMoney(n.price, shopCurrency),
      compare_at_price: shapeMoney(n.compareAtPrice, shopCurrency),
      available_for_sale: Boolean(n.availableForSale),
      inventory_quantity:
        n.inventoryQuantity === null || n.inventoryQuantity === undefined
          ? null
          : Number(n.inventoryQuantity),
      inventory_by_location: shapeInventoryByLocation(n.inventoryItem),
    });
  }
  return map;
}

export function mergeVolatilePricingIntoProducts(products, volatileMap) {
  if (!volatileMap || volatileMap.size === 0) return;
  for (const p of products || []) {
    for (const v of p.variants || []) {
      if (!v?.id) continue;
      const row = volatileMap.get(String(v.id));
      if (!row) continue;
      v.price = row.price;
      v.compare_at_price = row.compare_at_price;
      v.available_for_sale = row.available_for_sale;
      v.inventory_quantity = row.inventory_quantity;
      v.inventory_by_location = Array.isArray(row.inventory_by_location) ? row.inventory_by_location : [];
    }
  }
}

function collectVariantIds(products) {
  const ids = [];
  for (const p of products || []) {
    for (const v of p.variants || []) {
      if (v?.id) ids.push(String(v.id));
    }
  }
  return ids;
}

async function fetchVariantsVolatileMap(ids, trace_id, shopCurrency) {
  const map = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += VARIANT_PRICING_CHUNK) {
    const chunk = unique.slice(i, i + VARIANT_PRICING_CHUNK);
    const result = await adminGraphql({
      query: QUERY_VARIANTS_VOLATILE,
      variables: { ids: chunk, inventoryLevelsFirst: INVENTORY_LEVELS_FIRST },
      trace_id,
    });
    if (!result.ok) {
      return { ok: false, result };
    }
    const partial = buildVolatileMapFromNodes(result.data?.nodes, shopCurrency);
    for (const [k, v] of partial) map.set(k, v);
  }
  return { ok: true, map };
}

/** Colour + non-colour options for voice-friendly stock lines (e.g. "Army Green, Large"). */
function variantStockDescriptor(variant) {
  const colour = variant.colour || null;
  const others = (variant.options || [])
    .filter((o) => !/colour|color/i.test(String(o?.name || '')))
    .map((o) => String(o?.value || '').trim())
    .filter(Boolean);
  const parts = [];
  if (colour) parts.push(colour);
  if (others.length) parts.push(others.join(', '));
  if (parts.length) return parts.join(', ');
  const t = String(variant.title || '').trim();
  if (t) return t;
  const sku = String(variant.sku || '').trim();
  return sku || 'variant';
}

/**
 * One product → rolled-up stock lines + single summary string for voice/LLM.
 * Example summary: "2x Brisbane · Army Green; 1x Burleigh · White"
 */
export function buildInventoryDisplayForProduct(product) {
  const lines = [];
  for (const v of product?.variants || []) {
    const descriptor = variantStockDescriptor(v);
    const variant_title = String(v.title || '').trim();
    const sku = String(v.sku || '').trim();
    const colour = v.colour || null;
    const locs = Array.isArray(v.inventory_by_location) ? v.inventory_by_location : [];

    if (locs.length > 0) {
      for (const loc of locs) {
        const qty = loc.available;
        if (qty === null || qty === undefined || Number(qty) <= 0) continue;
        lines.push({
          quantity: Number(qty),
          location_name: String(loc.location_name || '').trim(),
          colour,
          descriptor,
          variant_title,
          sku,
        });
      }
    } else {
      const iq = v.inventory_quantity;
      if (iq !== null && iq !== undefined && Number(iq) > 0) {
        lines.push({
          quantity: Number(iq),
          location_name: '',
          colour,
          descriptor,
          variant_title,
          sku,
          aggregate_only: true,
        });
      }
    }
  }

  const summary = lines
    .map((L) => {
      const place = L.aggregate_only
        ? 'all locations'
        : L.location_name || 'store';
      return `${L.quantity}x ${place} · ${L.descriptor}`.replace(/\s+/g, ' ').trim();
    })
    .join('; ');

  return { lines, summary };
}

function enrichProductsInventoryDisplay(products) {
  for (const p of products || []) {
    p.inventory_display = buildInventoryDisplayForProduct(p);
  }
}

/** Normalize LLM category hints for catalog search composition. */
export function normalizeProductCategory(value) {
  const v = String(value ?? 'all')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (!v || v === 'all' || v === 'any') return 'all';
  if (v === 'e_bike' || v === 'electric_bike' || v === 'bike' || v === 'ebikes') return 'ebike';
  if (v === 'ebike') return 'ebike';
  if (v === 'scooter' || v === 'scooters') return 'scooter';
  if (v === 'part' || v === 'parts' || v === 'accessory' || v === 'accessories' || v === 'spare') return 'part';
  return 'all';
}

function envCategoryFragment(category) {
  const key =
    category === 'part'
      ? 'SHOPIFY_SEARCH_FILTER_PART'
      : category === 'ebike'
        ? 'SHOPIFY_SEARCH_FILTER_EBIKE'
        : category === 'scooter'
          ? 'SHOPIFY_SEARCH_FILTER_SCOOTER'
          : null;
  if (!key) return '';
  return String(process.env[key] || '').trim();
}

/**
 * Build Shopify Admin `products(query: …)` string from LLM payload.
 * Uses optional category filters from env (store-specific product_type values).
 */
export function buildProductSearchShopifyQuery(payload) {
  const term = String(payload?.query ?? payload?.q ?? payload?.search ?? '').trim();
  const category = normalizeProductCategory(payload?.category ?? payload?.product_category);
  const override = String(payload?.category_query ?? payload?.category_filter ?? '').trim();
  const envFragment = category === 'all' ? '' : envCategoryFragment(category);
  const fragment = override || envFragment;

  const parts = [];
  if (term) parts.push(term);
  if (fragment) parts.push(`(${fragment})`);

  const q = parts.join(' AND ').trim();
  let category_filter_note = '';
  if (category !== 'all' && !fragment) {
    category_filter_note =
      'Category filter was requested but no Shopify fragment is configured. Set SHOPIFY_SEARCH_FILTER_PART, SHOPIFY_SEARCH_FILTER_EBIKE, or SHOPIFY_SEARCH_FILTER_SCOOTER on shopify-mcp to match this store product types—or pass payload.category_query.';
  }

  return {
    q,
    category,
    category_filter_applied: !!fragment,
    category_filter_note,
  };
}

export async function runShopifyOperation(operation, payload, trace_id) {
  const op = String(operation || '').trim().toLowerCase();
  if (op === 'connection_check' || op === 'ping' || op === 'shop_info') {
    if (!shopifyConfigured()) {
      return {
        ok: false,
        operation: 'connection_check',
        message: 'Shopify is not configured on the MCP service. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_API_ACCESS_TOKEN.',
        data: { configured: false },
      };
    }
    const bypass = normalizeCacheMode(payload) === 'bypass';
    if (!bypass && PING_CACHE_TTL_SEC > 0) {
      const hit = pingCacheGet();
      if (hit) {
        jsonLog({
          trace_id,
          span_id: trace_id,
          service: 'shopify-mcp',
          route: 'connection_check',
          cache_hit: true,
          ping_ttl_sec: PING_CACHE_TTL_SEC,
        });
        return JSON.parse(JSON.stringify(hit));
      }
    }
    const result = await adminGraphql({ query: QUERY_SHOP_PING, variables: {}, trace_id });
    if (!result.ok) {
      return {
        ok: false,
        operation: 'connection_check',
        message: 'Could not reach Shopify or GraphQL returned errors.',
        data: {
          status_code: result.status_code,
          error_code: result.error_code,
          graphql_errors: compactGraphqlErrors(result.graphql_errors),
        },
      };
    }
    const shop = result.data?.shop;
    const out = {
      ok: true,
      operation: 'connection_check',
      message: 'Connected to Shopify Admin API.',
      data: {
        configured: true,
        shop: shop
          ? {
              id: shop.id,
              name: shop.name,
              primary_domain_host: shop.primaryDomain?.host ?? null,
            }
          : null,
        api_version: SHOPIFY_API_VERSION,
      },
    };
    if (!bypass && PING_CACHE_TTL_SEC > 0) pingCacheSet(out, PING_CACHE_TTL_SEC);
    return out;
  }

  if (op === 'product_search' || op === 'products_search') {
    const built = buildProductSearchShopifyQuery(payload);
    const q = built.q;
    const firstRaw = Number(payload?.first ?? payload?.limit ?? DEFAULT_PRODUCTS_LIMIT);
    const first = Math.min(
      MAX_PRODUCTS,
      Math.max(1, Number.isFinite(firstRaw) ? firstRaw : DEFAULT_PRODUCTS_LIMIT),
    );
    const variantsFirstRaw = Number(payload?.variants_first ?? payload?.variantsFirst ?? MAX_VARIANTS_PER_PRODUCT);
    const variantsFirst = Math.min(
      MAX_VARIANTS_PER_PRODUCT,
      Math.max(1, Number.isFinite(variantsFirstRaw) ? variantsFirstRaw : MAX_VARIANTS_PER_PRODUCT),
    );
    if (!q) {
      return {
        ok: false,
        operation: 'product_search',
        message: 'product_search requires payload.search (or query/q): the customer/product text to find.',
        data: { error_code: 'missing_query' },
      };
    }
    if (!shopifyConfigured()) {
      return {
        ok: false,
        operation: 'product_search',
        message: 'Shopify is not configured on the MCP service.',
        data: { configured: false },
      };
    }
    const bypassCatalog = normalizeCacheMode(payload) === 'bypass';
    const ck = catalogCacheKey(q, first, variantsFirst);
    let catalogBundle = null;
    let catalogCacheHit = false;
    if (!bypassCatalog && CATALOG_CACHE_TTL_SEC > 0) {
      catalogBundle = catalogCacheGet(ck);
      if (catalogBundle) catalogCacheHit = true;
    }
    if (!catalogBundle) {
      const catResult = await adminGraphql({
        query: QUERY_PRODUCT_SEARCH_CATALOG,
        variables: { q, first, variantsFirst },
        trace_id,
      });
      if (!catResult.ok) {
        return {
          ok: false,
          operation: 'product_search',
          message: 'Product search failed against Shopify.',
          data: {
            status_code: catResult.status_code,
            error_code: catResult.error_code,
            graphql_errors: compactGraphqlErrors(catResult.graphql_errors),
          },
        };
      }
      catalogBundle = shapeCatalogProductSearchData(catResult.data);
      if (!bypassCatalog && CATALOG_CACHE_TTL_SEC > 0) {
        catalogCacheSet(ck, catalogBundle, CATALOG_CACHE_TTL_SEC);
      }
    }

    jsonLog({
      trace_id,
      span_id: trace_id,
      service: 'shopify-mcp',
      route: 'product_search',
      catalog_cache_hit: catalogCacheHit,
      catalog_ttl_sec: CATALOG_CACHE_TTL_SEC,
      variant_ids: collectVariantIds(catalogBundle.products).length,
    });

    const ids = collectVariantIds(catalogBundle.products);
    const products = JSON.parse(JSON.stringify(catalogBundle.products));
    if (ids.length > 0) {
      const vol = await fetchVariantsVolatileMap(ids, trace_id, catalogBundle.shopCurrency);
      if (!vol.ok) {
        const r = vol.result;
        return {
          ok: false,
          operation: 'product_search',
          message: 'Could not load live price and availability from Shopify.',
          data: {
            status_code: r?.status_code,
            error_code: r?.error_code || 'variant_pricing_failed',
            graphql_errors: compactGraphqlErrors(r?.graphql_errors || []),
          },
        };
      }
      mergeVolatilePricingIntoProducts(products, vol.map);
    }

    enrichProductsInventoryDisplay(products);

    const shaped = { products, count: products.length };
    return {
      ok: true,
      operation: 'product_search',
      message: `Found ${shaped.count} product(s). Variants include price, colours/options, availability, and inventory when Shopify exposes it.`,
      data: {
        ...shaped,
        query: q,
        shopify_query: q,
        search_term: String(payload?.query ?? payload?.q ?? payload?.search ?? '').trim(),
        category: built.category,
        category_filter_applied: built.category_filter_applied,
        ...(built.category_filter_note ? { category_filter_note: built.category_filter_note } : {}),
        first,
        variants_first: variantsFirst,
        llm_evidence_rule:
          'Prefer product.inventory_display.summary and inventory_display.lines for stock-by-location-and-colour wording (e.g. 2x Brisbane · Army Green). Also variants[].price for price; do not invent stock if lines/summary are empty. Use payload.category part|ebike|scooter (with env filters) or payload.category_query to separate bikes from parts.',
      },
    };
  }

  return {
    ok: false,
    operation: op || 'unknown',
    message: 'Unsupported Shopify MCP operation.',
    data: { error_code: 'unsupported_operation', allowed: ['connection_check', 'product_search'] },
  };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'shopify-mcp',
    shopify_configured: shopifyConfigured(),
    shop_domain_set: !!SHOPIFY_STORE_DOMAIN,
    api_version: SHOPIFY_API_VERSION,
  });
});

app.post('/execute', async (req, res) => {
  const trace_id = parseTraceId(req.headers['x-trace-id'] || req.body?.trace_id);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const operation = String(body.operation || '').trim();
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
  const out = await runShopifyOperation(operation, payload, trace_id);
  return res.status(out.ok ? 200 : 502).json({
    ok: out.ok,
    trace_id,
    operation: out.operation,
    message: out.message,
    data: out.data,
  });
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, '0.0.0.0', () => {
    jsonLog({ level: 'info', msg: 'shopify-mcp listening', port: PORT, service: 'shopify-mcp' });
  });
}

export { normalizeShopDomain, MAX_PRODUCTS, MAX_VARIANTS_PER_PRODUCT, shapeProductSearchData };
