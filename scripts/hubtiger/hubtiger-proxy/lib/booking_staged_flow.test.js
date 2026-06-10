import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkshopSlot, bookingServiceSet } from './booking_staged_flow.js';
import { createBookingSession, getBookingSession } from './booking_session_store.js';

test('validateWorkshopSlot rejects Sunday', () => {
  const sunday = new Date();
  sunday.setDate(sunday.getDate() + ((7 - sunday.getDay()) % 7 || 7));
  sunday.setHours(10, 0, 0, 0);
  const iso = sunday.toISOString().slice(0, 16);
  assert.match(validateWorkshopSlot(iso) || '', /Monday to Saturday/i);
});

test('validateWorkshopSlot rejects before 8:30am', () => {
  const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T08:00`;
  assert.match(validateWorkshopSlot(iso) || '', /8:30am/i);
});

test('booking session store roundtrip', () => {
  const id = createBookingSession({ store: 'brisbane' });
  const row = getBookingSession(id);
  assert.equal(row.store, 'brisbane');
  assert.equal(row.slot_confirmed, false);
});

test('bookingServiceSet requires bike confirmed', async () => {
  const id = createBookingSession({
    store: 'brisbane',
    slot_confirmed: true,
    bike_confirmed: false,
  });
  const result = await bookingServiceSet({
    payload: {
      booking_session_id: id,
      service_type: 'service_full',
      issue_description: 'Brake noise',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.workflow_node, 'booking_bike_confirm');
});
