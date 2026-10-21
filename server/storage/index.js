// Persistent application data.
//
// What is stored (and why it is allowed):
//   places   – Google place IDs only (exempt from Places caching restrictions),
//              plus our own data: which of our categories found them, when,
//              and the outcome of Google's own electorate-area check.
//   reviews  – human boundary-review decisions and notes, keyed by place ID.
//   sweeps   – our own run history (request counts, number of results).
//   usage    – our own request counters for cost control.
//
// Never stored: business names, addresses, phone numbers, websites, opening
// hours, coordinates or any other Places content (Maps ToS §3.2.3(a)–(b)).
//
// Every adapter implements:
//   init(), get(col,id), set(col,id,doc), merge(col,id,partial),
//   delete(col,id), list(col), increment(col,id,field,by), describe(), close()

export const COLLECTIONS = ['places', 'reviews', 'sweeps', 'usage'];

export async function createStorage(cfg) {
  const { backend } = cfg.storage;
  let store;
  if (backend === 'memory') {
    const { MemoryStorage } = await import('./memory.js');
    store = new MemoryStorage();
  } else if (backend === 'file') {
    const { FileStorage } = await import('./file.js');
    store = new FileStorage(cfg.storage.dataDir);
  } else if (backend === 'firestore') {
    const { FirestoreStorage } = await import('./firestore.js');
    store = new FirestoreStorage(cfg.storage);
  } else {
    throw new Error(`Unknown STORAGE_BACKEND ${backend}`);
  }
  await store.init();
  return store;
}
