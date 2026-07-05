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

// A mock powers handle backing an in-memory petstore, counting each remote
// method call so the tests can assert on round-trip counts. `E(powers).m()`
// works on a local object too, so no daemon is needed.
const makeMockPowers = () => {
  /** @type {Map<string, unknown>} */
  const store = new Map();
  const counts = { list: 0, lookup: 0, storeValue: 0 };
  const powers = {
    async list() {
      counts.list += 1;
      return [...store.keys()];
    },
    /** @param {string} name */
    async lookup(name) {
      counts.lookup += 1;
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

// Build a linear chain of `depth` nodes and return the leaf id.
const buildChain = async (tree, depth) => {
  const root = await tree.addNode(null, [{ role: 'system', content: 'sys' }]);
  let leaf = root.id;
  for (let i = 0; i < depth; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const node = await tree.addNode(leaf, [
      { role: 'user', content: `m${i}` },
    ]);
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
  t.deepEqual(kids.map(k => k.id), [child.id]);
  const path = await tree.getPath(child.id);
  t.is(path.length, 2);
});
