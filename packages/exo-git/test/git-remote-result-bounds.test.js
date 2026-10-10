// @ts-check
/// <reference types="ses"/>

/**
 * Coverage for the transparent, configurable bounding applied to
 * `GitRemote`'s network-sourced results (`fetch` / `pull` / `push`), and
 * for the structural guard ceiling that backstops it regardless of which
 * backend produced the result. See `../src/result-bounds.js` and the
 * `RemoteOperationResultShape` / `GitRefShape` guards in
 * `../src/interfaces.js`.
 *
 * @import { GitBackend } from '../src/git.js'
 * @import { GitRef, GitRemote, RemotePolicy } from '../src/types.js'
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import {
  makeGit,
  makeGitOperations,
  makeGitRemote,
  makeNotYetImplementedBackend,
} from '../src/index.js';
import { GitRemoteInterface } from '../src/interfaces.js';
import {
  DEFAULT_REMOTE_REF_STRING_LIMIT,
  DEFAULT_REMOTE_TEXT_LIMIT,
  DEFAULT_REMOTE_UPDATED_REFS_LIMIT,
  REMOTE_TEXT_MARKER_OVERHEAD,
  boundGitRef,
  boundRemoteOperationResult,
  truncateRemoteText,
} from '../src/result-bounds.js';

/** @returns {RemotePolicy} */
const makePolicy = () => ({
  url: 'file:///remote.git',
  allowedDirections: ['fetch', 'push'],
  fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
  pushRefspecs: ['refs/heads/*:refs/heads/*'],
  allowLocalFileTransport: true,
});

/**
 * @param {object} [args]
 * @param {Partial<GitBackend>} [args.backendOverrides]
 * @param {{ text?: number, updatedRefs?: number, refString?: number }} [args.resultLimits]
 */
const makeRemoteHarness = ({ backendOverrides = {}, resultLimits } = {}) => {
  /** @type {GitBackend} */
  const backend = harden({
    ...makeNotYetImplementedBackend(),
    remoteFetch: async () => harden({ updatedRefs: harden([]), text: '' }),
    remotePush: async () => harden({ updatedRefs: harden([]), text: '' }),
    revParse: async ref =>
      harden({
        name: /** @type {string} */ (ref),
        kind: 'commit',
        oid: '0'.repeat(40),
      }),
    merge: async () => 'merged',
    ...backendOverrides,
  });
  const mount = makeExo('FakeGitRemoteResultBoundsMount', undefined, {});
  const git = makeGit(
    /** @type {Parameters<typeof makeGit>[0]} */ (
      /** @type {unknown} */ ({ mount, backend, lineageOf: () => undefined })
    ),
  );
  const operations = makeGitOperations({ backend, git });
  const { remote, controller } = makeGitRemote({
    git,
    operations,
    name: 'origin',
    policy: makePolicy(),
    ...(resultLimits === undefined ? {} : { resultLimits }),
  });
  return { remote, controller };
};

// #region result-bounds.js pure functions

test('truncateRemoteText accepts at the bound and truncates with a marker over it', t => {
  const atBound = 'a'.repeat(100);
  t.is(truncateRemoteText(atBound, 100), atBound);

  const overBound = 'b'.repeat(150);
  const truncated = truncateRemoteText(overBound, 100);
  t.true(truncated.length <= 100);
  t.true(truncated.startsWith('b'.repeat(36)));
  t.regex(truncated, /\.\.\. \(truncated, 150 chars total\)$/);
});

test('boundGitRef truncates an oversized name/oid with a visible marker', t => {
  /** @type {GitRef} */
  const ref = harden({ kind: 'branch', name: 'short', oid: '0'.repeat(40) });
  t.deepEqual(boundGitRef(ref, 100), ref);

  const longName = 'x'.repeat(200);
  /** @type {GitRef} */
  const oversized = harden({ kind: 'branch', name: longName });
  const bounded = boundGitRef(oversized, 100);
  t.true(bounded.name.length <= 100);
  t.true(bounded.name.length < longName.length);
  t.regex(bounded.name, /\.\.\. \(truncated, 200 chars total\)$/);
});

