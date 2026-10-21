// Runtime configuration. Credential VALUES are never logged or returned by
// describeConfig(); only whether they are present and how they are used.

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  if (env === process.env && existsSync(join(ROOT, '.env')) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(join(ROOT, '.env')); // does not override variables already set
  }
  const production = env.NODE_ENV === 'production';
  const bool = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));
  const int = (v, dflt) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };

  const browserKey = env.GOOGLE_MAPS_BROWSER_KEY || '';
  const serverKey = env.GOOGLE_PLACES_SERVER_KEY || '';
  const placesAuthMode = (env.PLACES_AUTH_MODE || 'key').toLowerCase(); // 'key' | 'proxy'
  const allowFallback = bool(env.PLACES_ALLOW_BROWSER_KEY_FALLBACK, !production);

  let placesKey = '';
  let placesKeySource = 'none';
  if (placesAuthMode === 'proxy') {
    placesKeySource = 'network-secret-proxy';
  } else if (serverKey) {
    placesKey = serverKey;
    placesKeySource = 'GOOGLE_PLACES_SERVER_KEY';
  } else if (browserKey && allowFallback) {
    placesKey = browserKey;
    placesKeySource = 'GOOGLE_MAPS_BROWSER_KEY (development fallback)';
  }

  return {
    production,
    port: int(env.PORT, 8080),
    // Private by default: only listen on loopback unless told otherwise.
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    maps: {
      browserKey,
      mapId: env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID',
    },
    places: {
      authMode: placesAuthMode,
      key: placesKey,
      keySource: placesKeySource,
      configured: placesAuthMode === 'proxy' || Boolean(placesKey),
      baseUrl: env.PLACES_BASE_URL || 'https://places.googleapis.com/v1',
      aggregateUrl: env.PLACES_AGGREGATE_URL || 'https://areainsights.googleapis.com/v1:computeInsights',
      timeoutMs: int(env.PLACES_TIMEOUT_MS, 20000),
      concurrency: Math.max(1, Math.min(4, int(env.PLACES_CONCURRENCY, 2))),
    },
    limits: {
      // Self-imposed daily caps (UTC day) — deliberately conservative.
      textSearchPerDay: int(env.DAILY_TEXT_SEARCH_LIMIT, 300),
      detailsPerDay: int(env.DAILY_DETAILS_LIMIT, 150), // opened businesses (Place Details Enterprise)
      gapFillPerDay: int(env.DAILY_GAP_FILL_LIMIT, 500), // electorate-check places loaded (Place Details Pro)
      aggregatePerDay: int(env.DAILY_AGGREGATE_LIMIT, 150),
      sweepTextSearchMax: int(env.SWEEP_MAX_TEXT_SEARCH, 120),
      sweepAggregateMax: int(env.SWEEP_MAX_AGGREGATE, 40),
      gapFillMax: Math.min(200, int(env.GAP_FILL_MAX, 100)),
      areaSearchMaxKm: int(env.AREA_SEARCH_MAX_KM, 20),
    },
    membershipMaxAgeDays: int(env.MEMBERSHIP_MAX_AGE_DAYS, 30),
    storage: {
      backend: (env.STORAGE_BACKEND || 'file').toLowerCase(), // 'file' | 'firestore' | 'memory'
      dataDir: env.DATA_DIR || join(ROOT, '.data'),
      firestoreProjectId: env.FIRESTORE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || '',
      firestoreDatabaseId: env.FIRESTORE_DATABASE_ID || '(default)',
      firestorePrefix: env.FIRESTORE_COLLECTION_PREFIX || 'gbm_',
      // Optional service-account JSON (e.g. for Claude Code cloud sessions, which have no ADC).
      firestoreCredentialsJson: env.FIRESTORE_CREDENTIALS_JSON || '',
    },
    auth: {
      password: env.APP_ACCESS_PASSWORD || '',
      trustUpstreamAuth: bool(env.TRUST_UPSTREAM_AUTH, false),
    },
  };
}

export function describeConfig(cfg) {
  return {
    mode: cfg.production ? 'production' : 'development',
    listen: `${cfg.host}:${cfg.port}`,
    mapsBrowserKey: cfg.maps.browserKey ? 'set' : 'MISSING',
    mapId: cfg.maps.mapId === 'DEMO_MAP_ID' ? 'DEMO_MAP_ID (development only)' : 'custom',
    placesAuth: cfg.places.authMode,
    placesCredential: cfg.places.keySource,
    storage: cfg.storage.backend,
    access: cfg.auth.password ? 'password' : cfg.auth.trustUpstreamAuth ? 'upstream (IAP/IAM)' : 'none (loopback only)',
  };
}

export function validateConfig(cfg) {
  const problems = [];
  const warnings = [];
  if (!cfg.maps.browserKey) problems.push('GOOGLE_MAPS_BROWSER_KEY is not set — the map cannot load.');
  if (!cfg.places.configured) {
    warnings.push(
      'No Places credential: set GOOGLE_PLACES_SERVER_KEY (or PLACES_AUTH_MODE=proxy). Business search is disabled.',
    );
  } else if (cfg.places.keySource.includes('fallback')) {
    warnings.push(
      'Places requests are using GOOGLE_MAPS_BROWSER_KEY as a development fallback. Create a separate server key ' +
        '(GOOGLE_PLACES_SERVER_KEY) before deploying and give the browser key website restrictions.',
    );
  }
  if (cfg.maps.mapId === 'DEMO_MAP_ID') warnings.push('GOOGLE_MAPS_MAP_ID not set; using DEMO_MAP_ID (development only).');
  const exposed = !['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
  if (exposed && !cfg.auth.password && !cfg.auth.trustUpstreamAuth) {
    problems.push(
      `Refusing to listen on ${cfg.host} without access control. Set APP_ACCESS_PASSWORD, or TRUST_UPSTREAM_AUTH=true ` +
        'when Cloud Run IAM / IAP already restricts access.',
    );
  }
  if (!['file', 'firestore', 'memory'].includes(cfg.storage.backend)) problems.push('STORAGE_BACKEND must be file, firestore or memory.');
  if (cfg.production && cfg.storage.backend !== 'firestore') {
    warnings.push('Production is not using Firestore; review decisions will be lost if the container filesystem is ephemeral.');
  }
  return { problems, warnings };
}
