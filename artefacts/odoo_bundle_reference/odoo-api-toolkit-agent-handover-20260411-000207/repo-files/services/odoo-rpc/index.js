import crypto from 'crypto';
import express from 'express';
import pg from 'pg';

const PORT = Number(process.env.ODOO_RPC_PORT || 8097);
const ODOO_URL = String(process.env.ODOO_URL || '').trim().replace(/\/$/, '');
const ODOO_DB = String(process.env.ODOO_DB || '').trim();
const ODOO_USERNAME = String(process.env.ODOO_USERNAME || '').trim();
const ODOO_SECRET = String(process.env.ODOO_API_KEY || process.env.ODOO_PASSWORD || '').trim();
const ODOO_RPC_INTERNAL_KEY = String(process.env.ODOO_RPC_INTERNAL_KEY || '').trim();
const ODOO_RPC_API_TOKEN = String(process.env.ODOO_RPC_API_TOKEN || '').trim();
const ODOO_RPC_ALLOW_MUTATIONS = /^(1|true|yes)$/i.test(String(process.env.ODOO_RPC_ALLOW_MUTATIONS || '').trim());
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.ODOO_RPC_TIMEOUT_MS || 20000));
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 4 }) : null;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_ONLY_METHODS = new Set([
  'fields_get',
  'name_get',
  'name_search',
  'read',
  'read_group',
  'search',
  'search_count',
  'search_fetch',
  'search_panel_select_multi_range',
  'search_panel_select_range',
  'search_read',
  'web_read',
  'web_search_read',
]);

let authCache = {
  uid: null,
  expires_at: 0,
};

function nowIso() {
  return new Date().toISOString();
}

function parseTraceId(value) {
  const traceId = String(value || '').trim();
  return UUID_REGEX.test(traceId) ? traceId : crypto.randomUUID();
}

function jsonLog(entry) {
  console.log(JSON.stringify(entry));
}

