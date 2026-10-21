import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { publicCategories, CATEGORIES } from './categories.js';
import { errorPayload, isPlaceId, STATUS } from './discovery.js';
import { PlacesError } from './places.js';
import { SKUS } from './budget.js';

const HTTP_FOR_KIND = { invalid: 400, quota: 429, config: 503, network: 502, upstream: 502 };
const DECISIONS = new Set(['inside', 'outside', 'unsure']);

export function createApp({ cfg, storage, budget, discovery, boundary }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.production ? 1 : false);

  app.use(securityHeaders);
  if (cfg.auth.password) app.use(basicAuth(cfg.auth.password));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => {
    // Places content must not be cached by browsers or intermediaries.
    res.set('Cache-Control', 'no-store');
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/config', wrap(async (req, res) => {
    // One page load ≈ one Dynamic Maps load; counted for the cost estimate only.
    storage.increment('usage', new Date().toISOString().slice(0, 10), 'mapLoads', 1).catch(() => {});
    res.json({
      mode: cfg.production ? 'production' : 'development',
      maps: { browserKey: cfg.maps.browserKey || null, mapId: cfg.maps.mapId },
      places: {
        configured: cfg.places.configured,
        authMode: cfg.places.authMode,
        developmentFallback: cfg.places.keySource.includes('fallback'),
      },
      storage: storage.describe(),
      limits: cfg.limits,
      membershipMaxAgeDays: cfg.membershipMaxAgeDays,
      categories: publicCategories(),
      boundary: { official: boundary.official, provenance: boundary.provenance, bbox: boundary.bbox, version: boundary.version },
      statuses: STATUS,
      prices: SKUS,
    });
  }));

  app.get('/api/boundary', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(boundary.geojson);
  });

  app.get('/api/usage', wrap(async (req, res) => res.json(await budget.summary())));

  app.post('/api/search/area', wrap(async (req, res) => {
    const { categoryId, type, query, box, pageToken } = req.body || {};
    res.json(await discovery.searchArea({ categoryId, type, query, box, pageToken: typeof pageToken === 'string' ? pageToken : undefined }));
  }));

  app.get('/api/sweeps/plan', (req, res) => res.json(discovery.planSweep(String(req.query.category || ''))));

  app.post('/api/sweeps', (req, res) => {
    const job = discovery.startSweep(String(req.body?.categoryId || ''));
    res.status(202).json(discovery.getJob(job.id));
  });

  app.get('/api/sweeps/:id', (req, res) => {
    const job = discovery.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: { kind: 'invalid', code: 'NO_JOB', message: 'Sweep not found (it may have expired).' } });
    res.json(job);
  });

  app.post('/api/area-check', wrap(async (req, res) => {
    const { categoryId, places } = req.body || {};
    res.json(await discovery.areaCheck({ categoryId, places: Array.isArray(places) ? places : [] }));
  }));

  app.post('/api/places/gap-fill', wrap(async (req, res) => {
    res.json(await discovery.gapFill(Array.isArray(req.body?.ids) ? req.body.ids : []));
  }));

  app.get('/api/places/:id', wrap(async (req, res) => res.json(await discovery.details(req.params.id))));

  app.get('/api/coverage', wrap(async (req, res) => res.json(await coverage(storage, discovery, boundary))));

  // ----- manual boundary review -----

  app.get('/api/reviews', wrap(async (req, res) => res.json({ reviews: await storage.list('reviews') })));

  app.put('/api/reviews/:id', wrap(async (req, res) => {
    const id = req.params.id;
    if (!isPlaceId(id)) throw new PlacesError({ kind: 'invalid', code: 'BAD_PLACE_ID', message: 'Invalid place ID.' });
    const review = cleanReview(req.body);
    await storage.set('reviews', id, review);
    res.json({ id, ...review });
  }));

  app.delete('/api/reviews/:id', wrap(async (req, res) => {
    if (!isPlaceId(req.params.id)) throw new PlacesError({ kind: 'invalid', code: 'BAD_PLACE_ID', message: 'Invalid place ID.' });
    await storage.delete('reviews', req.params.id);
    res.status(204).end();
  }));

  app.get('/api/reviews/export', wrap(async (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="greenvale-boundary-reviews.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      boundaryVersion: boundary.version,
      contents: 'Google place IDs and your own review decisions only — no Google Maps content.',
      reviews: await storage.list('reviews'),
    });
  }));

  app.post('/api/reviews/import', wrap(async (req, res) => {
    const items = Array.isArray(req.body?.reviews) ? req.body.reviews : null;
    if (!items) throw new PlacesError({ kind: 'invalid', code: 'BAD_IMPORT', message: 'Expected {"reviews": [...]} as produced by Export.' });
    let imported = 0;
    for (const r of items.slice(0, 20000)) {
      if (!isPlaceId(r?.id)) continue;
      try {
        await storage.set('reviews', r.id, cleanReview(r, r.updatedAt));
        imported++;
      } catch {
        /* skip invalid rows */
      }
    }
    res.json({ imported, skipped: items.length - imported });
  }));

  // ----- static front end -----
  app.get('/vendor/markerclusterer.min.js', (req, res) => {
    res.sendFile(join(ROOT, 'node_modules', '@googlemaps', 'markerclusterer', 'dist', 'index.min.js'));
  });
  app.use(express.static(join(ROOT, 'public'), { extensions: ['html'], maxAge: cfg.production ? '1h' : 0 }));

  app.use('/api', (req, res) => res.status(404).json({ error: { kind: 'invalid', code: 'NOT_FOUND', message: 'Unknown API route.' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { kind: 'invalid', code: 'BAD_JSON', message: 'Malformed JSON body.' } });
    const payload = errorPayload(err);
    if (!err.kind) console.error('Unexpected error:', err.message); // never logs request bodies or headers
    res.status(HTTP_FOR_KIND[err.kind] || 500).json({ error: payload });
  });

  return app;
}

