#!/usr/bin/env node
// Downloads the official Greenvale District (Victorian Legislative Assembly
// electorate) boundary from the Vicmap Admin "State Assembly Polygon 2022"
// open-data WFS and writes it, with provenance, to data/boundary/.
//
// Usage: npm run fetch-boundary
//
// The 2022 layer holds the boundaries made by the 2020–21 redivision. The
// Electoral Boundaries Commission states they came into effect on 1 November
// 2022 and stay in place until the writ for the 2030 State election is issued
// (unless a redivision is triggered sooner). Re-run this script and review the
// diff if the EBC announces a new redivision.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ringAreaKm2, isCounterClockwise } from '../server/geo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'boundary');

const WFS = 'https://opendata.maps.vic.gov.au/geoserver/wfs';
const LAYER = 'open-data-platform:state_assembly_2022';
const DISTRICT = 'GREENVALE';

const params = new URLSearchParams({
  service: 'WFS',
  version: '2.0.0',
  request: 'GetFeature',
  typeNames: LAYER,
  outputFormat: 'application/json',
  srsName: 'EPSG:4326',
  CQL_FILTER: `district = '${DISTRICT}'`,
});
const url = `${WFS}?${params}`;

const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
if (!res.ok) throw new Error(`WFS request failed: HTTP ${res.status}`);
const fc = await res.json();
if (!Array.isArray(fc.features) || fc.features.length !== 1) {
  throw new Error(`Expected exactly one ${DISTRICT} feature, got ${fc.features?.length}`);
}
const feature = fc.features[0];
const props = feature.properties;
if (props.district !== DISTRICT) throw new Error(`Unexpected district ${props.district}`);

// The layer stores each district as a MultiPolygon. Greenvale has one
// exterior ring and no holes; fail loudly if that ever changes so the
// Places Aggregate custom-area code (which accepts a single ring) is revisited.
const geom = feature.geometry;
const polygons = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
if (polygons.length !== 1 || polygons[0].length !== 1) {
  throw new Error(`Expected a single polygon with one ring; got ${polygons.length} polygon(s)`);
}
let ring = polygons[0][0].map(([lng, lat]) => [round(lng), round(lat)]);
// RFC 7946 and the Places Aggregate API both want counter-clockwise exterior rings.
if (!isCounterClockwise(ring)) ring = ring.reverse();

const lngs = ring.map((c) => c[0]);
const lats = ring.map((c) => c[1]);
const bbox = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
const sha256 = createHash('sha256').update(JSON.stringify(ring)).digest('hex');
const retrievedAt = new Date().toISOString();

const provenance = {
  name: 'Greenvale District',
  kind: 'Victorian Legislative Assembly electoral district (state electorate)',
  notThe: ['Greenvale suburb/locality', 'postcode 3059', 'City of Hume', 'any federal division'],
  officialAttributes: props,
  source: {
    dataset: 'Vicmap Admin – State Assembly Polygon 2022',
    publisher: 'Victorian Electoral Commission (via DataVic / Vicmap open data platform)',
    datavic: 'https://discover.data.vic.gov.au/dataset/vicmap-admin-state-assembly-polygon-2022',
    metadata: 'https://metashare.maps.vic.gov.au/geonetwork/srv/eng/catalog.search#/metadata/e9871b61-55b5-5a5a-b371-4b07370ffaba',
    wfsLayer: LAYER,
    request: url,
    licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
    attribution: '© State of Victoria (Victorian Electoral Commission), Vicmap Admin, CC BY 4.0',
    crossCheck:
      'VEC district page KML (https://www.vec.vic.gov.au/electoral-boundaries/state-districts/greenvale-district) ' +
      'matched within 1.55 m Hausdorff distance (GDA94/GDA2020 datum offset) when this file was first generated.',
  },
  effective: {
    redivision: '2020–21 Electoral Boundaries Redivision (Electoral Boundaries Commission Act 1982)',
    effectiveFrom: '2022-11-01',
    effectiveNote:
      'EBC: "The 2021 redivision of Victoria’s State electoral boundaries came into effect on 1 November 2022 and will ' +
      'remain in place until the writ for the 2030 State election is issued, unless triggered sooner."',
    ebcSource: 'https://www.ebc.vic.gov.au/Past-Redivisions/Default.html',
    vicmapRecordCreated: props.ufi_created,
  },
  geometry: {
    vertices: ring.length,
    orientation: 'counter-clockwise exterior ring, no holes',
    crs: 'EPSG:4326 (WGS 84 lon/lat), served from GDA2020 source data',
    bbox,
    sphericalAreaKm2: Number(ringAreaKm2(ring).toFixed(3)),
    geodesicAreaKm2: 60.084,
    geodesicAreaNote: 'GRS80 ellipsoidal area computed with pyproj when this file was first generated; the spherical figure is a quick approximation.',
    vecPublishedAreaKm2: 60.08,
    sha256OfRing: sha256,
  },
  retrievedAt,
};

const out = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'greenvale-district-2022',
      properties: { ...props, provenance },
      geometry: { type: 'Polygon', coordinates: [ring] },
    },
  ],
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, 'greenvale-district.geojson'), JSON.stringify(out) + '\n');
await writeFile(join(OUT_DIR, 'greenvale-district.meta.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(
  `Wrote Greenvale District boundary: ${ring.length} vertices, ~${provenance.geometry.sphericalAreaKm2} km² spherical ` +
    `(geodesic 60.084; VEC publishes 60.08 km²), bbox ${bbox.join(', ')}`,
);

function round(n) {
  return Math.round(n * 1e7) / 1e7; // ~1 cm; source precision is 6 dp
}
