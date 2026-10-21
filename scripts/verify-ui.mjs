#!/usr/bin/env node
// Browser verification with Playwright (Chromium).
//
//   npm run verify:ui                 # map + boundary + layout only (no Places requests)
//   npm run verify:ui -- --live       # also runs a small live search set (~25–40 Google requests)
//
// Expects the app running in development mode at APP_URL (default http://127.0.0.1:8080).
// Screenshots go to SCREENSHOT_DIR (default ./.verify).

import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const APP = process.env.APP_URL || 'http://127.0.0.1:8080';
const OUT = process.env.SCREENSHOT_DIR || '.verify';
const LIVE = process.argv.includes('--live');
await mkdir(OUT, { recursive: true });

const args = process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [];
const browser = await chromium.launch({ args });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const redact = (s) => s.replace(/AIza[0-9A-Za-z_-]{35}/g, '[KEY]').replace(/key=[^&\s]+/g, 'key=[REDACTED]');

async function openPage(viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(redact(m.text())));
  page.on('pageerror', (e) => errors.push(redact(e.message)));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__gbm?.mapView?.boundaryBounds && window.google?.maps, null, { timeout: 30000 });
  await page.waitForTimeout(2500); // tiles
  return { page, errors };
}

/** Markers currently on the map (including clustered ones) vs. list items. */
async function markerListAgreement(page) {
  return page.evaluate(() => {
    const s = window.__gbm;
    const markerIds = [...s.mapView.markers].filter(([, m]) => m.visible).map(([id]) => id).sort();
    const listIds = [...(s.listedIds || [])].sort();
    const rendered = document.querySelectorAll('#result-list .result').length;
    const withLocation = [...s.results.values()].filter((p) => !p.serviceAreaOnly && p.location && s.filters.statuses.has(p.membership.status) && p.businessStatus !== 'CLOSED_PERMANENTLY').length;
    const ids = [...s.results.keys()];
    return { markers: markerIds.length, list: listIds.length, rendered, same: JSON.stringify(markerIds) === JSON.stringify(listIds) && rendered === Math.min(listIds.length, s.listLimit), withLocation, uniqueIds: new Set(ids).size === ids.length };
  });
}

async function waitIdle(page) {
  await page.waitForFunction(() => !window.__gbm.busy, null, { timeout: 180000 });
  await page.waitForTimeout(600);
}

