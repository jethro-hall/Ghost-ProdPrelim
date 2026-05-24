import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { app, buildOperationExecuteRequest, getReadCacheTtlSeconds } from './index.js';

test('buildOperationExecuteRequest maps booking_create to /bookings', () => {
  const mapped = buildOperationExecuteRequest({
    operation: 'booking_create',
    payload: {
      store: 'brisbane',
      firstName: 'Alex',
      sendCommunication: false,
    },
  });

  assert.equal(mapped.method, 'POST');
  assert.equal(mapped.proxyPath, '/bookings?sendCommunication=false');
  assert.deepEqual(mapped.proxyBody, { store: 'brisbane', firstName: 'Alex' });
});

test('buildOperationExecuteRequest maps quote_add_line_item to /quotes/find-add dryRun false', () => {
  const mapped = buildOperationExecuteRequest({
    operation: 'quote_add_line_item',
    payload: {
      serviceId: 12,
      search: 'brake pads',
      quantity: 2,
    },
  });

  assert.equal(mapped.method, 'POST');
  assert.equal(mapped.proxyPath, '/quotes/find-add');
  assert.deepEqual(mapped.proxyBody, {
    serviceId: 12,
    search: 'brake pads',
    quantity: 2,
    dryRun: false,
  });
});

test('buildOperationExecuteRequest maps job_lookup with job_id to jobs search route', () => {
  const mapped = buildOperationExecuteRequest({
    operation: 'job_lookup',
    payload: {
      job_id: '4200325',
    },
  });

  assert.equal(mapped.method, 'POST');
  assert.equal(mapped.proxyPath, '/jobs/search');
  assert.deepEqual(mapped.proxyBody, {
    q: '4200325',
    allStores: true,
  });
});

test('buildOperationExecuteRequest maps job_search to jobs search route', () => {
  const mapped = buildOperationExecuteRequest({
    operation: 'job_search',
    payload: {
      phone: '0435185134',
    },
  });
  assert.equal(mapped.method, 'POST');
  assert.equal(mapped.proxyPath, '/jobs/search');
  assert.deepEqual(mapped.proxyBody, {
    q: '0435185134',
    allStores: true,
  });
});

test('buildOperationExecuteRequest accepts cache bypass hint from payload', () => {
  const mapped = buildOperationExecuteRequest({
    operation: 'job_search',
    payload: {
      phone: '0435185134',
      cache_mode: 'no_cache',
    },
  });
  assert.equal(mapped.cacheMode, 'bypass');
  assert.equal(mapped.proxyPath, '/jobs/search');
});

test('buildOperationExecuteRequest accepts cache bypass hint from top-level body', () => {
  const mapped = buildOperationExecuteRequest({
    operation: 'job_retrieve',
    cache_mode: 'fresh',
    payload: {
      job_card_no: '#35872',
    },
  });
  assert.equal(mapped.cacheMode, 'bypass');
  assert.equal(mapped.proxyPath, '/jobs/search');
});

test('buildOperationExecuteRequest maps job_retrieve to jobs search route', () => {
  const mapped = buildOperationExecuteRequest({
    operation: 'job_retrieve',
    payload: {
      job_card_no: '#35872',
    },
  });
  assert.equal(mapped.method, 'POST');
  assert.equal(mapped.proxyPath, '/jobs/search');
  assert.deepEqual(mapped.proxyBody, {
    q: '#35872',
    allStores: true,
  });
});

test('POST /test rejects unsupported operations instead of defaulting to jobs search', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'totally_unsupported_operation',
        payload: {},
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unsupported_hubtiger_test_operation');
    assert.equal(body.operation, 'totally_unsupported_operation');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('getReadCacheTtlSeconds returns operation-specific conservative defaults', () => {
  assert.equal(getReadCacheTtlSeconds('job_lookup'), 20);
  assert.equal(getReadCacheTtlSeconds('availability_lookup'), 60);
  assert.equal(getReadCacheTtlSeconds('quote_preview'), 10);
});

test('bi-directional cache mode derives alias keys for job lookup records', async () => {
  const priorDirection = process.env.HUBTIGER_MCP_CACHE_DIRECTION;
  process.env.HUBTIGER_MCP_CACHE_DIRECTION = 'bi_directional';
  const moduleUrl = new URL('./index.js?cache-bi-directional-test=1', import.meta.url).href;
  const imported = await import(moduleUrl);
  const aliases = imported.collectJobLookupAliasCacheKeys({
    operation: 'job_lookup',
    data: {
      matches: [
        { id: 4200325, jobCardNo: '#35872' },
      ],
    },
  });
  if (priorDirection === undefined) {
    delete process.env.HUBTIGER_MCP_CACHE_DIRECTION;
  } else {
    process.env.HUBTIGER_MCP_CACHE_DIRECTION = priorDirection;
  }
  assert.ok(aliases.length >= 2);
});
