// Cloud Firestore (Native mode) store — recommended for any deployment so
// review decisions and coverage survive container restarts and redeploys.
// Authenticates with Application Default Credentials (the Cloud Run service
// account, or `gcloud auth application-default login` locally), or with a
// service-account JSON in FIRESTORE_CREDENTIALS_JSON where ADC is unavailable
// (e.g. Claude Code cloud sessions). Grant that account only "Cloud Datastore User".

import { COLLECTIONS } from './index.js';

export class FirestoreStorage {
  constructor({ firestoreProjectId, firestoreDatabaseId, firestorePrefix, firestoreCredentialsJson }) {
    this.credentialsJson = firestoreCredentialsJson || '';
    this.projectId = firestoreProjectId || undefined;
    this.databaseId = firestoreDatabaseId;
    this.prefix = firestorePrefix;
  }

  async init() {
    let mod;
    try {
      mod = await import('@google-cloud/firestore');
    } catch {
      throw new Error('STORAGE_BACKEND=firestore needs the @google-cloud/firestore package (npm install).');
    }
    this.FieldValue = mod.FieldValue;
    const options = { projectId: this.projectId, databaseId: this.databaseId, ignoreUndefinedProperties: true };
    if (this.credentialsJson) {
      let creds;
      try {
        creds = JSON.parse(this.credentialsJson);
      } catch {
        throw new Error('FIRESTORE_CREDENTIALS_JSON is not valid JSON.'); // never echo the value
      }
      options.credentials = { client_email: creds.client_email, private_key: creds.private_key };
      options.projectId ??= creds.project_id;
      this.projectId = options.projectId;
    }
    this.db = new mod.Firestore(options);
    // Fail fast with a clear message if credentials or the database are missing.
    await this.db.collection(this.name('usage')).limit(1).get();
  }

  name(col) {
    if (!COLLECTIONS.includes(col)) throw new Error(`Unknown collection ${col}`);
    return `${this.prefix}${col}`;
  }

  ref(col, id) {
    // Firestore document IDs cannot contain "/"; place IDs and our IDs never do.
    return this.db.collection(this.name(col)).doc(String(id));
  }

  async get(col, id) {
    const snap = await this.ref(col, id).get();
    return snap.exists ? snap.data() : null;
  }

  async set(col, id, doc) {
    await this.ref(col, id).set(doc);
  }

  async merge(col, id, partial) {
    await this.ref(col, id).set(partial, { merge: true });
  }

  async delete(col, id) {
    await this.ref(col, id).delete();
  }

  async list(col) {
    const snap = await this.db.collection(this.name(col)).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async increment(col, id, field, by = 1) {
    const ref = this.ref(col, id);
    await ref.set({ [field]: this.FieldValue.increment(by) }, { merge: true });
    const snap = await ref.get();
    return snap.get(field) ?? by;
  }

  describe() {
    return {
      backend: 'firestore',
      persistent: true,
      note: `Cloud Firestore database ${this.databaseId}${this.projectId ? ` in ${this.projectId}` : ''}.`,
    };
  }

  async close() {
    await this.db?.terminate();
  }
}
