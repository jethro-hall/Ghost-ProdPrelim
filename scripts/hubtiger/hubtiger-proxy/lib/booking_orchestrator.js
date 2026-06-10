import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_TYPE_CONFIG = JSON.parse(
  readFileSync(join(__dirname, '../config/booking_service_types.json'), 'utf8'),
);

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeAuMobile(value) {
  const raw = normalizeSpaces(value);
  if (!raw) return '';
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+61')) return digits;
  if (digits.startsWith('61') && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith('0')) return `+61${digits.slice(1)}`;
  if (/^\d{9,10}$/.test(digits)) return `+61${digits.replace(/^0/, '')}`;
  return raw;
}

export function parseVehicleModel(vehicleModel, manufacturer, model) {
  const explicitManufacturer = normalizeSpaces(manufacturer);
  const explicitModel = normalizeSpaces(model);
  if (explicitManufacturer && explicitModel) {
    return { manufacturer: explicitManufacturer, model: explicitModel };
  }
  const combined = normalizeSpaces(vehicleModel);
  if (!combined) return { manufacturer: 'Unknown', model: 'Unknown' };
  const parts = combined.split(' ');
  if (parts.length === 1) return { manufacturer: parts[0], model: 'Unknown' };
  return { manufacturer: parts[0], model: parts.slice(1).join(' ') };
}

export function isAgentBookingPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.ID && payload.BikeID && Array.isArray(payload.ServiceTypes) && payload.ServiceTypes.length) {
    return false;
  }
  return Boolean(
    payload.firstName ||
      payload.first_name ||
      payload.lastName ||
      payload.last_name ||
      payload.mobile ||
      payload.phone ||
      payload.vehicleModel ||
      payload.vehicle_model ||
      payload.manufacturer ||
      payload.model,
  );
}

export function validateAgentBookingPayload(payload) {
  const missing = [];
  const firstName = normalizeSpaces(payload.firstName || payload.first_name);
  const lastName = normalizeSpaces(payload.lastName || payload.last_name);
  const mobile = normalizeAuMobile(payload.mobile || payload.phone);
  const notes = normalizeSpaces(
    payload.Notes || payload.notes || payload.customer_notes || payload.issue_description || payload.customer_request,
  );
  const vehicle = parseVehicleModel(
    payload.vehicleModel || payload.vehicle_model,
    payload.manufacturer || payload.bike_manufacturer,
    payload.bike_model || payload.model,
  );
  const serviceDate = normalizeSpaces(payload.ServiceDate || payload.serviceDate || payload.scheduled_date);
  const technicianId = Number(payload.TechnicianID || payload.technician_id || payload.technicianId || 0);

  if (!firstName) missing.push('first_name');
  if (!lastName) missing.push('last_name');
  if (!mobile) missing.push('mobile');
  if (!vehicle.manufacturer || vehicle.manufacturer === 'Unknown') missing.push('bike_manufacturer_or_vehicle_model');
  if (!notes) missing.push('issue_description');
  if (!serviceDate) missing.push('ServiceDate');
  if (!Number.isFinite(technicianId) || technicianId <= 0) missing.push('TechnicianID');

  return {
    ok: missing.length === 0,
    missing,
    normalized: {
      firstName,
      lastName,
      mobile,
      notes,
      vehicle,
      serviceDate,
      technicianId,
      email: normalizeSpaces(payload.email || payload.Email),
    },
  };
}

