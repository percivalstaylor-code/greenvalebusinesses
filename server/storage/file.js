// Single JSON file store for local development. Writes are debounced and
// atomic (write to a temp file, then rename).
//
// Durable only where the filesystem is: fine on a developer machine or a
// mounted volume; NOT durable inside an ephemeral cloud container. Use
// STORAGE_BACKEND=firestore for anything that must outlive the container.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COLLECTIONS } from './index.js';
import { MemoryStorage } from './memory.js';

export class FileStorage extends MemoryStorage {
  constructor(dir) {
    super();
    this.dir = dir;
    this.path = join(dir, 'greenvale-business-map.json');
    this.timer = null;
    this.writing = Promise.resolve();
    this.changed = () => this.scheduleWrite();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      for (const c of COLLECTIONS) {
        this.data[c] = new Map(Object.entries(raw[c] || {}));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${this.path}: ${err.message}`);
    }
  }

  scheduleWrite() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const snapshot = JSON.stringify(
      { version: 1, savedAt: new Date().toISOString(), ...Object.fromEntries(COLLECTIONS.map((c) => [c, Object.fromEntries(this.data[c])])) },
    );
    this.writing = this.writing.then(async () => {
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, this.path);
    });
    return this.writing;
  }

  describe() {
    return {
      backend: 'file',
      persistent: true,
      note: 'JSON file on this machine’s disk. Survives restarts here, but not the loss of the machine or container.',
    };
  }

  async close() {
    if (this.timer) await this.flush();
    await this.writing;
  }
}
