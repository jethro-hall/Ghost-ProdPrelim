import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAgentBookingPayload,
  normalizeAuMobile,
  parseVehicleModel,
  resolveServiceTypeSelection,
  validateAgentBookingPayload,
} from './booking_orchestrator.js';

test('normalizeAuMobile converts 04 numbers to +61', () => {
  assert.equal(normalizeAuMobile('0435185134'), '+61435185134');
});

test('parseVehicleModel splits manufacturer and model', () => {
  assert.deepEqual(parseVehicleModel('Fatfish OG', null, null), {
    manufacturer: 'Fatfish',
    model: 'OG',
  });
});

test('validateAgentBookingPayload reports missing mandatory fields', () => {
  const result = validateAgentBookingPayload({
    first_name: 'Jeff',
    last_name: 'Hall',
    mobile: '0435185134',
    vehicle_model: 'Fatfish OG',
    issue_description: 'Squeaky brakes',
    ServiceDate: '2026-05-23T13:40',
    TechnicianID: 2730,
  });
  assert.equal(result.ok, true);
  assert.equal(result.missing.length, 0);
});

test('resolveServiceTypeSelection maps service_plus and service_full', () => {
  const plus = resolveServiceTypeSelection({ service_type: 'service_plus' });
  assert.equal(plus.serviceTypeIds[0], 19799);
  const full = resolveServiceTypeSelection({ service_type: 'service_full' });
  assert.equal(full.serviceTypeIds[0], 19798);
});

test('resolveServiceTypeSelection flags non-standard callback path', () => {
  const tyre = resolveServiceTypeSelection({ service_type: 'tyre replacement', needs_workshop_callback: true });
  assert.equal(tyre.needsWorkshopCallback, true);
  assert.equal(tyre.serviceTypeIds[0], 79575);
  assert.match(tyre.customerMessage, /call you back/i);
});

test('isAgentBookingPayload detects conversational booking shape', () => {
  assert.equal(
    isAgentBookingPayload({
      first_name: 'Jeff',
      ServiceDate: '2026-05-23T13:40',
      TechnicianID: 2730,
    }),
    true,
  );
  assert.equal(
    isAgentBookingPayload({
      ID: 2186,
      BikeID: 1,
      ServiceTypes: [19798],
      ServiceDate: '2026-05-23T13:40',
      TechnicianID: 2730,
    }),
    false,
  );
});
