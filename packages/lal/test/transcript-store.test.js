// @ts-nocheck
/* eslint-disable no-await-in-loop, @jessie.js/safe-await-separator */

import test from '@endo/ses-ava/prepare-endo.js';

import { makeTranscriptStore, transcriptPetName } from '../transcript-store.js';

/** @import { TranscriptNode } from '../agent.types.js' */
/** @import { ChatMessage } from '../agent.types.js' */

/**
 * A minimal in-memory stand-in for the subset of Endo guest powers the
 * transcript store uses: `has`, `lookup`, `storeValue`.  Backed by a `Map`
 * that callers can pass in (so two stores can share the same "durable
 * storage" to simulate a cold restart).
 *
 * @param {Map<string, unknown>} [backing]
 */
const makeMockStoragePowers = (backing = new Map()) => {
  return {
    has: petName => Promise.resolve(backing.has(petName)),
    lookup: petName => {
      if (!backing.has(petName)) {
        return Promise.reject(new Error(`Unknown: ${petName}`));
      }
      return Promise.resolve(backing.get(petName));
    },
    storeValue: (value, petName) => {
      backing.set(petName, value);
      return Promise.resolve();
    },
    backing,
  };
};

/**
 * Build a chain of `count` transcript nodes, root-to-leaf, with stable
 * deterministic messageIds (`msg-0` is the root, `msg-{count-1}` the leaf).
 * The root node carries a system message; every subsequent node carries
 * one user message and one assistant message so that the assembled
 * transcript is easy to inspect.
 *
 * @param {ReturnType<typeof makeTranscriptStore>} store
 * @param {number} count
 */
const buildLinearChain = async (store, count) => {
  /** @type {TranscriptNode[]} */
  const nodes = [];
  for (let i = 0; i < count; i += 1) {
    /** @type {ChatMessage[]} */
    const messages =
      i === 0
        ? [{ role: 'system', content: 'system prompt' }]
        : [
            { role: 'user', content: `user-${i}` },
            { role: 'assistant', content: `assistant-${i}` },
          ];
    /** @type {TranscriptNode} */
    const node = harden({
      messageId: `msg-${i}`,
      parentMessageId: i === 0 ? null : `msg-${i - 1}`,
      messages,
    });
    // eslint-disable-next-line no-await-in-loop
    await store.putNode({ ...node, messages: [...node.messages] });
    nodes.push(node);
  }
  return nodes;
};

test('putNode persists nodes under the documented pet-name scheme', async t => {
  const powers = makeMockStoragePowers();
  const store = makeTranscriptStore(powers);

  await store.putNode({
    messageId: 'abc123',
    parentMessageId: null,
    messages: [{ role: 'system', content: 'sys' }],
  });

  t.true(
    powers.backing.has(transcriptPetName('abc123')),
    'node stored under transcript-<messageId>',
  );
  t.is(transcriptPetName('abc123'), 'transcript-abc123');
});

test('getNode resolves via cache and via durable storage', async t => {
  const powers = makeMockStoragePowers();
  const store = makeTranscriptStore(powers);

  await store.putNode({
    messageId: 'leaf',
    parentMessageId: null,
    messages: [{ role: 'system', content: 'sys' }],
  });

  const cached = await store.getNode('leaf');
  t.truthy(cached);
  t.is(cached && cached.messageId, 'leaf');

  // Drop the cache by forging a fresh store against the same backing.
  // The lookup must now resolve from durable storage.
  const fresh = makeTranscriptStore(powers);
  const recovered = await fresh.getNode('leaf');
  t.truthy(recovered);
  t.is(recovered && recovered.messageId, 'leaf');
});

test('getNode returns undefined for an unknown messageId', async t => {
  const store = makeTranscriptStore(makeMockStoragePowers());
  const missing = await store.getNode('nope');
  t.is(missing, undefined);
});

test('reply-chain reassembly survives inbox-message dismissal', async t => {
  // The transcript store is independent of the inbox: dismissing messages
  // from the inbox does not affect persisted nodes.  Simulate that by
  // building a 3-node chain, "dismissing" the middle message (a no-op
  // from the store's perspective, since the inbox is not the store), and
  // walking from the leaf.  The full chain must still resolve.
  const powers = makeMockStoragePowers();
  const store = makeTranscriptStore(powers);
  await buildLinearChain(store, 3);

  // Simulated inbox dismissal: a real inbox would drop the message,
  // but the transcript node lives in the pet store, not the inbox.
  // The store's view of `msg-1` must be unchanged.
  const middle = await store.getNode('msg-1');
  t.truthy(middle, 'middle node still resolvable after inbox dismissal');

  const transcript = await store.assembleTranscript('msg-2');
  t.is(transcript.length, 5, 'system + 2 user + 2 assistant messages');
  t.is(transcript[0].role, 'system');
  t.is(transcript[1].role, 'user');
  t.is(transcript[1].content, 'user-1');
  t.is(transcript[4].role, 'assistant');
  t.is(transcript[4].content, 'assistant-2');
});

