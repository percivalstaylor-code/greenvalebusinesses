// Runs only against the Firestore emulator:
//   npx firebase-tools emulators:exec --only firestore --project demo-gbm "npm test"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreStorage } from '../server/storage/firestore.js';
import { Budget, LocalLimitError } from '../server/budget.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

test('Firestore storage adapter round-trip', { skip: !enabled && 'FIRESTORE_EMULATOR_HOST not set' }, async () => {
  const store = new FirestoreStorage({ firestoreProjectId: 'demo-gbm', firestoreDatabaseId: '(default)', firestorePrefix: `t${Date.now()}_` });
  await store.init();
  await store.set('reviews', 'ChIJabc123456', { decision: 'inside', note: 'n' });
  await store.merge('reviews', 'ChIJabc123456', { reviewer: 'AB' });
  assert.deepEqual(await store.get('reviews', 'ChIJabc123456'), { decision: 'inside', note: 'n', reviewer: 'AB' });
  assert.equal((await store.list('reviews')).length, 1);
  assert.equal(await store.increment('usage', '2026-10-21', 'textSearchPro', 2), 2);
  assert.equal(await store.increment('usage', '2026-10-21', 'textSearchPro', 3), 5);
  await store.delete('reviews', 'ChIJabc123456');
  assert.equal(await store.get('reviews', 'ChIJabc123456'), null);

  const budget = new Budget(store, { textSearchPerDay: 1, detailsPerDay: 1, gapFillPerDay: 1, aggregatePerDay: 1 });
  await budget.consume('aggregate');
  await assert.rejects(budget.consume('aggregate'), LocalLimitError);
  await store.close();
});
