/**
 * Unified HubTiger authentication for Azure portal (bearer + legacy) and REST legacy API key mode.
 */

function buildQuery(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  return params;
}

async function parseUpstreamBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null);
  }
  const text = await response.text().catch(() => '');
  return text ? { _raw: text } : null;
}

export class HubTigerAuthClient {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || '').trim();
    this.authHeader = String(options.authHeader || 'x-api-key').trim();
    this.authMode = String(options.authMode || '').trim().toLowerCase();
    this.portalMode =
      Boolean(options.portalMode) ||
      /^(1|true|yes)$/i.test(String(options.portalModeEnv || '')) ||
      this.authMode === 'portal';
    this.hubUser = String(options.hubUser || '').trim();
    this.hubPass = String(options.hubPass || '').trim();
    this.legacyToken = String(options.legacyToken || '').trim();
    this.partnerId = String(options.partnerId || '').trim();
    this.functionCode = String(options.functionCode || '').trim();
    this.apiCode = String(options.apiCode || '').trim();
    this.apiUrl = String(options.apiUrl || 'https://hubtiger-api.azurewebsites.net').replace(/\/$/, '');
    this.servicesUrl = String(options.servicesUrl || 'https://hubtigerservices.azurewebsites.net').replace(/\/$/, '');
    this.baseUrl = String(options.baseUrl || this.apiUrl).replace(/\/$/, '');
    this.portalRoot = String(options.portalRoot || 'https://hubtigerportal.azurewebsites.net').replace(/\/$/, '');
    this.tokenCache = { token: null, legacyToken: null };
    this.functionCodeCache = { value: this.functionCode || '', fetchedAt: 0 };
  }

  async resolveFunctionCode({ forceRefresh = false } = {}) {
    const ttlMs = 6 * 60 * 60 * 1000;
    const now = Date.now();
    if (!forceRefresh && this.functionCodeCache.value && now - this.functionCodeCache.fetchedAt < ttlMs) {
      return this.functionCodeCache.value;
    }
    if (!forceRefresh && this.functionCode) {
      this.functionCodeCache = { value: this.functionCode, fetchedAt: now };
      return this.functionCode;
    }

    const rootResponse = await fetch(`${this.portalRoot}/`);
    const rootHtml = await rootResponse.text();
    const mainMatch =
      rootHtml.match(/(?:src=)["']([^"']*main\.[^"']+\.js)["']/i) ||
      rootHtml.match(/([^"']*main\.[a-zA-Z0-9]+\.js)/i);
    if (!mainMatch) throw new Error('hubtiger_portal_main_bundle_not_found');

    const mainUrl = mainMatch[1].startsWith('http')
      ? mainMatch[1]
      : `${this.portalRoot}/${mainMatch[1].replace(/^\//, '')}`;
    const bundleResponse = await fetch(mainUrl);
    const bundleText = await bundleResponse.text();
    const codeMatch =
      bundleText.match(/PRO_API_KEY\s*=\s*["']([^"']+)["']/) ||
      bundleText.match(/PRO_API_KEY["']?\s*[:=]\s*["']([^"']+)["']/) ||
      bundleText.match(/code=([A-Za-z0-9_\-]+={0,2})/);
    if (!codeMatch?.[1]) throw new Error('hubtiger_portal_pro_api_key_not_found');

    this.functionCode = codeMatch[1];
    this.functionCodeCache = { value: this.functionCode, fetchedAt: now };
    return this.functionCode;
  }

  async login() {
    const functionCode = await this.resolveFunctionCode();
    const loginUrl = `${this.apiUrl}/api/Auth/ValidateLogin?code=${encodeURIComponent(functionCode)}`;
    const body = JSON.stringify({ username: this.hubUser, password: this.hubPass, skipped: false });
    const response = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Portal login failed (${response.status}): ${text.slice(0, 500)}`);
    }
    const json = await response.json().catch(() => null);
    const token = json && (json.legacyToken || json.token);
    if (!token) throw new Error('Portal login response missing token');
    this.tokenCache = { token: json.token || null, legacyToken: json.legacyToken || json.token || null };
    return this.tokenCache.legacyToken;
  }

  async getLegacyToken({ forceRefresh = false } = {}) {
    if (this.hubUser && this.hubPass) {
      if (!forceRefresh && this.tokenCache.legacyToken) return this.tokenCache.legacyToken;
      return this.login();
    }
    if (this.legacyToken) return this.legacyToken;
    throw new Error('Portal auth missing: set HUB_USER and HUB_PASS (or HUBTIGER_LEGACY_TOKEN)');
  }

  async getBearerToken({ forceRefresh = false } = {}) {
    if (this.hubUser && this.hubPass) {
      if (!forceRefresh && (this.tokenCache.token || this.tokenCache.legacyToken)) {
        return this.tokenCache.token || this.tokenCache.legacyToken;
      }
      await this.login();
      return this.tokenCache.token || this.tokenCache.legacyToken;
    }
    if (this.legacyToken) return this.legacyToken;
    throw new Error('Portal auth missing: set HUB_USER and HUB_PASS (or HUBTIGER_LEGACY_TOKEN)');
  }

  buildRestHeaders(traceId) {
    const headers = { 'Content-Type': 'application/json' };
    if (traceId) headers['x-trace-id'] = traceId;
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
      headers[this.authHeader] = this.apiKey;
    }
    return headers;
  }

  portalApiUrl(path, query = {}) {
    const qs = buildQuery({ ...query, code: query.code ?? this.functionCode });
    return `${this.apiUrl}${path}?${qs.toString()}`;
  }

  async portalApiUrlAsync(path, query = {}) {
    const resolvedCode = query.code ?? (await this.resolveFunctionCode());
    const qs = buildQuery({ ...query, code: resolvedCode });
    return `${this.apiUrl}${path}?${qs.toString()}`;
  }

  portalServicesUrl(path, query = {}) {
    const qs = buildQuery(query);
    const suffix = qs.toString();
    return suffix ? `${this.servicesUrl}${path}?${suffix}` : `${this.servicesUrl}${path}`;
  }

  bearerEndpointLooksFragile(path) {
    return (
      String(path || '').startsWith('/api/Invoice/LineItem') ||
      String(path || '').startsWith('/api/Partner/lstSKUAutocompleteLookupV2') ||
      String(path || '').startsWith('/api/Partner/v3/ScheduleService') ||
      String(path || '').startsWith('/api/ServiceRequest/UpdateJobcardSlot')
    );
  }

  shouldRetryBearer(response, payload, api, path) {
    const bearerProblem =
      response.status === 401 ||
      (response.status === 400 &&
        ((typeof payload?._raw === 'string' && payload._raw.toLowerCase().includes('invalid bearer token')) ||
          (typeof payload?.message === 'string' && payload.message.toLowerCase().includes('invalid bearer token')) ||
          (typeof payload?.Message === 'string' &&
            payload.Message.toLowerCase().includes('authorization has been denied'))));
    const bearerLooksWrongOn500 =
      api === 'services' &&
      this.bearerEndpointLooksFragile(path) &&
      response.status >= 500 &&
      (payload === null || payload === undefined || payload?._raw === '');
    return bearerProblem || bearerLooksWrongOn500;
  }

  /**
   * Portal-aware fetch: Azure function-code query routes + bearer retry (token vs legacyToken).
   */
  async portalFetch({ api = 'api', path, method = 'GET', query = {}, body = null, auth = 'none' } = {}) {
    const url = api === 'services' ? this.portalServicesUrl(path, query) : await this.portalApiUrlAsync(path, query);
    const headers = { 'Content-Type': 'application/json', PartnerID: String(this.partnerId) };
    let primaryBearer = null;
    let alternateBearer = null;
    if (auth === 'bearer') {
      primaryBearer = await this.getBearerToken();
      alternateBearer =
        this.tokenCache.legacyToken && this.tokenCache.legacyToken !== primaryBearer
          ? this.tokenCache.legacyToken
          : null;
      headers.Authorization = `Bearer ${primaryBearer}`;
    }
    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    let response = await fetch(url, opts);
    let data = await parseUpstreamBody(response);

    if (auth === 'bearer' && this.shouldRetryBearer(response, data, api, path)) {
      if (alternateBearer) {
        const retryHeaders = { ...headers, Authorization: `Bearer ${alternateBearer}` };
        const retryOpts = { method, headers: retryHeaders };
        if (body && method !== 'GET') retryOpts.body = JSON.stringify(body);
        response = await fetch(url, retryOpts);
        data = await parseUpstreamBody(response);
      }
      if (this.shouldRetryBearer(response, data, api, path) && this.hubUser && this.hubPass) {
        this.tokenCache = { legacyToken: null, token: null };
        await this.login();
        const refreshedPrimary = this.tokenCache.token || this.tokenCache.legacyToken || primaryBearer;
        const refreshedAlt =
          this.tokenCache.legacyToken && this.tokenCache.legacyToken !== refreshedPrimary
            ? this.tokenCache.legacyToken
            : null;
        const retryHeaders2 = { ...headers, Authorization: `Bearer ${refreshedPrimary}` };
        const retryOpts2 = { method, headers: retryHeaders2 };
        if (body && method !== 'GET') retryOpts2.body = JSON.stringify(body);
        response = await fetch(url, retryOpts2);
        data = await parseUpstreamBody(response);
        if (this.shouldRetryBearer(response, data, api, path) && refreshedAlt) {
          const retryHeaders3 = { ...headers, Authorization: `Bearer ${refreshedAlt}` };
          const retryOpts3 = { method, headers: retryHeaders3 };
          if (body && method !== 'GET') retryOpts3.body = JSON.stringify(body);
          response = await fetch(url, retryOpts3);
          data = await parseUpstreamBody(response);
        }
      }
    }

    return { response, data, url };
  }

  async restFetch({ method = 'GET', path, body = null, traceId } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildRestHeaders(traceId);
    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    const response = await fetch(url, opts);
    const data = await parseUpstreamBody(response);
    return { response, data, url };
  }
}

export function createHubTigerAuthFromEnv(env = process.env) {
  return new HubTigerAuthClient({
    apiKey: env.HUBTIGER_API_KEY || '',
    authHeader: env.HUBTIGER_AUTH_HEADER || 'x-api-key',
    authMode: env.HUBTIGER_AUTH_MODE || '',
    portalModeEnv: env.HUBTIGER_PORTAL_MODE || '',
    hubUser: env.HUBTIGER_PORTAL_USERNAME || env.HUBTIGER_USERNAME || '',
    hubPass: env.HUBTIGER_PORTAL_PASSWORD || env.HUBTIGER_PASSWORD || '',
    legacyToken: env.HUBTIGER_LEGACY_TOKEN || '',
    partnerId: env.HUBTIGER_PARTNER_ID || '',
    functionCode: env.HUBTIGER_FUNCTION_CODE || env.HUBTIGER_API_CODE || '',
    apiCode: env.HUBTIGER_API_CODE || '',
    apiUrl: env.HUBTIGER_API_URL || 'https://hubtiger-api.azurewebsites.net',
    servicesUrl: env.HUBTIGER_SERVICES_URL || 'https://hubtigerservices.azurewebsites.net',
    baseUrl: env.HUBTIGER_BASE_URL || env.HUBTIGER_API_URL || 'https://hubtiger-api.azurewebsites.net',
    portalRoot: env.HUBTIGER_PORTAL_URL || 'https://hubtigerportal.azurewebsites.net',
  });
}
