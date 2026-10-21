import { api, ApiError } from './api.js';
import { loadGoogleMaps } from './maps-loader.js';
import { MapView } from './map-view.js';
import { renderDetails } from './details.js';
import { renderCoverage } from './coverage.js';
import {
  STATUS_INFO, MAP_STATUSES, escapeHtml, fmtDate, usd, baseStatus, reviewedStatus,
  GOOGLE_MAPS_ATTRIBUTION, RANKING_EXPLAINER,
} from './util.js';

const $ = (sel) => document.querySelector(sel);
const LIST_PAGE = 300;

const state = {
  cfg: null,
  categories: [],
  results: new Map(), // place id -> place (live Google data held in memory for this page only)
  searches: [],
  latestSearchId: null,
  selectedId: null,
  detailsLoaded: new Set(),
  detailsError: new Map(),
  liveCounts: {}, // categoryId -> Places Aggregate summary from this session (never stored)
  filters: { text: '', scope: 'all', category: '', statuses: new Set(MAP_STATUSES), inView: false, closed: false },
  listLimit: LIST_PAGE,
  tab: 'results',
  busy: false,
  coverage: null,
  usage: null,
  mapView: null,
};
let searchSeq = 0;

// ---------------- boot ----------------

init().catch((err) => showError(err));

async function init() {
  wireStaticUi();
  try {
    state.cfg = await api.config();
  } catch (err) {
    $('#map-loading').textContent = 'Cannot start: the app server is unreachable.';
    throw err;
  }
  const cfg = state.cfg;
  if (cfg.mode === 'development') window.__gbm = state; // read-only hook for scripts/verify-ui.mjs
  state.categories = cfg.categories;
  populateCategories();
  renderChips();
  renderLegend();
  renderAbout();
  $('#boundary-badge').textContent = `${cfg.boundary.official.district_label} · ${cfg.boundary.official.region_label} · official VEC boundary`;

  if (!cfg.places.configured) {
    banner('error', 'Business search is not configured', 'The server has no Places credential. Set GOOGLE_PLACES_SERVER_KEY (see README → “Google Cloud setup”) and restart the server. The map and boundary still work.');
  } else if (cfg.places.developmentFallback) {
    banner('warn', 'Development mode', 'Places requests are using the browser Maps key as a server fallback. Before deploying, create a separate server key and add website restrictions to the browser key (README → “Google Cloud setup”).', true);
  }
  updateButtons();
  refreshUsage();
  render();

  if (!cfg.maps.browserKey) {
    $('#map-loading').textContent = 'Map unavailable: GOOGLE_MAPS_BROWSER_KEY is not set on the server.';
    return;
  }
  window.addEventListener('gbm:maps-auth-failure', () => {
    $('#map-loading').hidden = false;
    $('#map-loading').textContent = 'Google Maps rejected the browser key.';
    banner('error', 'Google Maps could not authorise this page',
      `Check that Maps JavaScript API is enabled for the key’s project, billing is active, and the key’s website restrictions include ${location.origin}/*.`);
  });
  let lib;
  try {
    [lib] = await Promise.all([loadGoogleMaps({ key: cfg.maps.browserKey })]);
  } catch (err) {
    $('#map-loading').textContent = 'Google Maps failed to load.';
    throw new ApiError({ kind: 'connection', code: 'MAPS_LOAD_FAILED', message: err.message });
  }
  state.mapView = new MapView($('#map'), lib, {
    mapId: cfg.maps.mapId,
    onSelect: (id, source) => openDetails(id, source),
    onHover: (id, on) => document.querySelector(`.result[data-id="${CSS.escape(id)}"]`)?.classList.toggle('hover', on),
    onUserMove: (moved) => {
      $('#btn-search-here').hidden = !(moved && cfg.places.configured && !state.busy);
      if (state.filters.inView) renderList();
    },
  });
  const boundary = await api.boundary();
  state.mapView.drawBoundary(boundary);
  if (!window.__gbmMapsAuthFailed) $('#map-loading').hidden = true;
  render();
}