test('boundRemoteOperationResult caps updatedRefs and reports the drop count', t => {
  const updatedRefs = harden(
    Array.from({ length: 5 }, (_, i) =>
      harden({
        remote: `refs/heads/b${i}`,
        result: /** @type {const} */ ('updated'),
      }),
    ),
  );
  const result = harden({ updatedRefs, text: 'ok' });

  const untouched = boundRemoteOperationResult(result, {
    text: 100,
    updatedRefs: 5,
    refString: 100,
  });
  t.is(untouched.updatedRefs.length, 5);
  t.is(untouched.droppedUpdatedRefsCount, undefined);

  const capped = boundRemoteOperationResult(result, {
    text: 100,
    updatedRefs: 3,
    refString: 100,
  });
  t.is(capped.updatedRefs.length, 3);
  t.is(capped.droppedUpdatedRefsCount, 2);
});

test('boundRemoteOperationResult accumulates an incoming droppedUpdatedRefsCount', t => {
  const updatedRefs = harden(
    Array.from({ length: 5 }, (_, i) =>
      harden({
        remote: `refs/heads/b${i}`,
        result: /** @type {const} */ ('updated'),
      }),
    ),
  );
  // An already-bounded backend result reports refs it dropped before this
  // layer ever saw them.  When this layer drops nothing, the incoming count
  // passes through; when it drops more, the counts add.
  const preBounded = harden({
    updatedRefs,
    text: 'ok',
    droppedUpdatedRefsCount: 7,
  });
  const passedThrough = boundRemoteOperationResult(preBounded, {
    text: 100,
    updatedRefs: 5,
    refString: 100,
  });
  t.is(passedThrough.updatedRefs.length, 5);
  t.is(passedThrough.droppedUpdatedRefsCount, 7);

  const accumulated = boundRemoteOperationResult(preBounded, {
    text: 100,
    updatedRefs: 3,
    refString: 100,
  });
  t.is(accumulated.updatedRefs.length, 3);
  t.is(accumulated.droppedUpdatedRefsCount, 9);
});

test('boundRemoteOperationResult ignores an invalid incoming droppedUpdatedRefsCount', t => {
  const updatedRefs = harden([
    harden({
      remote: 'refs/heads/main',
      result: /** @type {const} */ ('updated'),
    }),
  ]);
  const limits = { text: 100, updatedRefs: 5, refString: 100 };
  // A hostile or buggy backend can put anything in the field; only a
  // positive integer is an honest count of dropped array elements.
  for (const bogus of [3.5, -1, 0, NaN, Infinity, -Infinity, 2 ** 53, '4']) {
    const result = boundRemoteOperationResult(
      harden({
        updatedRefs,
        text: 'ok',
        droppedUpdatedRefsCount: /** @type {number} */ (bogus),
      }),
      limits,
    );
    t.is(result.droppedUpdatedRefsCount, undefined, `for ${String(bogus)}`);
    t.is(result.updatedRefs.length, 1);
  }
});

// #endregion

// #region makeGitRemote integration: transparent bounding at the exo boundary

test('GitRemote.fetch truncates an oversized text with a visible marker', async t => {
  const hugeText = 'g'.repeat(DEFAULT_REMOTE_TEXT_LIMIT + 500);
  const { remote } = makeRemoteHarness({
    backendOverrides: {
      remoteFetch: async () =>
        harden({ updatedRefs: harden([]), text: hugeText }),
    },
  });
  const result = await E(remote).fetch();
  t.is(result.text, truncateRemoteText(hugeText, DEFAULT_REMOTE_TEXT_LIMIT));
  t.true(result.text.length <= DEFAULT_REMOTE_TEXT_LIMIT);
  t.true(result.text.length < hugeText.length);
  t.regex(result.text, /\.\.\. \(truncated, \d+ chars total\)$/);
});

test('GitRemote.fetch leaves text at or under the bound untouched', async t => {
  const okText = 'g'.repeat(DEFAULT_REMOTE_TEXT_LIMIT);
  const { remote } = makeRemoteHarness({
    backendOverrides: {
      remoteFetch: async () =>
        harden({ updatedRefs: harden([]), text: okText }),
    },
  });
  const result = await E(remote).fetch();
  t.is(result.text, okText);
});

