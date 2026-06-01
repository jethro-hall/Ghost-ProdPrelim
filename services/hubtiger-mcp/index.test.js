import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  app,
  buildOperationExecuteRequest,
  filterSlotsToOperatingHours,
  getReadCacheTtlSeconds,
  isWithinWorkshopOperatingHours,
  pickClosestAvailabilitySlots,
  rankAvailabilityOffers,
  resolveHubtigerJobRetrieveWithFallback,
  validateHubtigerJobRetrieveResult,
} from './index.js';

test('pickClosestAvailabilitySlots returns three chronologically clustered times', () => {
  const slots = [
    { available_slot: '2026-05-22T09:00:00', display: '2026-05-22 09:00' },
    { available_slot: '2026-05-22T14:00:00', display: '2026-05-22 14:00' },
    { available_slot: '2026-05-22T10:00:00', display: '2026-05-22 10:00' },
    { available_slot: '2026-05-22T11:00:00', display: '2026-05-22 11:00' },
    { available_slot: '2026-05-23T11:00:00', display: '2026-05-23 11:00' },
  ];
  const closest = pickClosestAvailabilitySlots(slots, 3);
  assert.deepEqual(closest, ['2026-05-22 09:00', '2026-05-22 10:00', '2026-05-22 11:00']);
});

test('filterSlotsToOperatingHours removes Sunday and outside 8:30am-5pm', () => {
  assert.equal(isWithinWorkshopOperatingHours({ available_slot: '2026-05-24T10:00:00' }), false);
  assert.equal(isWithinWorkshopOperatingHours({ available_slot: '2026-05-25T08:00:00' }), false);
  assert.equal(isWithinWorkshopOperatingHours({ available_slot: '2026-05-25T08:30:00' }), true);
  assert.equal(isWithinWorkshopOperatingHours({ available_slot: '2026-05-25T16:45:00' }), true);
  assert.equal(isWithinWorkshopOperatingHours({ available_slot: '2026-05-25T17:00:00' }), false);
  const filtered = filterSlotsToOperatingHours([
    { available_slot: '2026-05-24T10:00:00', display: '2026-05-24 10:00' },
    { available_slot: '2026-05-25T08:00:00', display: '2026-05-25 08:00' },
    { available_slot: '2026-05-25T09:00:00', display: '2026-05-25 09:00' },
  ]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].display, '2026-05-25 09:00');
});

test('rankAvailabilityOffers picks latest slot before deadline plus two nearest backups', () => {
  const slots = [
    { available_slot: '2026-05-25T09:00:00', display: '2026-05-25 09:00', time: '09:00', date: '2026-05-25' },
    { available_slot: '2026-05-28T10:00:00', display: '2026-05-28 10:00', time: '10:00', date: '2026-05-28' },
    { available_slot: '2026-06-01T09:00:00', display: '2026-06-01 09:00', time: '09:00', date: '2026-06-01' },
    { available_slot: '2026-06-01T14:00:00', display: '2026-06-01 14:00', time: '14:00', date: '2026-06-01' },
    { available_slot: '2026-06-10T11:00:00', display: '2026-06-10 11:00', time: '11:00', date: '2026-06-10' },
  ];
  const ranked = rankAvailabilityOffers(slots, {
    deadlineDate: '2026-06-02',
    schedulingGoal: 'before_deadline',
  });
  assert.equal(ranked.recommended.display, '2026-06-01 14:00');
  assert.equal(ranked.backups.length, 2);
  assert.equal(ranked.labels[0], '2026-06-01 14:00');
  assert.ok(ranked.voiceSummary.includes('before 2 June'));
  assert.ok(ranked.voiceSummary.includes('2026-06-01 14:00'));
});

test('pickClosestAvailabilitySlots returns fewer than three when not enough slots', () => {
  const slots = [
    { available_slot: '2026-05-22T09:00:00', display: '2026-05-22 09:00' },
    { available_slot: '2026-05-22T14:00:00', display: '2026-05-22 14:00' },
  ];
  assert.deepEqual(pickClosestAvailabilitySlots(slots, 3), ['2026-05-22 09:00', '2026-05-22 14:00']);
});

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