function wireStaticUi() {
  $('#category').addEventListener('change', () => {
    populateSubtypes();
    updateCostHint();
  });
  $('#subtype').addEventListener('change', updateCostHint);
  $('#btn-area').addEventListener('click', () => searchArea());
  $('#btn-search-here').addEventListener('click', () => searchArea());
  $('#btn-sweep').addEventListener('click', openSweepDialog);
  $('#free-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#free-q').value.trim();
    if (q) searchArea({ query: q });
  });
  let t;
  $('#filter-text').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.filters.text = e.target.value.trim().toLowerCase();
      state.listLimit = LIST_PAGE;
      render();
    }, 120);
  });
  $('#filter-scope').addEventListener('change', (e) => {
    state.filters.scope = e.target.value;
    render();
  });
  $('#filter-category').addEventListener('change', (e) => {
    state.filters.category = e.target.value;
    render();
  });
  $('#filter-inview').addEventListener('change', (e) => {
    state.filters.inView = e.target.checked;
    renderList();
  });
  document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => selectTab(btn.id.replace('tab-btn-', ''))));
  $('#btn-about').addEventListener('click', () => $('#about-dialog').showModal());
  $('#about-close').addEventListener('click', () => $('#about-dialog').close());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#details').hidden && !document.querySelector('dialog[open]')) closeDetails();
  });
}

// ---------------- searches ----------------

function selectedCategory() {
  return state.categories.find((c) => c.id === $('#category').value);
}

async function searchArea({ query, type, pageToken, label } = {}) {
  if (state.busy || !state.mapView) return;
  const box = state.mapView.viewportBox();
  if (!box) return;
  const category = selectedCategory();
  const subtype = type ?? $('#subtype').value;
  const body = query ? { query, box, pageToken } : { categoryId: category.id, type: subtype || undefined, box, pageToken };
  setBusy(true, query ? `Searching Google for “${query}”…` : `Searching Google for ${label || (subtype ? category.types.find((t) => t.type === subtype)?.label : category.label)}…`);
  try {
    const res = await api.searchArea(body);
    addSearch(res.places, res.meta);
    $('#btn-search-here').hidden = true;
    if (state.mapView) state.mapView.userMoved = false;
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
    refreshUsage();
  }
}

function addSearch(places, meta, extra = {}) {
  const id = `s${++searchSeq}`;
  for (const p of places) {
    const prev = state.results.get(p.id);
    const searches = new Set(prev?.searches || []);
    searches.add(id);
    // Spread order keeps phone/website/hours already loaded for this place.
    state.results.set(p.id, { ...(prev || {}), ...p, searches });
  }
  const search = { id, meta, at: new Date(), ids: places.map((p) => p.id), ...extra };
  state.searches.push(search);
  state.latestSearchId = id;
  if (extra.aggregate && !extra.aggregate.error) state.liveCounts[meta.categoryId] = extra.aggregate;
  state.listLimit = LIST_PAGE;
  selectTab('results');
  render();
  if (!places.length) toast(`Google returned no businesses for ${meta.label} in this area.`);
}

async function openSweepDialog() {
  if (state.busy) return;
  const category = selectedCategory();
  let plan;
  let usage;
  try {
    [plan, usage] = await Promise.all([api.sweepPlan(category.id), api.usage()]);
  } catch (err) {
    showError(err);
    return;
  }
  const p = state.cfg.prices;
  const left = (g) => usage.limits[g].limit - usage.limits[g].used;
  $('#sweep-plan').innerHTML = `
    <p>Searches every <strong>${escapeHtml(category.label)}</strong> business type across the electorate, then asks Google which results lie inside the official boundary.</p>
    <table class="plan-table">
      <thead><tr><th>Google requests</th><th>Expected</th><th>If beyond free tier</th></tr></thead>
      <tbody>
        <tr><td>Text Search Pro (${category.types.length} types${category.queries.length ? ` + ${category.queries.length} keyword searches` : ''})</td><td>${plan.textSearch.min}–${plan.textSearch.max}</td><td>≤ ${usd((plan.textSearch.max / 1000) * p.textSearchPro.usdPer1000)}</td></tr>
        <tr><td>Places Aggregate (electorate check)</td><td>${plan.aggregate.min}–${plan.aggregate.max}</td><td>≤ ${usd((plan.aggregate.max / 1000) * p.aggregate.usdPer1000)}</td></tr>
      </tbody>
    </table>
    <p class="hint">Google’s monthly free usage covers ${p.textSearchPro.freePerMonth.toLocaleString()} Text Search Pro and ${p.aggregate.freePerMonth.toLocaleString()} Aggregate requests per billing account, so a sweep is usually free. Remaining today under this app’s own limits: ${left('textSearch')} Text Search, ${left('aggregate')} Aggregate.</p>
    <p class="hint">Results are not stored except as place IDs; re-running a sweep repeats these requests.</p>`;
  const dlg = $('#sweep-dialog');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => { if (dlg.returnValue === 'run') runSweep(category); }, { once: true });
}

