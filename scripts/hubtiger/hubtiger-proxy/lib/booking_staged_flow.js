import {
  createBookingSession,
  requireBookingSession,
  updateBookingSession,
} from './booking_session_store.js';
import {
  normalizeAuMobile,
  parseVehicleModel,
  resolveServiceTypeSelection,
  orchestrateAgentBookingCreate,
} from './booking_orchestrator.js';

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function maskPhone(value) {
  const mobile = normalizeAuMobile(value);
  if (!mobile || mobile.length < 8) return mobile || '';
  return `${mobile.slice(0, 4)}***${mobile.slice(-3)}`;
}

function publicCustomerCandidate(row) {
  return {
    customer_id: Number(row.ID || row.id || 0),
    first_name: normalizeSpaces(row.Name),
    last_name: normalizeSpaces(row.Surname),
    phone_masked: maskPhone(row.PhoneNumber),
    has_email: Boolean(normalizeSpaces(row.Email)),
    service_count: Number(row.ServiceCount || 0),
  };
}

function publicBikeCandidate(row) {
  const manufacturer = normalizeSpaces(row.Manufacturer);
  const model = normalizeSpaces(row.Model);
  return {
    bike_id: Number(row.ID || row.id || 0),
    label: normalizeSpaces(row.RefNo) || `${manufacturer} ${model}`.trim(),
    manufacturer,
    model,
    colour: normalizeSpaces(row.Colour) || null,
    year: Number(row.ModelYear || 0) || null,
  };
}

export function validateWorkshopSlot(serviceDateRaw) {
  const raw = normalizeSpaces(serviceDateRaw);
  if (!raw) return 'A booking date and time is required.';
  const parsed = new Date(raw.length === 16 ? `${raw}:00` : raw);
  if (Number.isNaN(parsed.getTime())) return 'That booking time is not valid.';
  const now = new Date();
  if (parsed.getTime() < now.getTime() + 30 * 60 * 1000) {
    return 'Booking time must be at least 30 minutes in the future.';
  }
  if (parsed.getDay() === 0) return 'Bookings are available Monday to Saturday only.';
  const minutes = parsed.getHours() * 60 + parsed.getMinutes();
  if (minutes < 8 * 60 + 30 || minutes >= 17 * 60) {
    return 'Bookings are available between 8:30am and 5:00pm, Monday to Saturday.';
  }
  return null;
}

const WORKFLOW_NODE_ALIASES = {
  slot_hold: 'booking_slot',
  customer_search: 'booking_customer_search',
  customer_confirm: 'booking_customer_confirm',
  bike_list: 'booking_bike_list',
  bike_confirm: 'booking_bike_confirm',
  service_set: 'booking_service',
  service_collect: 'booking_service',
  submit: 'booking_submit',
  finalize: 'booking_submit',
  done: 'booking_complete',
};

function stagedResponse({
  ok = true,
  status = 200,
  booking_session_id,
  session,
  step,
  next_step,
  assistant_prompt,
  voice_line,
  error,
  hint,
  extra = {},
}) {
  const line = normalizeSpaces(voice_line || assistant_prompt);
  const node = WORKFLOW_NODE_ALIASES[next_step] || next_step || null;
  return {
    ok,
    status,
    error,
    hint,
    booking_session_id,
    step,
    next_step,
    workflow_node: node,
    assistant_prompt: line,
    voice_line: line,
    slot_confirmed: Boolean(session?.slot_confirmed),
    customer_confirmed: Boolean(session?.customer_confirmed),
    bike_confirmed: Boolean(session?.bike_confirmed),
    service_confirmed: Boolean(session?.service_confirmed),
    store: session?.store || null,
    ...extra,
  };
}

async function searchCyclist(auth, partnerId, query) {
  const path = `/api/Bikeshop/${encodeURIComponent(partnerId)}/Search/Cyclists`;
  const { response, data } = await auth.portalFetch({
    api: 'api',
    path,
    method: 'GET',
    query: { Page: 0, Limit: 20, Search: query },
    auth: 'bearer',
  });
  if (!response.ok) throw new Error(`cyclist_search_failed:${response.status}`);
  return Array.isArray(data?.cyclists) ? data.cyclists : Array.isArray(data) ? data : [];
}

