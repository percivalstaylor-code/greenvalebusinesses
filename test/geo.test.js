import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoundary } from '../server/boundary.js';
import { ringAreaKm2, isCounterClockwise, splitBox, clipRingToBox, boxIntersectsRing, intersectBoxes, boxWidthHeightKm } from '../server/geo.js';

const boundary = loadBoundary();

test('official boundary is the state electorate with expected provenance', () => {
  assert.equal(boundary.official.district, 'GREENVALE');
  assert.equal(boundary.official.district_label, 'Greenvale District');
  assert.equal(boundary.official.region_label, 'Northern Metropolitan Region');
  assert.equal(boundary.provenance.effective.effectiveFrom, '2022-11-01');
  assert.match(boundary.provenance.source.dataset, /State Assembly Polygon 2022/);
  assert.match(boundary.provenance.source.licence, /CC BY 4\.0/);
});

test('boundary ring is closed, counter-clockwise and ~60 km²', () => {
  const r = boundary.ring;
  assert.deepEqual(r[0], r[r.length - 1]);
  assert.ok(isCounterClockwise(r));
  const area = ringAreaKm2(r);
  assert.ok(area > 59.8 && area < 60.4, `area ${area}`); // VEC publishes 60.08 km²
});

test('splitting the boundary into box pieces conserves area', () => {
  let total = 0;
  for (const box of splitBox(boundary.bbox)) {
    for (const piece of clipRingToBox(boundary.ring, box)) {
      assert.ok(isCounterClockwise(piece));
      assert.deepEqual(piece[0], piece[piece.length - 1]);
      total += ringAreaKm2(piece);
    }
  }
  assert.ok(Math.abs(total - ringAreaKm2(boundary.ring)) < 0.01, `pieces ${total}`);
});

test('box helpers', () => {
  assert.equal(boxIntersectsRing([150, -34, 151, -33], boundary.ring), false);
  assert.equal(boxIntersectsRing(boundary.bbox, boundary.ring), true);
  assert.equal(intersectBoxes([0, 0, 1, 1], [2, 2, 3, 3]), null);
  assert.deepEqual(intersectBoxes([0, 0, 2, 2], [1, 1, 3, 3]), [1, 1, 2, 2]);
  const [w, h] = boxWidthHeightKm(boundary.bbox);
  assert.ok(w > 11 && w < 13.5 && h > 8.5 && h < 10, `${w} x ${h}`);
});