test('GitRemote.push caps an oversized updatedRefs array and reports the drop', async t => {
  const updatedRefs = harden(
    Array.from({ length: DEFAULT_REMOTE_UPDATED_REFS_LIMIT + 10 }, (_, i) =>
      harden({
        remote: `refs/heads/b${i}`,
        result: /** @type {const} */ ('updated'),
      }),
    ),
  );
  const { remote } = makeRemoteHarness({
    backendOverrides: {
      remotePush: async () => harden({ updatedRefs, text: 'ok' }),
    },
  });
  const result = await E(remote).push({ source: 'refs/heads/main' });
  t.is(result.updatedRefs.length, DEFAULT_REMOTE_UPDATED_REFS_LIMIT);
  t.is(result.droppedUpdatedRefsCount, 10);
});

test('GitRemote.push truncates an oversized ref-name string within updatedRefs', async t => {
  const longRemoteName = `refs/heads/${'r'.repeat(DEFAULT_REMOTE_REF_STRING_LIMIT + 200)}`;
  const { remote } = makeRemoteHarness({
    backendOverrides: {
      remotePush: async () =>
        harden({
          updatedRefs: harden([
            harden({
              remote: longRemoteName,
              result: /** @type {const} */ ('updated'),
            }),
          ]),
          text: 'ok',
        }),
    },
  });
  const result = await E(remote).push({ source: 'refs/heads/main' });
  const [update] = result.updatedRefs;
  t.true(update.remote.length < longRemoteName.length);
  t.regex(update.remote, /\.\.\. \(truncated, \d+ chars total\)$/);
});

test('GitRemote.pull truncates the fetched text nested under `fetch`', async t => {
  const hugeText = 'p'.repeat(DEFAULT_REMOTE_TEXT_LIMIT + 20);
  const { remote } = makeRemoteHarness({
    backendOverrides: {
      remoteFetch: async () =>
        harden({ updatedRefs: harden([]), text: hugeText }),
    },
  });
  const result = await E(remote).pull({ branch: 'refs/remotes/origin/main' });
  t.regex(result.fetch.text, /\.\.\. \(truncated, \d+ chars total\)$/);
  t.true(result.fetch.text.length <= DEFAULT_REMOTE_TEXT_LIMIT);
});

test('pull() bounds `head` with boundGitRef even though the local Git interface already bounds revParse', t => {
  // `head` in `GitRemote.pull`'s result comes from `E(git).revParse('HEAD')`,
  // which already crosses the (now-bounded) `GitRefShape` guard on the local
  // `Git` interface before `GitRemote` ever sees it — so there is no way to
  // drive an oversized `head` through a real `git` cap in this harness.
  // Cover `boundGitRef` (the same helper `pull()` applies to `head`) directly
  // instead; the defense-in-depth call in `git-remote.js` guards a `git`
  // implementation that does not enforce the guard as tightly.
  const hugeOid = 'a'.repeat(DEFAULT_REMOTE_REF_STRING_LIMIT + 20);
  const bounded = boundGitRef(
    harden({ kind: 'commit', name: 'HEAD', oid: hugeOid }),
    DEFAULT_REMOTE_REF_STRING_LIMIT,
  );
  t.true(
    /** @type {string} */ (bounded.oid).length <=
      DEFAULT_REMOTE_REF_STRING_LIMIT,
  );
  t.regex(
    /** @type {string} */ (bounded.oid),
    /\.\.\. \(truncated, \d+ chars total\)$/,
  );
});

test('GitRemote resultLimits option tightens the default bound', async t => {
  const text = 'z'.repeat(1000);
  const { remote } = makeRemoteHarness({
    backendOverrides: {
      remoteFetch: async () => harden({ updatedRefs: harden([]), text }),
    },
    resultLimits: { text: 100 },
  });
  const result = await E(remote).fetch();
  t.true(result.text.length < text.length);
  t.true(result.text.length <= 100);
  t.is(result.text, truncateRemoteText(text, 100));
  t.regex(result.text, /\.\.\. \(truncated, 1000 chars total\)$/);
});

