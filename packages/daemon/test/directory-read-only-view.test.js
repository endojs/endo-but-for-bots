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
  const declared = [...methodNames].filter(name => !name.startsWith('__')).sort();
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

test('help() falls back to the default for any unrecognized or prototype method name', async t => {
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
  // `__proto__`, `valueOf`) must NOT reach an inherited value — it falls back
  // to the overview. If `readOnlyHelp` ever loses its null prototype, these
  // redden.
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
      overview,
      `help(${JSON.stringify(evilNames[i])}) must fall back to the overview`,
    );
  });
});
