// Google Places API (New) + Places Aggregate API client (server side only).
//
// Field masks are kept to the cheapest tier that serves each screen:
//   list/search      → Text Search Pro        (no phone/website/hours)
//   opened business  → Place Details Enterprise (adds phone, website, hours)
//   gap fill         → Place Details Pro
// See https://developers.google.com/maps/documentation/places/web-service/data-fields

const PRO_PLACE_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'shortFormattedAddress',
  'location',
  'types',
  'primaryType',
  'primaryTypeDisplayName',
  'businessStatus',
  'googleMapsUri',
  'pureServiceAreaBusiness',
  'attributions',
];
const ENTERPRISE_EXTRA_FIELDS = ['nationalPhoneNumber', 'internationalPhoneNumber', 'websiteUri', 'regularOpeningHours'];

export const FIELD_MASKS = {
  textSearch: [...PRO_PLACE_FIELDS.map((f) => `places.${f}`), 'nextPageToken'].join(','),
  detailsPro: PRO_PLACE_FIELDS.join(','),
  detailsEnterprise: [...PRO_PLACE_FIELDS, ...ENTERPRISE_EXTRA_FIELDS].join(','),
};

export class PlacesError extends Error {
  constructor({ kind, code, message, httpStatus, api, help }) {
    super(message);
    Object.assign(this, { kind, code, httpStatus, api, help });
  }
}

const API_NAMES = {
  places: 'Places API (New) — places.googleapis.com',
  aggregate: 'Places Aggregate API — areainsights.googleapis.com',
};

/** Maps a Google error response to an actionable PlacesError. */
export function classifyGoogleError(httpStatus, body, api) {
  const err = body?.error || {};
  const reasons = (err.details || []).map((d) => d.reason).filter(Boolean);
  const reason = reasons[0] || err.status || `HTTP_${httpStatus}`;
  const msg = err.message || `Google returned HTTP ${httpStatus}`;
  const apiName = API_NAMES[api];
  const base = { httpStatus, api: apiName };

  // Places Aggregate answers INSIGHT_PLACES with HTTP 429 RESOURCE_EXHAUSTED when more than
  // 100 places match ("…The request produced 232 places…"). It is not a quota problem: the
  // caller should split the area. The count is carried on the error.
  const tooMany = /maximum number of allowed places[\s\S]*produced (\d+) places/i.exec(msg);
  if (api === 'aggregate' && (tooMany || /maximum number of allowed places/i.test(msg))) {
    const err = new PlacesError({ ...base, kind: 'invalid', code: 'AGGREGATE_TOO_MANY_PLACES', message: msg });
    err.count = tooMany ? Number(tooMany[1]) : null;
    return err;
  }

  if (httpStatus === 429 || err.status === 'RESOURCE_EXHAUSTED' || reason === 'RATE_LIMIT_EXCEEDED') {
    return new PlacesError({
      ...base, kind: 'quota', code: 'GOOGLE_QUOTA',
      message: `Google quota or rate limit reached for ${apiName}: ${msg}`,
      help: 'Wait and retry, or raise the quota in Google Cloud Console → Google Maps Platform → Quotas.',
    });
  }
  if (reason === 'SERVICE_DISABLED' || reason === 'API_KEY_SERVICE_BLOCKED' || /not been used|is disabled/i.test(msg)) {
    return new PlacesError({
      ...base, kind: 'config', code: 'API_NOT_ENABLED',
      message: `${apiName} is not enabled for this project, or the key's API restrictions exclude it.`,
      help: `Enable ${apiName.split(' — ')[0]} in Google Cloud Console → APIs & Services → Library, and add it to the server key's API restrictions.`,
    });
  }
  if (reason === 'API_KEY_HTTP_REFERRER_BLOCKED' || reason === 'API_KEY_IP_ADDRESS_BLOCKED') {
    return new PlacesError({
      ...base, kind: 'config', code: 'KEY_RESTRICTED',
      message: `The Places credential is restricted (${reason}) and cannot be used from this server.`,
      help:
        'Create a separate server key (GOOGLE_PLACES_SERVER_KEY) restricted to Places API (New) and Places Aggregate API, ' +
        'with no website restriction (use an IP restriction only if this server has a fixed egress IP).',
    });
  }
  if (reason === 'API_KEY_INVALID' || /API key not valid/i.test(msg)) {
    return new PlacesError({ ...base, kind: 'config', code: 'KEY_INVALID', message: 'Google rejected the Places API key as invalid.', help: 'Check GOOGLE_PLACES_SERVER_KEY.' });
  }
  if (reason === 'BILLING_DISABLED' || /billing/i.test(msg)) {
    return new PlacesError({ ...base, kind: 'config', code: 'BILLING_DISABLED', message: `Billing is not enabled for the project: ${msg}`, help: 'Link a billing account to the Google Cloud project.' });
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return new PlacesError({ ...base, kind: 'config', code: 'PERMISSION_DENIED', message: `${apiName} denied the request: ${msg}`, help: 'Check the key, its API restrictions and billing.' });
  }
  if (httpStatus === 400) {
    return new PlacesError({ ...base, kind: 'invalid', code: 'INVALID_REQUEST', message: `${apiName} rejected the request: ${msg}` });
  }
  return new PlacesError({ ...base, kind: 'upstream', code: 'GOOGLE_ERROR', message: `${apiName} error: ${msg}` });
}

export class PlacesClient {
  constructor(placesCfg, budget, { fetchImpl = fetch } = {}) {
    this.cfg = placesCfg;
    this.budget = budget;
    this.fetch = fetchImpl;
  }

