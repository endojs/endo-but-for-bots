import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import { makeMemoryCasStore } from '@endo/mem-cas/store.js';
import { sha256HexWebCrypto } from '@endo/mem-cas/store-web-powers.js';

import { makeNpmReferenceRegistry } from '../src/reference-backend.js';
import { registryErrorName } from '../src/errors.js';

/**
 * Build a minimal `EndoReadableTree`-shaped exo for tests. The
 * capability shape requires the methods named in
 * `@endo/daemon/src/interfaces.js` § ReadableTreeInterface, but for
 * layer 1 we only exercise `sha256()` to confirm content-addressing
 * carries through.
 *
 * @param {string} hash
 */
const makeFakeReadableTree = hash =>
  Far('FakeReadableTree', {
    sha256: () => hash,
    list: async () => [],
    lookup: async () => undefined,
    has: async () => false,
    help: () => `FakeReadableTree(${hash})`,
  });

test('default registry has no resolveHook and surfaces RegistryNetworkError', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const registry = makeNpmReferenceRegistry({ cas });
  const error = await t.throwsAsync(() => registry.resolve('{}', {}));
  t.is(
    registryErrorName(error),
    'RegistryNetworkError',
    'default hook must produce a structured failure',
  );
});

test('reference registry runs the injected resolveHook and populates the table', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const treeA = makeFakeReadableTree('hash-a');
  const treeB = makeFakeReadableTree('hash-b');
  /** @type {(packageJson: string, options: object, context: object) => Promise<object>} */
  const resolveHook = async (packageJson, options, _context) => {
    // The hook receives the entry package.json bytes, the options,
    // and the context (which carries `cas` and `retentionLinks`).
    return harden({
      packagesByKey: {
        'ses@1.0.0': {
          name: 'ses',
          version: '1.0.0',
          treeRef: treeA,
          integrity: 'sha512-AAAA',
        },
        '@endo/patterns@1.2.1': {
          name: '@endo/patterns',
          version: '1.2.1',
          treeRef: treeB,
          integrity: 'sha512-BBBB',
        },
      },
      keys: ['@endo/patterns@1.2.1', 'ses@1.0.0'],
      resolutionHash: 'fixture-resolution-hash',
    });
  };

  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const resolution = await registry.resolve('{}', {});
  t.is(resolution.resolutionHash, 'fixture-resolution-hash');
  t.deepEqual([...resolution.keys].sort(), [
    '@endo/patterns@1.2.1',
    'ses@1.0.0',
  ]);

  // Post-resolve, lookup returns the resolved entries.
  t.is(await registry.lookup('ses', '1.0.0'), treeA);
  t.is(await registry.lookup('@endo/patterns', '1.2.1'), treeB);
  // And fetch returns the same handles without re-running the hook.
  t.is(await registry.fetch('ses', '1.0.0'), treeA);
  t.is(await registry.fetch('@endo/patterns', '1.2.1'), treeB);
});

test('lookup returns undefined for unfetched packages', async t => {
  await null;
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const registry = makeNpmReferenceRegistry({ cas });
  t.is(await registry.lookup('lodash', '4.17.21'), undefined);
});

test('list returns installed packages and respects the prefix filter', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  /** @type {(packageJson: string, options: object, context: object) => Promise<object>} */
  const resolveHook = async () =>
    harden({
      packagesByKey: {
        'ses@1.0.0': {
          name: 'ses',
          version: '1.0.0',
          treeRef: makeFakeReadableTree('a'),
          integrity: 'sha512-AAAA',
        },
        'ses@2.0.0': {
          name: 'ses',
          version: '2.0.0',
          treeRef: makeFakeReadableTree('a2'),
          integrity: 'sha512-BBBB',
        },
        '@endo/patterns@1.2.1': {
          name: '@endo/patterns',
          version: '1.2.1',
          treeRef: makeFakeReadableTree('b'),
          integrity: 'sha512-CCCC',
        },
      },
      keys: ['@endo/patterns@1.2.1', 'ses@1.0.0', 'ses@2.0.0'],
      resolutionHash: 'fixture',
    });

  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  await registry.resolve('{}', {});

  const all = await registry.list();
  t.is(all.length, 3);

  const sesOnly = await registry.list('ses');
  t.deepEqual(sesOnly.map(({ name, version }) => `${name}@${version}`).sort(), [
    'ses@1.0.0',
    'ses@2.0.0',
  ]);

  const scoped = await registry.list('@endo/');
  t.deepEqual(scoped.length, 1);
  t.is(scoped[0].name, '@endo/patterns');
});

test('major-version coexistence: same name at two versions appears as distinct keys', async t => {
  // From the design's § Capability shape: "Packages with major-version
  // coexistence (allowed by MVS) appear as multiple entries under
  // distinct keys".
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const tree1 = makeFakeReadableTree('hash-1');
  const tree2 = makeFakeReadableTree('hash-2');
  /** @type {(packageJson: string, options: object, context: object) => Promise<object>} */
  const resolveHook = async () =>
    harden({
      packagesByKey: {
        'ses@1.0.0': {
          name: 'ses',
          version: '1.0.0',
          treeRef: tree1,
          integrity: 'sha512-AAAA',
        },
        'ses@2.3.4': {
          name: 'ses',
          version: '2.3.4',
          treeRef: tree2,
          integrity: 'sha512-BBBB',
        },
      },
      keys: ['ses@1.0.0', 'ses@2.3.4'],
      resolutionHash: 'fixture',
    });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  await registry.resolve('{}', {});
  t.is(await registry.lookup('ses', '1.0.0'), tree1);
  t.is(await registry.lookup('ses', '2.3.4'), tree2);
  // Distinct treeRef capabilities for distinct versions.
  t.not(tree1, tree2);
});

test('resolveHook receives cas and retentionLinks on its context', async t => {
  // Layer 2's mvs-resolver writes CAS trees through the bus verbs
  // (see § Two backends, one shape). Layer 1's hook contract makes
  // those handles available without further plumbing.
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  /** @type {{cas?: object, retentionLinks?: object}} */
  const captured = {};
  /** @type {(packageJson: string, options: object, context: object) => Promise<object>} */
  const resolveHook = async (_pj, _opts, context) => {
    captured.cas = /** @type {{cas: object, retentionLinks: object}} */ (
      context
    ).cas;
    captured.retentionLinks =
      /** @type {{cas: object, retentionLinks: object}} */ (
        context
      ).retentionLinks;
    return harden({
      packagesByKey: {},
      keys: [],
      resolutionHash: 'empty',
    });
  };
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  await registry.resolve('{}', {});
  t.truthy(captured.cas, 'hook received cas');
  t.truthy(captured.retentionLinks, 'hook received retentionLinks');
});

test('help returns a descriptive string', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const registry = makeNpmReferenceRegistry({ cas, label: 'unit-test' });
  const help = registry.help();
  t.regex(help, /EndoRegistry/);
  t.regex(help, /unit-test/);
});

test('makeNpmReferenceRegistry requires a CAS store', t => {
  t.throws(
    // @ts-expect-error intentional misuse
    () => makeNpmReferenceRegistry({}),
    { message: /requires a CAS store/ },
  );
});
