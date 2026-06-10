import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPortalJobSearchRequest, mapPortalSearchItem } from './index.js';

test('buildPortalJobSearchRequest matches lookup-only HAR contract', () => {
  const request = buildPortalJobSearchRequest({
    partnerId: 2186,
    query: '0435185134',
    allStores: false,
  });

  assert.ok(request);
  assert.equal(request.api, 'services');
  assert.equal(request.path, '/api/ServiceRequest/JobCardSearch');
  assert.equal(request.method, 'POST');
  assert.equal(request.auth, 'bearer');
  assert.deepEqual(request.payload, {
    PartnerID: 2186,
    Search: '0435185134',
    SearchAllStores: false,
  });
});

test('buildPortalJobSearchRequest fails closed without partner id', () => {
  const request = buildPortalJobSearchRequest({
    partnerId: '',
    query: '0435185134',
    allStores: false,
  });

  assert.equal(request, null);
});

test('mapPortalSearchItem preserves cyclist description as customer name', () => {
  const mapped = mapPortalSearchItem({
    ID: 4200325,
    JobCardNo: '#35872',
    CyclistDescription: 'Jeff Hall',
    BikeDescription: 'Fatfish Biggie',
    StatusID: 20,
    DateCheckedIn: '2026-04-30T10:30:00',
  });

  assert.equal(mapped.customerName, 'Jeff Hall');
  assert.equal(mapped.bike, 'Fatfish Biggie');
  assert.equal(mapped.status, 'Booked In');
});
