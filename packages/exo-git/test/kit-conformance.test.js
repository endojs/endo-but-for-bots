// @ts-check
/// <reference types="ses"/>

/**
 * Conformance test for the `makeGitKit` exo class kit: walks every facet
 * against its schema (`GIT_READER_METHODS` / `GIT_WRITER_METHODS` /
 * `GIT_REWRITER_METHODS` in `interfaces.js`), then probes the transitive
 * authority of the capabilities each facet's methods hand back — the
 * facet-membership contract is only as strong as what a caller can reach
 * through a returned `worktree()` or `filesystemAt()` cap, not just the
 * method names a facet advertises directly.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { fc } from '@fast-check/ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import { isGitHistoryRewrite, isGitReadOnly, makeGitKit } from '../src/git.js';
import {
  GIT_READER_METHODS,
  GIT_REWRITER_METHODS,
  GIT_WRITER_METHODS,
} from '../src/interfaces.js';

const INTROSPECTION_METHODS = harden([
  '__getInterfaceGuard__',
  '__getMethodNames__',
]);

/**
 * The fallback `makeHelp` yields for a method it has no entry for.
 * Spelled out here rather than imported so the test pins the wording a
 * caller actually sees.
 *
 * @param {string} method
 * @returns {string}
 */
const unknownMethodHelp = method =>
  `No documentation available for method "${method}".`;

/**
 * @param {object} facet
 * @returns {Promise<string[]>}
 */
const methodNamesOf = async facet =>
  // eslint-disable-next-line no-underscore-dangle
  E(/** @type {any} */ (facet)).__getMethodNames__();

// #region Fake backend + mount
//
// exo-git's own test suite is portable (no Node, no native git binary): a
// minimal in-memory backend and mount, sufficient to exercise every
// `makeGitKit` method's guard and the `filesystemAt` read pipeline through
// `@endo/platform/fs/extended`, which only ever asks the backend for the
// tree-reading quartet (`resolveTree` / `lsTree` / `readBlobBytes` /
// `streamBlobBytes`).

const TREE_OID = 'tree-oid-1';
const BLOB_OID = 'blob-oid-1';
const FILE_NAME = 'README.md';
const FILE_BYTES = new TextEncoder().encode('hello\n');

/**
 * @param {(segments: string[]) => Promise<void>} [worktreeRemove]
 */
const makeFakeBackend = (worktreeRemove = async () => undefined) =>
  harden({
    assertRepositoryRoot: async () => undefined,
    assertNoExecutableRepoConfig: async () => undefined,
    status: async () => [],
    worktreeList: async () => [
      {
        path: '.',
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        head: '0'.repeat(40),
        branch: 'refs/heads/main',
      },
    ],
    worktreeAdd: async () => makeFakeBackend(worktreeRemove),
    worktreeRemove,
    diff: async () => '',
    log: async () => [],
    show: async () => '',
    revParse: async ref => ({
      name: typeof ref === 'string' ? ref : ref.name,
      kind: 'commit',
      oid: '0'.repeat(40),
    }),
    add: async () => undefined,
    restore: async () => undefined,
    checkoutConflict: async () => undefined,
    commit: async (message, options = {}) => ({
      oid: '1'.repeat(40),
      summary: message,
      ...(options.amend ? { author: 'amended' } : {}),
    }),
    reword: async (ref, message) => ({ oid: '2'.repeat(40), summary: message }),
    cherryPick: async () => '3'.repeat(40),
    currentBranch: async () => ({ name: 'main', kind: 'branch' }),
    branches: async () => [{ name: 'main', kind: 'branch' }],
    createBranch: async name => ({ name, kind: 'branch' }),
    deleteBranch: async () => undefined,
    renameBranch: async () => undefined,
    switchBranch: async () => undefined,
    detach: async () => undefined,
    switch: async () => undefined,
    merge: async () => 'merged',
    rebase: async () => 'rebased',
    stashPush: async () => 'stash@{0}',
    stashList: async () => [],
    stashShow: async () => '',
    stashApply: async () => undefined,
    stashPop: async () => undefined,
    stashDrop: async () => undefined,
    tree: async () => harden({}),
    remoteFetch: async () => harden({}),
    remotePush: async () => harden({}),
    async resolveTree() {
      return { treeOid: TREE_OID };
    },
    async resolveRoot() {
      return {
        treeOid: TREE_OID,
        commitOid: '0'.repeat(40),
        treeAlgorithm: 'git-sha1-tree',
      };
    },
    followRoot({ cancelled }) {
      return harden({
        async *[Symbol.asyncIterator]() {
          try {
            await cancelled;
          } catch {}
          yield* [];
        },
      });
    },
    async lsTree(treeOid) {
      if (treeOid !== TREE_OID) return [];
      return harden([
        {
          mode: '100644',
          type: 'blob',
          oid: BLOB_OID,
          size: FILE_BYTES.length,
          name: FILE_NAME,
        },
      ]);
    },
    async readBlobBytes(blobOid) {
      if (blobOid !== BLOB_OID) throw new Error(`unknown blob ${blobOid}`);
      return FILE_BYTES;
    },
    streamBlobBytes(blobOid) {
      if (blobOid !== BLOB_OID) throw new Error(`unknown blob ${blobOid}`);
      return {
        async *[Symbol.asyncIterator]() {
          yield FILE_BYTES;
        },
      };
    },
  });

