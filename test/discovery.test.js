import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDiscovery, syntheticPlaces, testConfig, waitForJob } from './helpers.js';
import { CATEGORY_BY_ID } from '../server/categories.js';
import { loadBoundary } from '../server/boundary.js';
import { PlacesError } from '../server/places.js';

const boundary = loadBoundary();
const automotive = CATEGORY_BY_ID.get('automotive');
const autoTypes = automotive.types.map((t) => t.type);

// Content fields that must never be persisted (Maps ToS §3.2.3(a)–(b)).
const FORBIDDEN = ['name', 'address', 'shortAddress', 'location', 'lat', 'lng', 'phone', 'website', 'hours', 'types', 'primaryType', 'mapsUri', 'serviceAreaOnly', 'businessStatus'];

function assertNoContentStored(storage) {
  for (const [col, map] of Object.entries(storage.data)) {
    for (const [id, doc] of map) {
      for (const f of FORBIDDEN) assert.ok(!(f in doc), `${col}/${id} stores forbidden field ${f}`);
      assert.ok(!JSON.stringify(doc).includes('Synthetic'), `${col}/${id} stores a business name`);
    }
  }
}

test('sweep dedupes by place ID, classifies by ID matching, and stores no content', async () => {
  // Each synthetic place gets two automotive types so it is returned by two searches (duplicates).
  const places = syntheticPlaces(boundary, 150, autoTypes).map((p, i) => ({ ...p, types: [autoTypes[i % 8], autoTypes[(i + 1) % 8], 'establishment'] }));
  const { discovery, storage, fake } = makeDiscovery({ places });
  const job = await waitForJob(discovery, discovery.startSweep('automotive').id);
  assert.equal(job.status, 'done', JSON.stringify(job.error));
  const r = discovery.jobs.get(job.id).result;

  const ids = r.places.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate place IDs in results');
  assert.ok(r.meta.duplicatesMerged > 0, 'duplicates were merged');

  const truth = fake.insideIds(boundary.ring, autoTypes);
  for (const p of r.places) {
    const expected = truth.has(p.id) ? 'confirmed' : 'outside_google';
    assert.equal(p.membership.status, expected, `${p.id}`);
  }
  assert.equal(r.aggregate.complete, true);
  assert.equal(r.aggregate.googleCount, truth.size);
  // > 100 inside → the polygon had to be split for Google to return IDs
  assert.ok(truth.size > 100 ? fake.calls.aggregate > 1 : true);
  assertNoContentStored(storage);
});

test('Text Search 60-result cap triggers rectangle splitting and finds everything', async () => {
  const places = syntheticPlaces(boundary, 140, ['car_repair']);
  const { discovery, fake } = makeDiscovery({ places });
  const job = await waitForJob(discovery, discovery.startSweep('automotive').id);
  const r = discovery.jobs.get(job.id).result;
  const found = new Set(r.places.map((p) => p.id));
  assert.equal(found.size, 140, 'all synthetic places recovered after splitting');
  assert.ok(fake.calls.textSearch > automotive.types.length);
  assert.equal(r.gapIds.length, 0);
});

test('places Google lists inside but search missed become gap IDs, and gap fill fetches only those', async () => {
  const places = syntheticPlaces(boundary, 30, ['car_wash']);
  const { discovery, fake } = makeDiscovery({ places });
  // Simulate Text Search missing two listings.
  const orig = fake.textSearch.bind(fake);
  fake.textSearch = async (args) => {
    const res = await orig(args);
    return { ...res, places: res.places.filter((p) => !['ChIJsynthetic000001', 'ChIJsynthetic000002'].includes(p.id)) };
  };
  const job = await waitForJob(discovery, discovery.startSweep('automotive').id);
  const r = discovery.jobs.get(job.id).result;
  const inside = fake.insideIds(boundary.ring, ['car_wash']);
  const expectedGaps = ['ChIJsynthetic000001', 'ChIJsynthetic000002'].filter((id) => inside.has(id));
  assert.deepEqual(r.gapIds.sort(), expectedGaps.sort());
  const filled = await discovery.gapFill([...r.gapIds, 'ChIJsynthetic000003', 'not a valid id!']);
  assert.equal(filled.fetched, expectedGaps.length, 'only Google-confirmed gap IDs are fetched');
  filled.places.forEach((p) => assert.equal(p.membership.status, 'confirmed'));
});