function pickCyclistMatch(rows, { firstName, lastName, mobile }) {
  const normalizedMobile = normalizeAuMobile(mobile);
  const exact = rows.find((row) => normalizeAuMobile(row.PhoneNumber) === normalizedMobile);
  if (exact) return exact;
  const nameMatch = rows.find(
    (row) =>
      normalizeSpaces(row.Name).toLowerCase() === firstName.toLowerCase() &&
      normalizeSpaces(row.Surname).toLowerCase() === lastName.toLowerCase(),
  );
  return nameMatch || null;
}

async function createCustomer(auth, partnerId, customer) {
  const body = {
    PartnerID: Number(partnerId),
    Name: customer.firstName,
    Surname: customer.lastName,
    PhoneNumber: customer.mobile,
    Email: customer.email || '',
  };
  const { response, data } = await auth.portalFetch({
    api: 'api',
    path: '/api/store/customers',
    method: 'POST',
    body,
    auth: 'none',
  });
  if (!response.ok) throw new Error(`customer_create_failed:${response.status}`);
  const userId = Number(data?.ID || data?.id || data?.UserID || data?.userId || 0);
  if (!userId) throw new Error('customer_create_missing_user_id');
  return userId;
}

async function listActiveBikes(auth, userId, partnerId) {
  const path = `/api/Cyclist/${encodeURIComponent(userId)}/activebikes/partner/${encodeURIComponent(partnerId)}`;
  const { response, data } = await auth.portalFetch({
    api: 'services',
    path,
    method: 'GET',
    auth: 'bearer',
  });
  if (!response.ok) throw new Error(`bike_list_failed:${response.status}`);
  return Array.isArray(data) ? data : [];
}

async function createBike(auth, userId, vehicle) {
  const body = {
    ID: 0,
    UserID: Number(userId),
    RefNo: `${vehicle.manufacturer} - ${vehicle.model}`,
    SerialNo: null,
    Manufacturer: vehicle.manufacturer,
    Model: vehicle.model,
    Colour: vehicle.colour || 'Unknown',
    ModelYear: vehicle.year || new Date().getFullYear(),
    TypeID: 99,
    LastService: new Date().toISOString(),
    DateBought: null,
    StatusID: 0,
    PartnerType: 1,
  };
  const { response, data } = await auth.portalFetch({
    api: 'services',
    path: '/api/Bike',
    method: 'POST',
    body,
    auth: 'bearer',
  });
  if (!response.ok) throw new Error(`bike_create_failed:${response.status}`);
  const bikeId = Number(data?.ID || data?.id || 0);
  if (!bikeId) throw new Error('bike_create_missing_id');
  return bikeId;
}

function resolveSessionId(payload) {
  return normalizeSpaces(payload.booking_session_id || payload.bookingSessionId);
}

function ensureStore(payload, session) {
  const store = normalizeSpaces(payload.store || session?.store);
  if (!store) return { ok: false, error: 'store_required', hint: 'Set store (brisbane, southport, or burleigh) before continuing.' };
  return { ok: true, store };
}

/**
 * 1a — Hold preferred slot (skip if availability tool already confirmed a slot).
 */
