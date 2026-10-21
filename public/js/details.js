// Business details panel and the manual boundary-review form.

import { STATUS_INFO, escapeHtml, safeUrl, fmtDate, GOOGLE_MAPS_ATTRIBUTION } from './util.js';

const STATUS_EXPLAIN = {
  confirmed: (p, cat) =>
    `Google’s Places Aggregate API returned this place ID when asked for ${cat} businesses inside the official Greenvale District polygon (checked ${fmtDate(p.membership.googleAreaCheck?.checkedAt)}).`,
  outside_google: (p, cat) =>
    `Google listed every ${cat} business inside the official polygon (checked ${fmtDate(p.membership.googleAreaCheck?.checkedAt)}) and this place was not among them, so it is probably outside the electorate. Review it if the marker looks inside.`,
  unverified: () =>
    'Google has not confirmed whether this place is inside the electorate (no complete electorate check covers it yet). Compare the marker with the purple boundary and record a decision below.',
  service_area: () =>
    'Google lists this as a service-area business with no public premises, so its physical location — and therefore its electorate — cannot be established from Google data.',
  reviewed_inside: () => 'A reviewer recorded that this location is inside Greenvale District.',
  reviewed_outside: () => 'A reviewer recorded that this location is outside Greenvale District.',
  reviewed_unsure: () => 'A reviewer looked at this location but could not decide.',
};

const BUSINESS_STATUS = {
  CLOSED_TEMPORARILY: 'Temporarily closed (according to Google)',
  CLOSED_PERMANENTLY: 'Permanently closed (according to Google)',
};

export function renderDetails(el, p, { loading, error, categoryLabel, onClose, onSaveReview, onClearReview, onRetry }) {
  const status = p.membership?.status || 'unverified';
  const info = STATUS_INFO[status];
  const cat = categoryLabel(p.membership?.googleAreaCheck?.via || p.category) || 'matching';
  const missing = (what) => `<span class="d-missing">${what}</span>`;
  const field = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;
  const contact = (key, render) => {
    if (loading) return '<span class="d-missing">Loading…</span>';
    if (error) return missing('Not loaded');
    if (!(key in p)) return missing('Not loaded');
    return p[key] ? render(p[key]) : missing('Not listed on Google');
  };
  const website = safeUrl(p.website);
  const mapsUri = safeUrl(p.mapsUri);
  const review = p.membership?.review;

  el.innerHTML = `
    <div class="d-head">
      <h2>${p.name ? escapeHtml(p.name) : '<span class="d-missing">Name not provided by Google</span>'}</h2>
      <div class="d-type">${escapeHtml(p.primaryTypeLabel || p.primaryType || 'Business')}</div>
      ${BUSINESS_STATUS[p.businessStatus] ? `<div class="r-closed">${BUSINESS_STATUS[p.businessStatus]}</div>` : ''}
      <button class="d-close" type="button" aria-label="Close details">×</button>
    </div>
    <div class="d-section">
      <dl class="d-fields">
        ${field('Address', p.address ? escapeHtml(p.address) : p.serviceAreaOnly ? missing('No public premises (service-area business)') : missing('Not listed on Google'))}
        ${field('Phone', contact('phone', (v) => `<a href="tel:${escapeHtml(p.phoneIntl || v).replace(/[^+\d]/g, '')}">${escapeHtml(v)}</a>`))}
        ${field('Website', contact('website', () => (website ? `<a href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(new URL(website).hostname.replace(/^www\./, ''))}</a>` : missing('Not listed on Google'))))}
        ${field('Hours', contact('hours', (h) => `<ul class="d-hours">${h.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`))}
        ${field('Google Maps', mapsUri ? `<a href="${escapeHtml(mapsUri)}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>` : missing('Link not provided'))}
      </dl>
      ${error ? `<p class="d-explain">Couldn’t load phone, website and hours: ${escapeHtml(error.message)} <button class="btn small" type="button" data-act="retry">Retry</button></p>` : ''}
    </div>
    <div class="d-section">
      <h3>Electorate status</h3>
      <div class="status-badge"><span class="dot s-${status}"></span>${info.label}</div>
      <p class="d-explain">${STATUS_EXPLAIN[status](p, escapeHtml(cat))}</p>
      ${status !== 'service_area' || review ? reviewForm(review) : ''}
    </div>
    <div class="d-attrib">
      <span>${(p.attributions || []).length ? `Data: ${p.attributions.map((a) => (safeUrl(a.providerUri) ? `<a href="${escapeHtml(safeUrl(a.providerUri))}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.provider)}</a>` : escapeHtml(a.provider))).join(', ')}` : 'Business information from'}</span>
      ${GOOGLE_MAPS_ATTRIBUTION}
    </div>`;

  el.querySelector('.d-close').addEventListener('click', onClose);
  el.querySelector('[data-act="retry"]')?.addEventListener('click', onRetry);
  const form = el.querySelector('.review-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = new FormData(form);
      if (!data.get('decision')) return;
      onSaveReview({ decision: data.get('decision'), note: data.get('note') || '', reviewer: data.get('reviewer') || '' });
    });
    form.querySelector('[data-act="clear"]')?.addEventListener('click', onClearReview);
  }
}

function reviewForm(review) {
  const checked = (d) => (review?.decision === d ? 'checked' : '');
  return `
    <form class="review-form" aria-label="Boundary review">
      <div class="seg" role="radiogroup" aria-label="Is this location inside Greenvale District?">
        <label><input type="radio" name="decision" value="inside" ${checked('inside')}>Inside</label>
        <label><input type="radio" name="decision" value="outside" ${checked('outside')}>Outside</label>
        <label><input type="radio" name="decision" value="unsure" ${checked('unsure')}>Unsure</label>
      </div>
      <textarea name="note" maxlength="500" placeholder="Note (optional), e.g. “entrance faces Mickleham Rd, inside boundary”">${escapeHtml(review?.note || '')}</textarea>
      <input type="text" name="reviewer" maxlength="80" placeholder="Reviewer initials (optional)" value="${escapeHtml(review?.reviewer || '')}">
      <div class="btn-row">
        <button class="btn primary" type="submit">${review ? 'Update review' : 'Save review'}</button>
        ${review ? '<button class="btn danger" type="button" data-act="clear">Clear review</button>' : ''}
      </div>
      ${review ? `<p class="d-explain">Last reviewed ${fmtDate(review.updatedAt)}${review.reviewer ? ` by ${escapeHtml(review.reviewer)}` : ''}.</p>` : ''}
    </form>`;
}
