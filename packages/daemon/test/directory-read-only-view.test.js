import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { readableNameHubMethodGuards } from '@endo/platform/fs/lite';

import { makeReadOnlyDirectoryView } from '../src/directory.js';

// `makeReadOnlyDirectoryView` mints the local `ReadableNameHub` exo that
// `EndoDirectory.readOnly()` — and the mailbox / message hub views in
// `manager.js` — hand to a (possibly less-trusted) holder. It is a plain
// in-daemon exo, so these unit tests exercise it directly against a stub
// backing hub (no daemon fork): they pin the attenuation surface, prove the
// interface guard rejects malformed arguments at THIS boundary, and pin the
// null-prototype `help` fallback the module comment claims.

/**
 * @returns {{ hub: any, calls: Array<[string, unknown[]]> }}
 */
const makeStubHub = () => {
  /** @type {Array<[string, unknown[]]>} */
  const calls = [];
  const hub = Far('StubHub', {
    has: async (...path) => {
      calls.push(['has', path]);
      return true;
    },
    list: async (...path) => {
      calls.push(['list', path]);
      return ['a', 'b'];
    },
    lookup: async (/** @type {any} */ path) => {
      calls.push(['lookup', [path]]);
      return 'looked-up';
    },
    maybeLookup: async (/** @type {any} */ path) => {
      calls.push(['maybeLookup', [path]]);
      return 'maybe';
    },
  });
  return { hub, calls };
};

test('the read-only view exposes exactly the ReadableNameHub surface', async t => {
  const { hub } = makeStubHub();
  const view = makeReadOnlyDirectoryView(hub);
  // eslint-disable-next-line no-underscore-dangle
  const methodNames = await E(/** @type {any} */ (view)).__getMethodNames__();
  // Drop the exo meta-methods (`__getInterfaceGuard__`, `__getMethodNames__`)
  // so only the declared interface surface is compared.
  const declared = [...methodNames]
    .filter(name => !name.startsWith('__'))
    .sort();
  t.deepEqual(declared, Object.keys(readableNameHubMethodGuards).sort());
  // None of the directory's mutators leak onto the view.
  for (const mutator of [
    'storeIdentifier',
    'storeLocator',
    'remove',
    'move',
    'copy',
    'makeDirectory',
    'writeText',
  ]) {
    t.false(declared.includes(mutator), `${mutator} must not be on the view`);
  }
});

test('the read-only view forwards its reads to the backing hub', async t => {
  const { hub, calls } = makeStubHub();
  const view = makeReadOnlyDirectoryView(hub);

  t.is(await E(view).has('one'), true);
  t.deepEqual([...(await E(view).list())], ['a', 'b']);
  t.is(await E(view).lookup('one'), 'looked-up');
  t.is(await E(view).maybeLookup('two'), 'maybe');

  t.deepEqual(calls, [
    ['has', ['one']],
    ['list', []],
    ['lookup', ['one']],
    ['maybeLookup', ['two']],
  ]);
});

test('the interface guard rejects malformed arguments at the view boundary', async t => {
  const { hub, calls } = makeStubHub();
  const view = makeReadOnlyDirectoryView(hub);

  // `lookup`/`maybeLookup` require a string or string[]; `has`/`list` require a
  // rest of string[]. A number is refused by the guard BEFORE it reaches the
  // backing hub — so the stub records nothing for these calls.
  await t.throwsAsync(E(/** @type {any} */ (view)).lookup(42), {
    message: /ReadableNameHub/,
  });
  await t.throwsAsync(E(/** @type {any} */ (view)).maybeLookup(42), {
    message: /ReadableNameHub/,
  });
  await t.throwsAsync(E(/** @type {any} */ (view)).has(42), {
    message: /ReadableNameHub/,
  });
  await t.throwsAsync(E(/** @type {any} */ (view)).list(42), {
    message: /ReadableNameHub/,
  });
  t.deepEqual(calls, [], 'no malformed call reached the backing hub');
});

test('help() returns a plain string, never an inherited prototype value', async t => {
  const { hub } = makeStubHub();
  const view = makeReadOnlyDirectoryView(hub);

  const overview = await E(view).help();
  t.true(overview.startsWith('ReadableNameHub'));

  // A documented method returns its own entry, not the overview.
  const lookupDoc = await E(view).help('lookup');
  t.true(lookupDoc.startsWith('lookup('));
  t.not(lookupDoc, overview);

  // The security contract: a caller-supplied method name that only resolves
  // through `Object.prototype` (`constructor`, `toString`, `hasOwnProperty`,
  // `__proto__`, `valueOf`) must NOT reach an inherited value. `makeHelp` uses
  // an own-property lookup, so each returns the shared "no documentation"
  // string — a plain string that satisfies the `help(method?) -> string` return
  // guard — rather than an `Object.prototype` function that would trip it. If
  // `makeHelp` ever regresses to an `in` (prototype-walking) lookup, these
  // redden with a return-guard rejection.
  const evilNames = [
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
    'valueOf',
    'isPrototypeOf',
    'not-a-real-method',
  ];
  const evilDocs = await Promise.all(evilNames.map(name => E(view).help(name)));
  evilDocs.forEach((doc, i) => {
    t.is(
      doc,
      `No documentation available for method "${evilNames[i]}".`,
      `help(${JSON.stringify(evilNames[i])}) must return a plain miss string`,
    );
  });
});

test('empty and multi-segment path arguments forward verbatim to the backing hub', async t => {
  const { hub, calls } = makeStubHub();
  const view = makeReadOnlyDirectoryView(hub);

  // The guard admits `''`, `[]`, a multi-segment array, and a zero-length rest
  // for `has`/`list`. None are rejected at THIS boundary (they are value, not
  // type, confusion — `assertNamePath`/`assertName` reject them downstream at
  // the backing hub), so each must forward through unchanged.
  t.is(await E(view).lookup(''), 'looked-up');
  t.is(await E(view).lookup([]), 'looked-up');
  t.is(await E(view).maybeLookup(['a', 'b']), 'maybe');
  await E(view).has();
  await E(view).list();

  t.deepEqual(calls, [
    ['lookup', ['']],
    ['lookup', [[]]],
    ['maybeLookup', [['a', 'b']]],
    ['has', []],
    ['list', []],
  ]);
});

test('the liveness gate severs every read once the backing capability is canceled', async t => {
  const { hub, calls } = makeStubHub();
  let cancelled = false;
  const assertLive = () => {
    if (cancelled) {
      throw new Error('Directory has been revoked');
    }
  };
  const view = makeReadOnlyDirectoryView(hub, assertLive);

  // Live: reads forward to the backing hub.
  t.is(await E(view).has('one'), true);

  // Cancel the backing capability. The view carries no formula identity, so
  // formula collection's sever path cannot reach it; the liveness gate is what
  // stops it forwarding. Every read must now reject and NOT reach the hub.
  cancelled = true;
  const callsAfterCancel = calls.length;
  await t.throwsAsync(E(view).has('one'), { message: /revoked/ });
  await t.throwsAsync(E(view).list(), { message: /revoked/ });
  await t.throwsAsync(E(view).lookup('one'), { message: /revoked/ });
  await t.throwsAsync(E(view).maybeLookup('one'), { message: /revoked/ });
  t.is(
    calls.length,
    callsAfterCancel,
    'no read reached the backing hub after cancellation',
  );

  // `help` is a pure self-description and stays available (it forwards to
  // nothing), so it does not need the gate.
  const overview = await E(view).help();
  t.true(overview.startsWith('ReadableNameHub'));
});
