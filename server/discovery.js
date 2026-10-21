// Business discovery and electorate membership.
//
// Two Google-supported mechanisms are combined:
//
// 1. Places Aggregate API (computeInsights, INSIGHT_PLACES) with a customArea
//    polygon = the official Greenvale District boundary. Google itself decides
//    which places fall inside the polygon and returns their place IDs (only
//    when ≤ 100 match, so the polygon is cut into pieces when needed). This is
//    the only basis for "Confirmed inside" — we never test Places coordinates
//    against the polygon ourselves (Maps ToS §3.2.3(c)(iv)).
//
// 2. Places Text Search (New), one request per Google place type, restricted
//    to the electorate's bounding rectangle (Text Search only supports
//    rectangles). This returns the displayable details. The rectangle is
//    larger than the electorate, so results include places outside it; the
//    rectangle is split when a query hits Google's 60-result cap.
//
// Results are matched to (1) by place ID only. Places Google did not return
// for the polygon, although that category's enumeration was complete, are
// "Not in Google's electorate results"; everything else is "Needs review".

import { randomUUID } from 'node:crypto';
import { splitBox, clipRingToBox, boxIntersectsRing, intersectBoxes, expandBox, boxWidthHeightKm } from './geo.js';
import { CATEGORY_BY_ID, categoryForTypes } from './categories.js';
import { PlacesError } from './places.js';
import { LocalLimitError } from './budget.js';

const MAX_TEXT_PAGES = 3; // Text Search returns at most 60 results (3 × 20)
const MAX_TEXT_SPLIT_DEPTH = 2;
const MAX_AGG_SPLIT_DEPTH = 4;
const PIECE_OVERLAP_KM = 0.03;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

export const STATUS = {
  confirmed: 'confirmed', // in Google's Places Aggregate results for the electorate polygon
  outside: 'outside_google', // category enumeration complete and the place was not in it
  unverified: 'unverified',
  serviceArea: 'service_area',
  reviewedInside: 'reviewed_inside',
  reviewedOutside: 'reviewed_outside',
  reviewedUnsure: 'reviewed_unsure',
};

export const isPlaceId = (id) => typeof id === 'string' && PLACE_ID_RE.test(id);

export class Discovery {
  constructor({ places, storage, boundary, cfg }) {
    this.places = places;
    this.storage = storage;
    this.boundary = boundary;
    this.cfg = cfg;
    this.ring = boundary.ring;
    this.bbox = boundary.bbox;
    this.searchRegion = expandBox(boundary.bbox, 2); // area searches must overlap the electorate's surroundings
    this.jobs = new Map();
    this.activeSweep = null;
  }

  // ---------- membership ----------

  isFresh(area) {
    if (!area || area.boundary !== this.boundary.version) return false;
    const ageDays = (Date.now() - Date.parse(area.checkedAt)) / 86400000;
    return ageDays <= this.cfg.membershipMaxAgeDays;
  }

  /** Effective membership of a place, from stored Google area checks and human reviews. */
  membershipFor(place, doc, review) {
    const area = doc?.area && this.isFresh(doc.area) ? doc.area : null;
    const base = place?.serviceAreaOnly
      ? STATUS.serviceArea
      : area
        ? area.inside ? STATUS.confirmed : STATUS.outside
        : STATUS.unverified;
    const reviewed = review
      ? { inside: STATUS.reviewedInside, outside: STATUS.reviewedOutside, unsure: STATUS.reviewedUnsure }[review.decision]
      : null;
    return {
      status: reviewed || base,
      googleAreaCheck: area ? { inside: area.inside, checkedAt: area.checkedAt, via: area.via } : null,
      review: review || null,
    };
  }

  async annotate(places) {
    const ids = places.map((p) => p.id);
    const [docs, reviews] = await Promise.all([this.docsFor('places', ids), this.docsFor('reviews', ids)]);
    return places.map((p) => ({ ...p, category: categoryForTypes(p.types, p.primaryType), membership: this.membershipFor(p, docs.get(p.id), reviews.get(p.id)) }));
  }

  async docMap(col) {
    return new Map((await this.storage.list(col)).map((d) => [d.id, d]));
  }

  /** Reads only the documents needed when there are few, otherwise the whole collection. */
  async docsFor(col, ids) {
    if (ids.length > 40) return this.docMap(col);
    const docs = await Promise.all(ids.map((id) => this.storage.get(col, id)));
    return new Map(ids.map((id, i) => [id, docs[i]]).filter(([, d]) => d));
  }