export async function bookingSlotHold({ auth, payload, partnerId }) {
  const existingId = resolveSessionId(payload);
  let booking_session_id = existingId;
  let session = null;
  if (existingId) {
    const check = requireBookingSession(existingId);
    if (!check.ok) {
      return stagedResponse({ ok: false, status: check.status || 404, error: check.error, hint: check.hint });
    }
    session = check.session;
  }

  const skip = Boolean(payload.slot_from_availability || payload.skip_slot_step);
  const storeResult = ensureStore(payload, session);
  if (!storeResult.ok) {
    return stagedResponse({ ok: false, status: 400, error: storeResult.error, hint: storeResult.hint, booking_session_id });
  }

  if (!booking_session_id) {
    booking_session_id = createBookingSession({ store: storeResult.store });
    session = requireBookingSession(booking_session_id).session;
  } else {
    updateBookingSession(booking_session_id, { store: storeResult.store });
    session = requireBookingSession(booking_session_id).session;
  }

  if (skip || session.slot_confirmed) {
    const serviceDate = normalizeSpaces(payload.ServiceDate || payload.service_date || session.slot?.ServiceDate);
    const technicianId = Number(
      payload.TechnicianID || payload.technician_id || session.slot?.TechnicianID || 0,
    );
    if (!serviceDate || !technicianId) {
      return stagedResponse({
        ok: false,
        status: 400,
        booking_session_id,
        session,
        error: 'slot_fields_required',
        hint: 'After availability lookup, pass ServiceDate and TechnicianID once to start the booking session.',
        step: 'slot_hold',
        next_step: 'slot_hold',
      });
    }
    const hoursErr = validateWorkshopSlot(serviceDate);
    if (hoursErr) {
      return stagedResponse({
        ok: false,
        status: 400,
        booking_session_id,
        session,
        error: 'invalid_booking_slot',
        hint: hoursErr,
        step: 'slot_hold',
        next_step: 'slot_hold',
      });
    }
    updateBookingSession(booking_session_id, {
      store: storeResult.store,
      slot_confirmed: true,
      slot: {
        ServiceDate: serviceDate,
        TechnicianID: technicianId,
        slot_label: normalizeSpaces(payload.slot_label || payload.slotLabel || session.slot?.slot_label) || null,
      },
    });
    session = requireBookingSession(booking_session_id).session;
    return stagedResponse({
      booking_session_id,
      session,
      step: 'slot_hold',
      next_step: 'customer_search',
      assistant_prompt: 'Ask for their first name, last name, and mobile number.',
      slot_summary: session.slot?.slot_label || serviceDate,
    });
  }

  const serviceDate = normalizeSpaces(payload.ServiceDate || payload.service_date);
  const technicianId = Number(payload.TechnicianID || payload.technician_id || 0);
  const hoursErr = validateWorkshopSlot(serviceDate);
  if (hoursErr) {
    return stagedResponse({
      ok: false,
      status: 400,
      booking_session_id,
      session,
      error: 'invalid_booking_slot',
      hint: hoursErr,
      step: 'slot_hold',
      next_step: 'slot_hold',
    });
  }
  if (!Number.isFinite(technicianId) || technicianId <= 0) {
    return stagedResponse({
      ok: false,
      status: 400,
      booking_session_id,
      session,
      error: 'technician_required',
      hint: 'TechnicianID from the availability result is required.',
      step: 'slot_hold',
      next_step: 'slot_hold',
    });
  }

  updateBookingSession(booking_session_id, {
    store: storeResult.store,
    slot_confirmed: true,
    slot: {
      ServiceDate: serviceDate,
      TechnicianID: technicianId,
      slot_label: normalizeSpaces(payload.slot_label || payload.slotLabel) || null,
    },
  });
  session = requireBookingSession(booking_session_id).session;
  return stagedResponse({
    booking_session_id,
    session,
    step: 'slot_hold',
    next_step: 'customer_search',
    assistant_prompt: 'Confirm the chosen time with the customer, then collect first name, last name, and mobile.',
    slot_summary: session.slot?.slot_label || serviceDate,
  });
}

/**
 * 1b — Search customer; returns up to 3 matches. Does not confirm.
 */