function cleanReview(body, updatedAt) {
  const decision = String(body?.decision || '');
  if (!DECISIONS.has(decision)) throw new PlacesError({ kind: 'invalid', code: 'BAD_DECISION', message: 'decision must be inside, outside or unsure.' });
  return {
    decision,
    note: String(body?.note || '').slice(0, 500),
    reviewer: String(body?.reviewer || '').slice(0, 80),
    updatedAt: updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? new Date(updatedAt).toISOString() : new Date().toISOString(),
  };
}

/** Accumulated coverage measures computed from stored place IDs and our own records only. */
async function coverage(storage, discovery, boundary) {
  const [places, reviews, sweeps] = await Promise.all([storage.list('places'), storage.list('reviews'), storage.list('sweeps')]);
  const reviewMap = new Map(reviews.map((r) => [r.id, r]));
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c.id, { label: c.label, discovered: 0, confirmed: 0, outside: 0, unverified: 0 }]));
  const totals = { discovered: places.length, confirmed: 0, outside: 0, unverified: 0, reviewed: reviews.length };
  let since = null;
  const needsReview = [];
  for (const p of places) {
    const fresh = p.area && discovery.isFresh(p.area);
    const key = fresh ? (p.area.inside ? 'confirmed' : 'outside') : 'unverified';
    totals[key]++;
    for (const c of p.categories || []) if (byCategory[c]) { byCategory[c].discovered++; byCategory[c][key]++; }
    if (!since || (p.firstSeenAt && p.firstSeenAt < since)) since = p.firstSeenAt;
    if (key === 'unverified' && !reviewMap.has(p.id)) needsReview.push({ id: p.id, categories: p.categories || [], lastSeenAt: p.lastSeenAt });
  }
  const reviewCounts = { inside: 0, outside: 0, unsure: 0 };
  for (const r of reviews) reviewCounts[r.decision] = (reviewCounts[r.decision] || 0) + 1;
  const lastSweeps = {};
  for (const s of sweeps.sort((a, b) => (a.finishedAt < b.finishedAt ? -1 : 1))) lastSweeps[s.categoryId] = s;
  needsReview.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
  return {
    boundaryVersion: boundary.version,
    since,
    totals,
    byCategory,
    reviews: reviewCounts,
    lastSweeps,
    sweepsRun: sweeps.length,
    needsReview: needsReview.slice(0, 500),
    needsReviewTotal: needsReview.length,
    note:
      'Counts of unique Google place IDs this app has discovered and stored, with Google’s electorate-area verdicts ' +
      '(re-checked after the configured maximum age) and your reviews. Business details are never stored, so this ' +
      'is a coverage measure, not a register.',
  };
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    // The browser key's website restriction relies on the Referer header, so keep origin-level referrers.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.ggpht.com https://*.googleusercontent.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com https://*.ggpht.com",
      "connect-src 'self' https://*.googleapis.com https://*.google.com https://*.gstatic.com data: blob:",
      "worker-src 'self' blob:",
      "frame-src https://*.google.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
}

function basicAuth(password) {
  const expected = createHash('sha256').update(password).digest();
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const supplied = decoded.slice(decoded.indexOf(':') + 1);
      if (timingSafeEqual(createHash('sha256').update(supplied).digest(), expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Greenvale Business Map", charset="UTF-8"');
    res.status(401).send('Authentication required.');
  };
}
