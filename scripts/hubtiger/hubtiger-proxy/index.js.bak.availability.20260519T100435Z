/**
 * Hubtiger Proxy — internal module. Control-plane calls this; proxy calls Hubtiger API.
 * Env: HUBTIGER_BASE_URL, HUBTIGER_API_KEY, DATABASE_URL (optional, for request_logs)
 * Port: 8095 (internal only)
 * Logging: trace_id, span_id, service=hubtiger-proxy, route, start_ts, end_ts, latency_ms, status, error, upstream_*
 */
import express from 'express';
import crypto from 'crypto';
import pg from 'pg';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.HUBTIGER_PROXY_PORT || 8095);
const API_KEY = process.env.HUBTIGER_API_KEY || '';
const AUTH_HEADER = process.env.HUBTIGER_AUTH_HEADER || 'x-api-key';
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : null;

const AUTH_MODE = String(process.env.HUBTIGER_AUTH_MODE || '').trim().toLowerCase();
// Portal mode (Azure portal APIs). When enabled, job search uses hubtigerservices JobCardSearch instead of REST /jobs/search.
const PORTAL_MODE =
  /^(1|true|yes)$/i.test(process.env.HUBTIGER_PORTAL_MODE || '') || AUTH_MODE === 'portal';
const HUBTIGER_SERVICES_URL = (process.env.HUBTIGER_SERVICES_URL || 'https://hubtigerservices.azurewebsites.net').replace(/\/$/, '');
const HUBTIGER_API_URL = (process.env.HUBTIGER_API_URL || 'https://hubtiger-api.azurewebsites.net').replace(/\/$/, '');
// REST forwards (non-portal): use explicit HUBTIGER_BASE_URL when set; otherwise fallback to HUBTIGER_API_URL.
const BASE_URL = (process.env.HUBTIGER_BASE_URL || HUBTIGER_API_URL).replace(/\/$/, '');
const HUBTIGER_PARTNER_ID = process.env.HUBTIGER_PARTNER_ID || '';
const HUBTIGER_FUNCTION_CODE =
  process.env.HUBTIGER_FUNCTION_CODE || process.env.HUBTIGER_API_CODE || '';
const HUBTIGER_LEGACY_TOKEN = process.env.HUBTIGER_LEGACY_TOKEN || '';
const HUB_USER =
  process.env.HUB_USER ||
  process.env.HUBTIGER_PORTAL_USERNAME ||
  process.env.HUBTIGER_USERNAME ||
  '';
const HUB_PASS =
  process.env.HUB_PASS ||
  process.env.HUBTIGER_PORTAL_PASSWORD ||
  process.env.HUBTIGER_PASSWORD ||
  '';
const HUBTIGER_CREATED_BY_USER_ID = String(process.env.HUBTIGER_CREATED_BY_USER_ID || '').trim();
const HUBTIGER_POS_URL = (process.env.HUBTIGER_POS_URL || 'https://hubtiger-pos.azurewebsites.net').replace(/\/$/, '');
const BOOKING_TIMEZONE = process.env.HUBTIGER_BOOKING_TIMEZONE || 'Australia/Brisbane';
const PLACEHOLDER_TECHNICIAN_LABELS = new Set([
  'burleigh store',
  'burleigh build',
  'ride electric brisbane',
  'southport',
  'southport builds',
]);
const PRODUCTS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_JOB_SEARCH_CHARS = Number(process.env.HUBTIGER_MAX_JOB_SEARCH_CHARS || 96);
const MAX_PRODUCT_SEARCH_CHARS = Number(process.env.HUBTIGER_MAX_PRODUCT_SEARCH_CHARS || 96);
const MAX_SEARCH_RESULTS = Number(process.env.HUBTIGER_MAX_SEARCH_RESULTS || 25);
const MAX_AVAILABILITY_ROWS = Number(process.env.HUBTIGER_MAX_AVAILABILITY_ROWS || 25);
const SERVICE_STATUS_LABELS = {
  10: 'Pick Ups',
  20: 'Booked In',
  30: 'Waiting for Work',
  40: 'Waiting - Client',
  50: 'Waiting - Parts',
  60: 'Same day repair',
  70: 'Need Advice',
  80: 'Working On',
  90: 'Bike Ready',
  100: 'Collected',
  110: 'Deliveries',
  120: 'Fitting booked in',
  130: 'Fitting completed',
};

let portalTokenCache = { legacyToken: null, token: null };
let productsCatalogCache = {
  fetchedAt: 0,
  rows: [],
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseTraceId(header) {
  const v = (header || '').trim();
  return v && UUID_REGEX.test(v) ? v : crypto.randomUUID();
}

function jsonLog(obj) {
  console.log(JSON.stringify(obj));
}

export const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const trace_id = parseTraceId(req.headers['x-trace-id']);
  const span_id = crypto.randomUUID();
  req.trace_id = trace_id;
  req.span_id = span_id;
  res.setHeader('x-trace-id', trace_id);
  res.setHeader('x-span-id', span_id);
  next();
});

