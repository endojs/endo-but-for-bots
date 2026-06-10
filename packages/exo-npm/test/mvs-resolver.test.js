import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import {
  makeMemoryCasStore,
  makeRetentionLinkSet,
} from '@endo/mem-cas/store.js';
import { sha256HexWebCrypto } from '@endo/mem-cas/store-web-powers.js';

import { makeNpmReferenceRegistry } from '../src/reference-backend.js';
import {
  makeMvsResolveHook,
  satisfiesRange,
  parseRangeMajor,
} from '../src/mvs-resolver.js';
import { registryErrorName } from '../src/errors.js';

const utf8Encoder = new TextEncoder();

/**
 * Build a small in-memory fetcher backed by a fixture map. The
 * fixture maps `<name>` to a packument-shape document; tarball bytes
 * come from a separate `<name>@<version>` map.
 *
 * @param {{
 *   packuments: Record<string, object>,
 *   tarballs?: Record<string, string>,
 *   tarballFailures?: Record<string, string>,
 * }} fixture
 */
const makeFakeFetcher = fixture => {
  return harden({
    async getPackument(name) {
      const doc = fixture.packuments[name];
      if (!doc) {
        throw new Error(`no packument fixture for ${name}`);
      }
      return doc;
    },
    async getTarball(name, version) {
      const key = `${name}@${version}`;
      if (fixture.tarballFailures && fixture.tarballFailures[key]) {
        throw new Error(fixture.tarballFailures[key]);
      }
      const body =
        fixture.tarballs?.[key] ?? `fake-tarball-bytes-for-${name}@${version}`;
      return utf8Encoder.encode(body);
    },
  });
};

const makeFakeTreeRef = (hash, name, version) =>
  Far(`FakeReadableTree`, {
    sha256: () => hash,
    list: async () => [],
    lookup: async () => undefined,
    has: async () => false,
    help: () => `FakeReadableTree(${name}@${version}|${hash.slice(0, 8)})`,
  });

test('satisfiesRange handles common npm shapes', t => {
  // Caret.
  t.true(satisfiesRange('1.2.3', '^1.0.0'));
  t.true(satisfiesRange('1.99.99', '^1.0.0'));
  t.false(satisfiesRange('2.0.0', '^1.0.0'));
  // Caret with leading-zero major (npm widens to minor pinning).
  t.true(satisfiesRange('0.1.5', '^0.1.0'));
  t.false(satisfiesRange('0.2.0', '^0.1.0'));
  // Tilde.
  t.true(satisfiesRange('1.2.9', '~1.2.0'));
  t.false(satisfiesRange('1.3.0', '~1.2.0'));
  // Comparators.
  t.true(satisfiesRange('2.0.0', '>=1.0.0'));
  t.true(satisfiesRange('0.0.1', '<1.0.0'));
  t.false(satisfiesRange('1.0.0', '<1.0.0'));
  // Wildcards.
  t.true(satisfiesRange('1.0.0', '*'));
  t.true(satisfiesRange('1.5.0', '1.x'));
  t.false(satisfiesRange('2.0.0', '1.x'));
  // Exact.
  t.true(satisfiesRange('1.2.3', '1.2.3'));
  t.false(satisfiesRange('1.2.4', '1.2.3'));
  // Alternation.
  t.true(satisfiesRange('1.0.0', '^1.0.0 || ^2.0.0'));
  t.true(satisfiesRange('2.0.0', '^1.0.0 || ^2.0.0'));
  // Hyphen.
  t.true(satisfiesRange('1.5.0', '1.0.0 - 2.0.0'));
  t.false(satisfiesRange('2.0.1', '1.0.0 - 2.0.0'));
});

test('parseRangeMajor classifies ranges into major slots', t => {
  t.is(parseRangeMajor('^1.0.0'), '1');
  t.is(parseRangeMajor('~1.2.3'), '1');
  t.is(parseRangeMajor('>=2.0.0'), '2');
  t.is(parseRangeMajor('3.x'), '3');
  t.is(parseRangeMajor('*'), 'any');
});

test('resolve walks a transitive dependency graph (MVS pick)', async t => {
  // Entry depends on `lib-a@^1.0.0`; lib-a depends on
  // `helper@^1.0.0`. The fixture exposes helper@1.0.0 and helper@1.2.5;
  // MVS picks the greatest minor satisfying `^1.0.0`.
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const fetcher = makeFakeFetcher({
    packuments: {
      'lib-a': {
        versions: {
          '1.0.0': {
            dependencies: { helper: '^1.0.0' },
            dist: { integrity: 'sha512-aaa' },
          },
        },
      },
      helper: {
        versions: {
          '1.0.0': { dist: { integrity: 'sha512-h0' } },
          '1.2.5': { dist: { integrity: 'sha512-h25' } },
          '2.0.0': { dist: { integrity: 'sha512-h2' } },
        },
      },
    },
  });
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const entry = JSON.stringify({
    name: 'entry',
    version: '0.0.0',
    dependencies: { 'lib-a': '^1.0.0' },
  });
  const resolution = await registry.resolve(entry, {});
  t.deepEqual([...resolution.keys].sort(), [
    'helper@1.2.5',
    'lib-a@1.0.0',
  ]);
  t.is(resolution.packagesByKey['helper@1.2.5'].integrity, 'sha512-h25');
});