export async function bookingCustomerSearch({ auth, payload, partnerId }) {
  const booking_session_id = resolveSessionId(payload);
  const sessionCheck = requireBookingSession(booking_session_id);
  if (!sessionCheck.ok) return sessionCheck;
  let session = sessionCheck.session;

  const storeResult = ensureStore(payload, session);
  if (!storeResult.ok) {
    return stagedResponse({ ok: false, status: 400, error: storeResult.error, hint: storeResult.hint, booking_session_id });
  }
  if (!session.slot_confirmed) {
    return stagedResponse({
      ok: false,
      status: 409,
      booking_session_id,
      session,
      error: 'slot_not_confirmed',
      hint: 'Call booking_slot_hold first or pass slot_from_availability with ServiceDate and TechnicianID.',
      step: 'customer_search',
      next_step: 'slot_hold',
    });
  }

  const firstName = normalizeSpaces(payload.first_name || payload.firstName);
  const lastName = normalizeSpaces(payload.last_name || payload.lastName);
  const mobile = normalizeAuMobile(payload.mobile || payload.phone);
  const email = normalizeSpaces(payload.email || payload.Email);
  const missing = [];
  if (!firstName) missing.push('first_name');
  if (!lastName) missing.push('last_name');
  if (!mobile) missing.push('mobile');
  if (missing.length) {
    return stagedResponse({
      ok: false,
      status: 400,
      booking_session_id,
      session,
      error: 'customer_fields_required',
      missing,
      step: 'customer_search',
      next_step: 'customer_search',
    });
  }

  const searchKeys = [mobile, `${firstName} ${lastName}`.trim(), email].filter(Boolean);
  let rows = [];
  for (const key of searchKeys) {
    const found = await searchCyclist(auth, partnerId, key);
    if (found.length) {
      rows = found;
      break;
    }
  }

  const candidates = rows.slice(0, 3).map(publicCustomerCandidate);
  const exact = pickCyclistMatch(rows, { firstName, lastName, mobile });
  updateBookingSession(booking_session_id, {
    store: storeResult.store,
    customer: { firstName, lastName, mobile, email },
    customer_confirmed: false,
    customer_candidates: candidates,
    suggested_customer_id: exact ? Number(exact.ID) : null,
  });
  session = requireBookingSession(booking_session_id).session;

  if (candidates.length === 0) {
    return stagedResponse({
      booking_session_id,
      session,
      step: 'customer_search',
      next_step: 'customer_confirm',
      assistant_prompt:
        'No matching customer was found. Confirm their name and mobile are correct, then create their profile.',
      match_count: 0,
      candidates: [],
      create_recommended: true,
    });
  }
  if (candidates.length === 1) {
    return stagedResponse({
      booking_session_id,
      session,
      step: 'customer_search',
      next_step: 'customer_confirm',
      assistant_prompt: `I found one customer record for ${firstName} ${lastName}. Confirm this is them before continuing.`,
      match_count: 1,
      candidates,
      suggested_customer_id: session.suggested_customer_id,
    });
  }
  return stagedResponse({
    booking_session_id,
    session,
    step: 'customer_search',
    next_step: 'customer_confirm',
    assistant_prompt: `I found ${candidates.length} possible matches. Ask which customer this is (by name), or confirm we should add a new customer.`,
    match_count: candidates.length,
    candidates,
    suggested_customer_id: session.suggested_customer_id,
  });
}

/**
 * 1b — Confirm customer_id or create new. Blocks bike steps until confirmed.
 */
export async function bookingCustomerConfirm({ auth, payload, partnerId }) {
  const booking_session_id = resolveSessionId(payload);
  const sessionCheck = requireBookingSession(booking_session_id);
  if (!sessionCheck.ok) return sessionCheck;
  let session = sessionCheck.session;

  if (!session.customer) {
    return stagedResponse({
      ok: false,
      status: 409,
      booking_session_id,
      session,
      error: 'customer_search_required',
      hint: 'Run booking_customer_search before confirming the customer.',
      step: 'customer_confirm',
      next_step: 'customer_search',
    });
  }

  const createNew = Boolean(payload.create_new || payload.createNew || payload.confirm_create);
  const customerId = Number(payload.customer_id || payload.customerId || 0);
  let userId = 0;

  if (createNew) {
    userId = await createCustomer(auth, partnerId, session.customer);
  } else if (customerId > 0) {
    userId = customerId;
  } else if (session.suggested_customer_id) {
    userId = Number(session.suggested_customer_id);
  } else if (session.customer_candidates?.length === 1) {
    userId = Number(session.customer_candidates[0].customer_id);
  } else {
    return stagedResponse({
      ok: false,
      status: 400,
      booking_session_id,
      session,
      error: 'customer_selection_required',
      hint: 'Pass customer_id from candidates, or set create_new true to add a new customer.',
      step: 'customer_confirm',
      next_step: 'customer_confirm',
      candidates: session.customer_candidates || [],
    });
  }

  updateBookingSession(booking_session_id, {
    customer_confirmed: true,
    customer: { ...session.customer, user_id: userId },
  });
  session = requireBookingSession(booking_session_id).session;

  return stagedResponse({
    booking_session_id,
    session,
    step: 'customer_confirm',
    next_step: 'bike_list',
    assistant_prompt: 'Ask for their bike or scooter model (manufacturer and model, e.g. Fatfish OG).',
    customer_confirmed: true,
  });
}

/**
 * 2a — List bikes on file for confirmed customer.
 */
