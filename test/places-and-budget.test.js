import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGoogleError, FIELD_MASKS, normalizePlace, PlacesClient } from '../server/places.js';
import { Budget, LocalLimitError } from '../server/budget.js';
import { MemoryStorage } from '../server/storage/memory.js';

test('list/search field mask stays within the Text Search Pro SKU', () => {
  for (const f of ['nationalPhoneNumber', 'internationalPhoneNumber', 'websiteUri', 'regularOpeningHours', 'rating', 'reviews', 'photos']) {
    assert.ok(!FIELD_MASKS.textSearch.includes(f), `${f} would raise the SKU`);
  }
  assert.match(FIELD_MASKS.textSearch, /places\.id/);
  assert.match(FIELD_MASKS.detailsEnterprise, /nationalPhoneNumber/);
  assert.ok(!FIELD_MASKS.detailsPro.includes('websiteUri'));
});

test('Google errors map to actionable kinds', () => {
  const e1 = classifyGoogleError(403, { error: { status: 'PERMISSION_DENIED', message: 'x', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } }, 'aggregate');
  assert.equal(e1.code, 'API_NOT_ENABLED');
  assert.match(e1.help, /Places Aggregate API/);
  assert.equal(classifyGoogleError(403, { error: { details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } }, 'places').code, 'KEY_RESTRICTED');
  assert.equal(classifyGoogleError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }, 'places').kind, 'quota');
  assert.equal(classifyGoogleError(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }, 'places').code, 'KEY_INVALID');
  assert.equal(classifyGoogleError(500, {}, 'places').kind, 'upstream');
});

test('normalizePlace keeps missing values null and marks contact fields only when requested', () => {
  const p = normalizePlace({ id: 'abc', displayName: { text: 'X' }, pureServiceAreaBusiness: true });
  assert.equal(p.address, null);
  assert.equal(p.location, null);
  assert.equal(p.serviceAreaOnly, true);
  assert.ok(!('phone' in p));
  const d = normalizePlace({ id: 'abc' }, true);
  assert.equal(d.phone, null);
  assert.equal(d.website, null);
});

test('PlacesClient never leaks the key in errors and sends the field mask', async () => {
  const key = 'test-only-fake-places-key-0123456789';
  let seen;
  const fetchImpl = async (url, init) => {
    seen = init.headers;
    return new Response(JSON.stringify({ error: { code: 400, message: `bad request for ${key}` } }), { status: 400 });
  };
  const budget = new Budget(new MemoryStorage(), { textSearchPerDay: 5, detailsPerDay: 5, aggregatePerDay: 5 });
  const client = new PlacesClient({ key, authMode: 'key', configured: true, baseUrl: 'https://example.test', timeoutMs: 1000 }, budget, { fetchImpl });
  await assert.rejects(client.textSearch({ textQuery: 'cafe', box: [0, 0, 1, 1] }), (err) => !err.message.includes(key) && err.message.includes('[REDACTED]'));
  assert.equal(seen['X-Goog-FieldMask'], FIELD_MASKS.textSearch);
  assert.equal(seen['X-Goog-Api-Key'], key);
});

test('proxy auth mode sends no key header', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = init.headers;
    return new Response(JSON.stringify({ count: '3' }), { status: 200 });
  };
  const budget = new Budget(new MemoryStorage(), { textSearchPerDay: 5, detailsPerDay: 5, aggregatePerDay: 5 });
  const client = new PlacesClient({ key: '', authMode: 'proxy', configured: true, aggregateUrl: 'https://example.test', timeoutMs: 1000 }, budget, { fetchImpl });
  const res = await client.aggregate({ ring: [[0, 0], [1, 0], [1, 1], [0, 0]], types: ['cafe'] });
  assert.equal(res.count, 3);
  assert.ok(!('X-Goog-Api-Key' in seen));
});

test('Aggregate "over 100 places" 429 is treated as split-needed with the count, not a quota error', async () => {
  // Exact response body observed from areainsights.googleapis.com on 2026-10-20.
  const body = { error: { code: 429, message: 'The response exceeded the maximum number of allowed places. Only 100 places can be returned in a single response. The request produced 232 places and therefore no places were returned.', status: 'RESOURCE_EXHAUSTED' } };
  const fetchImpl = async () => new Response(JSON.stringify(body), { status: 429 });
  const budget = new Budget(new MemoryStorage(), { textSearchPerDay: 5, detailsPerDay: 5, aggregatePerDay: 5 });
  const client = new PlacesClient({ key: 'k', authMode: 'key', configured: true, aggregateUrl: 'https://example.test', timeoutMs: 1000 }, budget, { fetchImpl });
  assert.deepEqual(await client.aggregate({ ring: [[0, 0], [1, 0], [1, 1], [0, 0]], types: ['car_repair'] }), { count: 232, ids: null });
  // A genuine rate limit is still a quota error.
  const e = classifyGoogleError(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for quota metric' } }, 'aggregate');
  assert.equal(e.kind, 'quota');
});

test('budget enforces daily limits per group and estimates cost', async () => {
  const storage = new MemoryStorage();
  const budget = new Budget(storage, { textSearchPerDay: 2, detailsPerDay: 1, gapFillPerDay: 1, aggregatePerDay: 1 });
  await budget.consume('textSearchPro');
  await budget.consume('textSearchPro');
  await assert.rejects(budget.consume('textSearchPro'), LocalLimitError);
  await budget.consume('detailsEnterprise');
  await assert.rejects(budget.consume('detailsEnterprise'), LocalLimitError);
  await budget.consume('detailsPro'); // separate gap-fill group
  await assert.rejects(budget.consume('detailsPro'), LocalLimitError);
  const s = await budget.summary();
  assert.equal(s.limits.textSearch.used, 2);
  assert.equal(s.estMonthUsd, 0); // within free caps
});
