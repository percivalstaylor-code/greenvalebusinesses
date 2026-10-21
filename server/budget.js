// Self-imposed request limits and cost estimates.
//
// Prices: Google Maps Platform core services price list (global, USD),
// checked 2026-10-20. Each SKU has its own monthly free cap per billing
// account; the cost estimate assumes this app is the only consumer on the
// billing account and uses the first paid tier (up to 100,000 events).

export const SKUS = {
  textSearchPro: { label: 'Text Search Pro', freePerMonth: 5000, usdPer1000: 32, group: 'textSearch' },
  detailsEnterprise: { label: 'Place Details Enterprise', freePerMonth: 1000, usdPer1000: 20, group: 'details' },
  detailsPro: { label: 'Place Details Pro', freePerMonth: 5000, usdPer1000: 17, group: 'gapFill' },
  aggregate: { label: 'Places Aggregate', freePerMonth: 5000, usdPer1000: 10, group: 'aggregate' },
  mapLoads: { label: 'Dynamic Maps (page loads)', freePerMonth: 10000, usdPer1000: 7, group: null },
};

const GROUP_LABELS = { textSearch: 'Text Search', details: 'Place Details', gapFill: 'electorate-check details', aggregate: 'Places Aggregate' };

export class LocalLimitError extends Error {
  constructor(group, limit) {
    super(`This app's daily ${GROUP_LABELS[group] || group} limit of ${limit} requests has been reached (resets at 00:00 UTC). Raise it with the matching DAILY_*_LIMIT setting if needed.`);
    this.kind = 'quota';
    this.code = 'LOCAL_DAILY_LIMIT';
    this.group = group;
    this.limit = limit;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export class Budget {
  constructor(storage, limits) {
    this.storage = storage;
    this.limits = {
      textSearch: limits.textSearchPerDay,
      details: limits.detailsPerDay,
      gapFill: limits.gapFillPerDay,
      aggregate: limits.aggregatePerDay,
    };
    this.day = null;
    this.counts = {};
    this.lock = Promise.resolve();
  }

  async load() {
    const d = today();
    if (this.day !== d) {
      this.day = d;
      this.counts = (await this.storage.get('usage', d)) || {};
    }
  }

  groupCount(group) {
    return Object.entries(SKUS)
      .filter(([, s]) => s.group === group)
      .reduce((n, [sku]) => n + (this.counts[sku] || 0), 0);
  }

  /** Reserves `n` requests of `sku`, throwing LocalLimitError if that would pass the daily cap. */
  consume(sku, n = 1) {
    const run = this.lock.then(async () => {
      await this.load();
      const { group } = SKUS[sku];
      if (group && this.groupCount(group) + n > this.limits[group]) throw new LocalLimitError(group, this.limits[group]);
      this.counts[sku] = (this.counts[sku] || 0) + n;
      await this.storage.increment('usage', this.day, sku, n);
    });
    this.lock = run.catch(() => {});
    return run;
  }

  /** Remaining requests today for a group. */
  async remaining(group) {
    await this.lock;
    await this.load();
    return Math.max(0, this.limits[group] - this.groupCount(group));
  }

  async summary() {
    await this.lock;
    await this.load();
    const month = this.day.slice(0, 7);
    const docs = (await this.storage.list('usage')).filter((d) => d.id.startsWith(month));
    const monthCounts = {};
    for (const d of docs) for (const sku of Object.keys(SKUS)) monthCounts[sku] = (monthCounts[sku] || 0) + (d[sku] || 0);
    const skus = Object.entries(SKUS).map(([sku, s]) => {
      const used = monthCounts[sku] || 0;
      const billable = Math.max(0, used - s.freePerMonth);
      return { sku, ...s, today: this.counts[sku] || 0, month: used, estUsd: +((billable / 1000) * s.usdPer1000).toFixed(2) };
    });
    return {
      day: this.day,
      month,
      limits: Object.fromEntries(Object.entries(this.limits).map(([g, limit]) => [g, { limit, used: this.groupCount(g) }])),
      skus,
      estMonthUsd: +skus.reduce((t, s) => t + s.estUsd, 0).toFixed(2),
      note:
        'Counts are this app’s own records. Free caps apply per billing account per SKU, so other usage on the same ' +
        'billing account reduces what is free. Check Google Cloud Billing for the authoritative figure.',
    };
  }
}

/** Upper-bound USD cost of n events if the free cap is already used up. */
export function marginalUsd(sku, n) {
  return +((n / 1000) * SKUS[sku].usdPer1000).toFixed(2);
}
