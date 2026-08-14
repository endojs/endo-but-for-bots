// @ts-nocheck

// End-to-end worked-example tests for @endo/slots.  Two clients
// converse through a synthetic supervisor (the loopback stub from
// `_loopback.js`), bootstrapped via the position-1 root convention.
// This pins down how the package fits together when the bus splice
// lands in bus-worker-node-raw.js and bus-manager-endor.js.

import test from '@endo/ses-ava/prepare-endo.js';
import { Far, E } from '@endo/far';

import { bootstrap } from '../src/bootstrap.js';
import { makeLoopback } from './_loopback.js';

test('two clients — bootstrap, send method, await reply', async t => {
  const { a, b } = makeLoopback();

  const aRoot = Far('a-root', {
    announce(greeting) {
      return `A heard: ${greeting}`;
    },
  });
  const bRoot = Far('b-root', {
    greet(name) {
      return `hello ${name}`;
    },
  });

  const { remoteRoot } = bootstrap({
    clist: a.clist,
    client: a.client,
    root: aRoot,
  });
  bootstrap({ clist: b.clist, client: b.client, root: bRoot });

  const reply = await E(remoteRoot).greet('world');
  t.is(reply, 'hello world');
});

test('primitive return values flow back', async t => {
  const { a, b } = makeLoopback();

  const bRoot = Far('b-root', {
    add(x, y) {
      return x + y;
    },
    concat(a_, b_) {
      return `${a_}/${b_}`;
    },
  });
  bootstrap({ clist: b.clist, client: b.client, root: bRoot });
  const { remoteRoot } = bootstrap({
    clist: a.clist,
    client: a.client,
    root: Far('a-root', {}),
  });

  t.is(await E(remoteRoot).add(2, 3), 5);
  t.is(await E(remoteRoot).concat('left', 'right'), 'left/right');
});

test('E(function)(value) applies the whole argument vector', async t => {
  const { a, b } = makeLoopback();

  // B's root is a *function* Exo — a callable remotable.  A function
  // application carries no method selector; the receiver hands the
  // complete argument vector to `applyFunction`.
  const bRoot = Far('b-fn', (x, y) => `fn(${x}, ${y})`);
  bootstrap({ clist: b.clist, client: b.client, root: bRoot });
  const { remoteRoot } = bootstrap({
    clist: a.clist,
    client: a.client,
    root: Far('a-root', {}),
  });

  t.is(await E(remoteRoot)('left', 'right'), 'fn(left, right)');
});

test('send-only method and function deliveries reach the target', async t => {
  const { a, b } = makeLoopback();

  const seen = [];
  const bRoot = Far('b-root', {
    note(value) {
      seen.push(['method', value]);
    },
  });
  bootstrap({ clist: b.clist, client: b.client, root: bRoot });
  const { remoteRoot } = bootstrap({
    clist: a.clist,
    client: a.client,
    root: Far('a-root', {}),
  });

  E.sendOnly(remoteRoot).note('hello');
  // Let the loopback pump the inbound deliver.
  await null;
  await null;
  t.deepEqual(seen, [['method', 'hello']]);
});

test('E(function) send-only applies with no reply tracking', async t => {
  const { a, b } = makeLoopback();

  const seen = [];
  const bRoot = Far('b-fn', (...args) => {
    seen.push(args);
  });
  bootstrap({ clist: b.clist, client: b.client, root: bRoot });
  const { remoteRoot } = bootstrap({
    clist: a.clist,
    client: a.client,
    root: Far('a-root', {}),
  });

  E.sendOnly(remoteRoot)('fire', 'forget');
  await null;
  await null;
  t.deepEqual(seen, [['fire', 'forget']]);
  t.is(a.client.pendingCount(), 0);
});

test('rejections propagate across the loopback', async t => {
  const { a, b } = makeLoopback();

  const bRoot = Far('b-root', {
    fail() {
      throw Error('expected');
    },
  });
  bootstrap({ clist: b.clist, client: b.client, root: bRoot });
  const { remoteRoot } = bootstrap({
    clist: a.clist,
    client: a.client,
    root: Far('a-root', {}),
  });

  await t.throwsAsync(() => E(remoteRoot).fail(), { message: /expected/ });
});
