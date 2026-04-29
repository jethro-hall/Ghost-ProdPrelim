import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { app, buildOperationExecuteRequest } from './index.js';

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