  /**
   * Asks Google (Places Aggregate) which places of the category's types lie
   * inside the electorate polygon. Splits the polygon until every piece has
   * ≤ 100 matches. Returns { count, ids, complete, calls }.
   */
  async enumerateCategory(category, ctx) {
    const types = category.types.map((t) => t.type);
    const ids = new Set();
    let complete = true;
    let count = null;
    let queue = [{ ring: this.ring, box: this.bbox, depth: 0 }];
    while (queue.length) {
      const next = [];
      for (const piece of queue) {
        if (ctx.aggregateCalls >= this.cfg.limits.sweepAggregateMax) {
          complete = false;
          ctx.notes.add(`Electorate check for ${category.label} stopped at the per-sweep limit of ${this.cfg.limits.sweepAggregateMax} Aggregate requests.`);
          continue;
        }
        ctx.aggregateCalls++;
        const res = await this.places.aggregate({ ring: piece.ring, types });
        if (piece.depth === 0) count = res.count;
        if (res.ids) {
          res.ids.forEach((id) => ids.add(id));
        } else if (piece.depth < MAX_AGG_SPLIT_DEPTH) {
          for (const box of splitBox(piece.box)) {
            // Pieces overlap by ~30 m (still clipped to the electorate) so places on a cut line
            // are not lost between neighbours; the union is de-duplicated by place ID.
            for (const ring of clipRingToBox(piece.ring, expandBox(box, PIECE_OVERLAP_KM))) next.push({ ring, box, depth: piece.depth + 1 });
          }
        } else {
          complete = false;
        }
        ctx.progress();
      }
      queue = next;
    }
    if (count === null && complete) count = ids.size; // all pieces enumerated, so the union is the total
    if (complete && count !== null && ids.size < count) {
      // Should not happen (pieces tile the polygon exactly), but never claim completeness if it does.
      complete = false;
      ctx.notes.add(`${category.label}: Google counted ${count} places but returned ${ids.size} IDs across polygon pieces.`);
    }
    return { count, ids, complete };
  }

  // ---------- text search ----------

  /** Runs one Text Search task (up to 3 pages); returns whether Google's 60-result cap was hit. */
  async runTextTask(task, ctx, results) {
    let pageToken = null;
    let got = 0;
    for (let page = 0; page < MAX_TEXT_PAGES; page++) {
      if (ctx.textCalls >= ctx.textLimit) {
        ctx.truncated = true;
        return false;
      }
      ctx.textCalls++;
      const res = await this.places.textSearch({
        textQuery: task.query,
        includedType: task.type,
        box: task.box,
        pageToken,
        includeServiceArea: task.includeServiceArea,
      });
      ctx.progress();
      for (const p of res.places) {
        got++;
        const found = results.get(p.id);
        const via = task.type ? `type:${task.type}` : `query:${task.query}`;
        if (found) {
          ctx.duplicates++;
          if (!found.foundVia.includes(via)) found.foundVia.push(via);
        } else {
          results.set(p.id, { ...p, foundVia: [via] });
        }
      }
      pageToken = res.nextPageToken;
      // Google omits nextPageToken on the final (third) page, so a full 60 means "capped".
      if (!pageToken) return got >= 60;
    }
    return got >= 60;
  }

  async runTextTasks(tasks, ctx, results) {
    let queue = tasks;
    while (queue.length) {
      const next = [];
      await pool(queue, this.cfg.places.concurrency, async (task) => {
        const capped = await this.runTextTask(task, ctx, results);
        if (!capped) return;
        if (task.depth >= MAX_TEXT_SPLIT_DEPTH) {
          ctx.notes.add(`“${task.label}” still returned Google's 60-result maximum after splitting the area; some listings may be missing.`);
          return;
        }
        for (const box of splitBox(task.box)) {
          if (boxIntersectsRing(box, this.ring)) next.push({ ...task, box, depth: task.depth + 1 });
        }
      });
      queue = next;
    }
  }

  tasksForCategory(category, box, includeServiceArea) {
    return [
      ...category.types.map((t) => ({ type: t.type, query: typeQuery(t.type), label: t.label, box, depth: 0, includeServiceArea })),
      ...category.queries.map((q) => ({ type: null, query: q, label: q, box, depth: 0, includeServiceArea })),
    ];
  }

  // ---------- area search (interactive) ----------