/**
 * A repo-relative-segments PathEntry stand-in minted by the fake mount.
 *
 * @param {string[]} segments
 * @param {WeakSet<object>} [entries]
 */
const makeFakeEntry = (segments, entries) => {
  const entry = makeExo('FakeEntry', undefined, {
    segments: async () => segments,
    displayPath: () => segments.join('/'),
    child: () => makeFakeEntry(segments, entries),
    help: () => '',
  });
  entries?.add(entry);
  return entry;
};

/**
 * A minimal writable-mount fake plus its structural read-only view. Mirrors
 * the shape `daemon/test/git-remote.test.js`'s `makeFakeGitMount` uses:
 * enough of `WritableGitWorktree` / `ReadOnlyGitWorktree` for `makeGitKit`'s
 * own methods (`entry`, `readOnly`, `lookup`), plus one write-authority-
 * bearing method (`writeText`) present on the writable mount and absent
 * from its read-only view — the probe `worktree()` attenuation checks below
 * rely on that asymmetry. `worktree()`'s guard requires a real Remotable,
 * so the fakes are minted as exos (`makeExo`, no interface guard) rather
 * than plain hardened objects.
 */
/**
 * @param {{ failSubView?: boolean }} [options]
 */
const makeFakeMount = ({ failSubView = false } = {}) => {
  const entries = new WeakSet();
  const readOnlyMount = makeExo('FakeReadOnlyMount', undefined, {
    has: async () => false,
    list: async () => [],
    lookup: async () => undefined,
  });
  const mount = makeExo('FakeMount', undefined, {
    has: async () => false,
    list: async () => [],
    lookup: async () => undefined,
    subView: async () => {
      if (failSubView) {
        throw new Error('subView test failure');
      }
      return mount;
    },
    writeText: async () => undefined,
    remove: async () => undefined,
    move: async () => undefined,
    makeFile: async () => undefined,
    makeDirectory: async () => mount,
    readOnly: () => readOnlyMount,
    snapshot: async () => readOnlyMount,
    entry: segments => makeFakeEntry(segments, entries),
  });
  return { mount, readOnlyMount, entries };
};

/**
 * @param {{ failSubView?: boolean }} [options]
 * @returns {{ mount: object, backend: object, lineageOf: (v: unknown) => object | undefined, foreignEntry: object, removed: string[][] }}
 */
const makePowers = ({ failSubView = false } = {}) => {
  const { mount, entries } = makeFakeMount({ failSubView });
  const removed = [];
  const removeWorktree = async segments => {
    removed.push([...segments]);
  };
  const backend = makeFakeBackend(removeWorktree);
  const lineage = harden({});
  const foreignLineage = harden({});
  const foreignEntries = new WeakSet();
  const foreignEntry = makeFakeEntry(['foreign'], foreignEntries);
  const lineageOf = value =>
    value === mount || entries.has(value)
      ? lineage
      : foreignEntries.has(value)
        ? foreignLineage
        : undefined;
  return { mount, backend, lineageOf, foreignEntry, removed };
};

