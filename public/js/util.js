export const STATUS_INFO = {
  confirmed: { label: 'Inside (Google electorate check)', short: 'Inside', order: 1 },
  reviewed_inside: { label: 'Reviewed: inside', short: 'Reviewed inside', order: 2 },
  unverified: { label: 'Needs review', short: 'Needs review', order: 3 },
  reviewed_unsure: { label: 'Reviewed: unsure', short: 'Unsure', order: 4 },
  outside_google: { label: 'Not in Google’s electorate results', short: 'Likely outside', order: 5 },
  reviewed_outside: { label: 'Reviewed: outside', short: 'Reviewed outside', order: 6 },
  service_area: { label: 'Service-area business (no premises)', short: 'Service area', order: 7 },
};

export const MAP_STATUSES = ['confirmed', 'reviewed_inside', 'unverified', 'reviewed_unsure', 'outside_google', 'reviewed_outside'];

export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Only allow http(s) links from API data into href attributes. */
export function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export const usd = (n) => `US$${Number(n || 0).toFixed(2)}`;

/** Membership status when no human review applies (mirrors server/discovery.js). */
export function baseStatus(place) {
  if (place.serviceAreaOnly) return 'service_area';
  const check = place.membership?.googleAreaCheck;
  if (check) return check.inside ? 'confirmed' : 'outside_google';
  return 'unverified';
}

export function reviewedStatus(decision) {
  return { inside: 'reviewed_inside', outside: 'reviewed_outside', unsure: 'reviewed_unsure' }[decision];
}

export const GOOGLE_MAPS_ATTRIBUTION = '<span class="gmp-attribution" translate="no">Google Maps</span>';

export const RANKING_EXPLAINER =
  'When searching for businesses or places near a location, Google Maps will show local results. Several factors — ' +
  'primarily relevance, distance and prominence — are combined to help find the best results for a search.';
