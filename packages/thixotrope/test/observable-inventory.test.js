// @ts-check
import { E, Far } from '@endo/far';
import test from '@endo/ses-ava/test.js';
import { setImmediate } from 'node:timers/promises';

import { makeObservableInventory } from '../src/inventory/observable-inventory.js';
import { renderInventory } from '../src/inventory/inventory-view.js';

const flush = async () => {
  await setImmediate();
};

test('inventory Map methods notify real changes and retain capability identity', async t => {
  const inventory = makeObservableInventory();
  const updates = [];
  const observer = Far('Observer', {
    changed: snapshot => {
      updates.push(snapshot);
    },
  });
  const subscription = inventory.subscribe(observer);
  await flush();
  const counter = Far('Counter', { read: () => 42 });
  t.is(inventory.set('counter', counter), inventory);
  t.is(inventory.get('counter'), counter);
  t.true(inventory.has('counter'));
  t.is(inventory.getSize(), 1);
  await flush();
  t.deepEqual(
    updates.map(snapshot => snapshot.revision),
    [0n, 1n],
  );
  inventory.set('counter', counter);
  t.false(inventory.delete('absent'));
  await flush();
  t.is(updates.length, 2);
  inventory.clear();
  inventory.clear();
  await flush();
  t.deepEqual(updates[2], { revision: 2n, entries: [] });
  await E(subscription).unsubscribe();
  await E(subscription).unsubscribe();
  t.deepEqual(inventory.subscriptionCounts(), { durable: 0n, ephemeral: 0n });
  inventory.set('later', true);
  await flush();
  t.is(updates.length, 3);
});

test('slow observers coalesce snapshots and cancellation drops queued updates', async t => {
  const inventory = makeObservableInventory();
  /** @type {(() => void) | undefined} */
  let release;
  const pending = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  const updates = [];
  const subscription = inventory.subscribe(
    Far('SlowObserver', {
      changed: snapshot => {
        updates.push(snapshot);
        return pending;
      },
    }),
    true,
  );
  await flush();
  for (let index = 0; index < 100; index += 1) inventory.set('value', index);
  await flush();
  t.is(updates.length, 1);
  if (!release) throw Error('Missing release');
  release();
  await flush();
  t.is(updates.length, 2);
  t.is(updates[1].revision, 100n);
  await E(subscription).unsubscribe();
  t.deepEqual(inventory.subscriptionCounts(), { durable: 0n, ephemeral: 0n });
  inventory.set('value', 101);
  await flush();
  t.is(updates.length, 2);
});

test('failed observers are removed and epoch reset preserves durable subscriptions', async t => {
  const inventory = makeObservableInventory();
  inventory.subscribe(
    Far('Broken', {
      changed: () => {
        throw Error('gone');
      },
    }),
    true,
  );
  const durable = inventory.subscribe(Far('Durable', { changed: () => {} }));
  inventory.subscribe(Far('View', { changed: () => {} }), true);
  await flush();
  t.deepEqual(inventory.subscriptionCounts(), { durable: 1n, ephemeral: 1n });
  inventory.disconnectEphemeral();
  t.deepEqual(inventory.subscriptionCounts(), { durable: 1n, ephemeral: 0n });
  await E(durable).unsubscribe();
});

test('inventory display does not emit terminal control sequences from keys or values', t => {
  const rendered = renderInventory({
    revision: 1n,
    entries: [['evil\x1b[2J', 'value\r\n\x9b']],
  });
  t.false(rendered.includes('\x1b'));
  t.false(rendered.includes('\r'));
  t.false(rendered.includes('\x9b'));
  t.true(rendered.includes('evil\\u001b[2J'));
});