// #endregion

test('every facet advertises exactly its schema, no more and no less', async t => {
  const { reader, writer, rewriter } = makeGitKit(makePowers());
  const schemaByFacet = harden({
    reader: GIT_READER_METHODS,
    writer: GIT_WRITER_METHODS,
    rewriter: GIT_REWRITER_METHODS,
  });
  for (const [name, facet] of /** @type {const} */ ([
    ['reader', reader],
    ['writer', writer],
    ['rewriter', rewriter],
  ])) {
    // eslint-disable-next-line no-await-in-loop
    const advertised = (await methodNamesOf(facet)).filter(
      m => !INTROSPECTION_METHODS.includes(m),
    );
    t.deepEqual(
      [...advertised].sort(),
      [...schemaByFacet[name]].sort(),
      `${name} facet method set must equal its schema exactly`,
    );
  }
});

test('every facet documents its overview and each method it advertises', async t => {
  const { reader, writer, rewriter } = makeGitKit(makePowers());
  const schemaByFacet = harden({
    reader: GIT_READER_METHODS,
    writer: GIT_WRITER_METHODS,
    rewriter: GIT_REWRITER_METHODS,
  });
  for (const [name, facet] of /** @type {const} */ ([
    ['reader', reader],
    ['writer', writer],
    ['rewriter', rewriter],
  ])) {
    const schema = schemaByFacet[name];
    // eslint-disable-next-line no-await-in-loop
    const [overview, unknown, ...docs] = await Promise.all([
      E(facet).help(),
      E(facet).help('unknownMethod'),
      ...schema.map(method => E(facet).help(method)),
    ]);
    t.regex(
      overview,
      /^Git - /,
      `${name} overview must be the Git entity overview`,
    );
    schema.forEach((method, index) => {
      const doc = docs[index];
      t.not(doc, '', `${name}.${method} must have documentation`);
      t.not(
        doc,
        unknownMethodHelp(method),
        `${name}.${method} must have per-method documentation, not the fallback`,
      );
      t.true(
        doc.startsWith(`${method}(`),
        `${name}.${method} documentation must open with its signature`,
      );
    });
    t.is(unknown, unknownMethodHelp('unknownMethod'));
  }
});

test('worktree methods have specific help and retain the fallback contract', async t => {
  const { reader, writer } = makeGitKit(makePowers());
  const [listDoc, addDoc, unknown] = await Promise.all([
    E(reader).help('worktreeList'),
    E(writer).help('worktreeAdd'),
    E(reader).help('unknownWorktreeMethod'),
  ]);
  t.regex(listDoc, /^worktreeList\(\) -> Promise<GitWorktreeEntry\[\]>/);
  t.regex(addDoc, /^worktreeAdd\(entry, options\?\) -> Promise<Git>/);
  t.not(listDoc, '');
  t.not(addDoc, '');
  t.is(unknown, unknownMethodHelp('unknownWorktreeMethod'));
});

test('a method absent from a facet schema is absent, not merely rejecting', async t => {
  const { reader, writer } = makeGitKit(makePowers());

  // Every reader-absent, writer-present method.
  for (const name of GIT_WRITER_METHODS.filter(
    m => !GIT_READER_METHODS.includes(m),
  )) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(/** @type {any} */ (reader))[name](), {
      message: new RegExp(`has no method "${name}"`),
    });
  }

  // Every writer-absent, rewriter-present method.
  for (const name of GIT_REWRITER_METHODS.filter(
    m => !GIT_WRITER_METHODS.includes(m),
  )) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(/** @type {any} */ (writer))[name](), {
      message: new RegExp(`has no method "${name}"`),
    });
  }
});