async function proxyToHubtiger(req, res, method, upstreamPath, body = null) {
  const start = Date.now();
  const start_ts = new Date().toISOString();
  const route = `${req.method} ${req.originalUrl}`;

  const url = `${BASE_URL}${upstreamPath}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-trace-id': req.trace_id,
  };
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
    headers[AUTH_HEADER] = API_KEY;
  }

  let upstreamStatus = null;
  let upstreamLatency = null;

  try {
    const upstreamStart = Date.now();
    const fetchOpts = { method, headers };
    if (body && (method === 'POST' || method === 'PUT')) fetchOpts.body = JSON.stringify(body);
    const response = await fetch(url, fetchOpts);
    upstreamLatency = Date.now() - upstreamStart;
    upstreamStatus = response.status;

    const end_ts = new Date().toISOString();
    const latency_ms = Date.now() - start;
    let responseBody = null;
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try {
        responseBody = await response.json();
      } catch {
        responseBody = { _raw: await response.text() };
      }
    }

    const meta = { upstream_path: upstreamPath, upstream_status: upstreamStatus, upstream_latency_ms: upstreamLatency };
    jsonLog({ level: 'info', trace_id: req.trace_id, span_id: req.span_id, service: 'hubtiger-proxy', route, start_ts, end_ts, latency_ms, status: response.status, error: response.ok ? null : String(response.status), ...meta });
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.trace_id, req.span_id, 'hubtiger-proxy', route, start_ts, end_ts, latency_ms, response.status, response.ok ? null : String(response.status), JSON.stringify(meta)]
        );
      } catch (_) {}
    }

    res.status(response.status).setHeader('Content-Type', 'application/json');
    if (responseBody !== null) res.json(responseBody);
    else res.end();
  } catch (err) {
    upstreamLatency = Date.now() - start;
    const end_ts = new Date().toISOString();
    const latency_ms = Date.now() - start;
    const meta = { upstream_path: upstreamPath, upstream_status: upstreamStatus, upstream_latency_ms: upstreamLatency };
    jsonLog({ level: 'info', trace_id: req.trace_id, span_id: req.span_id, service: 'hubtiger-proxy', route, start_ts, end_ts, latency_ms, status: 502, error: String(err && err.message || err), ...meta });
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.trace_id, req.span_id, 'hubtiger-proxy', route, start_ts, end_ts, latency_ms, 502, String(err && err.message || err), JSON.stringify(meta)]
        );
      } catch (_) {}
    }
    res.setHeader('x-error', 'upstream_request_failed');
    res.status(502).json({ error: 'upstream_request_failed', message: String(err && err.message || err) });
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'hubtiger-proxy',
    portalMode: PORTAL_MODE,
    authMode: AUTH_MODE || null,
    restForwardBaseUrl: BASE_URL,
    hubtigerApiUrl: HUBTIGER_API_URL,
    portalConfigured: PORTAL_MODE && !!HUBTIGER_PARTNER_ID && !!HUBTIGER_FUNCTION_CODE,
    portalAutoLogin: PORTAL_MODE && !!(HUB_USER && HUB_PASS),
    hasApiKey: !!API_KEY,
    hasPartnerId: !!HUBTIGER_PARTNER_ID,
    hasFunctionCode: !!HUBTIGER_FUNCTION_CODE,
    hasCreatedByUserId: !!HUBTIGER_CREATED_BY_USER_ID,
  });
});

async function portalLogin() {
  const loginUrl = `${HUBTIGER_API_URL}/api/Auth/ValidateLogin?code=${encodeURIComponent(HUBTIGER_FUNCTION_CODE)}`;
  // Portal expects Content-Type application/x-www-form-urlencoded but body is a raw JSON string.
  const body = JSON.stringify({ username: HUB_USER, password: HUB_PASS, skipped: false });
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    throw new Error(`Portal login failed (${response.status}): ${txt.slice(0, 500)}`);
  }
  const json = await response.json().catch(() => null);
  const token = json && (json.legacyToken || json.token);
  if (!token) throw new Error('Portal login response missing token');
  portalTokenCache = { token: json.token || null, legacyToken: json.legacyToken || json.token || null };
  return portalTokenCache.legacyToken;
}

async function getPortalLegacyToken(forceRefresh = false) {
  const canAutoLogin = !!(HUB_USER && HUB_PASS);
  if (canAutoLogin) {
    if (!forceRefresh && portalTokenCache.legacyToken) return portalTokenCache.legacyToken;
    return portalLogin();
  }
  if (HUBTIGER_LEGACY_TOKEN) return HUBTIGER_LEGACY_TOKEN;
  throw new Error('Portal auth missing: set HUB_USER and HUB_PASS (or HUBTIGER_LEGACY_TOKEN)');
}

async function getPortalBearerToken(forceRefresh = false) {
  const canAutoLogin = !!(HUB_USER && HUB_PASS);
  if (canAutoLogin) {
    if (!forceRefresh && (portalTokenCache.token || portalTokenCache.legacyToken)) {
      return portalTokenCache.token || portalTokenCache.legacyToken;
    }
    await portalLogin();
    return portalTokenCache.token || portalTokenCache.legacyToken;
  }
  if (HUBTIGER_LEGACY_TOKEN) return HUBTIGER_LEGACY_TOKEN;
  throw new Error('Portal auth missing: set HUB_USER and HUB_PASS (or HUBTIGER_LEGACY_TOKEN)');
}

export function buildPortalJobSearchRequest({ query, allStores = false, partnerId = HUBTIGER_PARTNER_ID } = {}) {
  const compactQuery = compactSearchText(query, MAX_JOB_SEARCH_CHARS);
  const parsedPartnerId = Number(partnerId);
  if (!compactQuery) return null;
  if (!Number.isFinite(parsedPartnerId) || parsedPartnerId <= 0) return null;
  return {
    url: `${HUBTIGER_SERVICES_URL}/api/ServiceRequest/JobCardSearch`,
    payload: {
      PartnerID: parsedPartnerId,
      Search: compactQuery,
      SearchAllStores: allStores === true,
    },
    headers: {
      'Content-Type': 'application/json',
    },
  };
}

export function mapPortalSearchItem(item) {
  const scheduledDate = item.ScheduledDate ?? item.DateScheduled ?? item.StartDate ?? item.BookingDate ?? item.BookedDate ?? item.SlotStart ?? item.DateCheckedIn ?? item.UpdatedDate;
  const durationMinutes = item.DurationMinutes ?? item.Duration ?? item.EstimatedDuration ?? item.EstimatedDurationMinutes ?? item.DurationMins ?? item.BookingDuration;
  const statusCode = Number(item.StatusID ?? 0) || null;
  const statusLabel = mapServiceStatusLabel(statusCode, item.StatusDescription || null);
  const combinedCustomerName = normalizeWhitespace(`${item.Name || ''} ${item.Surname || ''}`);
  return {
    id: item.ID,
    jobCardNo: item.JobCardNo || item.JobCardID?.toString(),
    customerName: item.CyclistDescription || combinedCustomerName || 'Unknown',
    bike: item.BikeDescription || 'Unknown Bike',
    status: statusLabel || item.StatusID?.toString() || 'Unknown',
    statusCode,
    statusLabel: statusLabel || null,
    lastUpdated: item.DateCheckedIn || item.UpdatedDate,
    scheduledDate: scheduledDate ?? undefined,
    durationMinutes: durationMinutes != null && durationMinutes !== '' ? Number(durationMinutes) : undefined
  };
}

function buildQuery(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  return usp;
}

function parsePositiveInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function mapServiceStatusLabel(statusId, fallbackDescription = null) {
  if (fallbackDescription && String(fallbackDescription).trim()) return String(fallbackDescription).trim();
  const parsed = Number(statusId);
  if (Number.isFinite(parsed) && SERVICE_STATUS_LABELS[parsed]) return SERVICE_STATUS_LABELS[parsed];
  return null;
}

function normalizeWhitespace(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function compactSearchText(input, maxChars) {
  const compact = normalizeWhitespace(input);
  if (!compact) return '';
  return compact.slice(0, Math.max(8, Number(maxChars) || 96));
}

function parseNoteLines(input) {
  const raw = String(input || '').replace(/<br\s*\/?>/gi, '\n').replace(/\r/g, '\n');
  return raw
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0);
}

function buildJobMemoryPayload(job) {
  const statusCode = Number(job?.StatusID ?? job?.statusId ?? 0) || null;
  const statusLabel = mapServiceStatusLabel(statusCode, job?.StatusDescription ?? job?.statusDescription ?? null);
  const internalNotes = parseNoteLines(job?.PostServiceInspection_Notes ?? job?.postServiceInspectionNotes ?? '');
  const externalNotes = parseNoteLines(job?.InitialAssesment_Notes ?? job?.initialAssesmentNotes ?? '');
  return {
    customer: {
      id: job?.CyclistID ?? job?.cyclistId ?? null,
      name: normalizeWhitespace(`${job?.Name || ''} ${job?.Surname || ''}`) || (job?.CyclistDescription ?? null),
      phone: job?.PhoneNumber ?? null,
      email: job?.Email ?? null,
    },
    bike: {
      id: job?.BikeID ?? null,
      description: job?.BikeDescription ?? null,
    },
    job: {
      id: job?.ID ?? null,
      jobCardNo: job?.JobCardNo ?? job?.JobCardID ?? null,
      statusCode,
      statusLabel,
      technicianId: job?.TechnicianID ?? null,
      technicianName: job?.TechnicianDescription ?? null,
      dateCheckedIn: job?.DateCheckedIn ?? null,
      dateRequiredBy: job?.DateRequiredBy ?? null,
      priceEstimate: job?.PriceEstimate ?? null,
    },
    notes: {
      internal: internalNotes,
      external: externalNotes,
    },
  };
}

function isValidPortalPath(v) {
  return typeof v === 'string' && v.startsWith('/api/');
}

function portalApiUrl(path, query = {}) {
  const qs = buildQuery({ ...query, code: query.code ?? HUBTIGER_FUNCTION_CODE });
  return `${HUBTIGER_API_URL}${path}?${qs.toString()}`;
}

function portalServicesUrl(path, query = {}) {
  const qs = buildQuery(query);
  const suffix = qs.toString();
  return suffix ? `${HUBTIGER_SERVICES_URL}${path}?${suffix}` : `${HUBTIGER_SERVICES_URL}${path}`;
}

async function parseUpstreamBody(response) {
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) return response.json().catch(() => null);
  const txt = await response.text().catch(() => '');
  return txt ? { _raw: txt } : null;
}

async function fetchProductsCatalogFromUpstream() {
  const url = `${HUBTIGER_POS_URL}/api/${encodeURIComponent(HUBTIGER_PARTNER_ID)}/products/sync/incremental/immediate`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { PartnerID: String(HUBTIGER_PARTNER_ID), 'Content-Type': 'application/json' },
  });
  const data = await parseUpstreamBody(response);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      data,
      rows: [],
    };
  }
  const rows = Array.isArray(data) ? data : [];
  return {
    ok: true,
    status: response.status,
    data,
    rows,
  };
}

async function getProductsCatalogSnapshot({ forceRefresh = false } = {}) {
  const now = Date.now();
  const cacheAgeMs = now - productsCatalogCache.fetchedAt;
  const hasWarmCache = Array.isArray(productsCatalogCache.rows) && productsCatalogCache.rows.length > 0;
  const cacheFresh = hasWarmCache && cacheAgeMs < PRODUCTS_CACHE_TTL_MS;

  if (!forceRefresh && cacheFresh) {
    return {
      rows: productsCatalogCache.rows,
      cache: { hit: true, stale: false, ageMs: cacheAgeMs, ttlMs: PRODUCTS_CACHE_TTL_MS },
    };
  }

  const upstream = await fetchProductsCatalogFromUpstream();
  if (upstream.ok) {
    productsCatalogCache = {
      fetchedAt: now,
      rows: upstream.rows,
    };
    return {
      rows: upstream.rows,
      cache: { hit: false, stale: false, ageMs: 0, ttlMs: PRODUCTS_CACHE_TTL_MS },
    };
  }

  // Graceful fallback: stale cache is better than complete failure for quick quote-template lookup.
  if (hasWarmCache) {
    return {
      rows: productsCatalogCache.rows,
      cache: {
        hit: true,
        stale: true,
        ageMs: cacheAgeMs,
        ttlMs: PRODUCTS_CACHE_TTL_MS,
        upstream_status: upstream.status,
      },
    };
  }

  const err = new Error('portal_products_sync_failed');
  err.upstream_status = upstream.status;
  err.upstream_data = upstream.data;
  throw err;
}

function buildSkuQueryVariants(input) {
  const clean = normalizeWhitespace(input).toLowerCase();
  if (!clean) return [];
  const variants = new Set([clean]);
  const singular = clean.replace(/\bpads\b/g, 'pad').replace(/\bcontrollers\b/g, 'controller');
  variants.add(singular);
  variants.add(singular.replace(/[^\w\s+-]/g, '').trim());
  const tokens = singular.split(' ').filter(Boolean);
  if (tokens.length > 2) {
    variants.add(tokens.slice(0, 3).join(' '));
    variants.add(tokens.slice(-3).join(' '));
  }
  if (singular.includes('controller')) {
    variants.add('controller');
    if (tokens.includes('zero') && tokens.includes('11x')) variants.add('zero 11x controller');
    if (tokens.includes('vsett') && tokens.includes('apex')) variants.add('vsett apex controller');
  }
  if (singular.includes('brake')) {
    variants.add('brake');
    variants.add('brake pad');
    variants.add('brake caliper');
  }
  return Array.from(variants).filter((v) => v.length >= 3).slice(0, 8);
}

function mapProductHit(p, source, queryUsed = null) {
  return {
    id: p.ID ?? p.id ?? null,
    externalProductId: p.ExternalProductID ?? p.externalProductId ?? p.SKU ?? null,
    sku: p.SKU ?? p.sku ?? (typeof p.Description === 'string' && /^\d+$/.test(p.Description) ? p.Description : null),
    name: p.Name ?? p.Data ?? p.name ?? null,
    description: p.Description ?? p.description ?? p.Data ?? null,
    unitPrice: p.UnitPrice ?? p.unitPrice ?? null,
    unitPriceIncludingTax: p.UnitPrice_IncludingTax ?? p.unitPriceIncludingTax ?? null,
    tax: p.Tax ?? p.tax ?? null,
    brand: p.Brand ?? p.brand ?? null,
    internalProductId: p.InternalProductID ?? p.internalProductId ?? null,
    source,
    queryUsed,
  };
}

async function searchProductsSmart(query, limit = 25) {
  const q = normalizeWhitespace(query);
  const variants = buildSkuQueryVariants(q);
  const attempts = [];
  for (const variant of variants) {
    const { response, data } = await portalFetch({
      api: 'services',
      path: '/api/Partner/lstSKUAutocompleteLookupV2',
      method: 'POST',
      body: { ID: Number(HUBTIGER_PARTNER_ID), SKU: variant },
      auth: 'bearer',
    });
    const products = Array.isArray(data?.products) ? data.products : [];
    attempts.push({ variant, status: response.status, count: products.length });
    if (response.ok && products.length > 0) {
      const mapped = products.map((p) => mapProductHit(p, 'sku_autocomplete_v2', variant)).slice(0, limit);
      return { ok: true, results: mapped, attempts, source: 'sku_autocomplete_v2' };
    }
  }

  // Fallback to cached catalog search if SKU autocomplete returns nothing.
  const snapshot = await getProductsCatalogSnapshot({ forceRefresh: false });
  const needle = q.toLowerCase();
  const fallback = snapshot.rows
    .filter((p) => `${p.Name || ''} ${p.Description || ''} ${p.SKU || ''}`.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((p) => mapProductHit(p, 'catalog_cache', q));
  return { ok: true, results: fallback, attempts, source: 'catalog_cache', cache: snapshot.cache };
}

async function getInvoiceForService(serviceId) {
  const { response, data } = await portalFetch({
    api: 'services',
    path: `/api/ServiceRequest/${encodeURIComponent(serviceId)}/GetInvoice`,
    method: 'GET',
    query: { getFromPOS: 'false' },
    auth: 'bearer',
  });
  if (!response.ok || !data || !data.ID) {
    const err = new Error('invoice_lookup_failed');
    err.upstream_status = response.status;
    err.upstream_data = data;
    throw err;
  }
  return data;
}

function buildInvoiceLineItemFromProduct(product, invoiceId, quantity = 1) {
  const qty = Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : 1;
  const unitEx = Number(product.unitPrice ?? 0);
  const unitInc = Number(product.unitPriceIncludingTax ?? unitEx);
  const tax = Number(product.tax ?? Math.max(unitInc - unitEx, 0));
  return {
    ID: 0,
    ExternalProductID: product.externalProductId ?? null,
    SKU: product.sku ?? null,
    Name: product.name ?? product.description ?? 'Quoted part',
    Description: product.description ?? product.name ?? 'Quoted part',
    ManufacturerSKU: '',
    Brand: product.brand ?? '',
    SystemSKU: '',
    UPC: '',
    UnitPrice: unitEx,
    UnitPrice_IncludingTax: unitInc,
    Tax: tax,
    EAN: '',
    CustomSKU: null,
    Quantity: qty,
    Discount: 0,
    DiscountID: 0,
    FoundInPOS: true,
    OriginalUnitPrice: unitEx,
    Price: unitEx,
    LightSpeedDiscounts: [],
    InternalProductID: product.internalProductId ?? null,
    InvoiceID: Number(invoiceId),
  };
}

async function portalFetch({
  api = 'api',
  path,
  method = 'GET',
  query = {},
  body = null,
  auth = 'none',
}) {
  const url = api === 'services' ? portalServicesUrl(path, query) : portalApiUrl(path, query);
  const headers = { 'Content-Type': 'application/json', PartnerID: String(HUBTIGER_PARTNER_ID) };
  let primaryBearer = null;
  let alternateBearer = null;
  if (auth === 'bearer') {
    primaryBearer = await getPortalBearerToken();
    alternateBearer = portalTokenCache.legacyToken && portalTokenCache.legacyToken !== primaryBearer
      ? portalTokenCache.legacyToken
      : null;
    headers.Authorization = `Bearer ${primaryBearer}`;
  }
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  let response = await fetch(url, opts);
  let data = await parseUpstreamBody(response);
  const bearerProblem = (res, payload) =>
    res.status === 401 ||
    (res.status === 400 &&
      (
        (typeof payload?._raw === 'string' && payload._raw.toLowerCase().includes('invalid bearer token')) ||
        (typeof payload?.message === 'string' && payload.message.toLowerCase().includes('invalid bearer token')) ||
        (typeof payload?.Message === 'string' && payload.Message.toLowerCase().includes('authorization has been denied'))
      ));
  const endpointLooksBearerFragile = () =>
    api === 'services' &&
    (
      String(path || '').startsWith('/api/Invoice/LineItem') ||
      String(path || '').startsWith('/api/Partner/lstSKUAutocompleteLookupV2') ||
      String(path || '').startsWith('/api/Partner/v3/ScheduleService') ||
      String(path || '').startsWith('/api/ServiceRequest/UpdateJobcardSlot')
    );
  const bearerLooksWrongOn500 = (res, payload) =>
    endpointLooksBearerFragile() &&
    res.status >= 500 &&
    (payload === null || payload === undefined || payload?._raw === '');
  const shouldRetryBearer = (res, payload) =>
    bearerProblem(res, payload) || bearerLooksWrongOn500(res, payload);

  if (auth === 'bearer' && shouldRetryBearer(response, data)) {
    // Some Hubtiger endpoints accept one bearer flavor and reject the other.
    if (alternateBearer) {
      const retryHeaders = { ...headers, Authorization: `Bearer ${alternateBearer}` };
      const retryOpts = { method, headers: retryHeaders };
      if (body && method !== 'GET') retryOpts.body = JSON.stringify(body);
      response = await fetch(url, retryOpts);
      data = await parseUpstreamBody(response);
    }
    if (shouldRetryBearer(response, data) && HUB_USER && HUB_PASS) {
      portalTokenCache = { legacyToken: null, token: null };
      await portalLogin();
      const refreshedPrimary = portalTokenCache.token || portalTokenCache.legacyToken || primaryBearer;
      const refreshedAlt = portalTokenCache.legacyToken && portalTokenCache.legacyToken !== refreshedPrimary
        ? portalTokenCache.legacyToken
        : null;
      const retryHeaders2 = { ...headers, Authorization: `Bearer ${refreshedPrimary}` };
      const retryOpts2 = { method, headers: retryHeaders2 };
      if (body && method !== 'GET') retryOpts2.body = JSON.stringify(body);
      response = await fetch(url, retryOpts2);
      data = await parseUpstreamBody(response);
      if (shouldRetryBearer(response, data) && refreshedAlt) {
        const retryHeaders3 = { ...headers, Authorization: `Bearer ${refreshedAlt}` };
        const retryOpts3 = { method, headers: retryHeaders3 };
        if (body && method !== 'GET') retryOpts3.body = JSON.stringify(body);
        response = await fetch(url, retryOpts3);
        data = await parseUpstreamBody(response);
      }
    }
  }
  return { response, data, url };
}

function parseDateTokenToIso(dateToken, hhmm) {
  const d = String(dateToken || '').trim();
  const t = String(hhmm || '').trim();
  if (!/^\d{8}$/.test(d) || !/^\d{2}:\d{2}$/.test(t)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t}:00`;
}
function getZonedDateTimeParts(date, timeZone = BOOKING_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const dateToken = `${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  return { year, month, day, hour, minute, dateToken };
}
function parseHHMMToMinutes(hhmm) {
  const value = String(hhmm || '').trim();
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const h = Number(value.slice(0, 2));
  const m = Number(value.slice(3, 5));
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}
function minutesToHHMM(totalMinutes) {
  const mins = Math.max(0, Math.min(23 * 60 + 59, Number(totalMinutes) || 0));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function roundUpQuarterMinutes(mins) {
  const n = Number(mins) || 0;
  const rem = n % 15;
  return rem === 0 ? n : n + (15 - rem);
}
function dateTokenPlusDays(dateToken, days) {
  const y = Number(String(dateToken).slice(0, 4));
  const m = Number(String(dateToken).slice(4, 6));
  const d = Number(String(dateToken).slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = dt.getUTCMonth() + 1;
  const dd = dt.getUTCDate();
  return `${String(yy).padStart(4, '0')}${String(mm).padStart(2, '0')}${String(dd).padStart(2, '0')}`;
}
function weekdayFromDateToken(dateToken) {
  const y = Number(String(dateToken).slice(0, 4));
  const m = Number(String(dateToken).slice(4, 6));
  const d = Number(String(dateToken).slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
}
function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function normalizeLabel(value) {
  return normalizeSpaces(value).toLowerCase();
}
function technicianLabel(row) {
  return normalizeSpaces([row?.name, row?.surname].filter(Boolean).join(' '));
}
function isPlaceholderTechnician(row) {
  return PLACEHOLDER_TECHNICIAN_LABELS.has(normalizeLabel(technicianLabel(row)));
}
function normalizeStoreSelection(value) {
  const v = normalizeLabel(value);
  if (!v) return null;
  if (v.includes('brisbane') || v.includes('newstead')) return 'brisbane';
  if (v.includes('southport')) return 'southport';
  if (v.includes('burleigh')) return 'burleigh';
  return null;
}
function inferStoreFromTechnician(row) {
  const label = normalizeLabel(technicianLabel(row));
  if (!label) return null;
  if (label.includes('southport')) return 'southport';
  if (label.includes('burleigh')) return 'burleigh';
  if (label.includes('brisbane') || label.includes('newstead')) return 'brisbane';
  if (label.startsWith('kim') || label.startsWith('hassler')) return 'brisbane';
  return null;
}
function isBrisbaneMechanic(row) {
  const label = normalizeLabel(technicianLabel(row));
  return label.startsWith('kim') || label.startsWith('hassler');
}

function toDateOnlyIso(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function addDays(dateIso, days) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toUtcStart(dateIso) {
  return `${dateIso}T00:00:00.000Z`;
}

function inferStoreName(technicianLabel) {
  const label = String(technicianLabel || '').toLowerCase();
  if (label.includes('burleigh')) return 'Burleigh';
  if (label.includes('southport')) return 'Southport';
  if (label.includes('brisbane')) return 'Brisbane';
  if (label.includes('warehouse')) return 'Warehouse';
  return String(technicianLabel || '').trim() || 'Unknown';
}

function findEarliestAvailability(rows, requiredMinutes = 60, now = new Date(), options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const minRequired = parsePositiveInt(requiredMinutes, 60);
  const selectedStore = normalizeStoreSelection(options.store);
  const businessStartMin = 9 * 60;
  const businessEndMin = 17 * 60;

  // Minimum booking lead time is 30 minutes from call time, evaluated in workshop timezone.
  let leadInstant = new Date(now.getTime() + 30 * 60 * 1000);
  const leadPartsPreRound = getZonedDateTimeParts(leadInstant);
  const extraToQuarter = (15 - (leadPartsPreRound.minute % 15)) % 15;
  if (extraToQuarter > 0) {
    leadInstant = new Date(leadInstant.getTime() + (extraToQuarter * 60 * 1000));
  }
  const leadParts = getZonedDateTimeParts(leadInstant);
  let minLeadDateToken = leadParts.dateToken;
  let minLeadMinutes = leadParts.hour * 60 + leadParts.minute;
  if (minLeadMinutes >= 24 * 60) {
    minLeadDateToken = dateTokenPlusDays(minLeadDateToken, 1);
    minLeadMinutes -= 24 * 60;
  }

  const candidates = rows
    .filter((r) => !isPlaceholderTechnician(r))
    .filter((r) => {
      if (!selectedStore) return true;
      if (selectedStore === 'brisbane') return isBrisbaneMechanic(r);
      const inferred = inferStoreFromTechnician(r);
      return inferred ? inferred === selectedStore : true;
    })
    .filter((r) => Number(r?.roundedAvailableTime) >= minRequired)
    .map((r) => {
      const dateToken = String(r?.date || '').trim();
      const shiftStartMin = parseHHMMToMinutes(r?.startTime);
      const shiftEndMin = parseHHMMToMinutes(r?.endTime);
      if (!/^\d{8}$/.test(dateToken) || shiftStartMin == null || shiftEndMin == null || shiftEndMin <= shiftStartMin) return null;

      // Only Monday to Saturday.
      const weekday = weekdayFromDateToken(dateToken);
      if (weekday === 0) return null;

      // Only future dates/times.
      if (dateToken < minLeadDateToken) return null;

      let slotFloorMin = Math.max(shiftStartMin, businessStartMin);
      if (dateToken === minLeadDateToken) {
        slotFloorMin = Math.max(slotFloorMin, minLeadMinutes);
      }
      slotFloorMin = roundUpQuarterMinutes(slotFloorMin);

      const slotCeilingMin = Math.min(shiftEndMin, businessEndMin);
      if (slotFloorMin >= slotCeilingMin) return null;

      const slotEndMin = slotFloorMin + minRequired;
      if (slotEndMin > slotCeilingMin) return null;

      const slotStartHHMM = minutesToHHMM(slotFloorMin);
      const slotEndHHMM = minutesToHHMM(slotEndMin);
      const inferredStore = inferStoreFromTechnician(r);

      return {
        technicianId: r.id,
        technicianName: [r.name, r.surname].filter(Boolean).join(' ').trim() || String(r.id),
        store: inferredStore,
        date: dateToken,
        startTime: slotStartHHMM,
        endTime: slotEndHHMM,
        shiftStartTime: r.startTime || null,
        shiftEndTime: r.endTime || null,
        availableMinutes: Number(r.roundedAvailableTime || 0),
        slotStart: parseDateTokenToIso(dateToken, slotStartHHMM),
        slotEnd: parseDateTokenToIso(dateToken, slotEndHHMM),
        confirmedAvailable: true,
        bookingTimezone: BOOKING_TIMEZONE,
      };
    })
    .filter(Boolean);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.slotStart < b.slotStart) return -1;
    if (a.slotStart > b.slotStart) return 1;
    return b.availableMinutes - a.availableMinutes;
  });
  return candidates[0];
}

async function portalSearchJobs(req, res) {
  const start = Date.now();
  const start_ts = new Date().toISOString();
  const route = `${req.method} ${req.originalUrl}`;
  const body = req.body || {};
  const q = typeof body.q === 'string' ? compactSearchText(body.q, MAX_JOB_SEARCH_CHARS) : '';
  const query = q || (typeof body.query === 'string' ? compactSearchText(body.query, MAX_JOB_SEARCH_CHARS) : '');
  const allStores = body.allStores === true;
  if (!query) return res.status(400).json({ ok: false, error: 'missing_query' });
  const upstreamRequest = buildPortalJobSearchRequest({ query, allStores });
  if (!upstreamRequest) return res.status(503).json({ ok: false, error: 'portal_not_configured' });

  let response;
  try {
    response = await fetch(upstreamRequest.url, {
      method: 'POST',
      headers: upstreamRequest.headers,
      body: JSON.stringify(upstreamRequest.payload),
    });
  } catch (e) {
    const end_ts = new Date().toISOString();
    const latency_ms = Date.now() - start;
    jsonLog({
      level: 'info',
      trace_id: req.trace_id,
      span_id: req.span_id,
      service: 'hubtiger-proxy',
      route,
      start_ts,
      end_ts,
      latency_ms,
      status: 502,
      error: String(e?.message || e),
      upstream_path: '/api/ServiceRequest/JobCardSearch',
      upstream_status: null,
      auth_mode: 'none',
    });
    return res.status(502).json({ ok: false, error: 'portal_search_failed', message: String(e?.message || e) });
  }

  const end_ts = new Date().toISOString();
  const latency_ms = Date.now() - start;
  jsonLog({
    level: 'info',
    trace_id: req.trace_id,
    span_id: req.span_id,
    service: 'hubtiger-proxy',
    route,
    start_ts,
    end_ts,
    latency_ms,
    status: response.status,
    error: response.ok ? null : String(response.status),
    upstream_path: '/api/ServiceRequest/JobCardSearch',
    upstream_status: response.status,
    auth_mode: 'none',
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    return res.status(502).json({ ok: false, error: 'portal_search_failed', status: response.status, message: txt.slice(0, 500) });
  }
  const json = await response.json().catch(() => null);
  const list = Array.isArray(json) ? json : (json && (json.results || json.matches)) || [];
  const matches = list.map(mapPortalSearchItem).slice(0, Math.max(1, MAX_SEARCH_RESULTS));
  return res.json({ ok: true, matches, results: matches, count: matches.length });
}

async function portalGetJob(req, res) {
  const id = req.params.id;
  if (!HUBTIGER_PARTNER_ID || !HUBTIGER_FUNCTION_CODE) return res.status(503).json({ ok: false, error: 'portal_not_configured' });
  const url = `${HUBTIGER_API_URL}/api/Portal/Workshop/Calendar/JobCard/${encodeURIComponent(id)}?code=${encodeURIComponent(HUBTIGER_FUNCTION_CODE)}`;
  let token;
  try {
    token = await getPortalBearerToken();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'portal_login_failed', message: String(e?.message || e) });
  }
  const response = await fetch(url, { headers: { PartnerID: HUBTIGER_PARTNER_ID, Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    return res.status(502).json({ ok: false, error: 'portal_job_get_failed', status: response.status, message: txt.slice(0, 500) });
  }
  const job = await response.json().catch(() => null);
  if (!job || typeof job !== 'object') return res.json(job);
  const memory = buildJobMemoryPayload(job);
  return res.json({
    ...job,
    StatusLabel: memory.job.statusLabel,
    memory,
  });
}

async function fetchPortalUnreadMessages(page = 1, limit = 20) {
  const path = `/api/v4.0/Messaging/Partner/${encodeURIComponent(HUBTIGER_PARTNER_ID)}/Unread`;
  const { response, data } = await portalFetch({
    api: 'api',
    path,
    method: 'GET',
    query: { page: parsePositiveInt(page, 1), limit: parsePositiveInt(limit, 20) },
    auth: 'bearer',
  });
  if (!response.ok) {
    const msg = typeof data?._raw === 'string' ? data._raw : JSON.stringify(data || {});
    throw new Error(`portal_messages_unread_failed (${response.status}): ${String(msg).slice(0, 500)}`);
  }
  const json = data;
  return Array.isArray(json) ? json : (json?.messages || json?.data || []);
}

async function portalJobMessages(req, res) {
  if (!HUBTIGER_PARTNER_ID || !HUBTIGER_FUNCTION_CODE) {
    return res.status(503).json({ ok: false, error: 'portal_not_configured' });
  }
  const id = String(req.params.id || '').trim();
  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, 100);
  const all = req.query.all === '1' || req.query.all === 'true';
  try {
    const messages = await fetchPortalUnreadMessages(page, limit);
    const filtered = all ? messages : messages.filter((m) => String(m.JobCardID) === id || String(m.JobCardNo) === id || `#${String(m.JobCardNo)}` === id);
    return res.json({ ok: true, jobId: id, messages: filtered, count: filtered.length, source: 'v4.0/Messaging/Unread' });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'portal_job_messages_failed', message: String(e?.message || e) });
  }
}