test('resolve admits multi-major coexistence', async t => {
  // Entry depends on pkg@^1.0.0 directly and on lib-b@^1.0.0; lib-b
  // depends on pkg@^2.0.0. Both pkg majors must appear in the
  // resolution under distinct keys.
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const fetcher = makeFakeFetcher({
    packuments: {
      pkg: {
        versions: {
          '1.0.0': { dist: { integrity: 'sha512-p1' } },
          '1.5.0': { dist: { integrity: 'sha512-p15' } },
          '2.3.4': { dist: { integrity: 'sha512-p234' } },
        },
      },
      'lib-b': {
        versions: {
          '1.0.0': {
            dependencies: { pkg: '^2.0.0' },
            dist: { integrity: 'sha512-b1' },
          },
        },
      },
    },
  });
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const entry = JSON.stringify({
    name: 'entry',
    dependencies: { pkg: '^1.0.0', 'lib-b': '^1.0.0' },
  });
  const resolution = await registry.resolve(entry, {});
  t.true(resolution.keys.includes('pkg@1.5.0'));
  t.true(resolution.keys.includes('pkg@2.3.4'));
  t.true(resolution.keys.includes('lib-b@1.0.0'));
});

test('resolve picks greatest mentioned minor across requesters', async t => {
  // Entry depends on pkg@^1.0.0; lib-c depends on pkg@^1.3.0. The
  // result must be the greatest 1.x that satisfies both ranges (the
  // 1.3.x line).
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const fetcher = makeFakeFetcher({
    packuments: {
      pkg: {
        versions: {
          '1.0.0': { dist: { integrity: 'sha512-a' } },
          '1.2.0': { dist: { integrity: 'sha512-b' } },
          '1.4.7': { dist: { integrity: 'sha512-c' } },
        },
      },
      'lib-c': {
        versions: {
          '1.0.0': {
            dependencies: { pkg: '^1.3.0' },
            dist: { integrity: 'sha512-c1' },
          },
        },
      },
    },
  });
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const entry = JSON.stringify({
    name: 'entry',
    dependencies: { pkg: '^1.0.0', 'lib-c': '^1.0.0' },
  });
  const resolution = await registry.resolve(entry, {});
  // Only one pkg entry, the one that satisfies both ranges.
  const pkgKeys = resolution.keys.filter(k => k.startsWith('pkg@'));
  t.deepEqual(pkgKeys, ['pkg@1.4.7']);
});

test('resolve raises RegistryMissingPackageError for unmet peer', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const fetcher = makeFakeFetcher({
    packuments: {
      'pkg-a': {
        versions: {
          '1.0.0': {
            peerDependencies: { react: '^18.0.0' },
            dist: { integrity: 'sha512-a' },
          },
        },
      },
    },
  });
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const entry = JSON.stringify({
    name: 'entry',
    dependencies: { 'pkg-a': '^1.0.0' },
  });
  const error = await t.throwsAsync(() => registry.resolve(entry, {}));
  t.is(registryErrorName(error), 'RegistryMissingPackageError');
});

test('resolve accepts satisfied peer dependency', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const fetcher = makeFakeFetcher({
    packuments: {
      'pkg-a': {
        versions: {
          '1.0.0': {
            peerDependencies: { react: '^18.0.0' },
            dist: { integrity: 'sha512-a' },
          },
        },
      },
      react: {
        versions: {
          '18.2.1': { dist: { integrity: 'sha512-r' } },
        },
      },
    },
  });
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const entry = JSON.stringify({
    name: 'entry',
    dependencies: { 'pkg-a': '^1.0.0', react: '^18.0.0' },
  });
  const resolution = await registry.resolve(entry, {});
  t.true(resolution.keys.includes('react@18.2.1'));
  t.true(resolution.keys.includes('pkg-a@1.0.0'));
});

