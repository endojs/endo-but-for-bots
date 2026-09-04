// @ts-check
/**
 * The Endo petstore backend must load conversation nodes cheaply: one
 * `list()` plus a single parallel batch of `lookup()`s, served thereafter
 * from an in-memory index — not a fresh list()+lookup-per-node on every
 * getChildren/getNode (which made session loading O(N·depth) round trips).
 */

import '@endo/init/debug.js';

import test from 'ava';

import { makeConversationTree } from '../index.js';
import { makeEndoPetstoreBackend } from '../src/endopetstore-backend.js';

/** @import { ConversationTree } from '../types.js' */

// A promise plus its resolve, for sequencing the mock's round trips.
const makeDeferred = () => {
  /** @type {(value?: unknown) => void} */
  let resolve;
  // The Promise executor runs synchronously, so `resolve` is assigned by here.
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};

const noop = () => {};

// A mock powers handle backing an in-memory petstore, counting each remote
// method call so the tests can assert on round-trip counts. `E(powers).m()`
// works on a local object too, so no daemon is needed.
//
// `afterList` and `beforeLookup` are optional hooks awaited inside the
// corresponding method, which lets a test interleave a write with a load that
// is still in flight, or fail a round trip by throwing from the hook.
// `afterList` runs once the names have been captured, so the snapshot it
// releases is the pre-write one.
const makeMockPowers = ({ afterList = noop, beforeLookup = noop } = {}) => {
  /** @type {Map<string, unknown>} */
  const store = new Map();
  const counts = { list: 0, lookup: 0, storeValue: 0 };
  const powers = {
    async list() {
      counts.list += 1;
      const names = [...store.keys()];
      await afterList();
      return names;
    },
    /** @param {string} name */
    async lookup(name) {
      counts.lookup += 1;
      await beforeLookup();
      if (!store.has(name)) throw new Error(`unknown petname ${name}`);
      return store.get(name);
    },
    /**
     * @param {unknown} value
     * @param {string | string[]} pathOrName
     */
    async storeValue(value, pathOrName) {
      counts.storeValue += 1;
      const name = Array.isArray(pathOrName) ? pathOrName[0] : pathOrName;
      store.set(name, value);
    },
  };
  return { powers, counts, store };
};

/**
 * Build a linear chain of `depth` nodes and return the leaf id.
 *
 * @param {ConversationTree} tree
 * @param {number} depth
 * @returns {Promise<string>}
 */
const buildChain = async (tree, depth) => {
  const root = await tree.addNode(null, [{ role: 'system', content: 'sys' }]);
  let leaf = root.id;
  for (let i = 0; i < depth; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const node = await tree.addNode(leaf, [{ role: 'user', content: `m${i}` }]);
    leaf = node.id;
  }
  return leaf;
};

test('getPath loads all nodes in a single batch, then serves from cache', async t => {
  const { powers, counts } = makeMockPowers();
  const backend = makeEndoPetstoreBackend(powers);
  const tree = makeConversationTree(backend);

  const leaf = await buildChain(tree, 5); // 1 root + 5 = 6 nodes
  // Building only writes; nothing has read yet, so the index is unbuilt.
  counts.list = 0;
  counts.lookup = 0;

  const path = await tree.getPath(leaf);
  t.is(path.length, 6, 'every node on the branch contributes its messages');
  t.is(counts.list, 1, 'exactly one list() to discover node names');
  t.is(counts.lookup, 6, 'one lookup per node — a single parallel batch');

  // A second traversal is fully in-memory: no further round trips.
  const path2 = await tree.getPath(leaf);
  t.is(path2.length, 6);
  t.is(counts.list, 1, 'no re-list on cached reads');
  t.is(counts.lookup, 6, 'no re-lookup on cached reads');
});

test('getChildren returns siblings newest-last and stays cached', async t => {
  const { powers, counts } = makeMockPowers();
  const backend = makeEndoPetstoreBackend(powers);
  const tree = makeConversationTree(backend);

  const root = await tree.addNode(null, [{ role: 'system', content: 's' }]);
  const a = await tree.addNode(root.id, [{ role: 'user', content: 'a' }]);
  const b = await tree.addNode(root.id, [{ role: 'user', content: 'b' }]);

  const kids = await tree.getChildren(root.id);
  t.deepEqual(
    kids.map(k => k.id),
    [a.id, b.id],
    'children in insertion order (newest last)',
  );

  const listAfterFirst = counts.list;
  await tree.getChildren(root.id);
  t.is(counts.list, listAfterFirst, 'getChildren does not re-list once loaded');
});