export async function bookingBikeList({ auth, payload, partnerId }) {
  const booking_session_id = resolveSessionId(payload);
  const sessionCheck = requireBookingSession(booking_session_id);
  if (!sessionCheck.ok) return sessionCheck;
  let session = sessionCheck.session;

  if (!session.customer_confirmed || !session.customer?.user_id) {
    return stagedResponse({
      ok: false,
      status: 409,
      booking_session_id,
      session,
      error: 'customer_not_confirmed',
      hint: 'Confirm the customer before listing bikes.',
      step: 'bike_list',
      next_step: 'customer_confirm',
    });
  }

  const rows = await listActiveBikes(auth, session.customer.user_id, partnerId);
  const candidates = rows.slice(0, 8).map(publicBikeCandidate);
  updateBookingSession(booking_session_id, { bike_candidates: candidates, bike_confirmed: false });
  session = requireBookingSession(booking_session_id).session;

  if (!candidates.length) {
    return stagedResponse({
      booking_session_id,
      session,
      step: 'bike_list',
      next_step: 'bike_confirm',
      assistant_prompt: 'No bikes are on file. Ask for manufacturer and model, then add the bike.',
      match_count: 0,
      candidates: [],
      create_recommended: true,
    });
  }
  if (candidates.length === 1) {
    return stagedResponse({
      booking_session_id,
      session,
      step: 'bike_list',
      next_step: 'bike_confirm',
      assistant_prompt: `They have one bike on file: ${candidates[0].label}. Confirm this is the correct bike.`,
      match_count: 1,
      candidates,
      suggested_bike_id: candidates[0].bike_id,
    });
  }
  return stagedResponse({
    booking_session_id,
    session,
    step: 'bike_list',
    next_step: 'bike_confirm',
    assistant_prompt: 'Read out their bikes on file and ask which one this booking is for, or if we should add a new bike.',
    match_count: candidates.length,
    candidates,
  });
}

/**
 * 2b — Confirm bike_id or create from vehicle_model.
 */
export async function bookingBikeConfirm({ auth, payload, partnerId }) {
  const booking_session_id = resolveSessionId(payload);
  const sessionCheck = requireBookingSession(booking_session_id);
  if (!sessionCheck.ok) return sessionCheck;
  let session = sessionCheck.session;

  if (!session.customer_confirmed || !session.customer?.user_id) {
    return stagedResponse({
      ok: false,
      status: 409,
      booking_session_id,
      session,
      error: 'customer_not_confirmed',
      step: 'bike_confirm',
      next_step: 'customer_confirm',
    });
  }

  const bikeId = Number(payload.bike_id || payload.bikeId || 0);
  const createNew = Boolean(payload.create_new || payload.createNew);
  const vehicle = parseVehicleModel(
    payload.vehicle_model || payload.vehicleModel,
    payload.manufacturer || payload.bike_manufacturer,
    payload.bike_model || payload.model,
  );
  if (payload.colour || payload.color) vehicle.colour = normalizeSpaces(payload.colour || payload.color);
  if (payload.year || payload.model_year) vehicle.year = Number(payload.year || payload.model_year);

  let resolvedBikeId = bikeId;
  if (!resolvedBikeId && createNew) {
    if (!vehicle.manufacturer || vehicle.manufacturer === 'Unknown' || !vehicle.model || vehicle.model === 'Unknown') {
      return stagedResponse({
        ok: false,
        status: 400,
        booking_session_id,
        session,
        error: 'vehicle_model_required',
        hint: 'Provide vehicle_model (e.g. Fatfish OG) when adding a new bike.',
        step: 'bike_confirm',
        next_step: 'bike_confirm',
      });
    }
    resolvedBikeId = await createBike(auth, session.customer.user_id, vehicle);
  } else if (!resolvedBikeId && session.bike_candidates?.length === 1) {
    resolvedBikeId = Number(session.bike_candidates[0].bike_id);
  } else if (!resolvedBikeId) {
    return stagedResponse({
      ok: false,
      status: 400,
      booking_session_id,
      session,
      error: 'bike_selection_required',
      hint: 'Pass bike_id from bike_list, or create_new with vehicle_model.',
      step: 'bike_confirm',
      next_step: 'bike_confirm',
      candidates: session.bike_candidates || [],
    });
  }

  updateBookingSession(booking_session_id, {
    bike_confirmed: true,
    bike: { bike_id: resolvedBikeId, ...vehicle },
  });
  session = requireBookingSession(booking_session_id).session;

  return stagedResponse({
    booking_session_id,
    session,
    step: 'bike_confirm',
    next_step: 'service_collect',
    voice_line: 'Got it. What would you like us to do — a Service Full, Service Plus, or something else?',
    bike_confirmed: true,
  });
}

