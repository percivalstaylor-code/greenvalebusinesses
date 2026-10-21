// Thin client for the app's own server. All Google Places calls happen on
// the server; the browser never sees the Places credential.

export class ApiError extends Error {
  constructor({ kind = 'internal', code = 'ERROR', message, help = null, api = null, status = 0 }) {
    super(message);
    Object.assign(this, { kind, code, help, api, status });
  }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError({
      kind: 'connection',
      code: 'APP_SERVER_UNREACHABLE',
      message: 'Cannot reach the Greenvale Business Map server. Check your connection and that the server is running.',
    });
  }
  if (res.status === 204) return null;
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty or non-JSON */
  }
  if (!res.ok) throw new ApiError({ ...(json?.error || { message: `Server returned HTTP ${res.status}` }), status: res.status });
  return json;
}

export const api = {
  config: () => request('GET', '/api/config'),
  boundary: () => request('GET', '/api/boundary'),
  usage: () => request('GET', '/api/usage'),
  coverage: () => request('GET', '/api/coverage'),
  searchArea: (body) => request('POST', '/api/search/area', body),
  sweepPlan: (categoryId) => request('GET', `/api/sweeps/plan?category=${encodeURIComponent(categoryId)}`),
  startSweep: (categoryId) => request('POST', '/api/sweeps', { categoryId }),
  sweep: (id) => request('GET', `/api/sweeps/${encodeURIComponent(id)}`),
  areaCheck: (categoryId, places) => request('POST', '/api/area-check', { categoryId, places }),
  details: (id) => request('GET', `/api/places/${encodeURIComponent(id)}`),
  gapFill: (ids) => request('POST', '/api/places/gap-fill', { ids }),
  saveReview: (id, review) => request('PUT', `/api/reviews/${encodeURIComponent(id)}`, review),
  deleteReview: (id) => request('DELETE', `/api/reviews/${encodeURIComponent(id)}`),
  importReviews: (data) => request('POST', '/api/reviews/import', data),
};
