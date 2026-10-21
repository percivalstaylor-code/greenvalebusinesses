// Test doubles. The fake Places client serves SYNTHETIC places (not Google
// data) so discovery logic can be tested without network access or cost.

import { loadBoundary } from '../server/boundary.js';
import { loadConfig } from '../server/config.js';
import { MemoryStorage } from '../server/storage/memory.js';
import { Budget } from '../server/budget.js';
import { Discovery } from '../server/discovery.js';

export function testConfig(overrides = {}) {
  const cfg = loadConfig({ GOOGLE_MAPS_BROWSER_KEY: 'test-browser-key', GOOGLE_PLACES_SERVER_KEY: 'test-server-key', STORAGE_BACKEND: 'memory' });
  return { ...cfg, ...overrides, limits: { ...cfg.limits, ...(overrides.limits || {}) } };
}

/** Ray-casting point-in-polygon — used ONLY by the fake to simulate Google's own Aggregate behaviour on synthetic points. */
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function syntheticPlaces(boundary, n, types, seed = 1) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const [w, so, e, no] = boundary.bbox;
  return Array.from({ length: n }, (_, i) => ({
    id: `ChIJsynthetic${String(i).padStart(6, '0')}`,
    name: `Synthetic ${i}`,
    address: `${i} Test St`,
    shortAddress: `${i} Test St`,
    location: { lat: so + rand() * (no - so), lng: w + rand() * (e - w) },
    types: [types[i % types.length], 'point_of_interest', 'establishment'],
    primaryType: types[i % types.length],
    primaryTypeLabel: types[i % types.length],
    businessStatus: 'OPERATIONAL',
    mapsUri: `https://maps.google.com/?cid=${i}`,
    serviceAreaOnly: false,
    attributions: [],
  }));
}

export class FakePlaces {
  constructor(places, { failAggregate = null } = {}) {
    this.places = places;
    this.calls = { textSearch: 0, aggregate: 0, details: 0 };
    this.failAggregate = failAggregate;
    this.tokens = new Map();
  }

  async textSearch({ includedType, textQuery, box, pageToken }) {
    this.calls.textSearch++;
    const [w, s, e, n] = box;
    let matches;
    let offset = 0;
    if (pageToken) ({ matches, offset } = this.tokens.get(pageToken));
    else {
      matches = this.places.filter((p) => {
        const inBox = p.location.lng >= w && p.location.lng <= e && p.location.lat >= s && p.location.lat <= n;
        const typeOk = includedType ? p.types.includes(includedType) : p.name.toLowerCase().includes(textQuery.toLowerCase()) || p.types.includes(textQuery);
        return inBox && typeOk;
      }).slice(0, 60); // Google's cap
    }
    const page = matches.slice(offset, offset + 20);
    let nextPageToken = null;
    if (offset + 20 < matches.length) {
      nextPageToken = `tok${this.tokens.size}`;
      this.tokens.set(nextPageToken, { matches, offset: offset + 20 });
    }
    return { places: page.map((p) => structuredClone(p)), nextPageToken };
  }

  async aggregate({ ring, types }) {
    this.calls.aggregate++;
    if (this.failAggregate) throw this.failAggregate;
    const hits = this.places.filter((p) => p.types.some((t) => types.includes(t)) && inRing([p.location.lng, p.location.lat], ring));
    return { count: hits.length, ids: hits.length <= 100 ? hits.map((p) => p.id) : null };
  }

  async details(id, tier) {
    this.calls.details++;
    const p = this.places.find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('not found'), { kind: 'invalid', code: 'NOT_FOUND' });
    return tier === 'enterprise' ? { ...structuredClone(p), phone: null, phoneIntl: null, website: null, hours: null } : structuredClone(p);
  }

  /** Test oracle: which synthetic places are really inside. */
  insideIds(ring, types) {
    return new Set(this.places.filter((p) => p.types.some((t) => types.includes(t)) && inRing([p.location.lng, p.location.lat], ring)).map((p) => p.id));
  }
}

export function makeDiscovery({ places, cfg = testConfig(), fakeOptions } = {}) {
  const boundary = loadBoundary();
  const storage = new MemoryStorage();
  const budget = new Budget(storage, cfg.limits);
  const fake = new FakePlaces(places || [], fakeOptions);
  const discovery = new Discovery({ places: fake, storage, boundary, cfg });
  return { discovery, storage, budget, fake, boundary, cfg };
}

export async function waitForJob(discovery, id) {
  for (let i = 0; i < 500; i++) {
    const job = discovery.getJob(id);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not finish');
}
