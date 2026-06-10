import crypto from 'crypto';
import express from 'express';
import pg from 'pg';
import { createClient } from 'redis';

const PORT = Number(process.env.HUBTIGER_MCP_PORT || 8096);
const HUBTIGER_PROXY_URL = String(process.env.HUBTIGER_PROXY_URL || '').trim().replace(/\/$/, '');
const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const CACHE_TTL_SECONDS = Number(process.env.HUBTIGER_MCP_CACHE_TTL_SECONDS || 20);
const READ_TIMEOUT_MS = Number(process.env.HUBTIGER_MCP_READ_TIMEOUT_MS || 8000);
const MUTATION_TIMEOUT_MS = Number(process.env.HUBTIGER_MCP_MUTATION_TIMEOUT_MS || 12000);
const FAILURE_THRESHOLD = Number(process.env.HUBTIGER_MCP_CIRCUIT_FAILS || 3);
const CIRCUIT_OPEN_MS = Number(process.env.HUBTIGER_MCP_CIRCUIT_OPEN_MS || 60000);

const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 4 }) : null;
const redis = REDIS_URL ? createClient({ url: REDIS_URL }) : null;
if (redis) {
  redis.on('error', (err) => {
    jsonLog({ level: 'warn', service: 'hubtiger-mcp', route: 'redis', error: String(err?.message || err) });
  });
  redis.connect().catch((err) => {
    jsonLog({ level: 'warn', service: 'hubtiger-mcp', route: 'redis_connect', error: String(err?.message || err) });
  });
}

const app = express();
app.use(express.json({ limit: '1mb' }));

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const circuitByOperation = new Map();

function parseTraceId(value) {
  const v = String(value || '').trim();
  return UUID_REGEX.test(v) ? v : crypto.randomUUID();
}

function jsonLog(obj) {
  console.log(JSON.stringify(obj));
}

function nowIso() {
  return new Date().toISOString();
}

function isReadOperation(operation, method) {
  const op = String(operation || '').trim().toLowerCase();
  if (method === 'GET') return true;
  return op === 'jobs_search' || op === 'products_search';
}

function buildOperationExecuteRequest(body) {
  const operation = String(body?.operation || '').trim();
  const payload = body && typeof body.payload === 'object' && body.payload ? body.payload : {};
  if (!operation) return null;

  if (operation === 'availability_lookup') {
    const fromDate = String(payload.start_date || payload.date || '').trim();
    const toDate = String(payload.end_date || '').trim();
    const store = String(payload.store || '').trim();
    if (!store || !fromDate) return null;
    const params = new URLSearchParams({
      store,
      fromDate,
      toDate: toDate || fromDate,
      requiredMinutes: String(Number(payload.requiredMinutes || 60)),
    });
    return {
      operation,
      method: 'GET',
      proxyPath: `/availability/technicians?${params.toString()}`,
      proxyBody: null,
    };
  }

  if (operation === 'job_lookup') {
    const customer = payload.customer && typeof payload.customer === 'object' ? payload.customer : {};

    const jobId = String(payload.job_id || payload.jobId || '').trim();
    if (jobId) {
      return {
        operation,
        method: 'GET',
        proxyPath: `/jobs/${encodeURIComponent(jobId)}`,
        proxyBody: null,
      };
    }

    const q = String(
      payload.phone ||
      payload.mobile ||
      customer.phone ||
      customer.mobile ||
      [payload.first_name || customer.first_name, payload.last_name || customer.last_name].filter(Boolean).join(' ') ||
      payload.search ||
      payload.q ||
      ''
    ).trim();

    if (!q) return null;

    return {
      operation,
      method: 'POST',
      proxyPath: '/jobs/search',
      proxyBody: { q, allStores: true },
    };
  }

  if (operation === 'quote_preview') {
    const serviceId = payload.serviceId || payload.service_id || payload.job_id;
    const search = String(payload.search || payload.query || '').trim();
    if (!serviceId || !search) return null;
    return {
      operation,
      method: 'POST',
      proxyPath: '/quotes/find-add',
      proxyBody: { serviceId: Number(serviceId), search, quantity: Number(payload.quantity || 1), dryRun: true },
    };
  }

  return null;
}

function cacheKey(operation, method, proxyPath, proxyBody) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ operation, method, proxyPath, proxyBody: proxyBody || null }));
  return `hubtiger-mcp:${hash.digest('hex')}`;
}