test('buildOperationExecuteRequest maps booking_update to /bookings/update', () => {
  const mapped = buildOperationExecuteRequest({
    operation: 'booking_update',
    payload: {
      id: 4200325,
      ServiceDate: '2026-05-22T10:00:00',
      TechnicianID: 2730,
      send_communication: false,
    },
  });

  assert.equal(mapped.method, 'POST');
  assert.equal(mapped.proxyPath, '/bookings/update?sendCommunication=false');
  assert.deepEqual(mapped.proxyBody, {
    id: 4200325,
    ServiceDate: '2026-05-22T10:00:00',
    TechnicianID: 2730,
  });
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

const validJobRetrieveResult = {
  ok: true,
  status: 200,
  data: {
    matches: [
      {
        id: 4200325,
        jobCardNo: '#35872',
        customerName: 'Test Rider',
        bike: 'Fatfish OG',
        status: 'Booked In',
      },
    ],
    count: 1,
  },
  latency_ms: 50,
};

test('validateHubtigerJobRetrieveResult accepts usable cached job data', () => {
  const validation = validateHubtigerJobRetrieveResult({ ...validJobRetrieveResult, cache_hit: true });
  assert.equal(validation.ok, true);
  assert.equal(validation.reason, 'valid_job_retrieve');
  assert.equal(validation.source, 'cache');
});

test('validateHubtigerJobRetrieveResult rejects empty, unavailable, incomplete, and stale results', () => {
  assert.equal(validateHubtigerJobRetrieveResult(null).reason, 'empty_result');
  assert.equal(
    validateHubtigerJobRetrieveResult({
      ok: true,
      data: { message: 'The workshop system is temporarily unavailable.' },
    }).reason,
    'unavailable_placeholder'
  );
  assert.equal(
    validateHubtigerJobRetrieveResult({
      ok: true,
      data: { matches: [{ jobCardNo: '#35872' }] },
    }).reason,
    'missing_job_details'
  );
  assert.equal(
    validateHubtigerJobRetrieveResult(
      { ...validJobRetrieveResult, cached_at: 1 },
      { ttlMs: 1000, nowMs: 5000 }
    ).reason,
    'stale_cache'
  );
});

test('resolveHubtigerJobRetrieveWithFallback returns valid cache without fresh call', async () => {
  let freshCalled = false;
  const resolved = await resolveHubtigerJobRetrieveWithFallback({
    cachedResult: validJobRetrieveResult,
    fetchFresh: async () => {
      freshCalled = true;
      return validJobRetrieveResult;
    },
  });
  assert.equal(freshCalled, false);
  assert.equal(resolved.result.ok, true);
  assert.equal(resolved.result.data.business_success, true);
  assert.equal(resolved.result.data.source, 'cache');
  assert.equal(resolved.result.data.fallback_used, false);
});

test('resolveHubtigerJobRetrieveWithFallback self-heals transcript-style bad cache with fresh result', async () => {
  const transcriptBadCache = {
    ok: true,
    status: 200,
    data: {
      success: true,
      message: 'Tool succeeded',
      assistant_prompt: 'It looks like the workshop system is temporarily unavailable.',
    },
    latency_ms: 4,
  };
  const resolved = await resolveHubtigerJobRetrieveWithFallback({
    cachedResult: transcriptBadCache,
    fetchFresh: async () => validJobRetrieveResult,
  });
  assert.equal(resolved.cacheValidation.ok, false);
  assert.equal(resolved.cacheValidation.reason, 'unavailable_placeholder');
  assert.equal(resolved.result.ok, true);
  assert.equal(resolved.result.data.business_success, true);
  assert.equal(resolved.result.data.source, 'fresh');
  assert.equal(resolved.result.data.fallback_used, true);
  assert.equal(resolved.result.data.cache_reject_reason, 'unavailable_placeholder');
  assert.match(resolved.result.data.assistant_summary, /job card/i);
});

test('resolveHubtigerJobRetrieveWithFallback returns safe failure when cache and fresh are invalid', async () => {
  const resolved = await resolveHubtigerJobRetrieveWithFallback({
    cachedResult: { ok: true, data: {} },
    fetchFresh: async () => ({ ok: true, status: 200, data: { matches: [] } }),
  });
  assert.equal(resolved.result.ok, false);
  assert.equal(resolved.result.data.business_success, false);
  assert.equal(resolved.result.data.user_message, 'I could not retrieve the workshop record right now.');
  assert.equal(resolved.result.data.retryable, true);
  assert.equal(resolved.result.data.fallback_used, true);
});
