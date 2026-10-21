import { COLLECTIONS } from './index.js';

export class MemoryStorage {
  constructor() {
    this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
  }

  async init() {}

  col(name) {
    const c = this.data[name];
    if (!c) throw new Error(`Unknown collection ${name}`);
    return c;
  }

  async get(col, id) {
    const v = this.col(col).get(id);
    return v ? structuredClone(v) : null;
  }

  async set(col, id, doc) {
    this.col(col).set(id, structuredClone(doc));
    this.changed?.();
  }

  async merge(col, id, partial) {
    const c = this.col(col);
    c.set(id, { ...(c.get(id) || {}), ...structuredClone(partial) });
    this.changed?.();
  }

  async delete(col, id) {
    this.col(col).delete(id);
    this.changed?.();
  }

  async list(col) {
    return [...this.col(col)].map(([id, doc]) => ({ id, ...structuredClone(doc) }));
  }

  async increment(col, id, field, by = 1) {
    const c = this.col(col);
    const doc = c.get(id) || {};
    doc[field] = (doc[field] || 0) + by;
    c.set(id, doc);
    this.changed?.();
    return doc[field];
  }

  describe() {
    return { backend: 'memory', persistent: false, note: 'Data is lost when the server stops.' };
  }

  async close() {}
}
