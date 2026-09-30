// @ts-check
import { E, Far } from '@endo/far';
import test from '@endo/ses-ava/test.js';
import { setImmediate } from 'node:timers/promises';

import { makeObservableMap } from '../src/observable-map.js';
import { silentLogger } from '../src/platform/logging.js';
import { renderInventory } from '../src/tui/inventory-view.js';
import { printJson, terminalText } from '../src/tui/terminal-text.js';

const flush = async () => {
  await setImmediate();
};

test('inventory Map methods notify real changes and retain capability identity', async t => {
  const inventory = makeObservableMap();
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
  const inventory = makeObservableMap();
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
  const inventory = makeObservableMap();
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

test('keyOf indexes values by their most recently set key', t => {
  const map = makeObservableMap();
  const a = Far('A', {});
  const b = Far('B', {});
  t.is(map.keyOf(a), undefined);
  map.set('one', a);
  t.is(map.keyOf(a), 'one');
  // The same value under two keys: the key set last wins, and deleting it
  // falls back to the other holder.
  map.set('two', a);
  t.is(map.keyOf(a), 'two');
  t.true(map.delete('two'));
  t.is(map.keyOf(a), 'one');
  // Reassigning a key releases its previous value.
  map.set('one', b);
  t.is(map.keyOf(a), undefined);
  t.is(map.keyOf(b), 'one');
  map.set('one', b);
  t.is(map.keyOf(b), 'one');
  map.set('three', 7n);
  t.is(map.keyOf(7n), 'three');
  map.clear();
  t.is(map.keyOf(b), undefined);
  t.is(map.keyOf(7n), undefined);
  t.false(map.delete('one'));
});

test('printed JSON escapes every terminal control character and still parses', t => {
  /** @type {string[]} */
  const lines = [];
  const logger = {
    ...silentLogger,
    /** @param {unknown[]} args */
    log: (...args) => {
      lines.push(args.join(' '));
    },
  };
  const value = {
    text: 'clear\x1b[2J csi\x9b nel\x85 sep\u2028\u2029 del\x7f nul\0',
    from: 'bob\r\n',
  };
  printJson(logger, value);
  const [output] = lines;
  for (const raw of [
    '\x1b',
    '\x9b',
    '\x85',
    '\u2028',
    '\u2029',
    '\x7f',
    '\0',
    '\r',
  ]) {
    t.false(output.includes(raw), JSON.stringify(raw));
  }
  t.true(output.includes('\\u001b[2J'));
  t.true(output.includes('\\u009b'));
  t.true(output.includes('\\u2028'));
  // Indentation newlines are structural, and the escapes are JSON escapes.
  t.is(output.split('\n').length, 4);
  t.deepEqual(JSON.parse(output), value);
  t.is(terminalText('plain ☃ text 😀'), 'plain ☃ text 😀');
  t.is(terminalText('\u0085\u2029'), '\\u0085\\u2029');
});