async function runSweep(category) {
  setBusy(true, `Sweeping ${category.label} across Greenvale District…`);
  try {
    let job = await api.startSweep(category.id);
    while (job.status === 'running') {
      await new Promise((r) => setTimeout(r, 1500));
      job = await api.sweep(job.id);
      setBusy(true, `Sweeping ${category.label} — ${job.progress.phase}: ${job.progress.textSearchRequests} Text Search, ${job.progress.aggregateRequests} Aggregate requests so far…`);
    }
    if (job.status === 'failed') throw new ApiError(job.error);
    const r = job.result;
    addSearch(r.places, r.meta, { aggregate: r.aggregate, gapIds: r.gapIds });
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
    refreshUsage();
    if (state.tab === 'coverage') loadCoverage();
  }
}

async function runAreaCheck(categoryId) {
  const category = state.categories.find((c) => c.id === categoryId);
  const latest = currentSearch();
  const places = (latest?.ids || []).map((id) => state.results.get(id)).filter(Boolean)
    .map(({ id, types, primaryType, businessStatus, serviceAreaOnly }) => ({ id, types, primaryType, businessStatus, serviceAreaOnly }));
  setBusy(true, `Asking Google which ${category.label} businesses are inside Greenvale District…`);
  try {
    const res = await api.areaCheck(categoryId, places);
    for (const [id, membership] of Object.entries(res.memberships)) {
      const p = state.results.get(id);
      if (p) p.membership = membership;
    }
    state.liveCounts[categoryId] = res.aggregate;
    latest.aggregate = res.aggregate;
    latest.gapIds = res.gapIds;
    latest.meta.notes = [...(latest.meta.notes || []), ...res.notes];
    render();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
    refreshUsage();
  }
}

async function runGapFill(search) {
  const ids = search.gapIds.slice(0, state.cfg.limits.gapFillMax);
  const price = state.cfg.prices.detailsPro;
  const ok = window.confirm(
    `Load ${ids.length} place${ids.length === 1 ? '' : 's'} that Google lists inside Greenvale District?\n\n` +
      `This makes ${ids.length} Place Details (Pro) request${ids.length === 1 ? '' : 's'}: free within ${price.freePerMonth.toLocaleString()} per month, ` +
      `then about ${usd((ids.length / 1000) * price.usdPer1000)} for this batch. Details are shown, not stored.`,
  );
  if (!ok) return;
  setBusy(true, `Loading ${ids.length} places Google lists inside the electorate…`);
  try {
    const res = await api.gapFill(ids);
    search.gapIds = search.gapIds.filter((id) => !ids.includes(id));
    addSearch(res.places, { kind: 'gap', label: `Electorate-check places not returned by search (${res.fetched})`, categoryId: search.meta.categoryId, textSearchRequests: 0, detailsRequests: res.fetched });
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
    refreshUsage();
  }
}

// ---------------- details & review ----------------