function sanitizeForLogs(value, depth = 0) {
  if (value == null) return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeForLogs(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      const lowerKey = String(key || '').toLowerCase();
      if (lowerKey.includes('password') || lowerKey.includes('secret') || lowerKey.includes('token') || lowerKey.includes('api_key')) {
        out[key] = '[redacted]';
      } else {
        out[key] = sanitizeForLogs(raw, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 400) return `${value.slice(0, 400)}...`;
  return value;
}

function missingConfig() {
  const missing = [];
  if (!ODOO_URL) missing.push('ODOO_URL');
  if (!ODOO_DB) missing.push('ODOO_DB');
  if (!ODOO_USERNAME) missing.push('ODOO_USERNAME');
  if (!ODOO_SECRET) missing.push('ODOO_API_KEY|ODOO_PASSWORD');
  return missing;
}

function hasValidServiceAuth(req) {
  const internalKeyHeader = String(req.headers['x-internal-key'] || '').trim();
  const bearerToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const internalKeyOk = ODOO_RPC_INTERNAL_KEY && internalKeyHeader === ODOO_RPC_INTERNAL_KEY;
  const apiTokenOk = ODOO_RPC_API_TOKEN && bearerToken === ODOO_RPC_API_TOKEN;
  if (!ODOO_RPC_INTERNAL_KEY && !ODOO_RPC_API_TOKEN) return true;
  return internalKeyOk || apiTokenOk;
}

function normalizePositiveInt(value, fallback, max = 1000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.trunc(numeric), max);
}

function normalizeOffset(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.trunc(numeric);
}

function normalizeFields(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value
    .map((field) => String(field || '').trim())
    .filter(Boolean)
    .slice(0, 100);
}

function normalizeDomain(value) {
  return Array.isArray(value) ? value : [];
}

function buildOrDomain(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return [];
  if (conditions.length === 1) return [conditions[0]];
  return [...new Array(conditions.length - 1).fill('|'), ...conditions];
}

function pickOrder(value, fallback = '') {
  const order = String(value || '').trim();
  return order || fallback;
}

function ensureReadOnlyMethod(method) {
  const normalized = String(method || '').trim();
  if (ODOO_RPC_ALLOW_MUTATIONS) return normalized;
  if (READ_ONLY_METHODS.has(normalized)) return normalized;
  const error = new Error(`Method "${normalized}" is blocked while ODOO_RPC_ALLOW_MUTATIONS is disabled.`);
  error.code = 'read_only_violation';
  throw error;
}

async function writeRequestLog({
  trace_id,
  span_id,
  route,
  start_ts,
  status,
  error,
  metadata,
}) {
  if (!pool) return;
  const end_ts = nowIso();
  const latency_ms = Math.max(0, Date.now() - Date.parse(start_ts));
  try {
    await pool.query(
      `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        trace_id,
        span_id,
        'odoo-rpc',
        route,
        start_ts,
        end_ts,
        latency_ms,
        Number(status || 0),
        error || null,
        JSON.stringify(metadata || {}),
      ]
    );
  } catch (_) {
    // Best effort logging only.
  }
}

async function odooJsonRpc({ service, method, args, trace_id, span_id }) {
  const response = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-trace-id': trace_id,
      'x-span-id': span_id,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service,
        method,
        args,
      },
      id: crypto.randomUUID(),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const text = payload && typeof payload === 'object' ? JSON.stringify(payload) : String(payload || '');
    const error = new Error(`odoo_http_${response.status}: ${text.slice(0, 500)}`);
    error.code = 'odoo_upstream_http_error';
    throw error;
  }
  if (payload?.error) {
    const message = String(
      payload.error?.data?.message
      || payload.error?.message
      || 'odoo_jsonrpc_error'
    );
    const error = new Error(message);
    error.code = 'odoo_jsonrpc_error';
    throw error;
  }
  return payload?.result;
}

async function authenticate(trace_id, span_id, forceRefresh = false) {
  if (!forceRefresh && authCache.uid && authCache.expires_at > Date.now()) return authCache.uid;
  const uid = await odooJsonRpc({
    service: 'common',
    method: 'authenticate',
    args: [ODOO_DB, ODOO_USERNAME, ODOO_SECRET, {}],
    trace_id,
    span_id,
  });
  if (!uid) {
    const error = new Error('odoo_auth_failed');
    error.code = 'odoo_auth_failed';
    throw error;
  }
  authCache = {
    uid: Number(uid),
    expires_at: Date.now() + 5 * 60 * 1000,
  };
  return authCache.uid;
}

async function executeKw({ model, method, args = [], kwargs = {}, trace_id, span_id }) {
  const uid = await authenticate(trace_id, span_id);
  return odooJsonRpc({
    service: 'object',
    method: 'execute_kw',
    args: [ODOO_DB, uid, ODOO_SECRET, model, method, args, kwargs],
    trace_id,
    span_id,
  });
}

async function searchRead({
  model,
  domain = [],
  fields = [],
  limit = 20,
  offset = 0,
  order = '',
  context = {},
  trace_id,
  span_id,
}) {
  const kwargs = {
    context: context && typeof context === 'object' ? context : {},
    fields: normalizeFields(fields),
    limit: normalizePositiveInt(limit, 20, 500),
    offset: normalizeOffset(offset),
  };
  const normalizedOrder = pickOrder(order);
  if (normalizedOrder) kwargs.order = normalizedOrder;
  return executeKw({
    model,
    method: 'search_read',
    args: [normalizeDomain(domain)],
    kwargs,
    trace_id,
    span_id,
  });
}

function productSearchDomain(query) {
  const term = String(query || '').trim();
  if (!term) return [];
  return buildOrDomain([
    ['name', 'ilike', term],
    ['default_code', 'ilike', term],
    ['barcode', 'ilike', term],
  ]);
}

function partnerSearchDomain(query) {
  const term = String(query || '').trim();
  if (!term) return [];
  return buildOrDomain([
    ['name', 'ilike', term],
    ['display_name', 'ilike', term],
    ['email', 'ilike', term],
    ['phone', 'ilike', term],
    ['mobile', 'ilike', term],
    ['ref', 'ilike', term],
    ['vat', 'ilike', term],
  ]);
}

function documentSearchDomain(query) {
  const term = String(query || '').trim();
  if (!term) return [];
  return buildOrDomain([
    ['name', 'ilike', term],
    ['ref', 'ilike', term],
    ['payment_reference', 'ilike', term],
  ]);
}

function orderSearchDomain(query) {
  const term = String(query || '').trim();
  if (!term) return [];
  return buildOrDomain([
    ['name', 'ilike', term],
    ['client_order_ref', 'ilike', term],
    ['origin', 'ilike', term],
  ]);
}

function accountSearchDomain(query) {
  const term = String(query || '').trim();
  if (!term) return [];
  return buildOrDomain([
    ['code', 'ilike', term],
    ['name', 'ilike', term],
  ]);
}

async function runSearchPreset({
  payload,
  model,
  defaultFields,
  baseDomain = [],
  defaultOrder = 'id desc',
  queryBuilder = null,
  trace_id,
  span_id,
}) {
  const query = String(payload?.query ?? payload?.q ?? '').trim();
  const extraDomain = normalizeDomain(payload?.domain);
  const fields = normalizeFields(payload?.fields, defaultFields);
  return searchRead({
    model,
    domain: [...baseDomain, ...extraDomain, ...(queryBuilder ? queryBuilder(query) : [])],
    fields,
    limit: normalizePositiveInt(payload?.limit, 20, 500),
    offset: normalizeOffset(payload?.offset),
    order: pickOrder(payload?.order, defaultOrder),
    context: payload?.context,
    trace_id,
    span_id,
  });
}

async function handleOperation(operation, payload, trace_id, span_id) {
  switch (operation) {
    case 'odoo.current_user':
    case 'odoo.meta.current_user': {
      const uid = await authenticate(trace_id, span_id);
      const rows = await searchRead({
        model: 'res.users',
        domain: [['id', '=', uid]],
        fields: normalizeFields(payload?.fields, ['id', 'name', 'login', 'email', 'company_id']),
        limit: 1,
        offset: 0,
        order: '',
        context: payload?.context,
        trace_id,
        span_id,
      });
      return { uid, user: rows[0] || null };
    }
    case 'odoo.meta.version': {
      const version = await odooJsonRpc({
        service: 'common',
        method: 'version',
        args: [],
        trace_id,
        span_id,
      });
      return { version };
    }
    case 'odoo.meta.companies.list': {
      const rows = await runSearchPreset({
        payload,
        model: 'res.company',
        defaultFields: ['id', 'name', 'currency_id'],
        defaultOrder: 'name asc',
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.products.search':
    case 'odoo.masters.products.search': {
      const rows = await runSearchPreset({
        payload,
        model: 'product.template',
        defaultFields: ['id', 'name', 'default_code', 'barcode', 'list_price', 'standard_price', 'qty_available', 'uom_id'],
        defaultOrder: 'name asc',
        queryBuilder: productSearchDomain,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.customers.search':
    case 'odoo.masters.customers.search': {
      const rows = await runSearchPreset({
        payload,
        model: 'res.partner',
        defaultFields: ['id', 'name', 'email', 'phone', 'mobile', 'customer_rank'],
        baseDomain: [['customer_rank', '>', 0]],
        defaultOrder: 'name asc',
        queryBuilder: partnerSearchDomain,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.sale_orders.search':
    case 'odoo.sales.orders.search': {
      const rows = await runSearchPreset({
        payload,
        model: 'sale.order',
        defaultFields: ['id', 'name', 'partner_id', 'date_order', 'amount_total', 'state', 'invoice_status'],
        defaultOrder: 'date_order desc',
        queryBuilder: orderSearchDomain,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.invoices.search':
    case 'odoo.finance.invoices.search': {
      const rows = await runSearchPreset({
        payload,
        model: 'account.move',
        defaultFields: ['id', 'name', 'move_type', 'partner_id', 'invoice_date', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state', 'state'],
        baseDomain: [['move_type', 'in', ['out_invoice', 'out_refund', 'in_invoice', 'in_refund']]],
        defaultOrder: 'invoice_date desc',
        queryBuilder: documentSearchDomain,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.finance.receivables.open': {
      const rows = await runSearchPreset({
        payload,
        model: 'account.move',
        defaultFields: ['id', 'name', 'partner_id', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state', 'state'],
        baseDomain: [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['payment_state', 'in', ['not_paid', 'partial']]],
        defaultOrder: 'invoice_date_due asc',
        queryBuilder: documentSearchDomain,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.finance.payables.open': {
      const rows = await runSearchPreset({
        payload,
        model: 'account.move',
        defaultFields: ['id', 'name', 'partner_id', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state', 'state'],
        baseDomain: [['move_type', '=', 'in_invoice'], ['state', '=', 'posted'], ['payment_state', 'in', ['not_paid', 'partial']]],
        defaultOrder: 'invoice_date_due asc',
        queryBuilder: documentSearchDomain,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.finance.journal_entries.search': {
      const rows = await runSearchPreset({
        payload,
        model: 'account.move',
        defaultFields: ['id', 'name', 'date', 'journal_id', 'state', 'ref'],
        baseDomain: [['move_type', '=', 'entry']],
        defaultOrder: 'date desc',
        queryBuilder: documentSearchDomain,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.finance.payments.search': {
      const rows = await runSearchPreset({
        payload,
        model: 'account.payment',
        defaultFields: ['id', 'name', 'date', 'payment_type', 'partner_type', 'partner_id', 'amount', 'currency_id', 'state', 'journal_id'],
        defaultOrder: 'date desc',
        queryBuilder: documentSearchDomain,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.finance.accounts.search': {
      const rows = await runSearchPreset({
        payload,
        model: 'account.account',
        defaultFields: ['id', 'code', 'name', 'account_type', 'reconcile', 'deprecated'],
        defaultOrder: 'code asc',
        queryBuilder: accountSearchDomain,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.purchasing.orders.search': {
      const rows = await runSearchPreset({
        payload,
        model: 'purchase.order',
        defaultFields: ['id', 'name', 'partner_id', 'date_order', 'currency_id', 'amount_total', 'state'],
        defaultOrder: 'date_order desc',
        queryBuilder: orderSearchDomain,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.inventory.quants.search': {
      const rows = await runSearchPreset({
        payload,
        model: 'stock.quant',
        defaultFields: ['id', 'product_id', 'location_id', 'quantity', 'available_quantity', 'company_id'],
        defaultOrder: 'id desc',
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.inventory.valuation.search': {
      const rows = await runSearchPreset({
        payload,
        model: 'stock.valuation.layer',
        defaultFields: ['id', 'product_id', 'quantity', 'value', 'remaining_qty', 'remaining_value', 'create_date', 'company_id'],
        defaultOrder: 'create_date desc',
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.search_read': {
      const model = String(payload?.model || '').trim();
      if (!model) {
        const error = new Error('model is required');
        error.code = 'missing_model';
        throw error;
      }
      const rows = await searchRead({
        model,
        domain: normalizeDomain(payload?.domain),
        fields: normalizeFields(payload?.fields),
        limit: normalizePositiveInt(payload?.limit, 20, 500),
        offset: normalizeOffset(payload?.offset),
        order: pickOrder(payload?.order),
        context: payload?.context,
        trace_id,
        span_id,
      });
      return { rows };
    }
    case 'odoo.execute_kw': {
      const model = String(payload?.model || '').trim();
      const method = ensureReadOnlyMethod(payload?.method);
      if (!model) {
        const error = new Error('model is required');
        error.code = 'missing_model';
        throw error;
      }
      const result = await executeKw({
        model,
        method,
        args: Array.isArray(payload?.args) ? payload.args : [],
        kwargs: payload?.kwargs && typeof payload.kwargs === 'object' ? payload.kwargs : {},
        trace_id,
        span_id,
      });
      return { result };
    }
    default: {
      const error = new Error(`Unsupported operation "${operation}"`);
      error.code = 'unsupported_operation';
      throw error;
    }
  }
}

function errorStatus(error) {
  switch (String(error?.code || '')) {
    case 'missing_model':
    case 'read_only_violation':
    case 'unsupported_operation':
      return 400;
    case 'odoo_auth_failed':
      return 502;
    case 'odoo_config_missing':
      return 503;
    default:
      return String(error?.code || '').startsWith('odoo_') ? 502 : 500;
  }
}

const app = express();
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

app.get('/health', async (req, res) => {
  const route = 'GET /health';
  const start_ts = nowIso();
  const missing = missingConfig();

  if (!hasValidServiceAuth(req)) {
    await writeRequestLog({
      trace_id: req.trace_id,
      span_id: req.span_id,
      route,
      start_ts,
      status: 401,
      error: 'unauthorized',
      metadata: { missing_config: missing },
    });
    res.setHeader('x-error', 'unauthorized');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (missing.length > 0) {
    await writeRequestLog({
      trace_id: req.trace_id,
      span_id: req.span_id,
      route,
      start_ts,
      status: 503,
      error: 'odoo_config_missing',
      metadata: { missing_config: missing },
    });
    res.setHeader('x-error', 'odoo_config_missing');
    return res.status(503).json({ ok: false, error: 'odoo_config_missing', missing });
  }

  try {
    const uid = await authenticate(req.trace_id, req.span_id, true);
    const version = await odooJsonRpc({
      service: 'common',
      method: 'version',
      args: [],
      trace_id: req.trace_id,
      span_id: req.span_id,
    });
    const latency_ms = Math.max(0, Date.now() - Date.parse(start_ts));
    const payload = {
      ok: true,
      service: 'odoo-rpc',
      latency_ms,
      auth_ok: true,
      uid,
      read_only: !ODOO_RPC_ALLOW_MUTATIONS,
      version: sanitizeForLogs(version),
    };
    await writeRequestLog({
      trace_id: req.trace_id,
      span_id: req.span_id,
      route,
      start_ts,
      status: 200,
      error: null,
      metadata: payload,
    });
    return res.json(payload);
  } catch (error) {
    const status = errorStatus(error);
    await writeRequestLog({
      trace_id: req.trace_id,
      span_id: req.span_id,
      route,
      start_ts,
      status,
      error: String(error?.message || error),
      metadata: { missing_config: missing },
    });
    res.setHeader('x-error', String(error?.code || 'odoo_health_failed'));
    return res.status(status).json({
      ok: false,
      error: String(error?.code || 'odoo_health_failed'),
      message: String(error?.message || error),
    });
  }
});

app.post('/tool', async (req, res) => {
  const route = 'POST /tool';
  const start_ts = nowIso();
  const missing = missingConfig();

  if (!hasValidServiceAuth(req)) {
    await writeRequestLog({
      trace_id: req.trace_id,
      span_id: req.span_id,
      route,
      start_ts,
      status: 401,
      error: 'unauthorized',
      metadata: {},
    });
    res.setHeader('x-error', 'unauthorized');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (missing.length > 0) {
    await writeRequestLog({
      trace_id: req.trace_id,
      span_id: req.span_id,
      route,
      start_ts,
      status: 503,
      error: 'odoo_config_missing',
      metadata: { missing_config: missing },
    });
    res.setHeader('x-error', 'odoo_config_missing');
    return res.status(503).json({ ok: false, error: 'odoo_config_missing', missing });
  }

  const operation = String(req.body?.operation || '').trim();
  const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
  const tool_id = req.body?.tool_id ? String(req.body.tool_id) : null;

  if (!operation) {
    await writeRequestLog({
      trace_id: req.trace_id,
      span_id: req.span_id,
      route,
      start_ts,
      status: 400,
      error: 'missing_operation',
      metadata: { tool_id },
    });
    return res.status(400).json({ ok: false, error: 'missing_operation' });
  }

  try {
    const data = await handleOperation(operation, payload, req.trace_id, req.span_id);
    const latency_ms = Math.max(0, Date.now() - Date.parse(start_ts));
    const response = {
      ok: true,
      operation,
      trace_id: req.trace_id,
      latency_ms,
      read_only: !ODOO_RPC_ALLOW_MUTATIONS,
      data,
    };
    await writeRequestLog({
      trace_id: req.trace_id,
      span_id: req.span_id,
      route,
      start_ts,
      status: 200,
      error: null,
      metadata: {
        tool_id,
        operation,
        payload: sanitizeForLogs(payload),
        response_preview: sanitizeForLogs(data),
      },
    });
    return res.json(response);
  } catch (error) {
    const status = errorStatus(error);
    await writeRequestLog({
      trace_id: req.trace_id,
      span_id: req.span_id,
      route,
      start_ts,
      status,
      error: String(error?.message || error),
      metadata: {
        tool_id,
        operation,
        payload: sanitizeForLogs(payload),
      },
    });
    res.setHeader('x-error', String(error?.code || 'odoo_tool_failed'));
    return res.status(status).json({
      ok: false,
      error: String(error?.code || 'odoo_tool_failed'),
      message: String(error?.message || error),
    });
  }
});

app.listen(PORT, () => {
  jsonLog({
    level: 'info',
    service: 'odoo-rpc',
    msg: 'listening',
    port: PORT,
    read_only: !ODOO_RPC_ALLOW_MUTATIONS,
    auth_required: Boolean(ODOO_RPC_INTERNAL_KEY || ODOO_RPC_API_TOKEN),
    odoo_url_configured: Boolean(ODOO_URL),
    database_configured: Boolean(ODOO_DB),
    username_configured: Boolean(ODOO_USERNAME),
    secret_configured: Boolean(ODOO_SECRET),
  });
});