test('resolve treats optionalDependencies as best-effort', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const fetcher = makeFakeFetcher({
    packuments: {
      'pkg-b': {
        versions: {
          '1.0.0': {
            optionalDependencies: { fsevents: '^2.0.0' },
            dist: { integrity: 'sha512-b' },
          },
        },
      },
      // Note: no fsevents packument; the resolver records it as an
      // unmet optional and the resolution succeeds.
    },
  });
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const entry = JSON.stringify({
    name: 'entry',
    dependencies: { 'pkg-b': '^1.0.0' },
  });
  const resolution =
    /** @type {{keys: string[], unmetOptionals?: ReadonlyArray<{name: string}>}} */ (
      await registry.resolve(entry, {})
    );
  t.true(resolution.keys.includes('pkg-b@1.0.0'));
  t.false(resolution.keys.some(k => k.startsWith('fsevents@')));
  // The unmet optional surfaces on the resolution's diagnostic side
  // channel.
  t.truthy(resolution.unmetOptionals);
  t.true(
    resolution.unmetOptionals?.some(d => d.name === 'fsevents') ?? false,
  );
});

test('resolve in offline mode rejects on missing cache entry', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  // Fetcher would succeed but offline mode forbids the call.
  const fetcher = makeFakeFetcher({
    packuments: {
      cached: {
        versions: { '1.0.0': { dist: { integrity: 'sha512-c' } } },
      },
    },
  });
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const entry = JSON.stringify({
    name: 'entry',
    dependencies: { cached: '^1.0.0' },
  });
  const error = await t.throwsAsync(() =>
    registry.resolve(entry, { offline: true }),
  );
  t.is(registryErrorName(error), 'RegistryOfflineError');
});

test('workspace specifier resolves through the workspace lookup', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const libBTree = makeFakeTreeRef('hash-lib-b', 'lib-b', 'workspace');
  const fetcher = makeFakeFetcher({ packuments: {} });
  const workspaceLookup = async name => {
    if (name === 'lib-b') {
      return {
        packageJson: JSON.stringify({
          name: 'lib-b',
          version: '0.0.0',
        }),
        treeRef: libBTree,
      };
    }
    return undefined;
  };
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
    workspaceLookup,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const entry = JSON.stringify({
    name: 'lib-a',
    version: '1.0.0',
    dependencies: { 'lib-b': 'workspace:^' },
  });
  const resolution = await registry.resolve(entry, {});
  // Workspace members keep the bare name (no version segment) so the
  // snapshot mapper can layout them at <name>/ rather than
  // <name>@<version>/.
  t.true(resolution.keys.includes('lib-b'));
  t.is(resolution.packagesByKey['lib-b'].treeRef, libBTree);
});

test('workspace member wins over a registry version', async t => {
  // The maintainer-intended semantic: a workspace member shadows a
  // published version regardless of the importer's range. The
  // mapper relies on the absence of a version segment to encode
  // this.
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const wsTree = makeFakeTreeRef('hash-ws', '@endo/patterns', 'ws');
  const fetcher = makeFakeFetcher({
    packuments: {
      '@endo/patterns': {
        versions: {
          '1.0.0': { dist: { integrity: 'sha512-p100' } },
        },
      },
    },
  });
  const workspaceLookup = async name => {
    if (name === '@endo/patterns') {
      return {
        packageJson: JSON.stringify({
          name: '@endo/patterns',
          version: '0.5.0',
        }),
        treeRef: wsTree,
      };
    }
    return undefined;
  };
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
    workspaceLookup,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const entry = JSON.stringify({
    name: 'entry',
    dependencies: { '@endo/patterns': '^1.0.0' },
  });
  const resolution = await registry.resolve(entry, {});
  t.true(resolution.keys.includes('@endo/patterns'));
  t.false(resolution.keys.includes('@endo/patterns@1.0.0'));
});

test('CAS stores tarball bytes and pins them via retention links', async t => {
  const links = makeRetentionLinkSet();
  const cas = makeMemoryCasStore({
    sha256: sha256HexWebCrypto,
    retentionLinks: links,
  });
  const fetcher = makeFakeFetcher({
    packuments: {
      'small-pkg': {
        versions: {
          '1.0.0': { dist: { integrity: 'sha512-x' } },
        },
      },
    },
    tarballs: { 'small-pkg@1.0.0': 'bytes-for-small-pkg-1.0.0' },
  });
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
  });
  const registry = makeNpmReferenceRegistry({
    cas,
    resolveHook,
    retentionLinks: links,
  });
  const entry = JSON.stringify({
    name: 'entry',
    dependencies: { 'small-pkg': '^1.0.0' },
  });
  const resolution = await registry.resolve(entry, {});
  t.true(resolution.keys.includes('small-pkg@1.0.0'));
  // The tarball bytes are in the CAS.
  const hashes = await cas.list();
  t.true(hashes.length >= 1);
  // Hard retention link pins the bytes against eviction.
  for (const h of hashes) {
    t.true(links.isPinned(h), `hash ${h.slice(0, 8)} must be pinned`);
  }
});