test('if the Aggregate API is unavailable, results are "unverified" rather than guessed', async () => {
  const places = syntheticPlaces(boundary, 20, ['gas_station']);
  const failAggregate = new PlacesError({ kind: 'config', code: 'API_NOT_ENABLED', message: 'disabled' });
  const { discovery } = makeDiscovery({ places, fakeOptions: { failAggregate } });
  const job = await waitForJob(discovery, discovery.startSweep('automotive').id);
  const r = discovery.jobs.get(job.id).result;
  assert.ok(r.places.length > 0);
  r.places.forEach((p) => assert.equal(p.membership.status, 'unverified'));
  assert.equal(r.aggregate.error.code, 'API_NOT_ENABLED');
});

test('incomplete enumeration never marks places as outside', async () => {
  const places = syntheticPlaces(boundary, 400, ['car_dealer']);
  const cfg = testConfig({ limits: { sweepAggregateMax: 2 } });
  const { discovery } = makeDiscovery({ places, cfg });
  const job = await waitForJob(discovery, discovery.startSweep('automotive').id);
  const r = discovery.jobs.get(job.id).result;
  assert.equal(r.aggregate.complete, false);
  assert.ok(!r.places.some((p) => p.membership.status === 'outside_google'));
});

test('human review overrides the automatic status; service-area businesses are separate', async () => {
  const places = syntheticPlaces(boundary, 5, ['electrician']);
  places[0].serviceAreaOnly = true;
  const { discovery, storage } = makeDiscovery({ places });
  await storage.set('reviews', places[1].id, { decision: 'outside', note: '', reviewer: '', updatedAt: new Date().toISOString() });
  const [a, b] = await discovery.annotate(places.slice(0, 2));
  assert.equal(a.membership.status, 'service_area');
  assert.equal(b.membership.status, 'reviewed_outside');
});

test('area search validates the area and makes one request per type', async () => {
  const places = syntheticPlaces(boundary, 10, ['tire_shop']);
  const { discovery, fake } = makeDiscovery({ places, cfg: testConfig({ limits: { areaSearchMaxKm: 5 } }) });
  await assert.rejects(discovery.searchArea({ categoryId: 'automotive', box: [150, -34, 151, -33] }), /does not overlap/);
  await assert.rejects(discovery.searchArea({ categoryId: 'automotive', box: [143, -39, 147, -36] }), /Zoom in/);
  discovery.cfg.limits.areaSearchMaxKm = 20;
  const res = await discovery.searchArea({ categoryId: 'automotive', box: boundary.bbox });
  assert.equal(fake.calls.textSearch, automotive.types.length);
  assert.equal(res.meta.textSearchRequests, automotive.types.length);
  res.places.forEach((p) => assert.equal(p.membership.status, 'unverified'));
  const one = await discovery.searchArea({ categoryId: 'automotive', type: 'tire_shop', box: boundary.bbox });
  assert.equal(one.meta.textSearchRequests, 1);
});

test('stale or other-boundary verdicts are ignored', async () => {
  const { discovery, storage } = makeDiscovery({ places: [] });
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  await storage.set('places', 'ChIJsynthetic000009', { area: { inside: true, checkedAt: old, via: 'retail', boundary: discovery.boundary.version } });
  await storage.set('places', 'ChIJsynthetic000008', { area: { inside: true, checkedAt: new Date().toISOString(), via: 'retail', boundary: 'different' } });
  const res = await discovery.annotate([{ id: 'ChIJsynthetic000009', types: [] }, { id: 'ChIJsynthetic000008', types: [] }]);
  res.forEach((p) => assert.equal(p.membership.status, 'unverified'));
});