test('GitRemote resultLimits option cannot widen past the guard ceiling', async t => {
  const hugeText = 'z'.repeat(DEFAULT_REMOTE_TEXT_LIMIT + 1000);
  const { remote } = makeRemoteHarness({
    backendOverrides: {
      remoteFetch: async () =>
        harden({ updatedRefs: harden([]), text: hugeText }),
    },
    // Absurdly large: must clamp to DEFAULT_REMOTE_TEXT_LIMIT, the guard's
    // structural ceiling, rather than let an oversized value through.
    resultLimits: { text: DEFAULT_REMOTE_TEXT_LIMIT * 100 },
  });
  const result = await E(remote).fetch();
  t.true(result.text.length <= DEFAULT_REMOTE_TEXT_LIMIT + 100);
});

test('GitRemote resultLimits rejects a non-positive override', t => {
  t.throws(
    () =>
      makeRemoteHarness({
        resultLimits: { text: 0 },
      }),
    { message: /resultLimits\.text must be a positive integer/ },
  );
});

test('GitRemote resultLimits rejects a fractional override', t => {
  // The limits are discrete capacities: `slice(0, 3.5)` would quietly keep
  // three entries while the dropped-count arithmetic reported a fraction.
  t.throws(() => makeRemoteHarness({ resultLimits: { updatedRefs: 3.5 } }), {
    message: /resultLimits\.updatedRefs must be a positive integer/,
  });
  t.throws(() => makeRemoteHarness({ resultLimits: { text: 100.5 } }), {
    message: /resultLimits\.text must be a positive integer/,
  });
  t.throws(() => makeRemoteHarness({ resultLimits: { refString: 99.9 } }), {
    message: /resultLimits\.refString must be a positive integer/,
  });
});

test('GitRemote resultLimits rejects a string limit too small to carry the marker', t => {
  t.throws(() => makeRemoteHarness({ resultLimits: { text: 1 } }), {
    message: /resultLimits\.text must be at least 64/,
  });
  t.throws(
    () =>
      makeRemoteHarness({
        resultLimits: { refString: REMOTE_TEXT_MARKER_OVERHEAD - 1 },
      }),
    { message: /resultLimits\.refString must be at least 64/ },
  );
  // `updatedRefs` carries its marker out of band (`droppedUpdatedRefsCount`),
  // so any positive integer cardinality is representable.
  t.notThrows(() => makeRemoteHarness({ resultLimits: { updatedRefs: 1 } }));
});

test('GitRemote resultLimits at the marker minimum still yields the full marker', async t => {
  const text = 'z'.repeat(1000);
  const { remote } = makeRemoteHarness({
    backendOverrides: {
      remoteFetch: async () => harden({ updatedRefs: harden([]), text }),
    },
    resultLimits: { text: REMOTE_TEXT_MARKER_OVERHEAD },
  });
  const result = await E(remote).fetch();
  t.true(result.text.length <= REMOTE_TEXT_MARKER_OVERHEAD);
  // The whole marker survives, original total included — nothing of the
  // promised evidence of truncation is sliced away at the minimum limit.
  t.regex(result.text, /\.\.\. \(truncated, 1000 chars total\)$/);
});

test('GitRemote.fetch accumulates a backend-reported droppedUpdatedRefsCount', async t => {
  const updatedRefs = harden(
    Array.from({ length: DEFAULT_REMOTE_UPDATED_REFS_LIMIT + 2 }, (_, i) =>
      harden({
        remote: `refs/heads/b${i}`,
        result: /** @type {const} */ ('updated'),
      }),
    ),
  );
  const { remote } = makeRemoteHarness({
    backendOverrides: {
      remoteFetch: async () =>
        harden({ updatedRefs, text: 'ok', droppedUpdatedRefsCount: 5 }),
    },
  });
  const result = await E(remote).fetch();
  t.is(result.updatedRefs.length, DEFAULT_REMOTE_UPDATED_REFS_LIMIT);
  // 5 dropped by the (already-bounded) backend + 2 dropped by this layer.
  t.is(result.droppedUpdatedRefsCount, 7);
});

// #endregion

// #region durable audit log retains bounded values