/**
 * 3a — Store service type and issue on session (no HubTiger write; fast).
 */
export async function bookingServiceSet({ payload }) {
  const booking_session_id = resolveSessionId(payload);
  const sessionCheck = requireBookingSession(booking_session_id);
  if (!sessionCheck.ok) return sessionCheck;
  let session = sessionCheck.session;

  if (!session.bike_confirmed) {
    return stagedResponse({
      ok: false,
      status: 409,
      booking_session_id,
      session,
      error: 'bike_not_confirmed',
      next_step: 'bike_confirm',
      step: 'service_set',
      voice_line: 'I still need to confirm your bike before we pick the service.',
    });
  }

  const issue = normalizeSpaces(
    payload.issue_description || payload.customer_request || payload.notes || payload.Notes,
  );
  const serviceType = normalizeSpaces(payload.service_type || payload.serviceType);
  const needsCallback = Boolean(
    payload.needs_workshop_callback ?? payload.needsWorkshopCallback ?? payload.non_standard_service,
  );

  if (!issue) {
    return stagedResponse({
      ok: false,
      status: 400,
      booking_session_id,
      session,
      error: 'issue_description_required',
      step: 'service_set',
      next_step: 'service_collect',
      voice_line: 'What’s going on with the bike, or what would you like us to look at?',
    });
  }
  if (!serviceType) {
    return stagedResponse({
      ok: false,
      status: 400,
      booking_session_id,
      session,
      error: 'service_type_required',
      step: 'service_set',
      next_step: 'service_collect',
      voice_line: 'Would you like a Service Full or a Service Plus?',
    });
  }

  const selection = resolveServiceTypeSelection({
    service_type: serviceType,
    needs_workshop_callback: needsCallback,
  });

  updateBookingSession(booking_session_id, {
    service_confirmed: true,
    service: {
      service_type: serviceType,
      service_label: selection.serviceLabel,
      issue_description: issue,
      needs_workshop_callback: Boolean(selection.needsWorkshopCallback || needsCallback),
    },
  });
  session = requireBookingSession(booking_session_id).session;

  const voice_line = selection.needsWorkshopCallback
    ? 'Thanks — I’ve noted that. I’ll lock in your booking now and a mechanic will call you about the work and costs.'
    : 'Perfect. I’ll confirm that booking for you now.';

  return stagedResponse({
    booking_session_id,
    session,
    step: 'service_set',
    next_step: 'submit',
    voice_line,
    service_label: selection.serviceLabel,
    needs_workshop_callback: Boolean(session.service?.needs_workshop_callback),
  });
}

/**
 * 3b — Submit ScheduleService from full session (HubTiger write).
 */
