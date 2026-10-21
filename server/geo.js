// Geometry helpers for the OFFICIAL ELECTORATE BOUNDARY and the search
// rectangles/pieces derived from it.
//
// Compliance note: nothing in this module may be given coordinates that came
// from Google Places. The Google Maps Platform Terms (§3.2.3(c)(iv)) prohibit
// using Places latitude/longitude "as an input for point-in-polygon analysis".
// Electorate membership is instead established by Google itself through the
// Places Aggregate API custom-area filter (see discovery.js), and by human
// review. These helpers only split our own (CC BY 4.0, VEC/Vicmap) polygon
// into pieces and rectangles to send to Google as search areas.

import polygonClipping from 'polygon-clipping';

const EARTH_RADIUS_M = 6378137;
const rad = (d) => (d * Math.PI) / 180;

/** Signed planar area in lon/lat degrees²; positive for counter-clockwise rings. */
function signedArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function isCounterClockwise(ring) {
  return signedArea(ring) > 0;
}

/** Spherical-excess area of a lon/lat ring in km² (accurate to well under 1% at this scale). */
export function ringAreaKm2(ring) {
  let total = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [l1, p1] = ring[i];
    const [l2, p2] = ring[(i + 1) % n];
    total += rad(l2 - l1) * (2 + Math.sin(rad(p1)) + Math.sin(rad(p2)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2) / 1e6;
}

/** [west, south, east, north] */
export function bboxOf(ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

export function splitBox([w, s, e, n]) {
  const mx = (w + e) / 2;
  const my = (s + n) / 2;
  return [
    [w, s, mx, my],
    [mx, s, e, my],
    [w, my, mx, n],
    [mx, my, e, n],
  ];
}

function boxRing([w, s, e, n]) {
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

function closeRing(ring) {
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring : [...ring, ring[0]];
}

/**
 * Intersects the boundary ring with a rectangle. Returns zero or more simple
 * closed CCW exterior rings (the boundary has no holes, so neither do pieces).
 */
export function clipRingToBox(ring, box) {
  const result = polygonClipping.intersection([closeRing(ring)], [boxRing(box)]);
  const rings = [];
  for (const poly of result) {
    // poly[0] is the exterior ring; a rectangle cut of a hole-free polygon has no holes.
    let r = closeRing(poly[0]);
    if (!isCounterClockwise(r)) r = [...r].reverse();
    if (r.length >= 4 && ringAreaKm2(r) > 1e-6) rings.push(r);
  }
  return rings;
}

export function boxIntersectsRing(box, ring) {
  return clipRingToBox(ring, box).length > 0;
}

export function boxToViewport([w, s, e, n]) {
  return { low: { latitude: s, longitude: w }, high: { latitude: n, longitude: e } };
}

export function boxWidthHeightKm([w, s, e, n]) {
  const midLat = rad((s + n) / 2);
  const kmPerDegLat = 111.32;
  return [(e - w) * kmPerDegLat * Math.cos(midLat), (n - s) * kmPerDegLat];
}

/** Intersection of two boxes, or null. */
export function intersectBoxes(a, b) {
  const w = Math.max(a[0], b[0]);
  const s = Math.max(a[1], b[1]);
  const e = Math.min(a[2], b[2]);
  const n = Math.min(a[3], b[3]);
  return w < e && s < n ? [w, s, e, n] : null;
}

/** Expands a box by a margin in kilometres. */
export function expandBox([w, s, e, n], km) {
  const dLat = km / 111.32;
  const dLng = km / (111.32 * Math.cos(rad((s + n) / 2)));
  return [w - dLng, s - dLat, e + dLng, n + dLat];
}