async function openDetails(id, source = 'list') {
  let p = state.results.get(id);
  state.selectedId = id;
  $('#details').hidden = false;
  if (!p) {
    // A stored place ID from the review queue: details must be fetched live.
    p = { id, name: null, types: [], membership: { status: 'unverified', googleAreaCheck: null, review: null }, searches: new Set(['review']) };
  }
  drawDetails(p, !state.detailsLoaded.has(id));
  renderList();
  syncMarkers();
  if (source === 'map') document.querySelector(`.result[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  else state.mapView?.focus(p);
  if (state.detailsLoaded.has(id)) return;
  try {
    const d = await api.details(id);
    state.detailsLoaded.add(id);
    state.detailsError.delete(id);
    const prev = state.results.get(id);
    state.results.set(id, { ...(prev || p), ...d, searches: prev?.searches || p.searches });
    if (!prev && source !== 'map') state.mapView?.focus(d);
  } catch (err) {
    state.detailsError.set(id, err);
    if (err.kind === 'quota' || err.kind === 'config') showError(err);
  } finally {
    refreshUsage();
    if (state.selectedId === id) {
      drawDetails(state.results.get(id) || p, false);
      render();
    }
  }
}

function drawDetails(p, loading) {
  renderDetails($('#details-inner'), p, {
    loading,
    error: state.detailsError.get(p.id),
    categoryLabel: (cid) => state.categories.find((c) => c.id === cid)?.label,
    onClose: closeDetails,
    onRetry: () => {
      state.detailsError.delete(p.id);
      openDetails(p.id, 'details');
    },
    onSaveReview: (review) => saveReview(p.id, review),
    onClearReview: () => clearReview(p.id),
  });
}

function closeDetails() {
  $('#details').hidden = true;
  state.selectedId = null;
  renderList();
  syncMarkers();
}

async function saveReview(id, review) {
  try {
    const saved = await api.saveReview(id, review);
    const p = state.results.get(id);
    if (p) {
      p.membership = { ...p.membership, review: saved, status: reviewedStatus(saved.decision) };
      drawDetails(p, false);
    }
    toast('Review saved.');
    render();
  } catch (err) {
    showError(err);
  }
}

async function clearReview(id) {
  try {
    await api.deleteReview(id);
    const p = state.results.get(id);
    if (p) {
      p.membership = { ...p.membership, review: null };
      p.membership.status = baseStatus(p);
      drawDetails(p, false);
    }
    toast('Review cleared.');
    render();
  } catch (err) {
    showError(err);
  }
}

// ---------------- rendering ----------------

function currentSearch() {
  return state.searches.find((s) => s.id === state.latestSearchId) || null;
}

function premisesPlaces() {
  const out = [];
  // Includes places opened from the stored review queue, so reviewers can see their markers.
  for (const p of state.results.values()) if (!p.serviceAreaOnly && p.searches) out.push(p);
  return out;
}

function filteredPlaces({ forList = false } = {}) {
  const f = state.filters;
  return premisesPlaces()
    .filter((p) => {
      if (f.scope === 'latest' && !p.searches.has(state.latestSearchId)) return false;
      if (f.category && p.category !== f.category) return false;
      if (!f.statuses.has(p.membership.status)) return false;
      if (!f.closed && p.businessStatus === 'CLOSED_PERMANENTLY') return false;
      if (f.text) {
        const hay = `${p.name || ''} ${p.address || ''} ${p.primaryTypeLabel || ''}`.toLowerCase();
        if (!hay.includes(f.text)) return false;
      }
      if (forList && f.inView && state.mapView && !state.mapView.inViewport(p)) return false;
      return true;
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function render() {
  renderSummary();
  renderList();
  renderServiceArea();
  renderReviewQueue();
  syncMarkers();
  if (state.tab === 'coverage') drawCoverage();
}

function syncMarkers() {
  state.mapView?.setPlaces(filteredPlaces(), state.selectedId);
}

function renderSummary() {
  const el = $('#search-summary');
  const s = currentSearch();
  const total = premisesPlaces().length;
  if (!s) {
    el.innerHTML = '';
    return;
  }
  const m = s.meta;
  const inThis = s.ids.map((id) => state.results.get(id)).filter(Boolean);
  const counts = {};
  inThis.forEach((p) => (counts[p.membership.status] = (counts[p.membership.status] || 0) + 1));
  const countText = Object.entries(counts)
    .sort((a, b) => STATUS_INFO[a[0]].order - STATUS_INFO[b[0]].order)
    .map(([st, n]) => `${n} ${STATUS_INFO[st].short.toLowerCase()}`)
    .join(' · ');
  const requests = [
    m.textSearchRequests ? `${m.textSearchRequests} Text Search` : '',
    m.aggregateRequests ? `${m.aggregateRequests} Aggregate` : '',
    m.detailsRequests ? `${m.detailsRequests} Place Details` : '',
  ].filter(Boolean).join(', ');
  const actions = [];
  const notes = [...(m.notes || [])];
  if (m.kind === 'area' && m.categoryId && !s.aggregate) {
    actions.push(`<button class="btn small" data-act="area-check">Check these against the electorate boundary (Google)</button>`);
  }
  if (m.moreAvailable?.length) {
    if (m.moreAvailable.length === 1) {
      const more = m.moreAvailable[0];
      actions.push(`<button class="btn small" data-act="more">Load more “${escapeHtml(more.label)}” (1 request)</button>`);
    } else {
      notes.push(`Google has more results for ${m.moreAvailable.length} types (${m.moreAvailable.slice(0, 4).map((x) => escapeHtml(x.label)).join(', ')}${m.moreAvailable.length > 4 ? '…' : ''}). Zoom in, pick a single type, or sweep the electorate.`);
    }
  }
  if (s.aggregate?.error) notes.push(`Electorate check unavailable: ${escapeHtml(s.aggregate.error.message)}`);
  else if (s.aggregate) {
    const a = s.aggregate;
    const cat = state.categories.find((c) => c.id === a.categoryId)?.label || '';
    notes.push(`Google’s electorate check: ${a.googleCount ?? '?'} operating ${escapeHtml(cat)} places inside Greenvale District (live count, not stored)${a.complete ? '' : ' — check incomplete, so unmatched results stay “Needs review”'}.`);
  }
  if (s.gapIds?.length) {
    const n = Math.min(s.gapIds.length, state.cfg.limits.gapFillMax);
    actions.push(`<button class="btn small" data-act="gap">Load ${n} of ${s.gapIds.length} places Google lists inside but search didn’t return (${n} Place Details requests)</button>`);
  }
  el.innerHTML = `
    <div><span class="sum-title">Latest: ${escapeHtml(m.label)}</span> — ${inThis.length} result${inThis.length === 1 ? '' : 's'}${requests ? ` · Google requests: ${requests}` : ''}${m.duplicatesMerged ? ` · ${m.duplicatesMerged} duplicate listing${m.duplicatesMerged === 1 ? '' : 's'} merged by place ID` : ''}</div>
    ${countText ? `<div>${countText}</div>` : ''}
    <div class="note">Session total on map: ${total} business${total === 1 ? '' : 'es'} from ${state.searches.length} search${state.searches.length === 1 ? '' : 'es'}. See Coverage for accumulated figures.</div>
    ${notes.map((n) => `<p class="note">${n}</p>`).join('')}
    ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}`;
  el.querySelector('[data-act="area-check"]')?.addEventListener('click', () => runAreaCheck(m.categoryId));
  el.querySelector('[data-act="gap"]')?.addEventListener('click', () => runGapFill(s));
  el.querySelector('[data-act="more"]')?.addEventListener('click', () => {
    const more = m.moreAvailable[0];
    m.moreAvailable = [];
    if (more.query) searchArea({ query: more.query, pageToken: more.nextPageToken });
    else searchArea({ type: more.type, pageToken: more.nextPageToken, label: more.label });
  });
}

function resultItem(p) {
  const st = p.membership.status;
  const meta = [p.primaryTypeLabel, p.shortAddress || p.address].filter(Boolean).map(escapeHtml).join(' · ');
  return `<li><button type="button" class="result${p.id === state.selectedId ? ' selected' : ''}" data-id="${escapeHtml(p.id)}">
      <span class="dot s-${st}" aria-hidden="true"></span>
      <span>
        <div class="r-name">${p.name ? escapeHtml(p.name) : '<em>Unnamed listing</em>'}</div>
        <div class="r-meta">${meta || '&nbsp;'}</div>
        ${p.businessStatus && p.businessStatus !== 'OPERATIONAL' ? `<div class="r-closed">${p.businessStatus === 'CLOSED_TEMPORARILY' ? 'Temporarily closed' : 'Permanently closed'}</div>` : ''}
      </span>
      <span class="r-status">${STATUS_INFO[st].short}</span>
    </button></li>`;
}

function bindList(listEl) {
  listEl.querySelectorAll('.result').forEach((btn) => {
    const id = btn.dataset.id;
    btn.addEventListener('click', () => openDetails(id, 'list'));
    btn.addEventListener('mouseenter', () => state.mapView?.highlight(id, true));
    btn.addEventListener('mouseleave', () => state.mapView?.highlight(id, false));
  });
}

function renderList() {
  const list = $('#result-list');
  const footer = $('#list-footer');
  const all = premisesPlaces();
  const items = filteredPlaces({ forList: true });
  state.listedIds = items.map((p) => p.id); // full filtered list (the DOM shows it in pages)
  $('#count-results').textContent = all.length;
  if (state.busy && !all.length) {
    list.innerHTML = `<li class="loading-row"><span class="spinner"></span>${escapeHtml(state.busyText || 'Loading…')}</li>`;
    footer.innerHTML = '';
    return;
  }
  if (!all.length) {
    list.innerHTML = state.searches.length
      ? '<li class="empty"><strong>No businesses with premises found yet</strong>Google returned nothing for the searches so far. Try another category, zoom out, or sweep the electorate.</li>'
      : '<li class="empty"><strong>Nothing loaded yet</strong>Choose a category and search the map area, or sweep the whole electorate. Results come live from Google each time; nothing is preloaded or stored.</li>';
    footer.innerHTML = '';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<li class="empty"><strong>No results match these filters</strong>Clear the text filter, enable more statuses, or untick “only list what is visible”.</li>';
    footer.innerHTML = '';
    return;
  }
  list.innerHTML = items.slice(0, state.listLimit).map(resultItem).join('');
  bindList(list);
  footer.innerHTML = `
    ${items.length > state.listLimit ? `<button class="btn small" id="more-list">Show ${Math.min(LIST_PAGE, items.length - state.listLimit)} more of ${items.length - state.listLimit}</button>` : ''}
    <p>${items.length} shown of ${all.length} in this session. ${escapeHtml(RANKING_EXPLAINER)} This is not a complete register of businesses.</p>
    <div class="attr-row">${GOOGLE_MAPS_ATTRIBUTION}</div>
    <label class="check"><input type="checkbox" id="filter-closed" ${state.filters.closed ? 'checked' : ''}> Include permanently closed listings</label>`;
  footer.querySelector('#more-list')?.addEventListener('click', () => {
    state.listLimit += LIST_PAGE;
    renderList();
  });
  footer.querySelector('#filter-closed').addEventListener('change', (e) => {
    state.filters.closed = e.target.checked;
    render();
  });
}

function renderServiceArea() {
  const list = $('#sab-list');
  const items = [...state.results.values()].filter((p) => p.serviceAreaOnly).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  $('#count-sab').textContent = items.length;
  list.innerHTML = items.length
    ? items.map(resultItem).join('') + `<li class="attr-row">${GOOGLE_MAPS_ATTRIBUTION}</li>`
    : '<li class="empty"><strong>None found yet</strong>Trades searches include service-area businesses; they appear here rather than on the map.</li>';
  bindList(list);
}

function renderReviewQueue() {
  const list = $('#review-list');
  const session = premisesPlaces().filter((p) => p.membership.status === 'unverified').sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const sessionIds = new Set(session.map((p) => p.id));
  const stored = (state.coverage?.needsReview || []).filter((r) => !sessionIds.has(r.id) && !state.results.get(r.id)?.membership?.review);
  $('#count-review').textContent = session.length + stored.length;
  const storedHtml = stored.slice(0, 100).map((r) => `<li><button type="button" class="result" data-id="${escapeHtml(r.id)}">
      <span class="dot s-unverified" aria-hidden="true"></span>
      <span><div class="r-name">Stored place ${escapeHtml(r.id.slice(0, 10))}…</div>
      <div class="r-meta">Found ${fmtDate(r.lastSeenAt)} · ${escapeHtml((r.categories || []).map((c) => state.categories.find((x) => x.id === c)?.label || c).join(', ') || 'uncategorised')} · opening loads details (1 request)</div></span>
      <span class="r-status">Needs review</span></button></li>`).join('');
  list.innerHTML = session.length || stored.length
    ? session.map(resultItem).join('') + storedHtml
    : '<li class="empty"><strong>Nothing to review</strong>Every place found so far has a Google electorate verdict or a human review.</li>';
  bindList(list);
  $('#review-footer').innerHTML = stored.length
    ? `<p>${stored.length} stored place IDs from earlier sessions also need review${stored.length > 100 ? ' (first 100 shown)' : ''}. Names are not stored, so each is loaded from Google when opened.</p>`
    : '';
}

async function loadCoverage() {
  try {
    const [coverage, usage] = await Promise.all([api.coverage(), api.usage()]);
    state.coverage = coverage;
    state.usage = usage;
    state.coverageError = null;
  } catch (err) {
    state.coverageError = err;
  }
  drawCoverage();
  renderReviewQueue();
}

function drawCoverage() {
  const places = premisesPlaces();
  renderCoverage($('#coverage'), {
    coverage: state.coverage,
    usage: state.usage,
    error: state.coverageError,
    categories: state.categories,
    session: {
      resultCount: places.length,
      searchCount: state.searches.length,
      confirmedCount: places.filter((p) => p.membership.status === 'confirmed').length,
      liveCounts: state.liveCounts,
      maxAgeDays: state.cfg?.membershipMaxAgeDays,
      storage: state.cfg?.storage || { backend: '?', note: '' },
    },
    onImport: async (data) => {
      if (!data) return toast('That file is not valid JSON.', true);
      try {
        const res = await api.importReviews(data);
        toast(`Imported ${res.imported} review${res.imported === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped}` : ''}.`);
        loadCoverage();
      } catch (err) {
        showError(err);
      }
    },
  });
}

function selectTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.id === `tab-btn-${tab}`)));
  document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
  if (tab === 'coverage' || tab === 'review') loadCoverage();
}

function populateCategories() {
  $('#category').innerHTML = state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('');
  $('#filter-category').innerHTML = '<option value="">All categories</option>' + state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('');
  populateSubtypes();
  updateCostHint();
}

function populateSubtypes() {
  const c = selectedCategory();
  $('#subtype').innerHTML = `<option value="">All types (${c.types.length})</option>` + c.types.map((t) => `<option value="${t.type}">${escapeHtml(t.label)}</option>`).join('');
}

function updateCostHint() {
  const c = selectedCategory();
  if (!c) return;
  const n = $('#subtype').value ? 1 : c.types.length + c.queries.length;
  $('#cost-hint').textContent = `“Search map area” uses ${n} Text Search request${n === 1 ? '' : 's'} (first page of up to 20 results per type) and only runs when you click.`;
}

function renderChips() {
  const el = $('#status-chips');
  el.innerHTML = MAP_STATUSES.map((s) => `<button type="button" class="chip" data-status="${s}" aria-pressed="true"><span class="dot s-${s}"></span>${STATUS_INFO[s].short}</button>`).join('');
  el.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const s = chip.dataset.status;
      const set = state.filters.statuses;
      set.has(s) ? set.delete(s) : set.add(s);
      chip.setAttribute('aria-pressed', String(set.has(s)));
      render();
    }),
  );
}

