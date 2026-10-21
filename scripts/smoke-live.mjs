#!/usr/bin/env node
// Small representative LIVE check of the Google integration (≈ 3–5 requests):
//   1. Text Search (Pro) for supermarkets across the electorate's bounding rectangle
//   2. Places Aggregate: supermarkets inside the official electorate polygon
//   3. Place Details (Enterprise) for one result
// Uses in-memory storage, so nothing is persisted. Never prints credentials.
//
// Usage: npm run smoke:live

import { loadConfig, describeConfig } from '../server/config.js';
import { MemoryStorage } from '../server/storage/memory.js';
import { Budget } from '../server/budget.js';
import { PlacesClient } from '../server/places.js';
import { loadBoundary } from '../server/boundary.js';

const cfg = loadConfig();
console.log('Config:', describeConfig(cfg));
if (!cfg.places.configured) {
  console.error('No Places credential configured (GOOGLE_PLACES_SERVER_KEY or PLACES_AUTH_MODE=proxy).');
  process.exit(1);
}
const storage = new MemoryStorage();
const budget = new Budget(storage, { textSearchPerDay: 4, detailsPerDay: 1, aggregatePerDay: 1 });
const places = new PlacesClient(cfg.places, budget);
const boundary = loadBoundary();

const step = async (label, fn) => {
  try {
    const r = await fn();
    console.log(`✔ ${label}`);
    return r;
  } catch (e) {
    console.log(`✘ ${label}: [${e.code || e.name}] ${e.message}${e.help ? `\n    → ${e.help}` : ''}`);
    return null;
  }
};

// 1. Text Search, following pagination (max 3 pages) to exercise page tokens and dedupe.
const found = new Map();
let duplicates = 0;
let requests = 0;
await step('Text Search (New): supermarkets in the electorate bounding rectangle', async () => {
  let pageToken;
  do {
    requests++;
    const res = await places.textSearch({ textQuery: 'Supermarket', includedType: 'supermarket', box: boundary.bbox, pageToken });
    for (const p of res.places) (found.has(p.id) ? duplicates++ : found.set(p.id, p));
    pageToken = res.nextPageToken;
  } while (pageToken && requests < 3);
});
console.log(`  ${found.size} unique places from ${requests} request(s); ${duplicates} duplicate listing(s) merged by place ID`);

// 2. Google's own membership check for the official polygon.
const agg = await step('Places Aggregate API: supermarkets inside the official Greenvale District polygon', () =>
  places.aggregate({ ring: boundary.ring, types: ['supermarket'] }),
);
if (agg) {
  const inside = new Set(agg.ids || []);
  const list = [...found.values()];
  const confirmed = list.filter((p) => inside.has(p.id));
  const notIn = list.filter((p) => !inside.has(p.id) && p.businessStatus !== 'CLOSED_PERMANENTLY');
  const gaps = [...inside].filter((id) => !found.has(id));
  console.log(`  Google count inside electorate: ${agg.count} (IDs returned: ${agg.ids ? agg.ids.length : 'no — over 100'})`);
  console.log(`  Search results confirmed inside: ${confirmed.length}; not in Google's electorate results: ${notIn.length}; inside but not returned by search: ${gaps.length}`);
  console.log('  Confirmed inside (name — address):');
  confirmed.slice(0, 20).forEach((p) => console.log(`    • ${p.name} — ${p.shortAddress || p.address || '(no address)'}`));
  console.log('  Returned by search but not inside per Google:');
  notIn.slice(0, 20).forEach((p) => console.log(`    • ${p.name} — ${p.shortAddress || p.address || '(no address)'}`));
}

// 3. One details lookup with contact fields.
const first = [...found.values()][0];
if (first) {
  const d = await step(`Place Details (New), Enterprise fields, for one result`, () => places.details(first.id, 'enterprise'));
  if (d) {
    console.log(`  ${d.name}: phone ${d.phone ? 'present' : 'not listed'}, website ${d.website ? 'present' : 'not listed'}, hours ${d.hours ? `${d.hours.length} lines` : 'not listed'}, Maps link ${d.mapsUri ? 'present' : 'missing'}`);
  }
}

const usage = await budget.summary();
console.log('Requests made:', Object.fromEntries(usage.skus.filter((s) => s.today).map((s) => [s.label, s.today])));