test('posture is facet membership: isGitReadOnly / isGitHistoryRewrite reflect which facet a cap is', async t => {
  const { reader, writer, rewriter } = makeGitKit(makePowers());

  t.is(isGitReadOnly(reader), true);
  t.is(isGitReadOnly(writer), false);
  t.is(isGitReadOnly(rewriter), false);

  t.is(isGitHistoryRewrite(reader), false);
  t.is(isGitHistoryRewrite(writer), false);
  t.is(isGitHistoryRewrite(rewriter), true);

  // A foreign object shaped nothing like a Git facet: neither confirmed nor
  // denied, since it was never minted by this kit.
  const foreign = harden({});
  t.is(isGitReadOnly(foreign), undefined);
  t.is(isGitHistoryRewrite(foreign), undefined);
});

test('scope is closed and strictly non-escalating per facet', async t => {
  const { reader, writer, rewriter } = makeGitKit(makePowers());
  // Deliberately out-of-schema arguments below (escalation attempts, an
  // unknown name) are cast past the static overloads that already forbid
  // them, to pin the same rejection at the runtime guard.
  const anyReader = /** @type {any} */ (reader);
  const anyWriter = /** @type {any} */ (writer);
  const anyRewriter = /** @type {any} */ (rewriter);

  // Reader may only select itself.
  t.is(await E(reader).scope('reader'), reader);
  await t.throwsAsync(E(anyReader).scope('writer'));
  await t.throwsAsync(E(anyReader).scope('rewriter'));
  await t.throwsAsync(E(anyReader).scope('bogus'));

  // Writer may select itself or the reader, never the rewriter.
  t.is(await E(writer).scope('reader'), reader);
  t.is(await E(writer).scope('writer'), writer);
  await t.throwsAsync(E(anyWriter).scope('rewriter'));
  await t.throwsAsync(E(anyWriter).scope('bogus'));

  // Rewriter, holding the maximal authority already, may select any facet.
  t.is(await E(rewriter).scope('reader'), reader);
  t.is(await E(rewriter).scope('writer'), writer);
  t.is(await E(rewriter).scope('rewriter'), rewriter);
  await t.throwsAsync(E(anyRewriter).scope('bogus'));

  // Repeated calls return the identical pre-existing reference.
  t.is(await E(writer).scope('reader'), await E(writer).scope('reader'));
});

test('scope: the closed non-escalation rule holds for every (facet, requested name) pair', async t => {
  // The hand-picked cases above pin the 12 valid combinations that exist
  // today. This property covers the general, universally-quantified rule
  // itself: `scope` succeeds and returns the identical sibling iff the
  // requested name's authority rank is no higher than the calling facet's,
  // and rejects every other name (including one outside the vocabulary
  // entirely), for any facet.
  const kit = makeGitKit(makePowers());
  /** @type {Record<string, number>} */
  const rank = { reader: 0, writer: 1, rewriter: 2 };
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('reader', 'writer', 'rewriter'),
      fc.oneof(
        fc.constantFrom('reader', 'writer', 'rewriter'),
        fc.string().filter(s => !(s in rank)),
      ),
      async (fromLevel, toName) => {
        const facet = /** @type {any} */ (kit[fromLevel]);
        if (Object.prototype.hasOwnProperty.call(rank, toName)) {
          if (rank[toName] <= rank[fromLevel]) {
            const scoped = await E(facet).scope(toName);
            return (
              scoped ===
              kit[/** @type {'reader'|'writer'|'rewriter'} */ (toName)]
            );
          }
        }
        try {
          await E(facet).scope(toName);
          return false;
        } catch {
          return true;
        }
      },
    ),
  );
  t.pass();
});

test('readOnly() always attenuates to the one shared reader facet', async t => {
  const { reader, writer, rewriter } = makeGitKit(makePowers());
  t.is(await E(reader).readOnly(), reader);
  t.is(await E(writer).readOnly(), reader);
  t.is(await E(rewriter).readOnly(), reader);
});