  validateBox(box) {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) || box[0] >= box[2] || box[1] >= box[3]) {
      throw new PlacesError({ kind: 'invalid', code: 'BAD_AREA', message: 'Invalid search area.' });
    }
    const clamped = intersectBoxes(box, this.searchRegion);
    if (!clamped) {
      throw new PlacesError({ kind: 'invalid', code: 'OUTSIDE_REGION', message: 'This map view does not overlap Greenvale District. Pan back to the electorate to search.' });
    }
    const [w, h] = boxWidthHeightKm(clamped);
    if (Math.max(w, h) > this.cfg.limits.areaSearchMaxKm) {
      throw new PlacesError({ kind: 'invalid', code: 'AREA_TOO_LARGE', message: `Zoom in: the search area is ${Math.round(Math.max(w, h))} km across (limit ${this.cfg.limits.areaSearchMaxKm} km). Use “Sweep electorate” for the whole district.` });
    }
    return clamped;
  }

  /**
   * One user-initiated search of the visible map area. Only page 1 per type
   * is fetched; Google's nextPageToken is returned so the user can ask for more.
   */
  async searchArea({ categoryId, type, query, box, pageToken }) {
    const area = this.validateBox(box);
    const category = categoryId ? CATEGORY_BY_ID.get(categoryId) : null;
    if (!query && !category) throw new PlacesError({ kind: 'invalid', code: 'BAD_CATEGORY', message: 'Choose a category or enter a search.' });
    const includeServiceArea = Boolean(category?.serviceArea);
    const ctx = newCtx(this.cfg.limits.sweepTextSearchMax);
    const results = new Map();
    const moreAvailable = [];
    let tasks;
    if (query) {
      const q = String(query).trim().slice(0, 120);
      if (!q) throw new PlacesError({ kind: 'invalid', code: 'BAD_QUERY', message: 'Enter something to search for.' });
      tasks = [{ type: null, query: q, label: q }];
    } else if (type) {
      const t = category.types.find((x) => x.type === type);
      if (!t) throw new PlacesError({ kind: 'invalid', code: 'BAD_TYPE', message: 'Unknown business type.' });
      tasks = [{ type: t.type, query: typeQuery(t.type), label: t.label }];
    } else {
      tasks = this.tasksForCategory(category, area, includeServiceArea);
    }
    await pool(tasks, this.cfg.places.concurrency, async (task) => {
      ctx.textCalls++;
      const res = await this.places.textSearch({ textQuery: task.query, includedType: task.type, box: area, includeServiceArea, pageToken: tasks.length === 1 ? pageToken : undefined });
      for (const p of res.places) {
        if (results.has(p.id)) ctx.duplicates++;
        else results.set(p.id, { ...p, foundVia: [task.type ? `type:${task.type}` : `query:${task.query}`] });
      }
      if (res.nextPageToken) moreAvailable.push({ label: task.label, type: task.type, query: task.type ? null : task.query, nextPageToken: res.nextPageToken });
    });
    const list = [...results.values()];
    await this.recordSeen(list, category?.id || null);
    return {
      places: await this.annotate(list),
      meta: {
        kind: 'area',
        label: query ? `“${String(query).trim()}”` : type ? category.types.find((x) => x.type === type).label : category.label,
        categoryId: category?.id || null,
        box: area,
        textSearchRequests: ctx.textCalls,
        duplicatesMerged: ctx.duplicates,
        moreAvailable,
      },
    };
  }

  // ---------- electorate check for already-displayed results ----------

  async areaCheck({ categoryId, places: shown = [] }) {
    const category = CATEGORY_BY_ID.get(categoryId);
    if (!category) throw new PlacesError({ kind: 'invalid', code: 'BAD_CATEGORY', message: 'Unknown category.' });
    const ctx = newCtx(0);
    const en = await this.enumerateCategory(category, ctx);
    const items = shown.filter((p) => isPlaceId(p?.id)).slice(0, 3000);
    await this.recordAreaResults(category, en, items);
    const shownIds = new Set(items.map((p) => p.id));
    const annotated = await this.annotate(items.map((p) => ({ id: p.id, types: p.types || [], primaryType: p.primaryType || null, serviceAreaOnly: Boolean(p.serviceAreaOnly) })));
    return {
      memberships: Object.fromEntries(annotated.map((p) => [p.id, p.membership])),
      aggregate: summariseEnumeration(category, en, ctx),
      gapIds: [...en.ids].filter((id) => !shownIds.has(id)),
      notes: [...ctx.notes],
    };
  }

  /** Stores Google's verdicts: IDs in the enumeration are inside; shown places of this category absent from a complete enumeration are not. */
  async recordAreaResults(category, en, items) {
    const now = new Date().toISOString();
    const typeSet = new Set(category.types.map((t) => t.type));
    const writes = [];
    for (const id of en.ids) writes.push([id, { area: { inside: true, checkedAt: now, via: category.id, boundary: this.boundary.version } }]);
    if (en.complete) {
      for (const p of items) {
        if (en.ids.has(p.id) || p.serviceAreaOnly) continue;
        if (p.businessStatus === 'CLOSED_PERMANENTLY') continue; // excluded from the Aggregate query, so absence proves nothing
        if (!(p.types || []).some((t) => typeSet.has(t))) continue;
        writes.push([p.id, { area: { inside: false, checkedAt: now, via: category.id, boundary: this.boundary.version } }]);
      }
    }
    const existing = await this.docsFor('places', writes.map(([id]) => id));
    await chunked(writes, 25, ([id, data]) => {
      // Never downgrade a fresh "inside" verdict from another category to "outside".
      const prev = existing.get(id)?.area;
      if (data.area.inside === false && prev?.inside && this.isFresh(prev)) return null;
      return this.storage.merge('places', id, { ...data, firstSeenAt: existing.get(id)?.firstSeenAt || now, lastSeenAt: now });
    });
  }

  async recordSeen(list, categoryId) {
    const now = new Date().toISOString();
    const existing = await this.docsFor('places', list.map((p) => p.id));
    await chunked(list, 25, (p) => {
      const prev = existing.get(p.id);
      const categories = new Set(prev?.categories || []);
      if (categoryId) categories.add(categoryId);
      const own = categoryForTypes(p.types, p.primaryType);
      if (own) categories.add(own);
      return this.storage.merge('places', p.id, { firstSeenAt: prev?.firstSeenAt || now, lastSeenAt: now, categories: [...categories] });
    });
  }

  // ---------- electorate sweep (systematic) ----------

  planSweep(categoryId) {
    const category = CATEGORY_BY_ID.get(categoryId);
    if (!category) throw new PlacesError({ kind: 'invalid', code: 'BAD_CATEGORY', message: 'Unknown category.' });
    const tasks = category.types.length + category.queries.length;
    return {
      categoryId,
      label: category.label,
      textSearch: { min: tasks, max: this.cfg.limits.sweepTextSearchMax },
      aggregate: { min: 1, max: this.cfg.limits.sweepAggregateMax },
    };
  }

  startSweep(categoryId) {
    const plan = this.planSweep(categoryId);
    if (this.activeSweep) {
      throw new PlacesError({ kind: 'invalid', code: 'SWEEP_RUNNING', message: 'A sweep is already running. Wait for it to finish.' });
    }
    const id = randomUUID();
    const job = { id, categoryId, label: plan.label, status: 'running', startedAt: new Date().toISOString(), progress: { textSearchRequests: 0, aggregateRequests: 0, phase: 'electorate check' }, result: null, error: null };
    this.jobs.set(id, job);
    this.activeSweep = id;
    this.runSweep(job)
      .catch((err) => {
        job.status = 'failed';
        job.error = errorPayload(err);
      })
      .finally(() => {
        this.activeSweep = null;
        job.finishedAt = new Date().toISOString();
        setTimeout(() => this.jobs.delete(id), 30 * 60 * 1000).unref?.();
      });
    return job;
  }

  async runSweep(job) {
    const category = CATEGORY_BY_ID.get(job.categoryId);
    const ctx = newCtx(this.cfg.limits.sweepTextSearchMax, () => {
      job.progress.textSearchRequests = ctx.textCalls;
      job.progress.aggregateRequests = ctx.aggregateCalls;
    });

    // 1. Google's own list of matching places inside the electorate polygon.
    let en = { count: null, ids: new Set(), complete: false };
    let aggregateError = null;
    try {
      en = await this.enumerateCategory(category, ctx);
    } catch (err) {
      if (err instanceof LocalLimitError || !(err instanceof PlacesError) || err.kind === 'network') throw err;
      aggregateError = errorPayload(err); // continue: results will be "Needs review"
      ctx.notes.add(`Electorate check unavailable (${err.code}); all results need review.`);
    }

    // 2. Displayable results from Text Search across the electorate's bounding rectangle.
    job.progress.phase = 'business search';
    const results = new Map();
    try {
      await this.runTextTasks(this.tasksForCategory(category, this.bbox, category.serviceArea), ctx, results);
    } catch (err) {
      if (err.kind !== 'quota' || results.size === 0) throw err;
      ctx.truncated = true; // keep what was found before the limit
      ctx.notes.add(`${err.message} Results are partial.`);
    }
    if (ctx.truncated) ctx.notes.add(`Stopped at the per-sweep limit of ${this.cfg.limits.sweepTextSearchMax} Text Search requests; results are partial.`);

    // 3. Store Google's verdicts (place IDs only) and classify.
    job.progress.phase = 'saving';
    const list = [...results.values()];
    await this.recordSeen(list, category.id);
    if (!aggregateError) await this.recordAreaResults(category, en, list);
    const places = await this.annotate(list);
    const gapIds = [...en.ids].filter((id) => !results.has(id));

    const counts = countStatuses(places);
    const sweepRecord = {
      categoryId: category.id,
      startedAt: job.startedAt,
      finishedAt: new Date().toISOString(),
      textSearchRequests: ctx.textCalls,
      aggregateRequests: ctx.aggregateCalls,
      resultsReturned: list.length,
      duplicatesMerged: ctx.duplicates,
      statusCounts: counts,
      electorateCheckComplete: en.complete,
      truncated: ctx.truncated,
      boundary: this.boundary.version,
    };
    await this.storage.set('sweeps', job.id, sweepRecord);

    job.result = {
      places,
      meta: {
        kind: 'sweep',
        label: `${category.label} — whole electorate`,
        categoryId: category.id,
        textSearchRequests: ctx.textCalls,
        aggregateRequests: ctx.aggregateCalls,
        duplicatesMerged: ctx.duplicates,
        truncated: ctx.truncated,
        statusCounts: counts,
        notes: [...ctx.notes],
      },
      aggregate: aggregateError ? { error: aggregateError } : summariseEnumeration(category, en, ctx),
      gapIds,
    };
    job.status = 'done';
  }

  getJob(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const { result, ...rest } = job;
    return { ...rest, result: job.status === 'done' ? result : null };
  }

  // ---------- details ----------

  async details(placeId) {
    if (!isPlaceId(placeId)) throw new PlacesError({ kind: 'invalid', code: 'BAD_PLACE_ID', message: 'Invalid place ID.' });
    const p = await this.places.details(placeId, 'enterprise');
    const [annotated] = await this.annotate([p]);
    return annotated;
  }

  /** Fetches basic details for places Google listed inside the electorate that Text Search did not return. */
  async gapFill(ids) {
    const valid = [...new Set((ids || []).filter(isPlaceId))].slice(0, this.cfg.limits.gapFillMax);
    const docs = await this.docsFor('places', valid);
    // Only places Google itself listed inside the electorate are eligible.
    const eligible = valid.filter((id) => docs.get(id)?.area?.inside && this.isFresh(docs.get(id).area));
    const out = [];
    await pool(eligible, this.cfg.places.concurrency, async (id) => {
      out.push({ ...(await this.places.details(id, 'pro')), foundVia: ['electorate-check'] });
    });
    await this.recordSeen(out, null);
    return { places: await this.annotate(out), requested: valid.length, fetched: out.length };
  }
}