function renderLegend() {
  const open = window.matchMedia('(min-width: 861px)').matches ? 'open' : '';
  $('#legend').innerHTML = `<details ${open}><summary>Legend</summary>
    <div class="lg-row"><span class="line"></span>Greenvale District (official)</div>
    ${MAP_STATUSES.map((s) => `<div class="lg-row"><span class="dot s-${s}"></span>${STATUS_INFO[s].label}</div>`).join('')}
  </details>`;
}

function renderAbout() {
  const b = state.cfg.boundary.provenance;
  $('#about-content').innerHTML = `
    <h3>Map area</h3>
    <p><strong>${escapeHtml(b.name)}</strong> — ${escapeHtml(b.kind)} (${escapeHtml(state.cfg.boundary.official.region_label)}). Not the Greenvale suburb, postcode 3059, the City of Hume, or a federal division.</p>
    <ul>
      <li>Source: <a href="${escapeHtml(b.source.datavic)}" target="_blank" rel="noopener">${escapeHtml(b.source.dataset)}</a>, published by the ${escapeHtml(b.source.publisher)}. ${escapeHtml(b.source.attribution)}.</li>
      <li>Effective from <strong>${fmtDate(b.effective.effectiveFrom)}</strong> (${escapeHtml(b.effective.redivision)}). The Electoral Boundaries Commission says these boundaries stay in place until the writ for the 2030 State election is issued, unless a redivision is triggered sooner.</li>
      <li>Area ${b.geometry.geodesicAreaKm2} km² (VEC publishes ${b.geometry.vecPublishedAreaKm2} km²); ${b.geometry.vertices.toLocaleString()} boundary vertices; retrieved ${fmtDate(b.retrievedAt)}.</li>
    </ul>
    <h3>How businesses are found</h3>
    <ul>
      <li>All business data comes live from Google Places API (New): Text Search, one request per Google business type, limited to a rectangle around the electorate. Text Search only accepts rectangles, so that rectangle is larger than the electorate.</li>
      <li>Google returns at most 60 results per query. Sweeps split the rectangle when that cap is hit, and repeated listings are merged by place ID.</li>
      <li><strong>Inside</strong> means Google’s Places Aggregate API returned the place ID for the official electorate polygon. This app never tests Google coordinates against the boundary itself: Google’s terms prohibit using Places coordinates for point-in-polygon analysis.</li>
      <li><strong>Likely outside</strong> means Google listed every place of that category inside the polygon and this one was not among them. <strong>Needs review</strong> means no complete check covers the place yet. Reviewers can record inside, outside or unsure, and their decision overrides the automatic status.</li>
      <li>Service-area businesses with no public premises are listed separately, without markers.</li>
    </ul>
    <h3>Coverage limitations</h3>
    <ul>
      <li>This is <strong>not a complete register</strong>. It only includes businesses that have a Google listing with one of the searched types, or that match a keyword search. Home-based businesses, unlisted businesses and businesses listed under unusual types will be missing.</li>
      <li>Google decides ranking and inclusion: ${escapeHtml(RANKING_EXPLAINER)}</li>
      <li>The electorate check counts places Google marks as operating or temporarily closed; permanently closed listings are excluded.</li>
      <li>Business details are shown live and never stored or exported. Only place IDs, Google’s inside/outside verdicts (re-checked after ${state.cfg.membershipMaxAgeDays} days) and your reviews are kept.</li>
    </ul>
    <h3>Costs</h3>
    <p>Each search runs only when you click. Text Search Pro costs ${usd(state.cfg.prices.textSearchPro.usdPer1000 / 1000)} per request after ${state.cfg.prices.textSearchPro.freePerMonth.toLocaleString()} free per month. Opening a business makes one Place Details Enterprise request (${usd(state.cfg.prices.detailsEnterprise.usdPer1000 / 1000)} after ${state.cfg.prices.detailsEnterprise.freePerMonth.toLocaleString()} free per month). Daily request limits are enforced by the server, and the Coverage tab shows usage.</p>
    <h3>Terms</h3>
    <p>Use of this app is subject to the <a href="https://cloud.google.com/maps-platform/terms" target="_blank" rel="noopener">Google Maps Platform Terms of Service</a>, <a href="https://maps.google.com/help/terms_maps/" target="_blank" rel="noopener">Google Maps/Google Earth Additional Terms of Service</a> and <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google Privacy Policy</a>. See also <a href="/legal">this app’s terms and privacy notice</a>.</p>`;
}