test('worktree(): the reader facet hands back a structural read-only view, never the writable mount', async t => {
  const powers = makePowers();
  const { reader, writer, rewriter } = makeGitKit(powers);

  const writable = /** @type {any} */ (await E(writer).worktree());
  t.is(
    writable,
    powers.mount,
    'writer.worktree() passes the writable mount through unchanged',
  );
  t.true(
    typeof writable.writeText === 'function',
    'the writable mount carries write authority',
  );

  const readOnlyView = await E(reader).worktree();
  t.not(
    readOnlyView,
    powers.mount,
    'reader.worktree() must not be the writable mount itself',
  );
  t.false(
    'writeText' in /** @type {any} */ (readOnlyView),
    'the read-only worktree view must not carry write authority',
  );

  // The rewriter facet is cumulative over the writer: same pass-through
  // writable worktree, same identity as the writer's.
  t.is(await E(rewriter).worktree(), powers.mount);
});

test('worktreeList is readable and worktreeAdd preserves the creating posture', async t => {
  const powers = makePowers();
  const { reader, writer, rewriter } = makeGitKit(powers);
  const entry = powers.mount.entry(['linked']);

  t.deepEqual(await E(reader).worktreeList(), [
    {
      path: '.',
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      head: '0'.repeat(40),
      branch: 'refs/heads/main',
    },
  ]);

  const writerDerived = await E(writer).worktreeAdd(entry, {
    ref: 'HEAD',
    newBranch: 'linked',
  });
  t.is(isGitReadOnly(writerDerived), false);
  t.is(isGitHistoryRewrite(writerDerived), false);
  t.truthy(await E(writerDerived).currentBranch());

  const rewriterDerived = await E(rewriter).worktreeAdd(entry, {
    ref: 'HEAD',
  });
  t.is(isGitReadOnly(rewriterDerived), false);
  t.is(isGitHistoryRewrite(rewriterDerived), true);

  const escaped = powers.mount.entry(['..', 'outside']);
  await t.throwsAsync(E(writer).worktreeAdd(escaped, { ref: 'HEAD' }), {
    message: /confined mount-relative PathEntry/,
  });
  await t.throwsAsync(
    E(writer).worktreeAdd(powers.foreignEntry, { ref: 'HEAD' }),
    { message: /different mount lineage/ },
  );
  await t.throwsAsync(E(writer).worktreeAdd(powers.mount.entry([])), {
    message: /non-empty confined mount-relative PathEntry/,
  });
  for (const segment of ['.git', '.GIT', 'git~1']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      E(writer).worktreeAdd(powers.mount.entry([segment]), { ref: 'HEAD' }),
      { message: /non-empty confined mount-relative PathEntry/ },
    );
  }
  await t.throwsAsync(
    E(/** @type {any} */ (reader)).worktreeAdd(entry, { ref: 'HEAD' }),
    {
      message: /has no method "worktreeAdd"/,
    },
  );
});

test('worktreeAdd compensates when the destination mount cannot be narrowed', async t => {
  const powers = makePowers({ failSubView: true });
  const { writer } = makeGitKit(powers);
  await t.throwsAsync(
    E(writer).worktreeAdd(powers.mount.entry(['linked']), { ref: 'HEAD' }),
    { message: /subView test failure/ },
  );
  t.deepEqual(powers.removed, [['linked']]);
});

test('filesystemAt(): the memo is per instance, and the returned Filesystem rejects every mutation regardless of facet', async t => {
  const powers = makePowers();
  const { reader, writer } = makeGitKit(powers);

  const fsFromReader = await E(reader).filesystemAt('HEAD');
  const fsFromWriter = await E(writer).filesystemAt('HEAD');
  t.is(
    fsFromReader,
    fsFromWriter,
    'the filesystemAt memo is shared across facets of one instance, not per facet',
  );

  const root = /** @type {any} */ (await E(fsFromWriter).root());
  const file = /** @type {any} */ (await E(root).lookup(FILE_NAME));
  t.truthy(
    file,
    "the fake tree's one file resolves through the real fs/extended pipeline",
  );

  // Transitive mutator probe: a Filesystem obtained through the *writer*
  // facet — which itself has full worktree write authority — must still
  // reject every mutating verb, because git tree reads are inherently
  // immutable regardless of which facet asked for them.
  await t.throwsAsync(E(root).create('new.txt', {}), { message: /EACCES/ });
  await t.throwsAsync(E(root).unlink(FILE_NAME), { message: /EACCES/ });
  await t.throwsAsync(E(file).open({ write: true }), { message: /EACCES/ });
});