function normalizeServiceDateForPortal(value) {
  const raw = normalizeSpaces(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return raw.slice(0, 16);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getDate()).padStart(2, '0');
  const hh = String(parsed.getHours()).padStart(2, '0');
  const min = String(parsed.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

export function resolveServiceTypeSelection(payload) {
  const rawLabel = normalizeSpaces(payload.service_type_key || payload.serviceTypeKey || payload.service_type || payload.serviceType);
  const rawKey = rawLabel
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  if (rawKey.includes('service_plus') || rawLabel.toLowerCase().includes('plus')) {
    const plus = SERVICE_TYPE_CONFIG.popular.find((row) => row.key === 'service_plus');
    if (plus) {
      return {
        serviceTypeIds: [plus.id],
        serviceLabel: plus.label,
        customerOutcome: 'booking_submitted',
        customerMessage: null,
        needsWorkshopCallback: false,
      };
    }
  }
  if (rawKey.includes('service_full') || rawLabel.toLowerCase().includes('full')) {
    const full = SERVICE_TYPE_CONFIG.popular.find((row) => row.key === 'service_full');
    if (full) {
      return {
        serviceTypeIds: [full.id],
        serviceLabel: full.label,
        customerOutcome: 'booking_submitted',
        customerMessage: null,
        needsWorkshopCallback: false,
      };
    }
  }
  const needsCallback = Boolean(
    payload.needs_workshop_callback ||
      payload.workshop_callback_required ||
      payload.non_standard_service ||
      ['tyre', 'tire', 'error', 'controller', 'diagnostic', 'repair', 'quotation', 'quote'].some((token) =>
        rawKey.includes(token),
      ),
  );

  if (needsCallback) {
    const fallback = SERVICE_TYPE_CONFIG.non_standard_fallback;
    return {
      serviceTypeIds: [fallback.id],
      serviceLabel: fallback.label,
      customerOutcome: 'pending_workshop_callback',
      customerMessage:
        'I have logged your booking request. A mechanic from the workshop will call you back shortly to discuss the work and any costs.',
      needsWorkshopCallback: true,
    };
  }

  const popular = SERVICE_TYPE_CONFIG.popular.find((row) => row.key === rawKey);
  if (popular) {
    return {
      serviceTypeIds: [popular.id],
      serviceLabel: popular.label,
      customerOutcome: 'booking_submitted',
      customerMessage: null,
      needsWorkshopCallback: false,
    };
  }

  if (Array.isArray(payload.ServiceTypes) && payload.ServiceTypes.length) {
    return {
      serviceTypeIds: payload.ServiceTypes.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0),
      serviceLabel: 'custom',
      customerOutcome: 'booking_submitted',
      customerMessage: null,
      needsWorkshopCallback: false,
    };
  }

  const defaultPopular = SERVICE_TYPE_CONFIG.popular.find((row) => row.key === 'service_full') || SERVICE_TYPE_CONFIG.popular[0];
  return {
    serviceTypeIds: [defaultPopular.id],
    serviceLabel: defaultPopular.label,
    customerOutcome: 'booking_submitted',
    customerMessage: null,
    needsWorkshopCallback: false,
  };
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
  return nameMatch || rows[0] || null;
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
  if (!response.ok) {
    throw new Error(`cyclist_search_failed:${response.status}`);
  }
  const rows = Array.isArray(data?.cyclists) ? data.cyclists : Array.isArray(data) ? data : [];
  return rows;
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
  if (!response.ok) {
    throw new Error(`customer_create_failed:${response.status}`);
  }
  const userId = Number(data?.ID || data?.id || data?.UserID || data?.userId || 0);
  if (!userId) throw new Error('customer_create_missing_user_id');
  return userId;
}

async function resolveUserId(auth, partnerId, customer) {
  const searchKeys = [customer.mobile, `${customer.firstName} ${customer.lastName}`.trim(), customer.email].filter(Boolean);
  for (const key of searchKeys) {
    const rows = await searchCyclist(auth, partnerId, key);
    const match = pickCyclistMatch(rows, customer);
    if (match?.ID) return Number(match.ID);
  }
  return createCustomer(auth, partnerId, customer);
}

async function createBike(auth, userId, vehicle) {
  const body = {
    ID: 0,
    UserID: Number(userId),
    RefNo: `${vehicle.manufacturer} - ${vehicle.model}`,
    SerialNo: null,
    Manufacturer: vehicle.manufacturer,
    Model: vehicle.model,
    Colour: 'Unknown',
    ModelYear: new Date().getFullYear(),
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

async function fetchPreServiceChecklist(auth, partnerId) {
  const path = `/api/Bikeshop/${encodeURIComponent(partnerId)}/PreService/Checklist`;
  const { response, data } = await auth.portalFetch({ api: 'api', path, method: 'GET', auth: 'bearer' });
  if (!response.ok) return [];
  return Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
}

async function fetchNextJobCardId(auth, partnerId) {
  const path = `/api/Partner/${encodeURIComponent(partnerId)}/GetNextJobcardID`;
  const { response, data } = await auth.portalFetch({ api: 'services', path, method: 'GET', auth: 'bearer' });
  if (!response.ok) throw new Error(`next_jobcard_failed:${response.status}`);
  return Number(data?.JobCardID || data?.jobCardId || data?.NewJobcardID || data || 0);
}

/**
 * Build and submit ScheduleService from agent-collected fields (HAR-aligned).
 */
export async function orchestrateAgentBookingCreate({
  auth,
  payload,
  sendCommunication = true,
  partnerId = SERVICE_TYPE_CONFIG.default_partner_id,
  createdByUserId = null,
}) {
  const validation = validateAgentBookingPayload(payload);
  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      error: 'booking_missing_required_fields',
      missing: validation.missing,
      hint: 'Required: first_name, last_name, mobile, vehicle model, issue description, ServiceDate, TechnicianID.',
    };
  }

  const { normalized } = validation;
  const serviceSelection = resolveServiceTypeSelection(payload);
  const partner = Number(partnerId || SERVICE_TYPE_CONFIG.default_partner_id);
  const serviceDate = normalizeServiceDateForPortal(normalized.serviceDate);
  const requiredByDate = normalizeServiceDateForPortal(payload.RequiredByDate || payload.required_by_date || serviceDate);

  const userId = await resolveUserId(auth, partner, normalized);
  const bikeId = Number(payload.BikeID || payload.bike_id || 0) || (await createBike(auth, userId, normalized.vehicle));
  const jobCardId = Number(payload.NewJobcardID || payload.new_job_card_id || 0) || (await fetchNextJobCardId(auth, partner));
  const preServiceChecklist = Array.isArray(payload.PreServiceChecklist)
    ? payload.PreServiceChecklist
    : await fetchPreServiceChecklist(auth, partner);

  const scheduleBody = {
    ID: partner,
    BikeID: bikeId,
    ServiceTypes: serviceSelection.serviceTypeIds,
    ServiceDate: serviceDate,
    RequiredByDate: requiredByDate,
    PleaseBookIn: true,
    NewJobcardID: jobCardId,
    Notes: normalized.notes,
    TechnicianID: normalized.technicianId,
    isBikeHere: Boolean(payload.isBikeHere || payload.bike_is_here || false),
    CouponCode: '',
    PreServiceChecklist: preServiceChecklist,
    BikeBay: normalizeSpaces(payload.BikeBay || payload.bike_bay || ''),
    CreatedBy: Number(createdByUserId || payload.CreatedBy || partner),
    IsCollection: false,
    IsDelivery: false,
    CollectionInfo: null,
    DeliveryInfo: null,
    PreApprovedAmount: 0,
    SelectedThirdParty: null,
    SelectedThirdPartyIsResponsibileForPayment: false,
    ServiceTypeQuestions: [],
  };

  const { response, data } = await auth.portalFetch({
    api: 'services',
    path: '/api/Partner/v3/ScheduleService',
    method: 'POST',
    query: { SendCommunication: sendCommunication ? 'true' : 'false' },
    body: scheduleBody,
    auth: 'bearer',
  });

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: 'portal_schedule_service_failed',
      upstream_status: response.status,
      data,
    };
  }

  const serviceRequestId = Number(data?.ServiceRequestID || data?.ID || data?.id || 0);
  if (serviceRequestId) {
    const dateCheckedIn = serviceDate.endsWith('Z') ? serviceDate : `${serviceDate}:00Z`;
    await auth.portalFetch({
      api: 'services',
      path: '/api/ServiceRequest/UpdateJobcardSlot',
      method: 'POST',
      body: {
        DateCheckedIn: dateCheckedIn,
        ID: serviceRequestId,
        TechnicianID: normalized.technicianId,
      },
      auth: 'bearer',
    }).catch(() => null);
  }

  const jobCardNo = data?.JobCardNo || data?.jobCardNo || (jobCardId ? `#${String(jobCardId).padStart(5, '0')}` : null);
  const bookingConfirmed = !serviceSelection.needsWorkshopCallback;
  const customerOutcome = serviceSelection.needsWorkshopCallback
    ? 'pending_workshop_callback'
    : 'booking_confirmed';

  return {
    ok: true,
    status: 200,
    data: {
      schedule_response: data,
      partner_id: partner,
      user_id: userId,
      bike_id: bikeId,
      job_card_id: jobCardId,
      job_card_no: jobCardNo,
      service_type: serviceSelection.serviceLabel,
      service_type_ids: serviceSelection.serviceTypeIds,
      service_date: serviceDate,
      technician_id: normalized.technicianId,
      booking_confirmed: bookingConfirmed,
      customer_outcome: customerOutcome,
      needs_workshop_callback: serviceSelection.needsWorkshopCallback,
    },
    booking_confirmed: bookingConfirmed,
    customer_outcome: customerOutcome,
    message:
      serviceSelection.customerMessage ||
      (bookingConfirmed
        ? 'Booking submitted successfully. The customer should receive SMS updates shortly.'
        : 'Booking request logged for workshop follow-up.'),
  };
}

export async function orchestrateBookingCreate({ auth, payload, sendCommunication = true, partnerId, createdByUserId }) {
  if (isAgentBookingPayload(payload)) {
    return orchestrateAgentBookingCreate({ auth, payload, sendCommunication, partnerId, createdByUserId });
  }
  const { response, data } = await auth.portalFetch({
    api: 'services',
    path: '/api/Partner/v3/ScheduleService',
    method: 'POST',
    query: { SendCommunication: sendCommunication ? 'true' : 'false' },
    body: payload,
    auth: 'bearer',
  });
  if (!response.ok) {
    return { ok: false, status: 502, error: 'portal_schedule_service_failed', upstream_status: response.status, data };
  }
  return {
    ok: true,
    status: 200,
    data,
    booking_confirmed: true,
    customer_outcome: 'booking_confirmed',
    message: 'Booking submitted successfully.',
  };
}