async function portalMessagesUnread(req, res) {
  if (!HUBTIGER_PARTNER_ID || !HUBTIGER_FUNCTION_CODE) {
    return res.status(503).json({ ok: false, error: 'portal_not_configured' });
  }
  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, 20);
  try {
    const messages = await fetchPortalUnreadMessages(page, limit);
    return res.json({ ok: true, messages, count: messages.length, page, limit });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'portal_messages_unread_failed', message: String(e?.message || e) });
  }
}

async function portalTechnicianAvailability(req, res) {
  if (!HUBTIGER_PARTNER_ID || !HUBTIGER_FUNCTION_CODE) {
    return res.status(503).json({ ok: false, error: 'portal_not_configured' });
  }
  const fromDate = String(req.query.fromDate || '').trim();
  const toDate = String(req.query.toDate || '').trim();
  let technicians = String(req.query.technicians || '').trim();
  const store = normalizeStoreSelection(req.query.store || req.query.storeName || req.query.location || req.query.branch);
  const requiredMinutes = parsePositiveInt(req.query.requiredMinutes, 60);
  if (!store) {
    return res.status(400).json({
      ok: false,
      error: 'missing_store_selection',
      hint: 'Choose store before checking availability: southport | burleigh | brisbane',
      allowedStores: ['southport', 'burleigh', 'brisbane'],
    });
  }
  if (!fromDate || !toDate) {
    return res.status(400).json({
      ok: false,
      error: 'missing_params',
      hint: 'Use fromDate,toDate. technicians optional; if omitted, proxy auto-discovers active technicians from calendar data.',
    });
  }
  if (!technicians) {
    const calendarPath = '/api/Technician/Calendar/Data';
    const cal = await portalFetch({
      api: 'api',
      path: calendarPath,
      method: 'GET',
      query: {
        PartnerID: HUBTIGER_PARTNER_ID,
        FromDate: toUtcStart(fromDate),
        ToDate: toUtcStart(toDate),
      },
      auth: 'bearer',
    });
    if (!cal.response.ok) {
      return res.status(502).json({
        ok: false,
        error: 'portal_calendar_data_failed',
        upstream_status: cal.response.status,
        data: cal.data,
      });
    }
    const discovered = [];
    const seen = new Set();
    const services = Array.isArray(cal.data?.services) ? cal.data.services : [];
    for (const row of services) {
      const id = String(row?.technicianID ?? row?.technicianId ?? '').trim();
      if (!/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      discovered.push(id);
    }
    if (discovered.length === 0) {
      const techList = Array.isArray(cal.data?.technicians) ? cal.data.technicians : [];
      for (const row of techList) {
        const id = String(row?.id ?? row?.technicianID ?? '').trim();
        if (!/^\d+$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        discovered.push(id);
      }
    }
    if (discovered.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'missing_params',
        hint: 'No technician IDs were discovered from calendar data. Provide technicians as csv.',
      });
    }
    technicians = discovered.join(',');
  }
  const path = '/api/v4.0/Services/TechniciansAvailabilityV3';
  const { response, data } = await portalFetch({
    api: 'api',
    path,
    method: 'GET',
    query: {
      PartnerID: HUBTIGER_PARTNER_ID,
      FromDate: fromDate,
      ToDate: toDate,
      Technicians: technicians,
    },
    auth: 'bearer',
  });
  if (!response.ok) {
    const msg = typeof data?._raw === 'string' ? data._raw : JSON.stringify(data || {});
    return res.status(502).json({ ok: false, error: 'portal_availability_failed', status: response.status, message: String(msg).slice(0, 500) });
  }
  const rows = Array.isArray(data) ? data : [];
  const list = (Array.isArray(rows) ? rows : []).slice(0, Math.max(1, MAX_AVAILABILITY_ROWS));
  const earliest = findEarliestAvailability(list, requiredMinutes, new Date(), { store });
  return res.json({ ok: true, store, rows: list, count: list.length, requiredMinutes, earliest });
}

