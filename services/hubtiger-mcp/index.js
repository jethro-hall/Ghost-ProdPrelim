import crypto from 'crypto';
import express from 'express';
import pg from 'pg';
import { createClient } from 'redis';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.HUBTIGER_MCP_PORT || 8096);
const HUBTIGER_PROXY_URL = String(process.env.HUBTIGER_PROXY_URL || '').trim().replace(/\/$/, '');
const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const CACHE_TTL_SECONDS = Number(process.env.HUBTIGER_MCP_CACHE_TTL_SECONDS || 20);
const CACHE_PROFILE = String(process.env.HUBTIGER_MCP_CACHE_PROFILE || 'conservative').trim().toLowerCase();
const CACHE_DIRECTION = String(process.env.HUBTIGER_MCP_CACHE_DIRECTION || 'request_only').trim().toLowerCase();
const NEGATIVE_CACHE_TTL_SECONDS = Number(process.env.HUBTIGER_MCP_NEGATIVE_CACHE_TTL_SECONDS || 3);
const JOB_LOOKUP_CACHE_TTL_SECONDS = Number(process.env.HUBTIGER_MCP_CACHE_TTL_JOB_LOOKUP || 0);
const AVAILABILITY_CACHE_TTL_SECONDS = Number(process.env.HUBTIGER_MCP_CACHE_TTL_AVAILABILITY || 0);
const QUOTE_PREVIEW_CACHE_TTL_SECONDS = Number(process.env.HUBTIGER_MCP_CACHE_TTL_QUOTE_PREVIEW || 0);
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

export const app = express();
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
  return ['jobs_search', 'products_search', 'availability_lookup', 'job_lookup', 'job_search', 'job_retrieve', 'quote_preview', 'customer_search'].includes(op);
}

function parseBoolLike(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return !['false', '0', 'no'].includes(normalized);
}

function normalizeCacheMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (!normalized) return null;
  if (['no_cache', 'nocache', 'bypass', 'fresh', 'force_fresh'].includes(normalized)) {
    return 'bypass';
  }
  if (['cache', 'default', 'prefer_cache'].includes(normalized)) {
    return 'default';
  }
  return null;
}


const HUBTIGER_BOOKING_RESOURCES = {
  // technicianId is the booking default; availability lookup auto-discovers active mechanics (Kim, Hassler, etc.)
  brisbane: { technicianId: 1489, label: 'Ride Electric Brisbane' },
  southport: { technicianId: 1491, label: 'Southport' },
  burleigh: { technicianId: 2188, label: 'Burleigh Store' },
};

function normalizeToolFunction(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'booking_availability') return 'availability_lookup';
  return normalized;
}

function normalizeStoreSlug(value) {
  const raw = String(value || '').trim().toLowerCase();
  const compact = raw.replace(/[^a-z0-9]+/g, '');
  const aliases = {
    brisbane: 'brisbane',
    bne: 'brisbane',
    rideelectricbrisbane: 'brisbane',
    southport: 'southport',
    southportstore: 'southport',
    goldcoast: 'southport',
    gc: 'southport',
    burleigh: 'burleigh',
    burleighheads: 'burleigh',
    burleighstore: 'burleigh',
  };
  return aliases[compact] || raw;
}

function normalizeDateOnly(value) {
  if (!value) return '';
  const text = String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : text;
}

function addUtcDays(dateText, offset) {
  const parts = String(dateText || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return '';
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + offset));
  return dt.toISOString().slice(0, 10);
}

function formatAvailabilityDisplay(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : text;
}

function formatAvailabilityTime(value) {
  const text = String(value || '');
  const match = text.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : text;
}

function availabilitySlotSortMs(slot) {
  const text = String(slot?.available_slot || '');
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function utcTodayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function diffUtcDaysInclusive(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.floor((end - start) / 86400000) + 1;
}

function formatFriendlyDate(dateText) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(dateText || '').trim();
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const day = Number(match[3]);
  const month = months[Number(match[2]) - 1] || match[2];
  return `${day} ${month}`;
}

const WORKSHOP_OPEN_MINUTES = 8 * 60 + 30;
const WORKSHOP_CLOSE_MINUTES = 17 * 60;

/** Ride Electric workshop hours: Mon–Sat 8:30am–5:00pm local (Brisbane). */
export function parseAvailabilitySlotLocalParts(slot) {
  const raw = String(slot?.available_slot || slot?.display || '').trim();
  const match = raw.match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const weekday = new Date(year, month - 1, day).getDay();
  return { weekday, hour, minute, minutesOfDay: hour * 60 + minute };
}

export function isWithinWorkshopOperatingHours(slot) {
  const parts = parseAvailabilitySlotLocalParts(slot);
  if (!parts) return true;
  if (parts.weekday === 0) return false;
  if (parts.minutesOfDay < WORKSHOP_OPEN_MINUTES || parts.minutesOfDay >= WORKSHOP_CLOSE_MINUTES) return false;
  return true;
}

export function filterSlotsToOperatingHours(slots) {
  return (Array.isArray(slots) ? slots : []).filter((slot) => isWithinWorkshopOperatingHours(slot));
}

function slotOffer(slot, rank) {
  const availableSlot = String(slot.available_slot || '').trim();
  const technicianId = Number(slot.technician_id || slot.technicianId || 0) || null;
  return {
    rank,
    date: slot.date || String(slot.display || '').slice(0, 10),
    time: slot.time || formatAvailabilityTime(availableSlot),
    display: slot.display || formatAvailabilityDisplay(availableSlot),
    available_slot: availableSlot,
    /** ElevenLabs / booking_create: pass through to payload.ServiceDate */
    ServiceDate: availableSlot,
    /** ElevenLabs / booking_create: pass through to payload.TechnicianID */
    TechnicianID: technicianId,
    technician_id: technicianId,
  };
}