// ---------- desktop ----------
{
  const { page, errors } = await openPage({ width: 1400, height: 900 });
  const info = await page.evaluate(() => ({
    authFailed: window.__gbmMapsAuthFailed,
    outline: Boolean(window.__gbm.mapView.outline?.getMap()),
    vertices: window.__gbm.mapView.outline?.getPath().getLength(),
    center: window.__gbm.mapView.map.getCenter().toJSON(),
    zoom: window.__gbm.mapView.map.getZoom(),
    contains: window.__gbm.mapView.map.getBounds().contains(window.__gbm.mapView.boundaryBounds.getNorthEast()) && window.__gbm.mapView.map.getBounds().contains(window.__gbm.mapView.boundaryBounds.getSouthWest()),
  }));
  check('Maps JavaScript API loads and authorises the browser key', !info.authFailed);
  check('Official boundary drawn on the map', info.outline && info.vertices > 6000, `${info.vertices} vertices`);
  check('Initial view fits the electorate', info.contains, `centre ${info.center.lat.toFixed(4)},${info.center.lng.toFixed(4)} zoom ${info.zoom}`);
  await page.screenshot({ path: `${OUT}/01-desktop-initial.png` });

  if (LIVE) {
    // Area search: Automotive, all types (one request per type).
    await page.selectOption('#category', 'automotive');
    await page.click('#btn-area');
    await waitIdle(page);
    let a = await markerListAgreement(page);
    check('Area search returns live results', a.list > 0, `${a.list} listed, ${a.markers} markers`);
    check('Markers and sidebar agree (area search)', a.same, `${a.markers} markers vs ${a.list} list items`);
    check('No duplicate place IDs in session results', a.uniqueIds);
    const summary1 = await page.textContent('#search-summary');
    check('Search summary reports requests', /Google requests: \d+ Text Search/.test(summary1), summary1.replace(/\s+/g, ' ').slice(0, 160));
    await page.screenshot({ path: `${OUT}/02-desktop-area-search.png` });

    // Google electorate check for those results.
    await page.click('[data-act="area-check"]');
    await waitIdle(page);
    const statuses = await page.evaluate(() => {
      const c = {};
      for (const p of window.__gbm.results.values()) c[p.membership.status] = (c[p.membership.status] || 0) + 1;
      return c;
    });
    check('Electorate check classifies results by place ID', (statuses.confirmed || 0) > 0, JSON.stringify(statuses));
    a = await markerListAgreement(page);
    check('Markers and sidebar agree after re-classification', a.same, `${a.markers}/${a.list}`);
    await page.screenshot({ path: `${OUT}/03-desktop-area-check.png` });

    // Status filter: hide "Likely outside" → markers and list both shrink.
    await page.click('.chip[data-status="outside_google"]');
    await page.waitForTimeout(400);
    const f = await markerListAgreement(page);
    check('Status filter applies to map and list together', f.same && f.list <= a.list, `${f.list} after filtering (was ${a.list})`);
    await page.click('.chip[data-status="outside_google"]');

    // Open a confirmed business: details + selection sync.
    const id = await page.evaluate(() => {
      const all = [...window.__gbm.results.values()].filter((p) => p.location && !p.serviceAreaOnly);
      return (all.find((p) => p.membership.status === 'confirmed') || all[0])?.id;
    });
    await page.click(`#result-list .result[data-id="${id}"]`);
    await page.waitForFunction((pid) => window.__gbm.detailsLoaded.has(pid) || window.__gbm.detailsError.has(pid), id, { timeout: 30000 });
    await page.waitForTimeout(800);
    const d = await page.evaluate((pid) => ({
      panel: !document.querySelector('#details').hidden,
      name: document.querySelector('.d-head h2')?.textContent,
      fields: [...document.querySelectorAll('.d-fields dt')].map((x) => x.textContent),
      selectedMarker: window.__gbm.mapView.markers.get(pid)?.el.classList.contains('selected'),
      selectedItem: document.querySelector('#result-list .result.selected')?.dataset.id === pid,
      attribution: Boolean(document.querySelector('.d-attrib .gmp-attribution')),
    }), id);
    check('Details panel shows name, address, phone, website, hours and Maps link', d.panel && ['Address', 'Phone', 'Website', 'Hours', 'Google Maps'].every((x) => d.fields.includes(x)), d.name);
    check('List selection and marker selection are synchronised', d.selectedMarker && d.selectedItem);
    check('Google Maps attribution shown with Places content', d.attribution);
    await page.screenshot({ path: `${OUT}/04-desktop-details.png` });

    // Manual review round trip (then cleared).
    await page.click('.seg label:has(input[value="unsure"])');
    await page.click('.review-form button[type="submit"]');
    await page.waitForFunction((pid) => window.__gbm.results.get(pid).membership.status === 'reviewed_unsure', id, { timeout: 10000 });
    check('Manual review saves and overrides status', true);
    await page.click('.review-form [data-act="clear"]');
    await page.waitForFunction((pid) => !window.__gbm.results.get(pid).membership.status.startsWith('reviewed_'), id, { timeout: 10000 });
    check('Clearing a review restores Google’s status', true);
    await page.click('.d-close');

    // Electorate sweep for Automotive.
    await page.click('#btn-sweep');
    await page.waitForSelector('#sweep-dialog[open]');
    await page.screenshot({ path: `${OUT}/05-desktop-sweep-dialog.png` });
    await page.click('#sweep-run');
    await waitIdle(page);
    const sweep = await page.evaluate(() => {
      const s = window.__gbm.searches.at(-1);
      return { kind: s.meta.kind, results: s.ids.length, dups: s.meta.duplicatesMerged, agg: s.aggregate, gaps: s.gapIds?.length, ts: s.meta.textSearchRequests };
    });
    check('Electorate sweep completes', sweep.kind === 'sweep' && sweep.results > 0, JSON.stringify(sweep));
    a = await markerListAgreement(page);
    check('Markers and sidebar agree (after sweep, all searches)', a.same && a.uniqueIds, `${a.markers}/${a.list}`);
    await page.selectOption('#filter-scope', 'latest');
    await page.waitForTimeout(400);
    a = await markerListAgreement(page);
    check('“Latest search only” scope applies to map and list', a.same, `${a.list} in latest search`);
    await page.selectOption('#filter-scope', 'all');
    await page.screenshot({ path: `${OUT}/06-desktop-sweep.png` });

    // Gap fill: load places Google lists inside the electorate that Text Search did not return.
    if (sweep.gaps > 0) {
      page.once('dialog', (dlg) => dlg.accept()); // cost confirmation
      await page.click('[data-act="gap"]');
      await waitIdle(page);
      const gap = await page.evaluate(() => {
        const s = window.__gbm.searches.at(-1);
        const ps = s.ids.map((id) => window.__gbm.results.get(id));
        return { kind: s.meta.kind, n: ps.length, allConfirmed: ps.every((p) => p.membership.status === 'confirmed') };
      });
      check('Gap fill loads Google-confirmed places missed by search', gap.kind === 'gap' && gap.n > 0 && gap.allConfirmed, JSON.stringify(gap));
      a = await markerListAgreement(page);
      check('Markers and sidebar agree after gap fill', a.same && a.uniqueIds, `${a.markers}/${a.list}`);
    }

    await page.click('#tab-btn-coverage');
    await page.waitForSelector('.cov .stat');
    await page.screenshot({ path: `${OUT}/07-desktop-coverage.png` });
    check('Coverage tab renders accumulated and session measures', (await page.textContent('#coverage')).includes('Accumulated coverage'));
  }
  check('No console errors (desktop)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

// ---------- mobile ----------
{
  const { page, errors } = await openPage({ width: 390, height: 844 });
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    mapHeight: document.querySelector('.map-wrap').getBoundingClientRect().height,
    sidebarTop: document.querySelector('.sidebar').getBoundingClientRect().top,
  }));
  check('Mobile: no horizontal scroll', layout.overflow <= 0, `overflow ${layout.overflow}px`);
  check('Mobile: map stacked above the list', layout.mapHeight > 250 && layout.sidebarTop >= layout.mapHeight, `map ${Math.round(layout.mapHeight)}px`);
  await page.screenshot({ path: `${OUT}/08-mobile-initial.png`, fullPage: true });
  if (LIVE) {
    await page.selectOption('#category', 'health');
    await page.selectOption('#subtype', 'pharmacy');
    await page.click('#btn-area');
    await waitIdle(page);
    const a = await markerListAgreement(page);
    const toastText = await page.evaluate(() => (document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').innerText));
    check('Mobile: single-type search works and markers match list', a.list > 0 && a.same, `${a.list} pharmacies ${toastText}`);
    if (!a.list) throw new Error('mobile search returned nothing');
    await page.screenshot({ path: `${OUT}/09-mobile-results.png`, fullPage: true });
    await page.click('#result-list .result >> nth=0');
    await page.waitForTimeout(2500);
    const panel = await page.evaluate(() => {
      const r = document.querySelector('#details').getBoundingClientRect();
      return { w: r.width, h: r.height, overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    check('Mobile: details open full-screen without overflow', panel.w >= 389 && panel.overflow <= 0, `${panel.w}×${panel.h}`);
    await page.screenshot({ path: `${OUT}/10-mobile-details.png` });
  }
  check('No console errors (mobile)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${LIVE ? ' (live)' : ' (no Places requests made)'}. Screenshots in ${OUT}/`);
process.exit(failed.length ? 1 : 0);