// ---------------- status UI ----------------

function setBusy(on, text) {
  state.busy = on;
  state.busyText = text;
  updateButtons();
  if (on) {
    toast(text, false, true);
    $('#btn-search-here').hidden = true;
  } else {
    hideToast();
  }
  if (!premisesPlaces().length) renderList();
}

function updateButtons() {
  const ok = Boolean(state.cfg?.places.configured) && !state.busy;
  ['#btn-area', '#btn-sweep', '#free-search button'].forEach((s) => ($(s).disabled = !ok));
}

let toastTimer;
function toast(text, isError = false, sticky = false) {
  const el = $('#toast');
  el.className = `toast${isError ? ' error' : ''}`;
  el.innerHTML = `${sticky ? '<span class="spinner" aria-hidden="true"></span>' : ''}<span>${escapeHtml(text)}</span>`;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(hideToast, isError ? 7000 : 3500);
}
function hideToast() {
  $('#toast').hidden = true;
}

function banner(kind, title, text, dismissible = true) {
  const el = $('#banner');
  el.className = `banner ${kind}`;
  el.innerHTML = `<div class="banner-text"><strong>${escapeHtml(title)}</strong>${escapeHtml(text)}</div>${dismissible ? '<button class="btn small" type="button">Dismiss</button>' : ''}`;
  el.hidden = false;
  el.querySelector('button')?.addEventListener('click', () => (el.hidden = true));
}

