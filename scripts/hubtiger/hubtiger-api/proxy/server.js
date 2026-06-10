
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

// Handle __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration (allow override for different Hubtiger environments)
const HUBTIGER_BASE_URL = (process.env.HUBTIGER_BASE_URL || 'https://api.hubtiger.com/v1').replace(/\/$/, '');
const HUBTIGER_API_KEY = process.env.HUBTIGER_API_KEY || process.env.HUBTIGER_CODE;
const INTERNAL_KEY = process.env.INTERNAL_KEY || process.env.HUBTIGER_INTERNAL_KEY || 'ride-ai-secret-2024';

// Portal mode: use real Azure portal APIs (see docs/hubtiger-portal-api-from-har.md)
const PORTAL_MODE = /^(1|true|yes)$/i.test(process.env.HUBTIGER_PORTAL_MODE || '');
const HUBTIGER_SERVICES_URL = (process.env.HUBTIGER_SERVICES_URL || 'https://hubtigerservices.azurewebsites.net').replace(/\/$/, '');
const HUBTIGER_API_URL = (process.env.HUBTIGER_API_URL || 'https://hubtiger-api.azurewebsites.net').replace(/\/$/, '');
const HUBTIGER_PARTNER_ID = process.env.HUBTIGER_PARTNER_ID || '';
const HUBTIGER_FUNCTION_CODE = process.env.HUBTIGER_FUNCTION_CODE || '';
const HUBTIGER_LEGACY_TOKEN = process.env.HUBTIGER_LEGACY_TOKEN || '';
const HUB_USER = process.env.HUB_USER || process.env.HUBTIGER_PORTAL_USERNAME || '';
const HUB_PASS = process.env.HUB_PASS || process.env.HUBTIGER_PORTAL_PASSWORD || '';

// In-memory cache for auto-login legacy token (portal mode). Cleared on 401 so we re-login.
let portalTokenCache = { legacyToken: null, token: null };

async function portalLogin() {
  const loginUrl = `${HUBTIGER_API_URL}/api/Auth/ValidateLogin?code=${encodeURIComponent(HUBTIGER_FUNCTION_CODE)}`;
  // HAR: Content-Type application/x-www-form-urlencoded, body = raw JSON string (82 bytes)
  const body = JSON.stringify({ username: HUB_USER, password: HUB_PASS, skipped: false });
  const res = await axios.post(loginUrl, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
    validateStatus: () => true
  });
  if (res.status !== 200 || !res.data) {
    const msg = res.data?.message || res.data?.error || res.statusText || 'Login failed';
    throw new Error(`Portal login failed (${res.status}): ${msg}`);
  }
  const { token, legacyToken } = res.data;
  if (!legacyToken && !token) {
    throw new Error('Portal login response missing token and legacyToken');
  }
  portalTokenCache = { token: token || null, legacyToken: legacyToken || token || null };
  return portalTokenCache.legacyToken;
}

async function getPortalLegacyToken(forceRefresh = false) {
  if (HUBTIGER_LEGACY_TOKEN && !forceRefresh) return HUBTIGER_LEGACY_TOKEN;
  if (!HUB_USER || !HUB_PASS) {
    if (HUBTIGER_LEGACY_TOKEN) return HUBTIGER_LEGACY_TOKEN;
    throw new Error('Portal auth: set HUB_USER and HUB_PASS (or HUBTIGER_LEGACY_TOKEN) in .env');
  }
  if (!forceRefresh && portalTokenCache.legacyToken) return portalTokenCache.legacyToken;
  return portalLogin();
}

// 1. SERVE FRONTEND FILES
// Points to the directory above 'proxy/'
const staticPath = path.join(__dirname, '../');
app.use(express.static(staticPath));

