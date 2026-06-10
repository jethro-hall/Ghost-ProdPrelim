import crypto from 'node:crypto';

const DEFAULT_TTL_MS = Number(process.env.HUBTIGER_BOOKING_SESSION_TTL_MS || 2 * 60 * 60 * 1000);
const sessions = new Map();

function purgeExpired(now = Date.now()) {
  for (const [id, row] of sessions.entries()) {
    if (!row || now - row.updatedAt > DEFAULT_TTL_MS) sessions.delete(id);
  }
}

export function createBookingSession(initial = {}) {
  purgeExpired();
  const booking_session_id = crypto.randomUUID();
  const now = Date.now();
  sessions.set(booking_session_id, {
    store: null,
    slot: null,
    slot_confirmed: false,
    customer: null,
    customer_confirmed: false,
    customer_candidates: [],
    bike: null,
    bike_confirmed: false,
    bike_candidates: [],
    service: null,
    service_confirmed: false,
    ...initial,
    createdAt: now,
    updatedAt: now,
  });
  return booking_session_id;
}

export function getBookingSession(booking_session_id) {
  purgeExpired();
  const id = String(booking_session_id || '').trim();
  if (!id) return null;
  const row = sessions.get(id);
  if (!row) return null;
  if (Date.now() - row.updatedAt > DEFAULT_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  return row;
}

export function updateBookingSession(booking_session_id, patch = {}) {
  const row = getBookingSession(booking_session_id);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: Date.now() });
  sessions.set(booking_session_id, row);
  return row;
}

export function requireBookingSession(booking_session_id) {
  const row = getBookingSession(booking_session_id);
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: 'booking_session_not_found',
      hint: 'Start a new booking flow or repeat the previous step to obtain a fresh booking_session_id.',
    };
  }
  return { ok: true, session: row };
}