test('audit log records droppedUpdatedRefsCount and a truncated failure message', async t => {
  const updatedRefs = harden(
    Array.from({ length: DEFAULT_REMOTE_UPDATED_REFS_LIMIT + 3 }, (_, i) =>
      harden({
        remote: `refs/heads/b${i}`,
        result: /** @type {const} */ ('updated'),
      }),
    ),
  );
  const hugeMessage = 'boom '.repeat(DEFAULT_REMOTE_TEXT_LIMIT);
  let callCount = 0;
  const { remote, controller } = makeRemoteHarness({
    backendOverrides: {
      remoteFetch: async () => {
        callCount += 1;
        if (callCount === 1) {
          return harden({ updatedRefs, text: 'ok' });
        }
        throw new Error(hugeMessage);
      },
    },
  });
  await E(remote).fetch();
  await t.throwsAsync(E(remote).fetch());

  const events = await E(controller).audit();
  const success =
    /** @type {{ droppedUpdatedRefsCount?: number, updatedRefs: unknown[] }} */ (
      events.find(e => e.type === 'fetch' && e.outcome === 'ok')
    );
  const failure = /** @type {{ message: string }} */ (
    events.find(e => e.type === 'fetch' && e.outcome === 'error')
  );
  t.is(success.droppedUpdatedRefsCount, 3);
  t.is(success.updatedRefs.length, DEFAULT_REMOTE_UPDATED_REFS_LIMIT);
  t.true(failure.message.length < hugeMessage.length);
  t.regex(failure.message, /\.\.\. \(truncated, \d+ chars total\)$/);
});

test('audit log normalizes non-string rejection values before truncating', async t => {
  await null;
  // A backend may reject with any JavaScript value.  Each case below used
  // to either throw a TypeError inside the failure recorder (masking the
  // original failure and losing the audit entry) or smuggle a non-string
  // `message` past the length check unbounded.  The recorder must always
  // hand the truncator a real string and always record the entry.
  const cases = harden([
    // Truthy non-string `message`: previously made `truncateRemoteText`
    // read `.length` of a number and throw.
    { rejection: harden({ message: 42 }), expected: '[object Object]' },
    // Short array-valued `message`: previously passed the length check
    // unchanged, retaining its unbounded elements in the audit log.
    {
      rejection: harden({ message: harden(['y'.repeat(100_000)]) }),
      expected: '[object Object]',
    },
    // Primitive rejection: stringified whole.
    { rejection: 'boom-string', expected: 'boom-string' },
    // Hostile `message` getter: reading it must not mask the failure.
    {
      rejection: harden({
        get message() {
          throw new Error('hostile getter');
        },
      }),
      expected: '(failure reason is unprintable)',
    },
    // Hostile `toString` on a rejection with no usable `message`.
    {
      rejection: harden({
        message: 42,
        toString() {
          throw new Error('hostile toString');
        },
      }),
      expected: '(failure reason is unprintable)',
    },
  ]);
  for (const { rejection, expected } of cases) {
    const { remote, controller } = makeRemoteHarness({
      backendOverrides: {
        remoteFetch: async () => {
          throw rejection;
        },
      },
    });
    // eslint-disable-next-line no-await-in-loop
    await E(remote)
      .fetch()
      .then(
        () => t.fail('fetch must reject'),
        () => undefined,
      );
    // eslint-disable-next-line no-await-in-loop
    const events = await E(controller).audit();
    const failure = /** @type {{ message: string } | undefined} */ (
      events.find(e => e.type === 'fetch' && e.outcome === 'error')
    );
    t.truthy(failure, `audit entry recorded for ${String(expected)}`);
    t.is(
      /** @type {{ message: string }} */ (failure).message,
      expected,
      `bounded message for ${String(expected)}`,
    );
  }
});

// #endregion

// #region guard structurally rejects an unbounded result (defense in depth)

/**
 * A `GitRemote` exo whose methods are all stubs except the ones a test
 * supplies, so the guard — not the implementation — is what the test
 * exercises. Every method `GitRemoteInterface` advertises must be present or
 * `makeExo` rejects the behavior, so building the full set here keeps adding
 * a method to the interface from rippling through each test below.
 *
 * The override values are deliberately untyped: several tests below return
 * records the `GitRemote` type forbids, precisely to prove the runtime guard
 * rejects them independently of the compiler. Only the method *names* are
 * checked, so a typo still fails to compile rather than silently stubbing.
 *
 * @param {Partial<Record<keyof GitRemote, (...args: any[]) => any>>} overrides
 * @returns {GitRemote}
 */
