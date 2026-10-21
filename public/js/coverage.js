// Coverage tab: accumulated (stored place-ID) measures, live Google counts
// from this session, and request/cost usage.

import { escapeHtml, fmtDate, fmtDateTime, usd } from './util.js';

export function renderCoverage(el, { coverage, usage, session, categories, error, onImport }) {
  if (error) {
    el.innerHTML = `<div class="empty"><strong>Coverage unavailable</strong>${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!coverage) {
    el.innerHTML = '<div class="loading-row"><span class="spinner"></span>Loading coverage…</div>';
    return;
  }
  const t = coverage.totals;
  const live = session.liveCounts; // categoryId -> aggregate summary (this browser session only)
  const rows = categories
    .map((c) => {
      const s = coverage.byCategory[c.id] || {};
      const lc = live[c.id];
      const last = coverage.lastSweeps[c.id];
      return `<tr>
        <td>${escapeHtml(c.label)}</td>
        <td>${s.discovered ?? 0}</td>
        <td>${s.confirmed ?? 0}</td>
        <td>${lc ? (lc.googleCount ?? '—') : '<span title="Run an electorate check or sweep this session to see Google’s live count">·</span>'}</td>
        <td>${last ? fmtDate(last.finishedAt) : '—'}</td>
      </tr>`;
    })
    .join('');
  const skuRows = (usage?.skus || [])
    .map((s) => `<tr><td>${escapeHtml(s.label)}</td><td>${s.today}</td><td>${s.month}</td><td>${s.freePerMonth.toLocaleString()}</td><td>${usd(s.estUsd)}</td></tr>`)
    .join('');

  el.innerHTML = `
    <div class="cov">
      <h3>This session (in your browser only)</h3>
      <div class="stat-grid">
        <div class="stat"><div class="v">${session.resultCount}</div><div class="l">businesses on the map now, from ${session.searchCount} search${session.searchCount === 1 ? '' : 'es'}</div></div>
        <div class="stat"><div class="v">${session.confirmedCount}</div><div class="l">of them confirmed inside by Google’s electorate check</div></div>
      </div>
      <p class="note">Session results come live from Google and disappear when you reload — business details are not stored.</p>

      <h3>Accumulated coverage (stored place IDs)</h3>
      <div class="stat-grid">
        <div class="stat"><div class="v">${t.discovered}</div><div class="l">unique places discovered${coverage.since ? ` since ${fmtDate(coverage.since)}` : ''}</div></div>
        <div class="stat"><div class="v">${t.confirmed}</div><div class="l">confirmed inside (Google check ≤ ${session.maxAgeDays} days old)</div></div>
        <div class="stat"><div class="v">${t.unverified}</div><div class="l">without a current Google verdict</div></div>
        <div class="stat"><div class="v">${t.reviewed}</div><div class="l">human reviews (${coverage.reviews.inside} in · ${coverage.reviews.outside} out · ${coverage.reviews.unsure} unsure)</div></div>
      </div>
      <table aria-label="Coverage by category">
        <thead><tr><th>Category</th><th>Found</th><th>Inside</th><th title="Google’s live count of operational or temporarily closed places of these types inside the electorate; not stored">Google count*</th><th>Last sweep</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">* Live Places Aggregate figure from this session, shown for comparison and never stored (Google’s terms limit caching of these counts). Category totals overlap because one place can have several types. This is a coverage measure built from Google’s listings, not a complete business register: businesses without a Google listing, or listed under other types, are not counted.</p>

      <h3>Google requests and estimated cost</h3>
      ${usage ? `
      <table aria-label="Usage">
        <thead><tr><th>SKU</th><th>Today</th><th>Month</th><th>Free / mo</th><th>Est.</th></tr></thead>
        <tbody>${skuRows}</tbody>
      </table>
      <p class="note">Month-to-date estimate: <strong>${usd(usage.estMonthUsd)}</strong>. ${escapeHtml(usage.note)} Daily limits — Text Search ${usage.limits.textSearch.used}/${usage.limits.textSearch.limit}, opened details ${usage.limits.details.used}/${usage.limits.details.limit}, electorate-check loads ${usage.limits.gapFill.used}/${usage.limits.gapFill.limit}, Aggregate ${usage.limits.aggregate.used}/${usage.limits.aggregate.limit}.</p>` : '<p class="note">Usage unavailable.</p>'}

      <h3>Review decisions</h3>
      <p class="note">Export contains only Google place IDs and your own decisions and notes — no Google Maps content.</p>
      <div class="btn-row">
        <a class="btn" href="/api/reviews/export" download>Export reviews</a>
        <label class="btn">Import reviews<input type="file" accept="application/json" id="import-file" hidden></label>
      </div>
      <p class="note">Storage: ${escapeHtml(session.storage.backend)} — ${escapeHtml(session.storage.note)}</p>
      <p class="note">Updated ${fmtDateTime(new Date().toISOString())}.</p>
    </div>`;

  el.querySelector('#import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      onImport(JSON.parse(await file.text()));
    } catch {
      onImport(null);
    }
  });
}