test('cold-start: a fresh store recovers the full chain from durable storage', async t => {
  // Simulate killing and restarting the lal agent: the in-memory cache
  // is gone, but every node persisted via `storeValue` must still be
  // walkable.  Two stores share one backing `Map` to model the two
  // process lifetimes.
  const powers = makeMockStoragePowers();
  const before = makeTranscriptStore(powers);
  await buildLinearChain(before, 4);

  // Cold start: build a brand-new store against the same durable backing.
  const after = makeTranscriptStore(powers);

  // The cache is empty on the fresh store.
  // Walk from the leaf: each node must come from durable storage.
  const walk = await after.walkParents('msg-3');
  t.true(walk.ok, 'walk succeeds on a cold store');
  if (walk.ok) {
    t.is(walk.chain.length, 4);
    t.deepEqual(
      walk.chain.map(n => n.messageId),
      ['msg-0', 'msg-1', 'msg-2', 'msg-3'],
    );
  }

  const transcript = await after.assembleTranscript('msg-3');
  t.is(transcript.length, 7, 'system + 3 user + 3 assistant');
});

test('orphan: walking from a leaf whose parent never persisted returns a failure result', async t => {
  // The agent observes a reply whose parent transcript node was never
  // persisted (data corruption, partial GC of the pet store).  Walking
  // from the leaf must surface the broken chain rather than silently
  // truncating: `walkParents` returns `{ ok: false, brokenAt }` and the
  // strict assembler throws.
  const powers = makeMockStoragePowers();
  const store = makeTranscriptStore(powers);

  // Persist a leaf whose parent is non-null but absent from storage.
  await store.putNode({
    messageId: 'orphan-leaf',
    parentMessageId: 'never-persisted-parent',
    messages: [
      { role: 'user', content: 'detached user message' },
      { role: 'assistant', content: 'detached assistant reply' },
    ],
  });

  const walk = await store.walkParents('orphan-leaf');
  t.false(walk.ok);
  if (!walk.ok) {
    t.is(walk.reason, 'missing-node');
    t.is(walk.brokenAt, 'never-persisted-parent');
    t.is(walk.leafMessageId, 'orphan-leaf');
  }

  await t.throwsAsync(() => store.assembleTranscriptStrict('orphan-leaf'), {
    message: /Broken transcript chain.*never-persisted-parent/,
  });
});

test('orphan: walking from a leaf that itself was never persisted reports a missing node', async t => {
  const store = makeTranscriptStore(makeMockStoragePowers());
  const walk = await store.walkParents('ghost-leaf');
  t.false(walk.ok);
  if (!walk.ok) {
    t.is(walk.brokenAt, 'ghost-leaf');
  }
});

test('putAlias makes an alias messageId resolve to the same chain', async t => {
  // When the agent observes its own outbound message, the outbound
  // messageId becomes an alias for the inbound parent's transcript node:
  // future inbound replies whose `replyTo` is the outbound messageId
  // must find the existing chain via the alias.
  const powers = makeMockStoragePowers();
  const store = makeTranscriptStore(powers);

  await store.putNode({
    messageId: 'inbound-1',
    parentMessageId: null,
    messages: [{ role: 'system', content: 'sys' }],
  });
  const node = await store.getNode('inbound-1');
  t.truthy(node);
  await store.putAlias('outbound-1', /** @type {TranscriptNode} */ (node));

  // A fresh store (cold start) resolves the alias from durable storage.
  const fresh = makeTranscriptStore(powers);
  const aliased = await fresh.getNode('outbound-1');
  t.truthy(aliased);
  t.is(aliased && aliased.messageId, 'inbound-1');
});

test('persistence boundary: every putNode commits to durable storage', async t => {
  // The design requires that "every Endo message the agent processes is
  // mapped to a durable transcript node".  Verify that each putNode call
  // (one per processed message) increments the durable store's footprint.
  const powers = makeMockStoragePowers();
  const store = makeTranscriptStore(powers);

  await store.putNode({
    messageId: 'a',
    parentMessageId: null,
    messages: [{ role: 'system', content: 'sys' }],
  });
  t.is(powers.backing.size, 1);

  await store.putNode({
    messageId: 'b',
    parentMessageId: 'a',
    messages: [{ role: 'user', content: 'hi' }],
  });
  t.is(powers.backing.size, 2);

  // Re-putting an existing node updates the same key, not a new one.
  await store.putNode({
    messageId: 'b',
    parentMessageId: 'a',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  });
  t.is(powers.backing.size, 2);

  // Cold-restart and confirm the latest-state-wins for the updated node.
  const fresh = makeTranscriptStore(powers);
  const recovered = await fresh.getNode('b');
  t.truthy(recovered);
  t.is(recovered && recovered.messages.length, 2);
});

test('hasNode is true once persisted, false otherwise', async t => {
  const powers = makeMockStoragePowers();
  const store = makeTranscriptStore(powers);
  t.false(await store.hasNode('x'));
  await store.putNode({
    messageId: 'x',
    parentMessageId: null,
    messages: [{ role: 'system', content: 'sys' }],
  });
  t.true(await store.hasNode('x'));

  // Cold-start: the in-memory cache is gone, but the durable answer is the same.
  const fresh = makeTranscriptStore(powers);
  t.true(await fresh.hasNode('x'));
  t.false(await fresh.hasNode('y'));
});
