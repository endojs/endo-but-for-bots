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

// ---------------------------------------------------------------------------
// Adversarial coverage: persistence semantics under failure / corruption.
// ---------------------------------------------------------------------------

test('walkParents terminates on a synthesized cycle rather than infinite-looping', async t => {
  // A corrupt durable pet store can produce a cycle (`A -> B -> A`) that
  // ordinary `putNode` traffic never creates.  The walk must terminate
  // cleanly with a structured `cycle-detected` result instead of looping
  // forever; otherwise a single corrupted entry wedges the agent.
  //
  // We inject the cycle through the mock backing directly to bypass the
  // store's harden-frozen invariants.
  const powers = makeMockStoragePowers();
  powers.backing.set(
    transcriptPetName('A'),
    harden({
      messageId: 'A',
      parentMessageId: 'B',
      messages: [{ role: 'user', content: 'a' }],
    }),
  );
  powers.backing.set(
    transcriptPetName('B'),
    harden({
      messageId: 'B',
      parentMessageId: 'A',
      messages: [{ role: 'user', content: 'b' }],
    }),
  );
  const store = makeTranscriptStore(powers);

  const walk = await store.walkParents('A');
  t.false(walk.ok);
  if (!walk.ok) {
    t.is(walk.reason, 'cycle-detected');
    // 'A' is the leaf and the messageId that closes the cycle when revisited.
    t.is(walk.brokenAt, 'A');
    t.is(walk.leafMessageId, 'A');
  }

  // The strict assembler surfaces the cycle in its error message so the
  // agent's diagnostic distinguishes corruption from a normal missing-node.
  await t.throwsAsync(() => store.assembleTranscriptStrict('A'), {
    message: /cycle detected at A/,
  });
});

test('walkParents completes in linear time on a 100-deep chain', async t => {
  // Deeply nested conversations must not blow stack or scale badly.
  // 100 is well below the realistic conversation depth bound; a cycle bug
  // or accidental O(n^2) traversal would show up as a timeout here.
  const DEPTH = 100;
  const powers = makeMockStoragePowers();
  const store = makeTranscriptStore(powers);
  await buildLinearChain(store, DEPTH);

  // Cold-start the store so every lookup must round-trip the mock storage
  // rather than hitting the write-through cache.
  const fresh = makeTranscriptStore(powers);

  t.timeout(5000);
  const walk = await fresh.walkParents(`msg-${DEPTH - 1}`);
  t.true(walk.ok);
  if (walk.ok) {
    t.is(walk.chain.length, DEPTH);
    t.is(walk.chain[0].messageId, 'msg-0');
    t.is(walk.chain[DEPTH - 1].messageId, `msg-${DEPTH - 1}`);
  }

  // The flattened transcript is system(1) + (DEPTH-1) * (user + assistant).
  const transcript = await fresh.assembleTranscript(`msg-${DEPTH - 1}`);
  t.is(transcript.length, 1 + (DEPTH - 1) * 2);
});

test('concurrent putNode for the same messageId resolves to last-write-wins', async t => {
  // Two callers race to persist competing snapshots of the same node.
  // The store's contract is last-write-wins on durable state: whichever
  // `storeValue` resolves last is what a cold-start reader sees.  The
  // mock storage resolves synchronously per `Promise.resolve`, so the
  // *invocation* order pins the durable winner.  This test documents and
  // pins that behavior so a future refactor (e.g. introducing a queue or
  // a CAS) makes the choice deliberate rather than accidental.
  //
  // We capture every `storeValue` argument in arrival order so the test
  // remains sensitive to behavior changes like first-write-wins (which
  // would either skip the second write or reorder the writes).
  const backing = new Map();
  /** @type {string[]} */
  const writeOrder = [];
  const orderedPowers = harden({
    has: petName => Promise.resolve(backing.has(petName)),
    lookup: petName =>
      backing.has(petName)
        ? Promise.resolve(backing.get(petName))
        : Promise.reject(new Error(`Unknown: ${petName}`)),
    storeValue: (value, petName) => {
      const tag = value.messages[value.messages.length - 1].content;
      writeOrder.push(tag);
      backing.set(petName, value);
      return Promise.resolve();
    },
  });
  const store = makeTranscriptStore(orderedPowers);

  const first = store.putNode({
    messageId: 'race',
    parentMessageId: null,
    messages: [{ role: 'user', content: 'first' }],
  });
  const second = store.putNode({
    messageId: 'race',
    parentMessageId: null,
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ],
  });
  await Promise.all([first, second]);

  // Both writes must reach durable storage in the order they were issued.
  // A first-write-wins implementation (skipping the second `storeValue`)
  // would break this assertion.
  t.deepEqual(writeOrder, ['first', 'second']);

  // Cold-start: the second (later) write is what survives.
  const fresh = makeTranscriptStore(orderedPowers);
  const recovered = await fresh.getNode('race');
  t.truthy(recovered);
  t.is(recovered && recovered.messages.length, 2);
  t.is(recovered && recovered.messages[1].content, 'second');
});

test('a putNode whose durable write fails leaves the store cold-recoverable to its prior state', async t => {
  // Builder's `putNode` swallows storage errors with `console.error` so a
  // transient pet-store failure does not crash the agent.  The trade-off
  // is that a failed write is invisible at the call site but observable
  // on cold restart: the in-memory cache holds the new node, but the
  // durable layer does not.  Pin that behavior so any future change
  // (e.g. propagating the error or retrying) is a conscious decision.
  const backing = new Map();
  let failNextWrite = false;
  const crashablePowers = harden({
    has: petName => Promise.resolve(backing.has(petName)),
    lookup: petName => {
      if (!backing.has(petName)) {
        return Promise.reject(new Error(`Unknown: ${petName}`));
      }
      return Promise.resolve(backing.get(petName));
    },
    storeValue: (value, petName) => {
      if (failNextWrite) {
        return Promise.reject(new Error('simulated crash'));
      }
      backing.set(petName, value);
      return Promise.resolve();
    },
  });

  // First, persist a known-good node so we have a prior durable state.
  const store = makeTranscriptStore(crashablePowers);
  await store.putNode({
    messageId: 'before',
    parentMessageId: null,
    messages: [{ role: 'system', content: 'sys' }],
  });
  t.true(backing.has(transcriptPetName('before')));

  // Now make the next durable write fail (simulate process death between
  // accepting the call and committing the value).
  failNextWrite = true;
  await store.putNode({
    messageId: 'crashed',
    parentMessageId: 'before',
    messages: [{ role: 'user', content: 'lost' }],
  });
  failNextWrite = false;

  // Recovery: the durable layer is up again, but the failed write was
  // never persisted.  Cold-start sees only `before`.
  t.false(backing.has(transcriptPetName('crashed')));
  const fresh = makeTranscriptStore(crashablePowers);
  t.true(await fresh.hasNode('before'));
  t.false(await fresh.hasNode('crashed'));

  // And walking from the never-persisted leaf reports a clean missing-node
  // failure rather than producing a partial transcript.
  const walk = await fresh.walkParents('crashed');
  t.false(walk.ok);
  if (!walk.ok) {
    t.is(walk.reason, 'missing-node');
    t.is(walk.brokenAt, 'crashed');
  }
});