// ---------- helpers ----------

/** Plain-language query for a type search, e.g. car_repair → "car repair". */
const typeQuery = (type) => type.replace(/_/g, ' ');

function newCtx(textLimit, onProgress = () => {}) {
  return { textCalls: 0, textLimit, aggregateCalls: 0, duplicates: 0, truncated: false, notes: new Set(), progress: onProgress };
}

function summariseEnumeration(category, en, ctx) {
  return {
    categoryId: category.id,
    // Live Google figure for display only — POI counts are not stored (Maps Service Terms §13.2).
    googleCount: en.count,
    idsReturned: en.ids.size,
    complete: en.complete,
    requests: ctx.aggregateCalls,
  };
}

export function countStatuses(places) {
  const counts = {};
  for (const p of places) counts[p.membership.status] = (counts[p.membership.status] || 0) + 1;
  return counts;
}

export function errorPayload(err) {
  return {
    kind: err.kind || 'internal',
    code: err.code || 'INTERNAL',
    message: err.kind ? err.message : 'Unexpected server error.',
    help: err.help || null,
    api: err.api || null,
  };
}

/** Runs fn over items with n workers; stops starting new items after the first error, then rethrows it. */
async function pool(items, n, fn) {
  let i = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !failure) {
      const item = items[i++];
      try {
        await fn(item);
      } catch (err) {
        failure ??= err;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}

async function chunked(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}