/**
 * Pick one recommended slot for the caller's goal, plus two backups closest in time to it.
 * `before_deadline`: latest opening on/before the deadline (best for "serviced by my birthday").
 * `earliest`: soonest opening in the window.
 */
export function rankAvailabilityOffers(slots, options = {}) {
  const normalized = filterSlotsToOperatingHours(
    Array.isArray(slots)
      ? slots.filter((slot) => slot && String(slot.available_slot || '').trim())
      : [],
  );
  if (!normalized.length) {
    return {
      recommended: null,
      backups: [],
      offers: [],
      labels: [],
      voiceSummary: '',
    };
  }

  const schedulingGoal = String(options.schedulingGoal || 'before_deadline').trim().toLowerCase();
  const deadlineDate = normalizeDateOnly(options.deadlineDate || '');
  const deadlineMs = deadlineDate ? Date.parse(`${deadlineDate}T23:59:59.000Z`) : null;

  const sorted = [...normalized].sort((left, right) => availabilitySlotSortMs(left) - availabilitySlotSortMs(right));
  let pool = sorted;
  if (deadlineMs) {
    const withinDeadline = sorted.filter((slot) => availabilitySlotSortMs(slot) <= deadlineMs);
    if (withinDeadline.length) pool = withinDeadline;
  }

  let recommended = pool[0];
  if (schedulingGoal === 'before_deadline' && deadlineMs) {
    recommended = pool[pool.length - 1];
  } else if (schedulingGoal === 'earliest') {
    recommended = pool[0];
  } else if (schedulingGoal === 'closest_cluster') {
    const clusterLabels = pickClosestAvailabilitySlots(pool, 1);
    recommended = pool.find((slot) => (slot.display || formatAvailabilityDisplay(slot.available_slot)) === clusterLabels[0]) || pool[0];
  }

  const recommendedMs = availabilitySlotSortMs(recommended);
  const backups = pool
    .filter((slot) => slot !== recommended)
    .sort((left, right) => Math.abs(availabilitySlotSortMs(left) - recommendedMs) - Math.abs(availabilitySlotSortMs(right) - recommendedMs))
    .slice(0, 2);

  const offers = [slotOffer(recommended, 'recommended'), ...backups.map((slot, index) => slotOffer(slot, `backup_${index + 1}`))];
  const labels = offers.map((offer) => offer.display);

  let voiceSummary = '';
  if (recommended) {
    const friendlyDeadline = deadlineDate ? formatFriendlyDate(deadlineDate) : '';
    if (schedulingGoal === 'before_deadline' && friendlyDeadline) {
      voiceSummary = `The best option to have your bike serviced before ${friendlyDeadline} is ${recommended.display}.`;
    } else {
      voiceSummary = `The best available time I can see is ${recommended.display}.`;
    }
    if (backups[0]) voiceSummary += ` I can also offer ${backups[0].display}`;
    if (backups[1]) voiceSummary += ` or ${backups[1].display}`;
    voiceSummary += '.';
  }

  return { recommended, backups, offers, labels, voiceSummary };
}

/** Return up to `count` slot display labels that are chronologically closest together. */
export function pickClosestAvailabilitySlots(slots, count = 3) {
  const normalized = Array.isArray(slots)
    ? slots.filter((slot) => slot && String(slot.available_slot || '').trim())
    : [];
  if (normalized.length === 0) return [];
  const limit = Math.max(1, Math.min(Number(count) || 3, 3));
  const sorted = [...normalized].sort((left, right) => availabilitySlotSortMs(left) - availabilitySlotSortMs(right));
  if (sorted.length <= limit) {
    return sorted.map((slot) => slot.display || formatAvailabilityDisplay(slot.available_slot));
  }
  let bestStart = 0;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= sorted.length - limit; index += 1) {
    const span = availabilitySlotSortMs(sorted[index + limit - 1]) - availabilitySlotSortMs(sorted[index]);
    if (span < bestSpan) {
      bestSpan = span;
      bestStart = index;
    }
  }
  return sorted
    .slice(bestStart, bestStart + limit)
    .map((slot) => slot.display || formatAvailabilityDisplay(slot.available_slot));
}

function normalizeAvailabilityInput(body) {
  const payload = body && typeof body.payload === 'object' && body.payload ? body.payload : {};
  const today = utcTodayDateOnly();
  const startDate = normalizeDateOnly(payload.start_date || payload.date || body?.start_date || body?.date || today);
  const deadlineDate = normalizeDateOnly(
    payload.deadline_date || payload.by_date || payload.must_complete_by || payload.end_date || body?.end_date || '',
  );
  let endDate = deadlineDate;
  let days = Math.max(1, Math.min(Number(payload.days || body?.days || 0) || 0, 14));
  if (endDate && startDate) {
    days = Math.max(1, Math.min(diffUtcDaysInclusive(startDate, endDate), 14));
  } else if (days < 1) {
    days = 7;
    endDate = addUtcDays(startDate, days - 1);
  } else {
    endDate = addUtcDays(startDate, days - 1);
  }
  const schedulingGoal = String(
    payload.scheduling_goal || (deadlineDate ? 'before_deadline' : 'earliest'),
  )
    .trim()
    .toLowerCase();
  return {
    store: normalizeStoreSlug(payload.store || body?.store || ''),
    startDate,
    endDate,
    days,
    deadlineDate: deadlineDate || endDate,
    schedulingGoal,
    requiredMinutes: Number(payload.requiredMinutes || 60),
    serviceType: String(payload.service_type || body?.service_type || 'workshop').trim() || 'workshop',
    cacheMode: normalizeCacheMode(body?.cache_mode ?? payload.cache_mode),
    customerRequest: String(payload.customer_request || payload.service_notes || '').trim(),
  };
}

function buildMcpLikeResult({ ok, status = 200, startNs, data, error, cacheMode = 'default' }) {
  const latency_ms = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
  return {
    ok,
    status,
    latency_ms,
    retry_count: 0,
    cache_hit: false,
    cache_mode: cacheMode,
    circuit_state: 'closed',
    data,
    error,
  };
}