const makeStubGitRemote = overrides => {
  const notNeeded = async () => {
    throw new Error('not needed');
  };
  return makeExo('GitRemote', GitRemoteInterface, {
    help: () => '',
    inspect: notNeeded,
    credentialHealth: notNeeded,
    fetch: notNeeded,
    pull: notNeeded,
    push: notNeeded,
    ...overrides,
  });
};

test('GitRemoteInterface rejects a fetch result whose text exceeds the guard ceiling', async t => {
  const exo = makeStubGitRemote({
    fetch: async () =>
      harden({
        updatedRefs: harden([]),
        text: 'x'.repeat(DEFAULT_REMOTE_TEXT_LIMIT + 1),
      }),
  });
  await t.throwsAsync(E(exo).fetch());
});

test('GitRemoteInterface rejects a fetch result whose updatedRefs exceeds the guard ceiling', async t => {
  const exo = makeStubGitRemote({
    fetch: async () =>
      harden({
        updatedRefs: harden(
          Array.from(
            { length: DEFAULT_REMOTE_UPDATED_REFS_LIMIT + 1 },
            (_, i) =>
              harden({
                remote: `refs/heads/b${i}`,
                result: /** @type {const} */ ('updated'),
              }),
          ),
        ),
        text: 'ok',
      }),
  });
  await t.throwsAsync(E(exo).fetch());
});

test('GitRemoteInterface accepts a fetch result exactly at the guard ceiling', async t => {
  const exo = makeStubGitRemote({
    fetch: async () =>
      harden({
        updatedRefs: harden(
          Array.from({ length: DEFAULT_REMOTE_UPDATED_REFS_LIMIT }, (_, i) =>
            harden({
              remote: `refs/heads/b${i}`,
              result: /** @type {const} */ ('updated'),
            }),
          ),
        ),
        text: 'x'.repeat(DEFAULT_REMOTE_TEXT_LIMIT),
      }),
  });
  const result = await E(exo).fetch();
  t.is(result.updatedRefs.length, DEFAULT_REMOTE_UPDATED_REFS_LIMIT);
  t.is(result.text.length, DEFAULT_REMOTE_TEXT_LIMIT);
});

// `RemoteCredentialHealthShape` is a two-armed union, not one record with
// optional fields: the arms are what keep `kind`/`audience` unreachable
// without `required: true`, and the empty rest pattern of each arm is what
// keeps credential material from riding along.
test('GitRemoteInterface rejects credential health that mixes the two arms', async t => {
  const exo = makeStubGitRemote({
    credentialHealth: async () =>
      harden({
        required: false,
        kind: 'bearer',
        audience: 'https://github.com',
        available: true,
        revoked: false,
      }),
  });
  await t.throwsAsync(E(exo).credentialHealth());
});

test('GitRemoteInterface rejects credential health that omits liveness when required', async t => {
  const exo = makeStubGitRemote({
    credentialHealth: async () => harden({ required: true }),
  });
  await t.throwsAsync(E(exo).credentialHealth());
});

test('GitRemoteInterface rejects credential health carrying material', async t => {
  const exo = makeStubGitRemote({
    credentialHealth: async () =>
      harden({
        required: true,
        kind: 'bearer',
        audience: 'https://github.com',
        available: true,
        revoked: false,
        material: harden({ token: 'test-token' }),
      }),
  });
  await t.throwsAsync(E(exo).credentialHealth());
});

test('GitRemoteInterface accepts each credential health arm exactly', async t => {
  const absent = makeStubGitRemote({
    credentialHealth: async () => harden({ required: false }),
  });
  t.deepEqual(await E(absent).credentialHealth(), { required: false });

  const present = makeStubGitRemote({
    credentialHealth: async () =>
      harden({
        required: true,
        kind: 'bearer',
        audience: 'https://github.com',
        available: true,
        revoked: false,
      }),
  });
  t.deepEqual(await E(present).credentialHealth(), {
    required: true,
    kind: 'bearer',
    audience: 'https://github.com',
    available: true,
    revoked: false,
  });
});

// #endregion