function getCircuitState(operation) {
  const key = String(operation || 'unknown');
  const now = Date.now();
  const current = circuitByOperation.get(key);
  if (!current) return { state: 'closed', failures: 0, opened_at: null };
  if (current.openedAt && now - current.openedAt >= CIRCUIT_OPEN_MS) {
    circuitByOperation.set(key, { failures: 0, openedAt: null });
    return { state: 'closed', failures: 0, opened_at: null };
  }
  return {
    state: current.openedAt ? 'open' : 'closed',
    failures: current.failures || 0,
    opened_at: current.openedAt ? new Date(current.openedAt).toISOString() : null,
  };
}

function markFailure(operation) {
  const key = String(operation || 'unknown');
  const current = circuitByOperation.get(key) || { failures: 0, openedAt: null };
  const failures = Number(current.failures || 0) + 1;
  const next = failures >= FAILURE_THRESHOLD
    ? { failures, openedAt: Date.now() }
    : { failures, openedAt: null };
  circuitByOperation.set(key, next);
}

function markSuccess(operation) {
  const key = String(operation || 'unknown');
  circuitByOperation.set(key, { failures: 0, openedAt: null });
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
        'hubtiger-mcp',
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

async function callHubtigerProxy({
  trace_id,
  operation,
  method,
  proxyPath,
  proxyBody,
}) {
  if (!HUBTIGER_PROXY_URL) {
    return {
      ok: false,
      status: 503,
      error: 'hubtiger_proxy_unavailable',
      data: { error: 'hubtiger_proxy_unavailable' },
      latency_ms: 0,
      retry_count: 0,
      cache_hit: false,
      circuit_state: 'closed',
    };
  }

  const route = 'POST /mcp/execute';
  const span_id = crypto.randomUUID();
  const start_ts = nowIso();
  const op = String(operation || '').trim() || 'unknown';
  const normalizedMethod = String(method || 'GET').trim().toUpperCase();
  const readOp = isReadOperation(op, normalizedMethod);
  const state = getCircuitState(op);
  if (state.state === 'open') {
    await writeRequestLog({
      trace_id,
      span_id,
      route,
      start_ts,
      status: 429,
      error: 'circuit_open',
      metadata: {
        operation: op,
        upstream_route: `${normalizedMethod} ${proxyPath}`,
        circuit_state: 'open',
        retry_count: 0,
        cache_hit: false,
      },
    });
    return {
      ok: false,
      status: 429,
      error: 'circuit_open',
      data: { error: 'circuit_open', hint: 'Hubtiger operation is temporarily paused due to repeated upstream failures.' },
      latency_ms: 0,
      retry_count: 0,
      cache_hit: false,
      circuit_state: 'open',
    };
  }

  const key = readOp ? cacheKey(op, normalizedMethod, proxyPath, proxyBody) : null;
  if (readOp && redis && key) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        const payload = JSON.parse(cached);
        await writeRequestLog({
          trace_id,
          span_id,
          route,
          start_ts,
          status: Number(payload.status || 200),
          error: payload.ok ? null : payload.error || null,
          metadata: {
            operation: op,
            upstream_route: `${normalizedMethod} ${proxyPath}`,
            upstream_status: payload.status || null,
            upstream_latency_ms: payload.latency_ms || null,
            cache_hit: true,
            retry_count: 0,
            circuit_state: 'closed',
          },
        });
        return { ...payload, cache_hit: true, retry_count: 0, circuit_state: 'closed' };
      }
    } catch (_) {
      // Continue without cache.
    }
  }

  const maxAttempts = readOp ? 3 : 1;
  let attempt = 0;
  let last = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    const started = Date.now();
    const controller = new AbortController();
    const timeoutMs = readOp ? READ_TIMEOUT_MS : MUTATION_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const fetchOpts = {
        method: normalizedMethod,
        headers: { 'x-trace-id': trace_id },
        signal: controller.signal,
      };
      if (proxyBody && normalizedMethod !== 'GET') {
        fetchOpts.headers['Content-Type'] = 'application/json';
        fetchOpts.body = JSON.stringify(proxyBody);
      }
      const response = await fetch(`${HUBTIGER_PROXY_URL}${proxyPath}`, fetchOpts);
      const latency_ms = Date.now() - started;
      const ct = response.headers.get('content-type') || '';
      let data = null;
      if (ct.includes('application/json')) {
        data = await response.json().catch(() => null);
      } else {
        const text = await response.text().catch(() => '');
        data = text ? { _raw: text.slice(0, 2000) } : null;
      }
      clearTimeout(timer);
      const ok = response.ok;
      last = {
        ok,
        status: response.status,
        data,
        error: ok ? null : String(data?.error || data?.message || `hubtiger_proxy_${response.status}`),
        latency_ms,
      };
      if (ok) break;
      if (!readOp) break;
      if (response.status < 500 && response.status !== 429) break;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    } catch (err) {
      clearTimeout(timer);
      const latency_ms = Date.now() - started;
      last = {
        ok: false,
        status: 502,
        data: null,
        error: String(err?.name === 'AbortError' ? 'timeout' : err?.message || err),
        latency_ms,
      };
      if (!readOp) break;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }

  if (!last) {
    last = { ok: false, status: 500, data: null, error: 'hubtiger_mcp_unknown_failure', latency_ms: 0 };
  }

  if (last.ok) {
    markSuccess(op);
    if (readOp && redis && key) {
      try {
        await redis.setEx(
          key,
          Math.max(1, CACHE_TTL_SECONDS),
          JSON.stringify({
            ok: last.ok,
            status: last.status,
            data: last.data,
            error: last.error,
            latency_ms: last.latency_ms,
          })
        );
      } catch (_) {
        // Cache failures are non-blocking.
      }
    }
  } else {
    markFailure(op);
  }

  const stateAfter = getCircuitState(op);
  await writeRequestLog({
    trace_id,
    span_id,
    route,
    start_ts,
    status: Number(last.status || 0),
    error: last.ok ? null : last.error || 'hubtiger_mcp_failed',
    metadata: {
      operation: op,
      upstream_route: `${normalizedMethod} ${proxyPath}`,
      upstream_status: last.status || null,
      upstream_latency_ms: last.latency_ms || null,
      cache_hit: false,
      retry_count: Math.max(0, attempt - 1),
      circuit_state: stateAfter.state,
    },
  });

  return {
    ...last,
    retry_count: Math.max(0, attempt - 1),
    cache_hit: false,
    circuit_state: stateAfter.state,
  };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'hubtiger-mcp',
    hubtiger_proxy_url: HUBTIGER_PROXY_URL || null,
    redis_configured: !!REDIS_URL,
    db_logging: !!DATABASE_URL,
  });
});

