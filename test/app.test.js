import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { makeDiscovery, syntheticPlaces, testConfig } from './helpers.js';
import { loadBoundary } from '../server/boundary.js';
import { validateConfig, loadConfig, describeConfig } from '../server/config.js';

let server;
let base;
let ctx;

before(async () => {
  const boundary = loadBoundary();
  ctx = makeDiscovery({ places: syntheticPlaces(boundary, 10, ['bakery']) });
  const app = createApp({ cfg: testConfig(), storage: ctx.storage, budget: ctx.budget, discovery: ctx.discovery, boundary });
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const j = (path, init) => fetch(base + path, init).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json(), headers: r.headers }));
const put = (path, body) => j(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('config exposes the browser key but never the server key', async () => {
  const { body, headers } = await j('/api/config');
  assert.equal(body.maps.browserKey, 'test-browser-key');
  assert.ok(!JSON.stringify(body).includes('test-server-key'));
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.match(headers.get('content-security-policy'), /default-src 'self'/);
});

test('reviews: validation, save, export contains IDs and decisions only, delete', async () => {
  assert.equal((await put('/api/reviews/bad%20id', { decision: 'inside' })).status, 400);
  assert.equal((await put('/api/reviews/ChIJsynthetic000001', { decision: 'maybe' })).status, 400);
  const saved = await put('/api/reviews/ChIJsynthetic000001', { decision: 'inside', note: 'n'.repeat(900), reviewer: 'AB' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.note.length, 500);
  const exp = await j('/api/reviews/export');
  assert.deepEqual(Object.keys(exp.body.reviews[0]).sort(), ['decision', 'id', 'note', 'reviewer', 'updatedAt']);
  const imp = await j('/api/reviews/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exp.body) });
  assert.equal(imp.body.imported, 1);
  assert.equal((await j('/api/reviews/ChIJsynthetic000001', { method: 'DELETE' })).status, 204);
});

test('errors are structured JSON with the right HTTP status', async () => {
  const r = await j('/api/search/area', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ categoryId: 'retail', box: [150, -34, 151, -33] }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'OUTSIDE_REGION');
  const bad = await j('/api/search/area', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(bad.body.error.code, 'BAD_JSON');
});

test('coverage reports accumulated counts without business details', async () => {
  const { body } = await j('/api/coverage');
  assert.ok('totals' in body && 'byCategory' in body);
  assert.ok(!JSON.stringify(body).includes('Synthetic'));
});

test('config validation refuses to expose the app publicly without access control', () => {
  const cfg = loadConfig({ GOOGLE_MAPS_BROWSER_KEY: 'k', HOST: '0.0.0.0' });
  assert.ok(validateConfig(cfg).problems.some((p) => /Refusing to listen/.test(p)));
  const ok = loadConfig({ GOOGLE_MAPS_BROWSER_KEY: 'k', HOST: '0.0.0.0', APP_ACCESS_PASSWORD: 'x' });
  assert.equal(validateConfig(ok).problems.length, 0);
  assert.ok(!JSON.stringify(describeConfig(ok)).includes('"x"'));
  const prod = loadConfig({ GOOGLE_MAPS_BROWSER_KEY: 'k', NODE_ENV: 'production', TRUST_UPSTREAM_AUTH: 'true' });
  assert.equal(prod.places.configured, false, 'no browser-key fallback in production');
});