// Middleware: Security Check for API endpoints
const authCheck = (req, res, next) => {
  const clientKey = req.headers['x-internal-key'];
  if (!clientKey || clientKey !== INTERNAL_KEY) {
    console.warn(`[AUTH] Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({ ok: false, error: 'Unauthorized: Missing or invalid X-Internal-Key' });
  }
  next();
};

// Structured log (for admin/correlation; include x-trace-id when present)
const logRequest = (req, route, status, latencyMs, message) => {
  const traceId = req.headers['x-trace-id'] || null;
  const line = JSON.stringify({
    level: 'info',
    service: 'hubtiger-api',
    route,
    trace_id: traceId,
    status,
    latency_ms: latencyMs,
    message: message || null
  });
  console.log(line);
};

// Health (no auth). ?login=1 triggers portal login and returns ok only if login succeeded.
app.get('/health', async (req, res) => {
  const base = {
    ok: true,
    service: 'hubtiger-api',
    hubtiger: !!HUBTIGER_API_KEY,
    portalMode: PORTAL_MODE,
    portalConfigured: PORTAL_MODE && !!HUBTIGER_PARTNER_ID && !!HUBTIGER_FUNCTION_CODE,
    portalAutoLogin: PORTAL_MODE && !!(HUB_USER && HUB_PASS)
  };
  if (req.query.login === '1' && PORTAL_MODE && HUB_USER && HUB_PASS) {
    try {
      await getPortalLegacyToken(true);
      return res.json({ ...base, portalLogin: 'ok' });
    } catch (e) {
      return res.status(503).json({ ok: false, ...base, portalLogin: 'failed', message: e.message });
    }
  }
  res.json(base);
});

// 2. API ENDPOINTS

// Portal mode: map portal search result to our shape. id = internal ID (use for GET job).
function mapPortalSearchItem(item) {
  const scheduledDate = item.ScheduledDate ?? item.DateScheduled ?? item.StartDate ?? item.BookingDate ?? item.BookedDate ?? item.SlotStart ?? item.DateCheckedIn ?? item.UpdatedDate;
  const durationMinutes = item.DurationMinutes ?? item.Duration ?? item.EstimatedDuration ?? item.EstimatedDurationMinutes ?? item.DurationMins ?? item.BookingDuration;
  return {
    id: item.ID,
    jobCardNo: item.JobCardNo || item.JobCardID?.toString(),
    customerName: item.CyclistDescription || item.Name || item.Surname ? `${item.Name || ''} ${item.Surname || ''}`.trim() : 'Unknown',
    bike: item.BikeDescription || 'Unknown Bike',
    status: item.StatusDescription || item.StatusID?.toString() || 'Unknown',
    lastUpdated: item.DateCheckedIn || item.UpdatedDate,
    scheduledDate: scheduledDate ?? undefined,
    durationMinutes: durationMinutes != null && durationMinutes !== '' ? Number(durationMinutes) : undefined
  };
}

app.post('/jobs/search', authCheck, async (req, res) => {
  const start = Date.now();
  const body = req.body || {};
  const q = body.q;
  const { firstName, lastName, email, phone, allStores = body.allStores !== false } = body;
  const query = (typeof q === 'string' && q.trim()) ? q.trim() : (phone || email || `${firstName || ''} ${lastName || ''}`.trim());

  if (!query) {
    logRequest(req, 'POST /jobs/search', 400, Date.now() - start, 'No search parameters');
    return res.status(400).json({ ok: false, error: 'No search parameters provided. Use q or phone/email/firstName/lastName.' });
  }

  try {
    let matches;

    if (PORTAL_MODE && HUBTIGER_PARTNER_ID) {
      // Real portal API: POST hubtigerservices.../api/ServiceRequest/JobCardSearch (auth via auto-login legacy token)
      const searchUrl = `${HUBTIGER_SERVICES_URL}/api/ServiceRequest/JobCardSearch`;
      const payload = { PartnerID: Number(HUBTIGER_PARTNER_ID), Search: query, SearchAllStores: allStores === true };
      let legacyToken;
      try {
        legacyToken = await getPortalLegacyToken();
      } catch (e) {
        logRequest(req, 'POST /jobs/search', 401, Date.now() - start, e.message);
        return res.status(401).json({ ok: false, error: 'Portal login failed', message: e.message });
      }
      const doSearch = (token) => axios.post(searchUrl, payload, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        timeout: 30000,
        validateStatus: () => true
      });
      let response = await doSearch(legacyToken);
      if (response.status === 401) {
        portalTokenCache = { legacyToken: null, token: null };
        legacyToken = await getPortalLegacyToken(true);
        response = await doSearch(legacyToken);
      }
      if (response.status !== 200) {
        const msg = response.data?.message || response.data?.error || response.statusText;
        throw new Error(msg || `Search returned ${response.status}`);
      }
      const list = Array.isArray(response.data) ? response.data : (response.data?.results || []);
      matches = list.map(mapPortalSearchItem);
    } else {
      // Generic / legacy: GET base_url/jobs/search
      const response = await axios.get(`${HUBTIGER_BASE_URL}/jobs/search`, {
        params: { q: query, all_stores: allStores },
        headers: { 'Authorization': `Bearer ${HUBTIGER_API_KEY}` }
      });
      const data = response.data;
      const list = Array.isArray(data) ? data : (data?.results || data?.matches || []);
      matches = list.map(job => ({
        id: job.id,
        jobCardNo: job.job_card_number || job.JobCardNo,
        customerName: job.customer ? `${job.customer.first_name || ''} ${job.customer.last_name || ''}`.trim() || 'Unknown' : (job.customerName || 'Unknown'),
        bike: job.bike ? `${job.bike.make || ''} ${job.bike.model || ''}`.trim() || 'Unknown Bike' : (job.bike || 'Unknown Bike'),
        status: job.status?.name || job.status || job.StatusDescription || 'Unknown',
        lastUpdated: job.updated_at || job.lastUpdated
      }));
    }

    logRequest(req, 'POST /jobs/search', 200, Date.now() - start, `Found ${matches.length} matches`);
    res.json({ ok: true, matches, results: matches, count: matches.length });
  } catch (error) {
    const latencyMs = Date.now() - start;
    logRequest(req, 'POST /jobs/search', 500, latencyMs, error.response?.data?.message || error.message);
    console.error('[ERROR] Search Failed:', error.response?.data || error.message);
    res.status(500).json({ ok: false, error: 'Hubtiger API search failed', message: error.response?.data?.message || error.message });
  }
});

app.get('/jobs/:id', authCheck, async (req, res) => {
  const start = Date.now();
  const { id } = req.params;
  try {
    let job;
    if (PORTAL_MODE && HUBTIGER_FUNCTION_CODE && HUBTIGER_PARTNER_ID) {
      // Real portal API: GET hubtiger-api.../api/Portal/Workshop/Calendar/JobCard/{internalId}?code=...
      // id must be the internal ID (e.g. 1535333), not JobCardNo (8628). See docs/hubtiger-portal-api-from-har.md
      const url = `${HUBTIGER_API_URL}/api/Portal/Workshop/Calendar/JobCard/${encodeURIComponent(id)}?code=${encodeURIComponent(HUBTIGER_FUNCTION_CODE)}`;
      const response = await axios.get(url, {
        headers: { PartnerID: HUBTIGER_PARTNER_ID },
        timeout: 15000
      });
      job = response.data;
    } else {
      const response = await axios.get(`${HUBTIGER_BASE_URL}/jobs/${id}`, {
        headers: { 'Authorization': `Bearer ${HUBTIGER_API_KEY}` }
      });
      job = response.data;
    }
    const customerName =
      job.CyclistDescription
      ?? (job.customer ? `${job.customer.first_name || ''} ${job.customer.last_name || ''}`.trim() : null)
      ?? (job.Name != null || job.Surname != null ? `${job.Name || ''} ${job.Surname || ''}`.trim() : null)
      ?? 'Unknown';
    // Scheduled date = when work commences; duration = estimated minutes. PEV ready by ~ scheduledDate + duration.
    const scheduledDate = job.ScheduledDate ?? job.DateScheduled ?? job.StartDate ?? job.BookingDate ?? job.BookedDate ?? job.AppointmentDate ?? job.ReservedDate ?? job.SlotStart ?? job.StartTime ?? job.DateCheckedIn ?? job.estimated_start_date;
    const durationMinutes = job.DurationMinutes ?? job.Duration ?? job.EstimatedDuration ?? job.EstimatedDurationMinutes ?? job.DurationMins ?? job.BookingDuration ?? job.booking_duration_minutes;
    const normalized = {
      id: job.ID ?? job.id,
      jobCardNo: job.JobCardNo ?? job.job_card_number,
      customerName: customerName || undefined,
      status: job.StatusDescription ?? job.status?.name ?? job.status,
      technician: job.TechnicianDescription ?? job.technician?.name ?? 'Unassigned',
      scheduledDate: scheduledDate ?? undefined,
      durationMinutes: durationMinutes != null && durationMinutes !== '' ? Number(durationMinutes) : undefined,
      estimatedReady: job.DateRequiredBy ?? job.estimated_completion_date,
      totalCost: job.PriceEstimate ?? job.total_price,
      mechanicNotes: job.Technician_Notes ?? job.InitialAssesment_Notes ?? job.PostServiceInspection_Notes ?? job.internal_notes ?? 'No notes found.',
      isReadyForCollection: job.DateCompleted != null && job.DateCompleted !== '' && job.DateCompleted !== undefined,
      bike: job.BikeDescription ?? (job.bike ? `${job.bike.make || ''} ${job.bike.model || ''}`.trim() : 'Unknown')
    };
    logRequest(req, `GET /jobs/${id}`, 200, Date.now() - start, 'OK');
    const includeRaw = req.query.raw === '1' || req.query.raw === 'true';
    res.json(includeRaw ? { ok: true, data: normalized, raw: job } : { ok: true, data: normalized });
  } catch (error) {
    logRequest(req, `GET /jobs/${id}`, 500, Date.now() - start, error.message);
    res.status(500).json({ ok: false, error: 'Could not fetch job details', message: error.response?.data?.message || error.message });
  }
});

app.get('/jobs/:id/messages', authCheck, async (req, res) => {
  const start = Date.now();
  const { id } = req.params;
  try {
    const response = await axios.get(`${HUBTIGER_BASE_URL}/jobs/${id}/messages`, {
      headers: { 'Authorization': `Bearer ${HUBTIGER_API_KEY}` }
    });
    const messages = Array.isArray(response.data) ? response.data : (response.data?.messages || response.data?.data || []);
    logRequest(req, `GET /jobs/${id}/messages`, 200, Date.now() - start, `${messages.length} messages`);
    res.json({ ok: true, messages, jobId: id });
  } catch (error) {
    logRequest(req, `GET /jobs/${id}/messages`, 500, Date.now() - start, error.message);
    res.status(500).json({ ok: false, error: 'Could not fetch messages', message: error.response?.data?.message || error.message });
  }
});

// 3. CATCH-ALL ROUTE (Serves the Dashboard SPA — Express 5 path-to-regexp requires named wildcard: /{*path})
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(staticPath, 'index.html'));
});

const PORT = process.env.PORT || 8095;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('---------------------------------------------');
  console.log(`🚀 RIDEAI DASHBOARD & PROXY IS LIVE`);
  console.log(`🌍 URL: http://ghost.rideai.com.au:${PORT}`);
  console.log(`📁 Static Files: ${staticPath}`);
  console.log('---------------------------------------------');
});

// Handle common server errors (like Port already in use)
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('---------------------------------------------');
    console.error(`❌ ERROR: Port ${PORT} is already in use.`);
    console.error(`👉 Try stopping the other process: 'fuser -k ${PORT}/tcp'`);
    console.error(`👉 Or change the port in your .env file.`);
    console.error('---------------------------------------------');
    process.exit(1);
  } else {
    console.error('❌ Server Error:', e);
  }
});