export async function bookingSubmit({
  auth,
  payload,
  partnerId,
  createdByUserId,
  sendCommunication = true,
}) {
  const booking_session_id = resolveSessionId(payload);
  const sessionCheck = requireBookingSession(booking_session_id);
  if (!sessionCheck.ok) return sessionCheck;
  const session = sessionCheck.session;

  if (!session.slot_confirmed || !session.slot?.ServiceDate) {
    return stagedResponse({
      ok: false,
      status: 409,
      booking_session_id,
      session,
      error: 'slot_not_confirmed',
      next_step: 'slot_hold',
      voice_line: 'Let me grab your appointment time first.',
    });
  }
  if (!session.customer_confirmed) {
    return stagedResponse({
      ok: false,
      status: 409,
      booking_session_id,
      session,
      error: 'customer_not_confirmed',
      next_step: 'customer_confirm',
      voice_line: 'I just need to confirm your contact details first.',
    });
  }
  if (!session.bike_confirmed || !session.bike?.bike_id) {
    return stagedResponse({
      ok: false,
      status: 409,
      booking_session_id,
      session,
      error: 'bike_not_confirmed',
      next_step: 'bike_confirm',
      voice_line: 'I still need your bike details before I can book you in.',
    });
  }

  let service = session.service;
  if (!service?.issue_description || !service?.service_type) {
    const issue = normalizeSpaces(
      payload.issue_description || payload.customer_request || payload.notes || payload.Notes,
    );
    const serviceType = normalizeSpaces(payload.service_type || payload.serviceType);
    if (issue && serviceType) {
      const selection = resolveServiceTypeSelection({
        service_type: serviceType,
        needs_workshop_callback: payload.needs_workshop_callback ?? payload.needsWorkshopCallback,
      });
      service = {
        service_type: serviceType,
        service_label: selection.serviceLabel,
        issue_description: issue,
        needs_workshop_callback: Boolean(selection.needsWorkshopCallback),
      };
      updateBookingSession(booking_session_id, { service_confirmed: true, service });
    }
  }

  if (!service?.issue_description || !service?.service_type) {
    return stagedResponse({
      ok: false,
      status: 409,
      booking_session_id,
      session,
      error: 'service_not_confirmed',
      step: 'submit',
      next_step: 'service_collect',
      voice_line: 'What service would you like, and what should we know about the bike?',
    });
  }

  const mergedPayload = {
    store: session.store,
    first_name: session.customer.firstName,
    last_name: session.customer.lastName,
    mobile: session.customer.mobile,
    email: session.customer.email,
    vehicle_model: `${session.bike.manufacturer} ${session.bike.model}`.trim(),
    manufacturer: session.bike.manufacturer,
    model: session.bike.model,
    issue_description: service.issue_description,
    service_type: service.service_type,
    needs_workshop_callback: service.needs_workshop_callback,
    ServiceDate: session.slot.ServiceDate,
    TechnicianID: session.slot.TechnicianID,
    BikeID: session.bike.bike_id,
    ID: session.customer.user_id,
  };

  const result = await orchestrateAgentBookingCreate({
    auth,
    payload: mergedPayload,
    sendCommunication,
    partnerId,
    createdByUserId,
  });

  if (!result.ok) {
    return {
      ok: false,
      status: result.status || 502,
      booking_session_id,
      error: result.error,
      hint: result.hint,
      step: 'submit',
      next_step: 'submit',
      workflow_node: 'booking_submit',
      voice_line: 'I couldn’t lock that in just now. I can try again or get the workshop to call you back.',
    };
  }

  const customerOutcome = result.customer_outcome;
  const voice_line =
    customerOutcome === 'pending_workshop_callback'
      ? 'You’re on the books. A mechanic will call you shortly about the work and any costs. You’ll also get SMS updates.'
      : customerOutcome === 'pending_staff_review'
        ? 'I’ve sent that to our workshop team to confirm. You’ll get an SMS once it’s locked in.'
        : 'You’re all booked in. You’ll get SMS updates from Ride Electric shortly.';

  return {
    ok: true,
    status: 200,
    booking_session_id,
    step: 'submit',
    next_step: 'done',
    workflow_node: 'booking_complete',
    assistant_prompt: voice_line,
    voice_line,
    booking_confirmed: Boolean(result.booking_confirmed),
    customer_outcome: customerOutcome,
    job_card_no: result.data?.job_card_no || null,
    service_type: result.data?.service_type || service.service_label,
    needs_workshop_callback: Boolean(result.data?.needs_workshop_callback),
    slot_confirmed: true,
    customer_confirmed: true,
    bike_confirmed: true,
    service_confirmed: true,
  };
}

/** @deprecated Use booking_service_set + booking_submit in separate workflow nodes. */
export async function bookingFinalize({
  auth,
  payload,
  partnerId,
  createdByUserId,
  sendCommunication = true,
}) {
  const setPayload = { ...payload };
  const hasServiceFields =
    normalizeSpaces(setPayload.issue_description || setPayload.notes) &&
    normalizeSpaces(setPayload.service_type || setPayload.serviceType);
  if (hasServiceFields) {
    const setResult = await bookingServiceSet({ payload: setPayload });
    if (!setResult.ok) return setResult;
  }
  return bookingSubmit({ auth, payload, partnerId, createdByUserId, sendCommunication });
}
