#!/usr/bin/env node
// Checks credentials and API access WITHOUT printing credential values.
//
//   npm run check-config                 # free probes only (Text Search "IDs only" SKU is free)
//   npm run check-config -- --aggregate  # also 1 Places Aggregate request (billable SKU, 5,000 free/month)

import { loadConfig, describeConfig, validateConfig } from '../server/config.js';
import { loadBoundary } from '../server/boundary.js';

const cfg = loadConfig();
const env = process.env;
const withAggregate = process.argv.includes('--aggregate');
const boundary = loadBoundary();

const keyShape = (v) => (!v ? 'not set' : /^AIza[0-9A-Za-z_-]{35}$/.test(v) ? 'set (standard API key format)' : 'set (unexpected format)');
console.log('Environment (values never printed):');
const SECRET = new Set(['APP_ACCESS_PASSWORD', 'FIRESTORE_CREDENTIALS_JSON']);
for (const name of ['GOOGLE_MAPS_BROWSER_KEY', 'GOOGLE_PLACES_SERVER_KEY', 'GOOGLE_MAPS_MAP_ID', 'PLACES_AUTH_MODE', 'STORAGE_BACKEND', 'APP_ACCESS_PASSWORD', 'FIRESTORE_CREDENTIALS_JSON']) {
  const v = env[name];
  const shown = name.endsWith('_KEY') ? keyShape(v) : SECRET.has(name) ? (v ? 'set' : 'not set') : v || 'not set';
  console.log(`  ${name.padEnd(26)} ${shown}`);
}
console.log('Resolved:', describeConfig(cfg));
const { problems, warnings } = validateConfig(cfg);
problems.forEach((p) => console.log(`  ✘ ${p}`));
warnings.forEach((w) => console.log(`  ! ${w}`));

async function probe(label, url, { key, body, fieldMask, referer }) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-Goog-Api-Key'] = key;
  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;
  if (referer) headers.Referer = referer;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const json = await res.json().catch(() => ({}));
    const reason = json.error?.details?.find((d) => d.reason)?.reason || json.error?.status || '';
    const msg = (json.error?.message || '').split(key || '\u0000').join('[REDACTED]');
    console.log(`  ${res.ok ? '✔' : '✘'} ${label}: HTTP ${res.status}${reason ? ` ${reason}` : ''}${!res.ok && msg ? ` — ${msg.slice(0, 160)}` : ''}`);
    return { ok: res.ok, status: res.status, reason, json };
  } catch (e) {
    console.log(`  ✘ ${label}: network error (${e.cause?.code || e.message})`);
    return { ok: false, network: true };
  }
}

const textSearchIdsOnly = { textQuery: 'cafe', pageSize: 1, locationRestriction: { rectangle: { low: { latitude: boundary.bbox[1], longitude: boundary.bbox[0] }, high: { latitude: boundary.bbox[3], longitude: boundary.bbox[2] } } } };

console.log('\nProbes:');
if (cfg.places.configured) {
  await probe(`Places API (New) with ${cfg.places.keySource} [free IDs-only SKU]`, `${cfg.places.baseUrl}/places:searchText`, {
    key: cfg.places.authMode === 'proxy' ? null : cfg.places.key, body: textSearchIdsOnly, fieldMask: 'places.id',
  });
  if (withAggregate) {
    await probe('Places Aggregate API [1 billable request]', cfg.places.aggregateUrl, {
      key: cfg.places.authMode === 'proxy' ? null : cfg.places.key,
      body: { insights: ['INSIGHT_COUNT'], filter: { locationFilter: { circle: { latLng: { latitude: -37.64, longitude: 144.9 }, radius: 500 } }, typeFilter: { includedTypes: ['cafe'] } } },
    });
  } else {
    console.log('  · Places Aggregate API not probed (add --aggregate; costs 1 request from the 5,000/month free allowance)');
  }
} else {
  console.log('  ✘ No Places credential configured; skipped Places probes.');
}

if (cfg.maps.browserKey) {
  // A browser key should be website-restricted. If it works from a server with no Referer, it is not.
  const r = await probe('Browser key used from a server without a Referer [free IDs-only SKU]', `${cfg.places.baseUrl}/places:searchText`, {
    key: cfg.maps.browserKey, body: textSearchIdsOnly, fieldMask: 'places.id',
  });
  if (r.ok) {
    console.log('  ! The browser key has no website (HTTP referrer) restriction, or allows Places from anywhere. Add website');
    console.log('    restrictions and limit it to Maps JavaScript API (see README → Google Cloud setup).');
  } else if (r.reason === 'API_KEY_HTTP_REFERRER_BLOCKED') {
    console.log('  ✔ Browser key is website-restricted (good). It cannot be used for server-side Places calls.');
  } else if (r.reason === 'API_KEY_SERVICE_BLOCKED') {
    console.log('  ✔ Browser key is API-restricted and excludes Places API (New) (good if a separate server key is set).');
  }
}
console.log('  · Maps JavaScript API can only be verified in a browser: open the app, or run `npm run verify:ui`.');
