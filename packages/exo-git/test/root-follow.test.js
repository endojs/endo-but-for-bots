// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeGit, makeNotYetImplementedBackend } from '../src/index.js';

/** @import { GitRootSnapshot, GitRootTransition } from '../src/types.js' */

const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);

const within = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out: ${label}`)), 2000);
    }),
  ]);

/**
 * @returns {{ git: import('../src/types.js').ReadWriteEndoGit, advanceExternally: (treeOid: string) => void, failExternally: (error: Error) => void }}
 */
const makeHarness = () => {
  /** @type {{ treeOid: string, commitOid: string, treeAlgorithm: string } | null} */
  let current = null;
  let commitNumber = 0;
  /** @type {Array<{ resolve: (position: NonNullable<typeof current>) => void, reject: (error: Error) => void }>} */
  const waiting = [];

  const advance = treeOid => {
    commitNumber += 1;
    current = harden({
      treeOid,
      commitOid: commitNumber.toString(16).padStart(40, '0'),
      treeAlgorithm: 'git-sha1-tree',
    });
    for (const waiter of waiting.splice(0)) waiter.resolve(current);
  };

  const failExternally = error => {
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  };

  const base = makeNotYetImplementedBackend();
  const backend = harden({
    ...base,
    commit: async message => {
      advance(
        message === 'metadata only' && current !== null
          ? current.treeOid
          : TREE_B,
      );
      return harden({
        oid: /** @type {NonNullable<typeof current>} */ (current).commitOid,
        summary: message,
      });
    },
    resolveRoot: async () => current,
    resolveTree: async () => ({
      treeOid: /** @type {NonNullable<typeof current>} */ (current).treeOid,
    }),
    lsTree: async () => [],
    readBlobBytes: async () => new Uint8Array(),
    streamBlobBytes: () =>
      harden({
        async *[Symbol.asyncIterator]() {
          yield* [];
        },
      }),
    followRoot: ({ cancelled }) =>
      harden({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const position = await Promise.race([
              new Promise((resolve, reject) =>
                waiting.push({ resolve, reject }),
              ),
              cancelled,
            ]);
            yield /** @type {NonNullable<typeof current>} */ (position);
          }
        },
      }),
  });
  const mount = makeExo('RootFollowTestMount', undefined, {});
  const git = makeGit(
    /** @type {Parameters<typeof makeGit>[0]} */ (
      /** @type {unknown} */ ({
        mount,
        backend,
        lineageOf: () => undefined,
      })
    ),
  );
  return { git, advanceExternally: advance, failExternally };
};

test('lossless follower snapshots unborn HEAD and chains metadata-only commits', async t => {
  const { git } = makeHarness();
  const roots = iterateReader(E(git).followRootChanges());

  t.deepEqual(await roots.next(), {
    done: false,
    value: { type: 'snapshot', revision: 0n, position: null },
  });

  await E(git).commit('content');
  const first = await roots.next();
  t.false(first.done);
  const firstValue = /** @type {GitRootTransition} */ (first.value);
  t.like(firstValue, {
    type: 'transition',
    fromRevision: 0n,
    toRevision: 1n,
    position: {
      commitOid: '1'.padStart(40, '0'),
      tree: { algorithm: 'git-sha1-tree', hash: TREE_B },
    },
  });

  await E(git).commit('metadata only');
  const second = await roots.next();
  const secondValue = /** @type {GitRootTransition} */ (second.value);
  t.like(secondValue, {
    type: 'transition',
    fromRevision: 1n,
    toRevision: 2n,
    position: {
      commitOid: '2'.padStart(40, '0'),
      tree: { algorithm: 'git-sha1-tree', hash: TREE_B },
    },
  });
  t.is(firstValue.position.root, secondValue.position.root);

  await E(git).commit('metadata only');
  const third = await roots.next();
  const thirdValue = /** @type {GitRootTransition} */ (third.value);
  t.like(thirdValue, {
    fromRevision: 2n,
    toRevision: 3n,
    position: { tree: { hash: TREE_B } },
  });
  t.is(secondValue.position.root, thirdValue.position.root);
  await roots.return();
});

test('lossless and latest followers preserve their distinct slow-reader semantics', async t => {
  const { git } = makeHarness();
  const changes = iterateReader(E(git).followRootChanges());
  const latest = iterateReader(E(git).followLatestRoot());
  await within(
    Promise.all([changes.next(), latest.next()]),
    'initial followers',
  );

  await within(E(git).commit('one'), 'commit one');
  await within(E(git).commit('metadata only'), 'commit two');
  await within(E(git).commit('three'), 'commit three');

  /** @type {GitRootTransition[]} */
  const transitions = [];
  for (let index = 0; index < 3; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- each read proves ordering
    const next = await within(changes.next(), `lossless ${index + 1}`);
    transitions.push(/** @type {GitRootTransition} */ (next.value));
  }
  t.deepEqual(
    transitions.map(({ fromRevision, toRevision }) => [
      fromRevision,
      toRevision,
    ]),
    [
      [0n, 1n],
      [1n, 2n],
      [2n, 3n],
    ],
  );
  t.like((await within(latest.next(), 'latest')).value, {
    type: 'snapshot',
    revision: 3n,
    position: { commitOid: '3'.padStart(40, '0') },
  });

  await Promise.all([changes.return(), latest.return()]);
});

test('late read-only subscriber starts at the current immutable root', async t => {
  const { git } = makeHarness();
  await E(git).commit('one');
  await E(git).commit('metadata only');

  const readOnly = E(git).readOnly();
  const roots = iterateReader(E(readOnly).followRootChanges());
  const initial = await roots.next();
  const initialValue = /** @type {GitRootSnapshot} */ (initial.value);
  t.like(initialValue, {
    type: 'snapshot',
    revision: 1n,
    position: {
      commitOid: '2'.padStart(40, '0'),
      tree: { algorithm: 'git-sha1-tree', hash: TREE_B },
    },
  });
  t.truthy(initialValue.position);
  const root = /** @type {NonNullable<typeof initialValue.position>} */ (
    initialValue.position
  ).root;
  t.is(typeof (/** @type {any} */ (root).writeText), 'undefined');
  await roots.return();
});

test('backend watcher advancements share the same ordered follower', async t => {
  const { git, advanceExternally } = makeHarness();
  const roots = iterateReader(E(git).followRootChanges());
  await roots.next();

  const firstP = roots.next();
  advanceExternally(TREE_A);
  t.like((await firstP).value, {
    fromRevision: 0n,
    toRevision: 1n,
    position: { tree: { hash: TREE_A } },
  });
  await roots.return();
});

test('cancellation terminates one follower without revoking delivered roots', async t => {
  const { git } = makeHarness();
  /** @type {(error: Error) => void} */
  let cancel = () => {};
  const cancelled = new Promise((_resolve, reject) => {
    cancel = reject;
  });
  cancelled.catch(() => {});
  const roots = iterateReader(
    E(git).followRootChanges({
      cancelled: /** @type {Promise<never>} */ (cancelled),
    }),
  );
  const initial = (await roots.next()).value;
  const nextP = roots.next();
  cancel(new Error('stop following'));
  await t.throwsAsync(nextP, { message: 'stop following' });
  t.deepEqual(initial, { type: 'snapshot', revision: 0n, position: null });
});

test('source failure is sticky for one reader and a later follower recovers', async t => {
  const { git, failExternally } = makeHarness();
  const failedRoots = iterateReader(E(git).followRootChanges());
  await failedRoots.next();
  const failedNext = failedRoots.next();
  failExternally(new Error('watch source failed'));
  await t.throwsAsync(failedNext, { message: 'watch source failed' });

  const recoveredRoots = iterateReader(E(git).followRootChanges());
  t.deepEqual(await recoveredRoots.next(), {
    done: false,
    value: { type: 'snapshot', revision: 0n, position: null },
  });
  await recoveredRoots.return();
});