async function portalCall(req, res) {
  if (!HUBTIGER_PARTNER_ID || !HUBTIGER_FUNCTION_CODE) {
    return res.status(503).json({ ok: false, error: 'portal_not_configured' });
  }
  const body = req.body || {};
  const api = body.api === 'services' ? 'services' : 'api';
  const path = body.path;
  const method = String(body.method || 'GET').toUpperCase();
  const query = body.query && typeof body.query === 'object' ? body.query : {};
  const requestBody = body.body && typeof body.body === 'object' ? body.body : null;
  const auth = String(body.auth || 'none').toLowerCase();

  if (!isValidPortalPath(path)) {
    return res.status(400).json({ ok: false, error: 'invalid_path', hint: 'path must start with /api/' });
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return res.status(400).json({ ok: false, error: 'invalid_method' });
  }

  let response;
  let data;
  try {
    const result = await portalFetch({ api, path, method, query, body: requestBody, auth });
    response = result.response;
    data = result.data;
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'portal_login_failed', message: String(e?.message || e) });
  }
  if (!response.ok) {
    return res.status(502).json({ ok: false, error: 'portal_call_failed', upstream_status: response.status, data });
  }
  return res.json({ ok: true, api, method, path, data });
}

async function portalSearchCyclists(req, res) {
  const q = String(req.query.q || req.query.search || '').trim();
  const type = String(req.query.type || 'phone').trim();
  const page = parsePositiveInt(req.query.page, 0);
  const limit = parsePositiveInt(req.query.limit, 20);
  if (!q) return res.status(400).json({ ok: false, error: 'missing_query' });
  const path = `/api/Bikeshop/${encodeURIComponent(HUBTIGER_PARTNER_ID)}/Search/Cyclists`;
  const { response, data } = await portalFetch({
    api: 'api',
    path,
    method: 'GET',
    query: { Page: page, Limit: limit, Search: q, Type: type },
    auth: 'bearer',
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_customer_search_failed', upstream_status: response.status, data });
  const rows = Array.isArray(data) ? data : (data?.results || data?.data || []);
  return res.json({ ok: true, results: rows, count: rows.length });
}

async function portalCreateCustomer(req, res) {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const { response, data } = await portalFetch({
    api: 'api',
    path: '/api/store/customers',
    method: 'POST',
    body: payload,
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_customer_create_failed', upstream_status: response.status, data });
  return res.json({ ok: true, data });
}

async function portalCreateBike(req, res) {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const { response, data } = await portalFetch({
    api: 'services',
    path: '/api/Bike',
    method: 'POST',
    body: payload,
    auth: 'bearer',
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_bike_create_failed', upstream_status: response.status, data });
  return res.json({ ok: true, data });
}

async function portalScheduleService(req, res) {
  const sendCommunication = req.query.sendCommunication !== 'false';
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const path = `/api/Partner/v3/ScheduleService`;
  const { response, data } = await portalFetch({
    api: 'services',
    path,
    method: 'POST',
    query: { SendCommunication: sendCommunication ? 'true' : 'false' },
    body: payload,
    auth: 'bearer',
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_schedule_service_failed', upstream_status: response.status, data });
  return res.json({ ok: true, data });
}

async function portalUpdateJobcardSlot(req, res) {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const { response, data } = await portalFetch({
    api: 'services',
    path: '/api/ServiceRequest/UpdateJobcardSlot',
    method: 'POST',
    body: payload,
    auth: 'bearer',
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_update_jobcard_slot_failed', upstream_status: response.status, data });
  return res.json({ ok: true, data });
}

async function portalUpdateServiceRequest(req, res) {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const { response, data } = await portalFetch({
    api: 'services',
    path: '/api/ServiceRequest',
    method: 'POST',
    body: payload,
    auth: 'bearer',
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_update_service_request_failed', upstream_status: response.status, data });
  return res.json({ ok: true, data });
}

async function portalAddInternalNotes(req, res) {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const { response, data } = await portalFetch({
    api: 'services',
    path: '/api/ServiceRequest/InternalNotes',
    method: 'POST',
    body: payload,
    auth: 'bearer',
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_internal_notes_failed', upstream_status: response.status, data });
  return res.json({ ok: true, data });
}

async function portalAddAssessmentNotes(req, res) {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const { response, data } = await portalFetch({
    api: 'services',
    path: '/api/ServiceRequest/AssessmentNotes',
    method: 'POST',
    body: payload,
    auth: 'bearer',
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_assessment_notes_failed', upstream_status: response.status, data });
  return res.json({ ok: true, data });
}

async function portalInvoiceLineItem(req, res) {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const { response, data } = await portalFetch({
    api: 'services',
    path: '/api/Invoice/LineItem',
    method: 'POST',
    body: payload,
    auth: 'bearer',
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_invoice_line_item_failed', upstream_status: response.status, data });
  return res.json({ ok: true, data });
}

async function portalRequestApproval(req, res) {
  const userId = req.params.userId;
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const path = `/api/v3/Athlete/${encodeURIComponent(userId)}/RequestApproval`;
  const { response, data } = await portalFetch({
    api: 'api',
    path,
    method: 'POST',
    body: payload,
    auth: 'bearer',
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_request_approval_failed', upstream_status: response.status, data });
  return res.json({ ok: true, data });
}

async function portalBookingsWeekSamples(req, res) {
  const fromDate = req.query.fromDate ? toDateOnlyIso(req.query.fromDate) : toDateOnlyIso(new Date());
  const toDate = req.query.toDate ? toDateOnlyIso(req.query.toDate) : (fromDate ? addDays(fromDate, 7) : null);
  const count = parsePositiveInt(req.query.count, 3);
  const distinctStores = String(req.query.distinctStores || 'true').toLowerCase() !== 'false';
  if (!fromDate || !toDate) return res.status(400).json({ ok: false, error: 'invalid_date_range' });

  const path = '/api/Technician/Calendar/Data';
  const { response, data } = await portalFetch({
    api: 'api',
    path,
    method: 'GET',
    query: {
      PartnerID: HUBTIGER_PARTNER_ID,
      FromDate: toUtcStart(fromDate),
      ToDate: toUtcStart(toDate),
    },
    auth: 'bearer',
  });
  if (!response.ok) return res.status(502).json({ ok: false, error: 'portal_calendar_data_failed', upstream_status: response.status, data });

  const technicians = Array.isArray(data?.technicians) ? data.technicians : [];
  const services = Array.isArray(data?.services) ? data.services : [];
  const techById = new Map(technicians.map((t) => [String(t.id), t.technicianName || `Tech ${t.id}`]));

  const normalized = services
    .filter((s) => s && s.customer && s.customerID && s.serviceID && s.jobCardNo)
    .map((s) => {
      const techName = techById.get(String(s.technicianID)) || s.technician || 'Unknown';
      const storeName = inferStoreName(techName);
      return {
        serviceID: s.serviceID,
        jobCardNo: s.jobCardNo,
        customerID: s.customerID,
        customerName: s.customer,
        bike: s.bike || null,
        dateCheckedIn: s.dateCheckedIn || null,
        technicianID: s.technicianID || null,
        technicianName: techName,
        storeName,
        duration: Number(s.duration || 0),
      };
    })
    .sort((a, b) => String(a.dateCheckedIn || '').localeCompare(String(b.dateCheckedIn || '')));

  const picked = [];
  const usedStores = new Set();
  for (const row of normalized) {
    if (picked.length >= count) break;
    if (distinctStores && usedStores.has(row.storeName)) continue;
    picked.push(row);
    usedStores.add(row.storeName);
  }
  if (picked.length < count) {
    for (const row of normalized) {
      if (picked.length >= count) break;
      if (picked.some((p) => p.serviceID === row.serviceID)) continue;
      picked.push(row);
    }
  }

  return res.json({
    ok: true,
    fromDate,
    toDate,
    countRequested: count,
    countReturned: picked.length,
    distinctStores,
    samples: picked,
  });
}

async function portalProductsSearch(req, res) {
  const q = compactSearchText(String(req.query.q || ''), MAX_PRODUCT_SEARCH_CHARS);
  const limit = parsePositiveInt(req.query.limit, 25);
  if (q) {
    try {
      const smart = await searchProductsSmart(q, limit);
      return res.json({
        ok: true,
        count: smart.results.length,
        results: smart.results,
        source: smart.source,
        attempts: smart.attempts,
        cache: smart.cache || null,
      });
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: 'portal_products_search_failed',
        message: String(e?.message || e),
      });
    }
  }

  // No query: return a sample from cached catalog for UI browsing.
  const forceRefresh = String(req.query.refresh || '').toLowerCase() === 'true' || String(req.query.refresh || '') === '1';
  try {
    const snapshot = await getProductsCatalogSnapshot({ forceRefresh });
    const rows = snapshot.rows.slice(0, limit).map((p) => mapProductHit(p, 'catalog_cache', null));
    return res.json({ ok: true, count: rows.length, results: rows, source: 'catalog_cache', cache: snapshot.cache });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: 'portal_products_sync_failed',
      upstream_status: e?.upstream_status ?? null,
      data: e?.upstream_data ?? null,
    });
  }
}

async function portalQuoteFindAndAdd(req, res) {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const serviceId = payload.serviceId ?? payload.jobId ?? payload.ID;
  const search = compactSearchText(payload.search ?? payload.q ?? '', MAX_PRODUCT_SEARCH_CHARS);
  const quantity = payload.quantity ?? 1;
  const dryRun = payload.dryRun === true;
  if (!serviceId || !search) {
    return res.status(400).json({ ok: false, error: 'missing_fields', hint: 'Provide serviceId/jobId and search text.' });
  }

  let searchResult;
  try {
    searchResult = await searchProductsSmart(search, 8);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'product_search_failed', message: String(e?.message || e) });
  }
  if (!Array.isArray(searchResult.results) || searchResult.results.length === 0) {
    return res.status(404).json({ ok: false, error: 'product_not_found', search, attempts: searchResult.attempts || [] });
  }
  const product = searchResult.results[0];

  let invoice;
  try {
    invoice = await getInvoiceForService(serviceId);
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: 'invoice_lookup_failed',
      upstream_status: e?.upstream_status ?? null,
      data: e?.upstream_data ?? null,
    });
  }

  const lineItem = buildInvoiceLineItemFromProduct(product, invoice.ID, quantity);
  if (dryRun) {
    return res.json({
      ok: true,
      dryRun: true,
      serviceId: Number(serviceId),
      invoiceId: invoice.ID,
      selectedProduct: product,
      previewLineItemRequest: lineItem,
      invoice,
      searchAttempts: searchResult.attempts || [],
    });
  }
  const { response, data } = await portalFetch({
    api: 'services',
    path: '/api/Invoice/LineItem',
    method: 'POST',
    body: lineItem,
    auth: 'bearer',
  });
  if (!response.ok) {
    return res.status(502).json({ ok: false, error: 'portal_invoice_line_item_failed', upstream_status: response.status, data });
  }
  return res.json({
    ok: true,
    serviceId: Number(serviceId),
    invoiceId: invoice.ID,
    selectedProduct: product,
    addedLineItemRequest: lineItem,
    invoice: data,
    searchAttempts: searchResult.attempts || [],
  });
}

async function portalQuoteFindAddAndRequestApproval(req, res) {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const serviceId = payload.serviceId ?? payload.jobId ?? payload.ID;
  const search = compactSearchText(payload.search ?? payload.q ?? '', MAX_PRODUCT_SEARCH_CHARS);
  const quantity = payload.quantity ?? 1;
  const dryRun = payload.dryRun === true;
  if (!serviceId || !search) {
    return res.status(400).json({ ok: false, error: 'missing_fields', hint: 'Provide serviceId/jobId and search text.' });
  }

  let searchResult;
  try {
    searchResult = await searchProductsSmart(search, 8);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'product_search_failed', message: String(e?.message || e) });
  }
  if (!Array.isArray(searchResult.results) || searchResult.results.length === 0) {
    return res.status(404).json({ ok: false, error: 'product_not_found', search, attempts: searchResult.attempts || [] });
  }
  const product = searchResult.results[0];

  let invoiceBefore;
  try {
    invoiceBefore = await getInvoiceForService(serviceId);
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: 'invoice_lookup_failed',
      upstream_status: e?.upstream_status ?? null,
      data: e?.upstream_data ?? null,
    });
  }

  const lineItem = buildInvoiceLineItemFromProduct(product, invoiceBefore.ID, quantity);
  const inferredUserId = payload.userId ?? payload.cyclistId ?? invoiceBefore.CyclistID ?? null;
  const approvalPayload = {
    PartnerID: Number(HUBTIGER_PARTNER_ID),
    UserID: Number(inferredUserId),
    CreatedBy: Number(
      payload.createdBy ??
        (HUBTIGER_CREATED_BY_USER_ID ? HUBTIGER_CREATED_BY_USER_ID : HUBTIGER_PARTNER_ID)
    ),
    Title: String(payload.title || 'Your invoice has been updated'),
    Message: String(payload.message || `Ride Electric has added ${product.name || 'an item'} to your pending quote and would like your approval`),
    JobURLLink: String(payload.jobUrlLink || `http://hubtigerportal.azurewebsites.net/cyclist/jobcard-approval/${serviceId}`),
  };

  if (!inferredUserId) {
    return res.status(400).json({
      ok: false,
      error: 'missing_user_id',
      hint: 'Provide payload.userId (or ensure invoice has CyclistID).',
      serviceId: Number(serviceId),
      invoiceId: invoiceBefore.ID,
    });
  }

  if (dryRun) {
    return res.json({
      ok: true,
      dryRun: true,
      serviceId: Number(serviceId),
      invoiceId: invoiceBefore.ID,
      selectedProduct: product,
      previewLineItemRequest: lineItem,
      previewApprovalRequest: {
        path: `/api/v3/Athlete/${encodeURIComponent(String(inferredUserId))}/RequestApproval`,
        body: approvalPayload,
      },
      invoice: invoiceBefore,
      searchAttempts: searchResult.attempts || [],
    });
  }

  const addResult = await portalFetch({
    api: 'services',
    path: '/api/Invoice/LineItem',
    method: 'POST',
    body: lineItem,
    auth: 'bearer',
  });
  if (!addResult.response.ok) {
    return res.status(502).json({ ok: false, error: 'portal_invoice_line_item_failed', upstream_status: addResult.response.status, data: addResult.data });
  }

  const approvalResult = await portalFetch({
    api: 'api',
    path: `/api/v3/Athlete/${encodeURIComponent(String(inferredUserId))}/RequestApproval`,
    method: 'POST',
    body: approvalPayload,
    auth: 'bearer',
  });
  if (!approvalResult.response.ok) {
    return res.status(502).json({
      ok: false,
      error: 'portal_request_approval_failed',
      upstream_status: approvalResult.response.status,
      data: approvalResult.data,
      lineItemAdded: true,
      invoiceId: invoiceBefore.ID,
      serviceId: Number(serviceId),
    });
  }

  return res.json({
    ok: true,
    serviceId: Number(serviceId),
    invoiceId: invoiceBefore.ID,
    selectedProduct: product,
    addedLineItemRequest: lineItem,
    invoiceAfterAdd: addResult.data,
    approvalRequest: approvalPayload,
    approvalResponse: approvalResult.data,
    searchAttempts: searchResult.attempts || [],
  });
}

// Job search: body { q, allStores } (ElevenLabs-style).
app.post('/jobs/search', (req, res) => {
  if (HUBTIGER_PARTNER_ID) return portalSearchJobs(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_search_failed', message: String(e && e.message || e) }));
  const body = req.body || {};
  proxyToHubtiger(req, res, 'POST', '/jobs/search', body);
});

// Job get by internal id (full job card). Used after search; id = results[].id.
app.get('/jobs/:id', (req, res) => {
  const id = req.params.id;
  if (PORTAL_MODE) return portalGetJob(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_job_get_failed', message: String(e && e.message || e) }));
  proxyToHubtiger(req, res, 'GET', `/jobs/${encodeURIComponent(id)}`);
});

app.get('/jobs/:id/messages', (req, res) => {
  const id = req.params.id;
  if (PORTAL_MODE) return portalJobMessages(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_job_messages_failed', message: String(e && e.message || e) }));
  proxyToHubtiger(req, res, 'GET', `/jobs/${encodeURIComponent(id)}/messages`);
});

app.get('/messages/unread', (req, res) => {
  if (PORTAL_MODE) return portalMessagesUnread(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_messages_unread_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'messages_unread_only_supported_in_portal_mode' });
});

app.get('/availability/technicians', (req, res) => {
  if (PORTAL_MODE) return portalTechnicianAvailability(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_availability_failed', message: String(e && e.message || e) }));
  const params = new URLSearchParams(req.query || {});
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return proxyToHubtiger(req, res, 'GET', `/availability/technicians${suffix}`);
});

app.post('/portal/call', (req, res) => {
  if (PORTAL_MODE) return portalCall(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_call_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'portal_call_only_supported_in_portal_mode' });
});

app.get('/customers/search', (req, res) => {
  if (PORTAL_MODE) return portalSearchCyclists(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_customer_search_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'customer_search_only_supported_in_portal_mode' });
});

app.post('/customers', (req, res) => {
  if (PORTAL_MODE) return portalCreateCustomer(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_customer_create_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'customer_create_only_supported_in_portal_mode' });
});

app.post('/bikes', (req, res) => {
  if (PORTAL_MODE) return portalCreateBike(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_bike_create_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'bike_create_only_supported_in_portal_mode' });
});

app.post('/bookings', (req, res) => {
  if (PORTAL_MODE) return portalScheduleService(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_schedule_service_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'booking_create_only_supported_in_portal_mode' });
});

app.post('/bookings/slot', (req, res) => {
  if (PORTAL_MODE) return portalUpdateJobcardSlot(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_update_jobcard_slot_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'booking_slot_update_only_supported_in_portal_mode' });
});

app.post('/bookings/update', (req, res) => {
  if (PORTAL_MODE) return portalUpdateServiceRequest(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_update_service_request_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'booking_update_only_supported_in_portal_mode' });
});

app.post('/bookings/notes/internal', (req, res) => {
  if (PORTAL_MODE) return portalAddInternalNotes(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_internal_notes_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'internal_notes_only_supported_in_portal_mode' });
});

app.post('/bookings/notes/customer', (req, res) => {
  if (PORTAL_MODE) return portalAddAssessmentNotes(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_assessment_notes_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'customer_notes_only_supported_in_portal_mode' });
});

app.post('/quotes/line-item', (req, res) => {
  if (PORTAL_MODE) return portalInvoiceLineItem(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_invoice_line_item_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'quote_line_item_only_supported_in_portal_mode' });
});

app.post('/quotes/find-add', (req, res) => {
  if (PORTAL_MODE) return portalQuoteFindAndAdd(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_quote_find_add_failed', message: String(e && e.message || e) }));
  return proxyToHubtiger(req, res, 'POST', '/quotes/find-add', req.body || {});
});

app.post('/quotes/find-add-request-approval', (req, res) => {
  if (PORTAL_MODE) return portalQuoteFindAddAndRequestApproval(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_quote_find_add_request_approval_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'quote_find_add_request_approval_only_supported_in_portal_mode' });
});

app.post('/quotes/request-approval/:userId', (req, res) => {
  if (PORTAL_MODE) return portalRequestApproval(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_request_approval_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'quote_approval_only_supported_in_portal_mode' });
});

app.get('/bookings/week-samples', (req, res) => {
  if (PORTAL_MODE) return portalBookingsWeekSamples(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_week_samples_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'booking_week_samples_only_supported_in_portal_mode' });
});

app.get('/products/search', (req, res) => {
  if (PORTAL_MODE) return portalProductsSearch(req, res).catch((e) => res.status(502).json({ ok: false, error: 'portal_products_search_failed', message: String(e && e.message || e) }));
  return res.status(400).json({ ok: false, error: 'products_search_only_supported_in_portal_mode' });
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, '0.0.0.0', () => {
    jsonLog({ level: 'info', msg: 'hubtiger-proxy listening', port: PORT });
  });
}