test('a node added after load is visible via putNode index update', async t => {
  const { powers } = makeMockPowers();
  const backend = makeEndoPetstoreBackend(powers);
  const tree = makeConversationTree(backend);

  const root = await tree.addNode(null, [{ role: 'system', content: 's' }]);
  // Force a load so the index exists.
  await tree.getRoots();
  // Append after the index is built; putNode must keep it coherent.
  const child = await tree.addNode(root.id, [{ role: 'user', content: 'c' }]);

  const kids = await tree.getChildren(root.id);
  t.deepEqual(
    kids.map(k => k.id),
    [child.id],
  );
  const path = await tree.getPath(child.id);
  t.is(path.length, 2);
});

test('a write that lands while the first load is in flight is not lost', async t => {
  // The load's `list()` snapshot can predate a concurrent `putNode`, and
  // `index` is not assigned until the load settles — so the write has to join
  // the load rather than find no index to update. Getting this wrong drops the
  // node from the index permanently: nothing re-lists, so `getChildren` would
  // never report it again. A `putNode` that instead *waited* on the in-flight
  // load would deadlock this test rather than fail it, so bound the wait.
  t.timeout(10_000);
  const listed = makeDeferred();
  const lookupGate = makeDeferred();
  const { powers } = makeMockPowers({
    afterList: () => listed.resolve(),
    beforeLookup: () => lookupGate.promise,
  });
  const backend = makeEndoPetstoreBackend(powers);
  const tree = makeConversationTree(backend);

  const root = await tree.addNode(null, [{ role: 'system', content: 's' }]);

  // Start a read; its list() runs, then its lookups block.
  const rootsP = tree.getRoots();
  await listed.promise;
  // Write while that load is still in flight. The write must not have to wait
  // on the load — it is already durable — so this settles before the gate opens.
  const child = await tree.addNode(root.id, [{ role: 'user', content: 'c' }]);
  lookupGate.resolve();
  await rootsP;

  const kids = await tree.getChildren(root.id);
  t.deepEqual(
    kids.map(k => k.id),
    [child.id],
    'the concurrent write is in the index',
  );
  const path = await tree.getPath(child.id);
  t.is(path.length, 2, 'and the branch it created is walkable');
});

test('a failed load is not cached; a later read retries', async t => {
  let failNextList = true;
  const { powers, counts } = makeMockPowers({
    afterList: () => {
      if (failNextList) {
        failNextList = false;
        throw new Error('list unavailable');
      }
      return undefined;
    },
  });
  const backend = makeEndoPetstoreBackend(powers);
  const tree = makeConversationTree(backend);

  const root = await tree.addNode(null, [{ role: 'system', content: 's' }]);

  await t.throwsAsync(() => tree.getRoots(), {
    message: /list unavailable/,
  });
  t.is(counts.list, 1);

  // The rejection must not be cached as the index: the next read re-lists.
  const roots = await tree.getRoots();
  t.deepEqual(
    roots.map(r => r.id),
    [root.id],
  );
  t.is(counts.list, 2, 'the failed load did not poison the cache');
});

test('getNode falls back to a lookup for a node another writer added', async t => {
  // The index is a snapshot, so it deliberately does not observe a second
  // writer. `getNode` covers that with a direct lookup on a miss — the escape
  // hatch the single-writer assumption rests on.
  const { powers, counts, store } = makeMockPowers();
  const backend = makeEndoPetstoreBackend(powers);
  const tree = makeConversationTree(backend);

  const root = await tree.addNode(null, [{ role: 'system', content: 's' }]);
  await tree.getRoots(); // build the index
  const lookupsAfterLoad = counts.lookup;

  // Another backend writes behind ours; our snapshot predates it.
  const outsider = harden({
    id: 'outsider',
    parentId: root.id,
    messages: [{ role: 'user', content: 'o' }],
    metadata: {},
    timestamp: 0,
  });
  store.set('ct-outsider', outsider);

  t.is(await tree.getNode('outsider'), outsider, 'found by direct lookup');
  t.is(counts.lookup, lookupsAfterLoad + 1, 'exactly one fallback lookup');

  // Having been cached, it is served locally and is visible to getChildren.
  t.is(await tree.getNode('outsider'), outsider);
  t.is(counts.lookup, lookupsAfterLoad + 1, 'the fallback result is cached');
  const kids = await tree.getChildren(root.id);
  t.deepEqual(
    kids.map(k => k.id),
    ['outsider'],
  );
});

test('getNode returns null for a node that is nowhere', async t => {
  const { powers } = makeMockPowers();
  const tree = makeConversationTree(makeEndoPetstoreBackend(powers));

  await tree.addNode(null, [{ role: 'system', content: 's' }]);
  t.is(await tree.getNode('nope'), null, 'a failed lookup reads as absent');
});