  redact(text) {
    return this.cfg.key ? String(text).split(this.cfg.key).join('[REDACTED]') : String(text);
  }

  async call(api, url, { method = 'POST', body, fieldMask, sku }) {
    if (!this.cfg.configured) {
      throw new PlacesError({
        kind: 'config', code: 'PLACES_NOT_CONFIGURED',
        message: 'No Places credential is configured on the server.',
        help: 'Set GOOGLE_PLACES_SERVER_KEY in the environment (or PLACES_AUTH_MODE=proxy), then restart.',
      });
    }
    await this.budget.consume(sku);
    const headers = { 'Content-Type': 'application/json' };
    if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;
    if (this.cfg.authMode !== 'proxy') headers['X-Goog-Api-Key'] = this.cfg.key;
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
      throw new PlacesError({
        kind: 'network', code: timeout ? 'GOOGLE_TIMEOUT' : 'GOOGLE_UNREACHABLE', api: API_NAMES[api],
        message: timeout ? `${API_NAMES[api]} did not respond within ${this.cfg.timeoutMs} ms.` : `Could not reach ${API_NAMES[api]}: ${this.redact(e.cause?.code || e.message)}`,
        help: 'Check the server’s outbound network access, then retry.',
      });
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const err = classifyGoogleError(res.status, json, api);
      err.message = this.redact(err.message);
      throw err;
    }
    return json || {};
  }

  /**
   * Text Search (New). `box` is [west, south, east, north] and is sent as a
   * locationRestriction rectangle — the only area shape Text Search supports.
   */
  async textSearch({ textQuery, includedType, box, pageToken, includeServiceArea = false, pageSize = 20 }) {
    const body = {
      textQuery,
      pageSize,
      languageCode: 'en-AU',
      regionCode: 'AU',
      includePureServiceAreaBusinesses: includeServiceArea,
      locationRestriction: { rectangle: { low: { latitude: box[1], longitude: box[0] }, high: { latitude: box[3], longitude: box[2] } } },
    };
    if (includedType) Object.assign(body, { includedType, strictTypeFiltering: true });
    if (pageToken) body.pageToken = pageToken;
    const json = await this.call('places', `${this.cfg.baseUrl}/places:searchText`, { body, fieldMask: FIELD_MASKS.textSearch, sku: 'textSearchPro' });
    return { places: (json.places || []).map((p) => normalizePlace(p)), nextPageToken: json.nextPageToken || null };
  }

  async details(placeId, tier = 'enterprise') {
    const sku = tier === 'enterprise' ? 'detailsEnterprise' : 'detailsPro';
    const json = await this.call('places', `${this.cfg.baseUrl}/places/${encodeURIComponent(placeId)}?languageCode=en-AU&regionCode=AU`, {
      method: 'GET',
      fieldMask: FIELD_MASKS[sku],
      sku,
    });
    return normalizePlace(json, tier === 'enterprise');
  }

  /**
   * Places Aggregate computeInsights over a custom polygon (CCW ring of
   * [lng, lat]). Returns the count and, when count ≤ 100, the place IDs;
   * over 100, ids is null (and count may be null if Google omits it).
   */
  async aggregate({ ring, types }) {
    const body = {
      insights: ['INSIGHT_COUNT', 'INSIGHT_PLACES'],
      filter: {
        locationFilter: { customArea: { polygon: { coordinates: ring.map(([lng, lat]) => ({ latitude: lat, longitude: lng })) } } },
        typeFilter: { includedTypes: types },
        operatingStatus: ['OPERATING_STATUS_OPERATIONAL', 'OPERATING_STATUS_TEMPORARILY_CLOSED'],
      },
    };
    let json;
    try {
      json = await this.call('aggregate', this.cfg.aggregateUrl, { body, sku: 'aggregate' });
    } catch (err) {
      if (err.code === 'AGGREGATE_TOO_MANY_PLACES') return { count: err.count, ids: null };
      throw err;
    }
    const count = Number(json.count || 0);
    const ids = (json.placeInsights || []).map((p) => String(p.place).replace(/^places\//, ''));
    return { count, ids: count <= 100 ? ids : null };
  }
}

/** Converts a Places API (New) Place into the app's display shape. Missing fields stay null. */
export function normalizePlace(p, withContact = false) {
  const loc = p.location && Number.isFinite(p.location.latitude) ? { lat: p.location.latitude, lng: p.location.longitude } : null;
  return {
    id: p.id,
    name: p.displayName?.text ?? null,
    address: p.formattedAddress ?? null,
    shortAddress: p.shortFormattedAddress ?? null,
    location: loc,
    types: p.types || [],
    primaryType: p.primaryType ?? null,
    primaryTypeLabel: p.primaryTypeDisplayName?.text ?? null,
    businessStatus: p.businessStatus ?? null,
    mapsUri: p.googleMapsUri ?? null,
    serviceAreaOnly: p.pureServiceAreaBusiness === true,
    attributions: (p.attributions || []).map((a) => ({ provider: a.provider, providerUri: a.providerUri ?? null })),
    ...(withContact
      ? {
          // null = Google has no value for this business (not "not requested").
          phone: p.nationalPhoneNumber ?? null,
          phoneIntl: p.internationalPhoneNumber ?? null,
          website: p.websiteUri ?? null,
          hours: p.regularOpeningHours?.weekdayDescriptions ?? null,
        }
      : {}),
  };
}