async function lookupTechnicianAvailableSlots(body) {
  const startNs = process.hrtime.bigint();
  const input = normalizeAvailabilityInput(body || {});
  const resource = HUBTIGER_BOOKING_RESOURCES[input.store];
  const cacheMode = input.cacheMode || 'default';

  if (!resource) {
    return buildMcpLikeResult({
      ok: false,
      status: 400,
      startNs,
      cacheMode,
      error: 'availability_lookup_missing_store',
      data: {
        success: false,
        operation: 'availability_lookup',
        blocked: false,
        message: 'I need to know which store: Brisbane, Southport, or Burleigh.',
        data: {
          requires_store: true,
          valid_stores: Object.keys(HUBTIGER_BOOKING_RESOURCES),
        },
      },
    });
  }

  if (!input.startDate) {
    return buildMcpLikeResult({
      ok: false,
      status: 400,
      startNs,
      cacheMode,
      error: 'availability_lookup_missing_date',
      data: {
        success: false,
        operation: 'availability_lookup',
        blocked: false,
        message: 'I need a preferred date to check workshop availability.',
        data: { requires_date: true },
      },
    });
  }

  const proxyBaseUrl = HUBTIGER_PROXY_URL;
  const partnerId = String(process.env.HUBTIGER_PARTNER_ID || '2186').trim();

  if (!proxyBaseUrl) {
    return buildMcpLikeResult({
      ok: false,
      status: 503,
      startNs,
      cacheMode,
      error: 'hubtiger_proxy_unavailable',
      data: {
        success: false,
        operation: 'availability_lookup',
        blocked: false,
        message: 'Live workshop availability is not configured. I can take the details and have the team confirm it manually.',
        data: {
          error_code: 'hubtiger_proxy_unavailable',
          requires_staff_confirmation: true,
        },
      },
    });
  }

  const allSlots = [];
  const slotsByDate = [];
  const upstreamStatuses = [];

  try {
    const params = new URLSearchParams();
    params.set('store', input.store);
    params.set('fromDate', input.startDate);
    params.set('toDate', input.endDate);
    params.set('requiredMinutes', String(input.requiredMinutes || 60));
    // Omit technicians= so hubtiger-proxy discovers calendar-active mechanics for the store.

    const upstreamPath = `/availability/technicians?${params.toString()}`;
    const url = `${proxyBaseUrl}${upstreamPath}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    let response;
    let text = '';
    try {
      response = await fetch(url, { method: 'GET', signal: controller.signal });
      text = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    upstreamStatuses.push({ from: input.startDate, to: input.endDate, status: response.status });

    if (!response.ok) {
      jsonLog({
        level: 'warn',
        service: 'hubtiger-mcp',
        route: 'availability_lookup',
        msg: 'HubTiger availability upstream non-ok',
        store: input.store,
        technician_id: resource.technicianId,
        from_date: input.startDate,
        to_date: input.endDate,
        status: response.status,
        upstream_body_preview: text.slice(0, 300),
      });
    } else {
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = {};
      }

      let openSlots = Array.isArray(json.openSlots) ? json.openSlots : [];
      if (!openSlots.length && json?.earliest?.slotStart) {
        openSlots = [
          {
            availableSlot: json.earliest.slotStart,
            technicianID: json.earliest.technicianId,
            technicianName: json.earliest.technicianName,
          },
        ];
      }
      const mappedSlots = openSlots
        .map((slot) => {
          const available_slot = String(slot?.availableSlot || slot?.available_slot || '');
          const date = normalizeDateOnly(available_slot) || input.startDate;
          return {
            date,
            available_slot,
            display: formatAvailabilityDisplay(available_slot),
            time: formatAvailabilityTime(available_slot),
            technician_id: Number(slot?.technicianID || slot?.technicianId || resource.technicianId || 0) || null,
            technician_name: String(slot?.technicianName || '').trim() || null,
          };
        })
        .filter((slot) => slot.available_slot);

      allSlots.push(...mappedSlots);

      const slotsByDateMap = new Map();
      for (const slot of mappedSlots) {
        const bucket = slotsByDateMap.get(slot.date) || [];
        bucket.push(slot);
        slotsByDateMap.set(slot.date, bucket);
      }
      for (const [date, daySlots] of slotsByDateMap.entries()) {
        const rankedDay = rankAvailabilityOffers(daySlots, {
          deadlineDate: input.deadlineDate,
          schedulingGoal: input.schedulingGoal,
        });
        slotsByDate.push({
          date,
          slot_count: daySlots.length,
          first_slots: rankedDay.labels,
          recommended_slot: rankedDay.recommended ? slotOffer(rankedDay.recommended, 'recommended') : null,
          backup_slots: rankedDay.backups.map((slot, index) => slotOffer(slot, `backup_${index + 1}`)),
          slots: daySlots.slice(0, 10),
        });
      }
      slotsByDate.sort((left, right) => String(left.date).localeCompare(String(right.date)));
    }
  } catch (err) {
    jsonLog({
      level: 'warn',
      service: 'hubtiger-mcp',
      route: 'availability_lookup',
      msg: 'HubTiger availability upstream fetch failed',
      store: input.store,
      technician_id: resource.technicianId,
      start_date: input.startDate,
      error: String(err?.message || err),
    });

    return buildMcpLikeResult({
      ok: false,
      status: 502,
      startNs,
      cacheMode,
      error: 'availability_lookup_fetch_failed',
      data: {
        success: false,
        operation: 'availability_lookup',
        blocked: false,
        message: 'I cannot confirm live workshop availability right now. I can take the details and have the team confirm it manually.',
        data: {
          error_code: 'availability_lookup_fetch_failed',
          requires_staff_confirmation: true,
        },
      },
    });
  }

  const anyUpstreamOk = upstreamStatuses.some((item) => item.status >= 200 && item.status < 300);
  if (!anyUpstreamOk && upstreamStatuses.length > 0) {
    return buildMcpLikeResult({
      ok: false,
      status: 502,
      startNs,
      cacheMode,
      error: 'availability_lookup_unavailable_upstream',
      data: {
        success: false,
        operation: 'availability_lookup',
        blocked: false,
        message: 'I cannot confirm live workshop availability right now. I can take the details and have the team confirm it manually.',
        data: {
          error_code: 'availability_lookup_unavailable_upstream',
          upstream_statuses: upstreamStatuses,
          requires_staff_confirmation: true,
        },
      },
    });
  }

  const ranked = rankAvailabilityOffers(allSlots, {
    deadlineDate: input.deadlineDate,
    schedulingGoal: input.schedulingGoal,
  });
  const offerLabels = ranked.labels;
  const noSlotsMessage = input.deadlineDate
    ? `I could not see open workshop slots for ${resource.label} between ${formatFriendlyDate(input.startDate)} and ${formatFriendlyDate(input.deadlineDate)}. I can check another store or take your details for a callback.`
    : `I could not see open workshop slots for ${resource.label} from ${formatFriendlyDate(input.startDate)}. I can check another date or take your details for a callback.`;
  const voicePayload = {
    success: true,
    operation: 'availability_lookup',
    blocked: false,
    message: allSlots.length ? ranked.voiceSummary || `I found workshop availability for ${resource.label}.` : noSlotsMessage,
    data: {
      store: input.store,
      store_label: resource.label,
      technician_id: resource.technicianId,
      start_date: input.startDate,
      end_date: input.endDate,
      deadline_date: input.deadlineDate,
      days_checked: input.days,
      scheduling_goal: input.schedulingGoal,
      service_type: input.serviceType,
      slot_count: allSlots.length,
      recommended_slot: ranked.recommended ? slotOffer(ranked.recommended, 'recommended') : null,
      backup_slots: ranked.backups.map((slot, index) => slotOffer(slot, `backup_${index + 1}`)),
      booking_offers: ranked.offers,
      first_slots: offerLabels,
      closest_slots: offerLabels,
      slots_by_date: slotsByDate,
      requires_staff_confirmation: !allSlots.length,
      source: 'hubtiger proxy availability/technicians',
    },
  };

  return buildMcpLikeResult({
    ok: true,
    status: 200,
    startNs,
    cacheMode,
    data: voicePayload,
    error: null,
  });
}

export function buildOperationExecuteRequest(body) {
  const operation = normalizeToolFunction(body?.operation || body?.function);
  const payload = body && typeof body.payload === 'object' && body.payload ? body.payload : {};
  const cacheMode = normalizeCacheMode(body?.cache_mode ?? payload.cache_mode);
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
      cacheMode,
    };
  }

  if (operation === 'job_lookup') {
    const customer = payload.customer && typeof payload.customer === 'object' ? payload.customer : {};

    const jobId = String(payload.job_id || payload.jobId || '').trim();
    if (jobId) {
      return {
        operation,
        method: 'POST',
        proxyPath: '/jobs/search',
        proxyBody: { q: jobId, allStores: true },
        cacheMode,
      };
    }

    const q = String(
      payload.phone ||
      payload.mobile ||
      customer.phone ||
      customer.mobile ||
      [payload.first_name || customer.first_name, payload.last_name || customer.last_name].filter(Boolean).join(' ') ||
      payload.query ||
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
      cacheMode,
    };
  }

  if (operation === 'job_search') {
    const customer = payload.customer && typeof payload.customer === 'object' ? payload.customer : {};
    const q = String(
      payload.phone ||
      payload.mobile ||
      customer.phone ||
      customer.mobile ||
      [payload.first_name || customer.first_name, payload.last_name || customer.last_name].filter(Boolean).join(' ') ||
      payload.query ||
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
      cacheMode,
    };
  }

  if (operation === 'job_retrieve') {
    const q = String(payload.job_card_no || payload.job_card || payload.job_id || '').trim();
    if (!q) return null;
    return {
      operation,
      method: 'POST',
      proxyPath: '/jobs/search',
      proxyBody: { q, allStores: true },
      cacheMode,
    };
  }

  if (operation === 'customer_search') {
    const q = String(payload.q || payload.phone || payload.mobile || '').trim();
    if (!q) return null;
    const type = String(payload.type || 'phone').trim() || 'phone';
    const page = Number.isFinite(Number(payload.page)) ? Math.max(0, Math.floor(Number(payload.page))) : 0;
    const limit = Number.isFinite(Number(payload.limit)) ? Math.max(1, Math.min(5, Math.floor(Number(payload.limit)))) : 1;
    const params = new URLSearchParams({ q, type, page: String(page), limit: String(limit) });
    return {
      operation,
      method: 'GET',
      proxyPath: `/customers/search?${params.toString()}`,
      proxyBody: null,
      cacheMode,
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
      cacheMode,
    };
  }

  const stagedRoutes = {
    booking_slot_hold: '/booking/session/slot',
    booking_customer_search: '/booking/session/customer/search',
    booking_customer_confirm: '/booking/session/customer/confirm',
    booking_bike_list: '/booking/session/bike/list',
    booking_bike_confirm: '/booking/session/bike/confirm',
    booking_service_set: '/booking/session/service',
    booking_submit: '/booking/session/submit',
    booking_finalize: '/booking/session/finalize',
  };
  if (stagedRoutes[operation]) {
    const payloadBody = { ...payload };
    let proxyPath = stagedRoutes[operation];
    if (operation === 'booking_create' || operation === 'booking_finalize' || operation === 'booking_submit') {
      const sendCommunication = parseBoolLike(
        payloadBody.sendCommunication ?? payloadBody.send_communication,
        true,
      );
      delete payloadBody.sendCommunication;
      delete payloadBody.send_communication;
      const params = new URLSearchParams({ sendCommunication: sendCommunication ? 'true' : 'false' });
      proxyPath = `${proxyPath}?${params.toString()}`;
    }
    delete payloadBody.cache_mode;
    if (Object.keys(payloadBody).length === 0) return null;
    return {
      operation,
      method: 'POST',
      proxyPath,
      proxyBody: payloadBody,
      cacheMode,
    };
  }

  if (operation === 'booking_create') {
    const payloadBody = { ...payload };
    const sendCommunication = parseBoolLike(
      payloadBody.sendCommunication ?? payloadBody.send_communication,
      true,
    );
    delete payloadBody.sendCommunication;
    delete payloadBody.send_communication;
    delete payloadBody.cache_mode;
    if (Object.keys(payloadBody).length === 0) return null;
    const params = new URLSearchParams({ sendCommunication: sendCommunication ? 'true' : 'false' });
    return {
      operation,
      method: 'POST',
      proxyPath: `/bookings?${params.toString()}`,
      proxyBody: payloadBody,
      cacheMode,
    };
  }

  if (operation === 'booking_update') {
    const payloadBody = { ...payload };
    const sendCommunication = parseBoolLike(
      payloadBody.sendCommunication ?? payloadBody.send_communication,
      true,
    );
    delete payloadBody.sendCommunication;
    delete payloadBody.send_communication;
    delete payloadBody.cache_mode;
    if (Object.keys(payloadBody).length === 0) return null;
    const params = new URLSearchParams({ sendCommunication: sendCommunication ? 'true' : 'false' });
    return {
      operation,
      method: 'POST',
      proxyPath: `/bookings/update?${params.toString()}`,
      proxyBody: payloadBody,
      cacheMode,
    };
  }

  if (operation === 'quote_add_line_item' || operation === 'quote_find_add') {
    const serviceId = payload.serviceId || payload.service_id || payload.job_id;
    const search = String(payload.search || payload.query || payload.q || '').trim();
    if (!serviceId || !search) return null;
    return {
      operation: operation === 'quote_find_add' ? 'quote_add_line_item' : operation,
      method: 'POST',
      proxyPath: '/quotes/find-add',
      proxyBody: { serviceId: Number(serviceId), search, quantity: Number(payload.quantity || 1), dryRun: false },
      cacheMode,
    };
  }

  return null;
}

function cacheKey(operation, method, proxyPath, proxyBody) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ operation, method, proxyPath, proxyBody: proxyBody || null }));
  return `hubtiger-mcp:${hash.digest('hex')}`;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function getReadCacheTtlSeconds(operation) {
  const op = String(operation || '').trim().toLowerCase();
  const conservative = {
    default: normalizePositiveInt(CACHE_TTL_SECONDS, 20),
    job_lookup: 20,
    availability_lookup: 60,
    quote_preview: 10,
  };
  const performance = {
    default: Math.max(30, normalizePositiveInt(CACHE_TTL_SECONDS, 20)),
    job_lookup: 60,
    availability_lookup: 120,
    quote_preview: 30,
  };
  const baseline = CACHE_PROFILE === 'performance' ? performance : conservative;
  const perOpOverride = {
    job_lookup: normalizePositiveInt(JOB_LOOKUP_CACHE_TTL_SECONDS, baseline.job_lookup),
    availability_lookup: normalizePositiveInt(AVAILABILITY_CACHE_TTL_SECONDS, baseline.availability_lookup),
    quote_preview: normalizePositiveInt(QUOTE_PREVIEW_CACHE_TTL_SECONDS, baseline.quote_preview),
  };
  return Math.max(1, perOpOverride[op] || baseline.default);
}

export function collectJobLookupAliasCacheKeys({ operation, data }) {
  if (CACHE_DIRECTION !== 'bi_directional') return [];
  if (String(operation || '').trim().toLowerCase() !== 'job_lookup') return [];
  const sourceRows = [];
  if (data && typeof data === 'object') {
    if (Array.isArray(data.matches)) sourceRows.push(...data.matches);
    if (Array.isArray(data.results)) sourceRows.push(...data.results);
    if (typeof data.id !== 'undefined') sourceRows.push(data);
  }
  const aliases = new Set();
  for (const row of sourceRows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || row.jobId || row.job_id || '').trim();
    const jobCardNo = String(row.jobCardNo || row.job_card_no || '').trim();
    if (id) {
      aliases.add(cacheKey('job_lookup', 'GET', `/jobs/${encodeURIComponent(id)}`, null));
      aliases.add(cacheKey('job_lookup', 'POST', '/jobs/search', { q: id, allStores: true }));
    }
    if (jobCardNo) {
      aliases.add(cacheKey('job_lookup', 'POST', '/jobs/search', { q: jobCardNo, allStores: true }));
    }
  }
  return [...aliases];
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function compactString(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = compactString(value);
    if (text) return text;
  }
  return '';
}

function hasUnavailablePlaceholder(value) {
  const pattern = /\b(temporarily unavailable|workshop system is temporarily unavailable|cache_miss|timeout|timed out|upstream error|unavailable response)\b/i;
  if (typeof value === 'string') return pattern.test(value);
  if (Array.isArray(value)) return value.some((item) => hasUnavailablePlaceholder(item));
  if (isPlainObject(value)) {
    return Object.entries(value).some(([key, nested]) => {
      const normalizedKey = String(key || '').toLowerCase();
      if (['trace_id', 'span_id'].includes(normalizedKey)) return false;
      return hasUnavailablePlaceholder(nested);
    });
  }
  return false;
}

function hasExplicitBusinessError(result, payload) {
  const statusText = compactString(payload?.status || result?.status || '').toLowerCase();
  const errorText = compactString(payload?.error || result?.error || payload?.error_code || '').toLowerCase();
  if (result?.ok === false || payload?.ok === false || payload?.success === false) return true;
  if (['error', 'failed', 'failure', 'timeout', 'unavailable', 'cache_miss'].includes(statusText)) return true;
  if (errorText) return true;
  return false;
}

function extractJobRows(payload) {
  if (!isPlainObject(payload)) return [];
  const rows = [];
  for (const key of ['matches', 'results', 'rows', 'job_cards', 'jobs']) {
    if (Array.isArray(payload[key])) rows.push(...payload[key].filter(isPlainObject));
  }
  if (isPlainObject(payload.job)) rows.push(payload.job);
  if (isPlainObject(payload.data)) rows.push(...extractJobRows(payload.data));
  const directIdentifier = firstNonEmpty(payload.id, payload.job_id, payload.jobId, payload.jobCardNo, payload.job_card_no, payload.JobCardNo);
  if (directIdentifier) rows.push(payload);
  return rows;
}

function rowHasJobIdentifier(row) {
  return Boolean(firstNonEmpty(
    row?.id,
    row?.job_id,
    row?.jobId,
    row?.ID,
    row?.JobID,
    row?.jobCardNo,
    row?.job_card_no,
    row?.JobCardNo,
    row?.JobCardID
  ));
}

function rowHasJobContext(row) {
  return Boolean(firstNonEmpty(
    row?.status,
    row?.statusLabel,
    row?.StatusDescription,
    row?.bike,
    row?.bikeDescription,
    row?.BikeDescription,
    row?.customerName,
    row?.customer_name,
    row?.CyclistDescription,
    row?.scheduledDate,
    row?.lastUpdated,
    row?.DateCheckedIn,
    row?.DateBookedIn,
    row?.workshop,
    row?.location,
    row?.TypeDescription
  ));
}

function sourceFromResult(result) {
  const explicit = compactString(result?.source || result?.data?.source);
  if (explicit) return explicit;
  if (result?.cache_hit === true) return 'cache';
  if (result?.cache_mode === 'bypass') return 'fresh';
  return 'unknown';
}

function cacheAgeMsFromResult(result, nowMs) {
  const direct = Number(result?.cache_age_ms ?? result?.cacheAgeMs ?? result?.data?.cache_age_ms);
  if (Number.isFinite(direct) && direct >= 0) return Math.floor(direct);
  const cachedAt = result?.cached_at ?? result?.cachedAt ?? result?.data?.cached_at;
  if (!cachedAt) return undefined;
  const cachedAtMs = Number.isFinite(Number(cachedAt)) ? Number(cachedAt) : Date.parse(String(cachedAt));
  if (!Number.isFinite(cachedAtMs)) return undefined;
  return Math.max(0, Math.floor(nowMs - cachedAtMs));
}

export function validateHubtigerJobRetrieveResult(result, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const ttlMs = Math.max(1000, Number(options.ttlMs || getReadCacheTtlSeconds('job_retrieve') * 1000));
  const source = sourceFromResult(result);
  const cacheAgeMs = cacheAgeMsFromResult(result, nowMs);
  const stale = typeof cacheAgeMs === 'number' && cacheAgeMs > ttlMs;
  const payload = isPlainObject(result?.data) ? result.data : result;
  const missingFields = [];

  if (!result || result === '' || (Array.isArray(result) && result.length === 0)) {
    return { ok: false, reason: 'empty_result', missingFields: ['payload'], stale, empty: true, source, cacheAgeMs };
  }
  if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
    return { ok: false, reason: 'empty_payload', missingFields: ['payload'], stale, empty: true, source, cacheAgeMs };
  }
  if (stale) {
    return { ok: false, reason: 'stale_cache', missingFields, stale: true, empty: false, source, cacheAgeMs };
  }
  if (hasExplicitBusinessError(result, payload)) {
    return { ok: false, reason: 'explicit_error', missingFields: ['error'], stale, empty: false, source, cacheAgeMs };
  }
  if (hasUnavailablePlaceholder(payload)) {
    return { ok: false, reason: 'unavailable_placeholder', missingFields: ['usable_job_data'], stale, empty: false, source, cacheAgeMs };
  }

  const rows = extractJobRows(payload);
  if (rows.length === 0) missingFields.push('job_rows');
  const usable = rows.find((row) => rowHasJobIdentifier(row) && rowHasJobContext(row));
  if (!usable) {
    if (!rows.some(rowHasJobIdentifier)) missingFields.push('job_identifier');
    if (!rows.some(rowHasJobContext)) missingFields.push('job_context');
    return {
      ok: false,
      reason: 'missing_job_details',
      missingFields: [...new Set(missingFields)],
      stale,
      empty: false,
      source,
      cacheAgeMs,
    };
  }

  return { ok: true, reason: 'valid_job_retrieve', missingFields: [], stale: false, empty: false, source, cacheAgeMs };
}

function buildAssistantSummary(data) {
  const row = extractJobRows(data)[0] || {};
  const jobCard = firstNonEmpty(row.jobCardNo, row.job_card_no, row.JobCardNo, row.JobCardID);
  const customer = firstNonEmpty(row.customerName, row.customer_name, row.CyclistDescription);
  const bike = firstNonEmpty(row.bike, row.bikeDescription, row.BikeDescription);
  const status = firstNonEmpty(row.statusLabel, row.status, row.StatusDescription);
  const parts = [];
  if (jobCard) parts.push(`job card ${jobCard}`);
  if (customer) parts.push(`for ${customer}`);
  if (bike) parts.push(bike);
  if (status) parts.push(`status ${status}`);
  return parts.length
    ? `I found ${parts.join(', ')}.`
    : 'I found the workshop job record.';
}

function decorateJobRetrieveResult(result, validation, { source, fallbackUsed, cacheRejectReason = null, cacheValidated = true }) {
  const data = isPlainObject(result?.data) ? { ...result.data } : {};
  return {
    ...result,
    ok: true,
    error: null,
    data: {
      ...data,
      ok: true,
      business_success: true,
      source,
      fallback_used: Boolean(fallbackUsed),
      cache_validated: Boolean(cacheValidated),
      cache_reject_reason: cacheRejectReason,
      validation_reason: validation.reason,
      missing_fields: validation.missingFields,
      assistant_summary: data.assistant_summary || buildAssistantSummary(data),
    },
  };
}

function buildJobRetrieveBusinessFailure({
  status = 502,
  cacheRejectReason = null,
  freshValidation,
  freshResult,
  fallbackUsed,
}) {
  const freshRejectReason = freshValidation?.reason || freshResult?.error || 'fresh_invalid';
  return {
    ok: false,
    status,
    data: {
      ok: false,
      business_success: false,
      status: 'unavailable',
      user_message: 'I could not retrieve the workshop record right now.',
      retryable: true,
      error_code: 'hubtiger_job_retrieve_business_invalid',
      safe_diagnostic_code: 'hubtiger_job_retrieve_business_invalid',
      cache_reject_reason: cacheRejectReason,
      fresh_reject_reason: freshRejectReason,
      fallback_used: Boolean(fallbackUsed),
      source: 'fresh',
    },
    error: 'hubtiger_job_retrieve_business_invalid',
    latency_ms: freshResult?.latency_ms || 0,
  };
}

export async function resolveHubtigerJobRetrieveWithFallback({
  cachedResult = null,
  fetchFresh,
  ttlMs,
  nowMs = Date.now(),
}) {
  let cacheValidation = null;
  if (cachedResult) {
    cacheValidation = validateHubtigerJobRetrieveResult(
      { ...cachedResult, cache_hit: true },
      { ttlMs, nowMs }
    );
    if (cacheValidation.ok) {
      return {
        result: decorateJobRetrieveResult(cachedResult, cacheValidation, {
          source: 'cache',
          fallbackUsed: false,
          cacheValidated: true,
        }),
        cacheValidation,
        freshValidation: null,
        fallbackUsed: false,
      };
    }
  }

  const freshResult = await fetchFresh();
  const freshValidation = validateHubtigerJobRetrieveResult(
    { ...freshResult, cache_hit: false, cache_mode: 'bypass' },
    { ttlMs, nowMs: Date.now() }
  );
  const fallbackUsed = Boolean(cachedResult);
  if (freshValidation.ok) {
    return {
      result: decorateJobRetrieveResult(freshResult, freshValidation, {
        source: 'fresh',
        fallbackUsed,
        cacheRejectReason: cacheValidation?.reason || null,
        cacheValidated: !fallbackUsed,
      }),
      cacheValidation,
      freshValidation,
      fallbackUsed,
    };
  }

  return {
    result: buildJobRetrieveBusinessFailure({
      cacheRejectReason: cacheValidation?.reason || null,
      freshValidation,
      freshResult,
      fallbackUsed,
    }),
    cacheValidation,
    freshValidation,
    fallbackUsed,
  };
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
  cacheMode,
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
  const bypassReadCache = readOp && normalizeCacheMode(cacheMode) === 'bypass';
  const validateJobRetrieve = op === 'job_retrieve';
  let cacheHitObserved = false;
  let cacheValidation = null;
  let freshValidation = null;
  let cacheRejectReason = null;
  let freshRejectReason = null;
  let skipCacheWrite = false;
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
  const ttlSeconds = readOp ? getReadCacheTtlSeconds(op) : 0;
  if (readOp && redis && key && !bypassReadCache) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        const payload = JSON.parse(cached);
        cacheHitObserved = true;
        if (validateJobRetrieve) {
          cacheValidation = validateHubtigerJobRetrieveResult(
            { ...payload, cache_hit: true },
            { ttlMs: ttlSeconds * 1000 }
          );
          if (!cacheValidation.ok) {
            cacheRejectReason = cacheValidation.reason;
          } else {
            const decorated = decorateJobRetrieveResult(payload, cacheValidation, {
              source: 'cache',
              fallbackUsed: false,
              cacheValidated: true,
            });
            await writeRequestLog({
              trace_id,
              span_id,
              route,
              start_ts,
              status: Number(payload.status || 200),
              error: null,
              metadata: {
                operation: op,
                upstream_route: `${normalizedMethod} ${proxyPath}`,
                upstream_status: payload.status || null,
                upstream_latency_ms: payload.latency_ms || null,
                cache_hit: true,
                cache_valid: true,
                cache_reject_reason: null,
                fallback_used: false,
                fresh_valid: null,
                retry_count: 0,
                circuit_state: 'closed',
                cache_mode: 'default',
              },
            });
            return { ...decorated, cache_hit: true, retry_count: 0, circuit_state: 'closed' };
          }
        } else {
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
              cache_mode: bypassReadCache ? 'bypass' : 'default',
            },
          });
          return { ...payload, cache_hit: true, retry_count: 0, circuit_state: 'closed' };
        }
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

  if (validateJobRetrieve) {
    freshValidation = validateHubtigerJobRetrieveResult(
      { ...last, cache_hit: false, cache_mode: 'bypass' },
      { ttlMs: ttlSeconds * 1000 }
    );
    if (freshValidation.ok) {
      last = decorateJobRetrieveResult(last, freshValidation, {
        source: 'fresh',
        fallbackUsed: Boolean(cacheRejectReason),
        cacheRejectReason,
        cacheValidated: !cacheRejectReason,
      });
    } else {
      freshRejectReason = freshValidation.reason;
      skipCacheWrite = true;
      const failureStatus = Number(last.status || 0) >= 400 ? Number(last.status) : 502;
      last = buildJobRetrieveBusinessFailure({
        status: failureStatus,
        cacheRejectReason,
        freshValidation,
        freshResult: last,
        fallbackUsed: Boolean(cacheRejectReason),
      });
    }
  }

  if (last.ok) {
    markSuccess(op);
    if (readOp && redis && key) {
      try {
        const cachedPayload = JSON.stringify({
          ok: last.ok,
          status: last.status,
          data: last.data,
          error: last.error,
          latency_ms: last.latency_ms,
          cached_at: Date.now(),
        });
        await redis.setEx(
          key,
          ttlSeconds,
          cachedPayload
        );
        const aliasKeys = collectJobLookupAliasCacheKeys({ operation: op, data: last.data });
        if (aliasKeys.length > 0) {
          await Promise.all(aliasKeys.map((aliasKey) => redis.setEx(aliasKey, ttlSeconds, cachedPayload)));
        }
      } catch (_) {
        // Cache failures are non-blocking.
      }
    }
  } else {
    markFailure(op);
    if (readOp && redis && key && !skipCacheWrite) {
      const status = Number(last.status || 0);
      const shouldNegativeCache = status >= 500 || status === 429;
      if (shouldNegativeCache) {
        try {
          await redis.setEx(
            key,
            normalizePositiveInt(NEGATIVE_CACHE_TTL_SECONDS, 3),
            JSON.stringify({
              ok: last.ok,
              status: last.status,
              data: last.data,
              error: last.error,
              latency_ms: last.latency_ms,
              cached_at: Date.now(),
            })
          );
        } catch (_) {
          // Cache failures are non-blocking.
        }
      }
    }
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
      cache_hit: validateJobRetrieve ? cacheHitObserved : false,
      cache_valid: validateJobRetrieve ? (cacheValidation ? cacheValidation.ok : null) : undefined,
      cache_reject_reason: validateJobRetrieve ? cacheRejectReason : undefined,
      fallback_used: validateJobRetrieve ? Boolean(last?.data?.fallback_used) : undefined,
      fresh_valid: validateJobRetrieve ? (freshValidation ? freshValidation.ok : null) : undefined,
      fresh_reject_reason: validateJobRetrieve ? freshRejectReason : undefined,
      retry_count: Math.max(0, attempt - 1),
      circuit_state: stateAfter.state,
      cache_mode: bypassReadCache ? 'bypass' : 'default',
    },
  });

  return {
    ...last,
    retry_count: Math.max(0, attempt - 1),
    cache_hit: false,
    circuit_state: stateAfter.state,
    cache_mode: bypassReadCache ? 'bypass' : 'default',
  };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'hubtiger-mcp',
    hubtiger_proxy_url: HUBTIGER_PROXY_URL || null,
    redis_configured: !!REDIS_URL,
    db_logging: !!DATABASE_URL,
    cache_profile: CACHE_PROFILE,
    cache_direction: CACHE_DIRECTION,
    cache_ttl_default_seconds: normalizePositiveInt(CACHE_TTL_SECONDS, 20),
  });
});

app.post('/test', async (req, res) => {
  const trace_id = parseTraceId(req.headers['x-trace-id']);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const requestedFunction = normalizeToolFunction(body.operation || body.function);
  if (requestedFunction === 'availability_lookup') {
    const result = await lookupTechnicianAvailableSlots(body);
    return res.status(result.ok ? 200 : (result.status || 502)).json({
      ok: result.ok,
      trace_id,
      operation: 'availability_lookup',
      status: result.status,
      latency_ms: result.latency_ms,
      retry_count: result.retry_count,
      cache_hit: result.cache_hit,
      cache_mode: result.cache_mode || 'default',
      circuit_state: result.circuit_state,
      data: result.data,
      error: result.error,
    });
  }
  const mapped = buildOperationExecuteRequest(body);
  if (!mapped) {
    return res.status(400).json({
      ok: false,
      trace_id,
      operation: String(body.operation || '').trim() || null,
      error: 'unsupported_hubtiger_test_operation',
      hint: 'Provide a supported operation with the minimum payload required for deterministic MCP routing.',
    });
  }
  const result = await callHubtigerProxy({
    trace_id,
    operation: mapped.operation,
    method: mapped.method,
    proxyPath: mapped.proxyPath,
    proxyBody: mapped.proxyBody,
    cacheMode: mapped.cacheMode,
  });
  return res.status(result.ok ? 200 : (result.status || 502)).json({
    ok: result.ok,
    trace_id,
    operation: mapped.operation,
    status: result.status,
    latency_ms: result.latency_ms,
    retry_count: result.retry_count,
    cache_hit: result.cache_hit,
    cache_mode: result.cache_mode || (mapped.cacheMode || 'default'),
    circuit_state: result.circuit_state,
    data: result.data,
    error: result.error,
  });
});

app.post('/execute', async (req, res) => {
  const trace_id = parseTraceId(req.headers['x-trace-id']);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let operation = normalizeToolFunction(body.operation || body.function);
  let method = String(body.method || '').trim().toUpperCase();
  let proxyPath = String(body.proxy_path || '').trim();
  let proxyBody = body.proxy_body && typeof body.proxy_body === 'object' ? body.proxy_body : null;
  let cacheMode = normalizeCacheMode(body.cache_mode);

  if (operation === 'availability_lookup') {
    const result = await lookupTechnicianAvailableSlots(body);
    return res.status(result.ok ? 200 : (result.status || 502)).json({
      ok: result.ok,
      trace_id,
      operation: 'availability_lookup',
      status: result.status,
      latency_ms: result.latency_ms,
      retry_count: result.retry_count,
      cache_hit: result.cache_hit,
      cache_mode: result.cache_mode || 'default',
      circuit_state: result.circuit_state,
      data: result.data,
      error: result.error,
    });
  }

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
      cacheMode = mapped.cacheMode || cacheMode;
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
    cacheMode,
  });
  return res.status(result.ok ? 200 : (result.status || 502)).json({
    ok: result.ok,
    trace_id,
    operation,
    status: result.status,
    latency_ms: result.latency_ms,
    retry_count: result.retry_count,
    cache_hit: result.cache_hit,
    cache_mode: result.cache_mode || (cacheMode || 'default'),
    circuit_state: result.circuit_state,
    data: result.data,
    error: result.error,
  });
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, '0.0.0.0', () => {
    jsonLog({ level: 'info', msg: 'hubtiger-mcp listening', port: PORT });
  });
}
