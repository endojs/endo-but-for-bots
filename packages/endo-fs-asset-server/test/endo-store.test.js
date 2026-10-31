// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makeEndoAssetStore } from '../src/endo-store.js';

test('failed orphan cleanup remains visible and can be explicitly released', async t => {
  const failedId = 'a'.repeat(32);
  const removedId = 'b'.repeat(32);
  const names = new Set([
    `asset-target-${failedId}`,
    `asset-target-${removedId}`,
    'unrelated-name',
  ]);
  let refuse = true;
  const powers = makeExo(
    'TestAssetStorePowers',
    M.interface('TestAssetStorePowers', {}, { defaultGuards: 'passable' }),
    {
      list: () => harden([...names]),
      has: name => names.has(name),
      remove: name => {
        if (refuse && name === `asset-target-${failedId}`) {
          throw Error('private-store-path-must-not-be-exposed');
        }
        names.delete(name);
      },
    },
  );
  const store = makeEndoAssetStore(powers);
  t.deepEqual(await store.load(), [
    { id: failedId, unreadable: 'orphaned target cleanup failed' },
  ]);
  t.true(names.has(`asset-target-${failedId}`));
  t.false(names.has(`asset-target-${removedId}`));
  t.true(names.has('unrelated-name'));
  // Reconstructing the store does not hide the failed target. No new journal
  // or authority is needed: its existing retained name is the recovery owner.
  const reconstructed = makeEndoAssetStore(powers);
  t.deepEqual(await reconstructed.load(), await store.load());
  refuse = false;
  t.true(await reconstructed.release(failedId));
  t.deepEqual(await reconstructed.load(), []);
  t.deepEqual([...names], ['unrelated-name']);
});