app.post('/test', async (req, res) => {
  const trace_id = parseTraceId(req.headers['x-trace-id']);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const mapped = buildOperationExecuteRequest(body);
  const result = await callHubtigerProxy(
    mapped
      ? {
          trace_id,
          operation: mapped.operation,
          method: mapped.method,
          proxyPath: mapped.proxyPath,
          proxyBody: mapped.proxyBody,
        }
      : {
          trace_id,
          operation: 'jobs_search',
          method: 'POST',
          proxyPath: '/jobs/search',
          proxyBody: { q: String(body.query ?? body.q ?? 'test').trim() || 'test', allStores: body.allStores === true },
        }
  );
  return res.status(result.ok ? 200 : (result.status || 502)).json({
    ok: result.ok,
    trace_id,
    operation: mapped ? mapped.operation : 'jobs_search',
    status: result.status,
    latency_ms: result.latency_ms,
    retry_count: result.retry_count,
    cache_hit: result.cache_hit,
    circuit_state: result.circuit_state,
    data: result.data,
    error: result.error,
  });
});

app.post('/execute', async (req, res) => {
  const trace_id = parseTraceId(req.headers['x-trace-id']);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let operation = String(body.operation || '').trim();
  let method = String(body.method || '').trim().toUpperCase();
  let proxyPath = String(body.proxy_path || '').trim();
  let proxyBody = body.proxy_body && typeof body.proxy_body === 'object' ? body.proxy_body : null;

  // Support canonical control-api contract:
  // { operation: "job_lookup", payload: {...}, trace_id: "..." }
  // as well as low-level MCP contract:
  // { operation, method, proxy_path, proxy_body }
  if (operation && (!method || !proxyPath)) {
    const mapped = buildOperationExecuteRequest(body);
    if (mapped) {
      operation = mapped.operation;
      method = mapped.method;
      proxyPath = mapped.proxyPath;
      proxyBody = mapped.proxyBody;
    }
  }

  if (!operation || !method || !proxyPath || !proxyPath.startsWith('/')) {
    return res.status(400).json({
      ok: false,
      trace_id,
      error: 'invalid_mcp_execute_request',
      hint: 'Provide operation + payload, or operation + method + proxy_path.',
    });
  }

  const result = await callHubtigerProxy({
    trace_id,
    operation,
    method,
    proxyPath,
    proxyBody,
  });
  return res.status(result.ok ? 200 : (result.status || 502)).json({
    ok: result.ok,
    trace_id,
    operation,
    status: result.status,
    latency_ms: result.latency_ms,
    retry_count: result.retry_count,
    cache_hit: result.cache_hit,
    circuit_state: result.circuit_state,
    data: result.data,
    error: result.error,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  jsonLog({ level: 'info', msg: 'hubtiger-mcp listening', port: PORT });
});
1