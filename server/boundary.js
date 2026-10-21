import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { bboxOf } from './geo.js';

/** Loads the official Greenvale District boundary written by scripts/fetch-boundary.mjs. */
export function loadBoundary(path = join(ROOT, 'data', 'boundary', 'greenvale-district.geojson')) {
  const fc = JSON.parse(readFileSync(path, 'utf8'));
  const feature = fc.features[0];
  const ring = feature.geometry.coordinates[0];
  const { provenance, ...official } = feature.properties;
  return {
    geojson: fc,
    ring,
    bbox: bboxOf(ring),
    official,
    provenance,
    // Stored membership results are tied to this exact boundary geometry.
    version: provenance.geometry.sha256OfRing.slice(0, 16),
  };
}