function showError(err) {
  console.warn(err);
  const e = err instanceof ApiError ? err : new ApiError({ message: err?.message || String(err) });
  const help = e.help ? ` ${e.help}` : '';
  if (e.kind === 'config') banner('error', 'Google configuration problem', `${e.message}${help}`);
  else if (e.kind === 'quota') banner('warn', e.code === 'LOCAL_DAILY_LIMIT' ? 'Daily request limit reached' : 'Google quota reached', `${e.message}${help}`);
  else if (e.kind === 'connection') banner('error', 'Connection problem', e.message);
  else if (e.kind === 'network') banner('error', 'Server could not reach Google', `${e.message}${help}`);
  else toast(e.message, true);
}

async function refreshUsage() {
  try {
    const u = await api.usage();
    state.usage = u;
    const l = u.limits;
    $('#usage-pill').textContent = `Today: ${l.textSearch.used} searches · ${l.details.used + l.gapFill.used} details · ${l.aggregate.used} area checks`;
    $('#usage-pill').title = `Google requests made by this app today (limits: ${l.textSearch.limit} Text Search, ${l.details.limit} opened details, ${l.gapFill.limit} electorate-check loads, ${l.aggregate.limit} Aggregate). Est. month-to-date cost ${usd(u.estMonthUsd)}.`;
  } catch {
    /* non-critical */
  }
}
