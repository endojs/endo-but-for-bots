import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import {
  makeMemoryCasStore,
  makeRetentionLinkSet,
} from '@endo/mem-cas/store.js';
import { sha256HexWebCrypto } from '@endo/mem-cas/store-web-powers.js';

import {
  makeMemoryPackageCacheTable,
  makeNpmReferenceRegistry,
} from '../src/reference-backend.js';
import { makeMvsResolveHook, satisfiesRange } from '../src/mvs-resolver.js';
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
  t.false(satisfiesRange('1.0.0-alpha.1', '^1.0.0-beta.2'));
  t.true(satisfiesRange('1.0.0-beta.10', '^1.0.0-beta.2'));
  t.false(satisfiesRange('1.0.0-rc.1', '1.0.0'));
  t.false(satisfiesRange('1.0.0-rc.1', '>=0.9.0'));
  t.false(satisfiesRange('1.1.0-rc.1', '^1.0.0-rc.0'));
});

test('resolve does not upgrade beyond a graph requirement', async t => {
  // Entry depends on `lib-a@^1.0.0`; lib-a depends on
  // `helper@^1.0.0`. Newer compatible releases exist.
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
          '1.9.0': { dist: { integrity: 'sha512-h90' } },
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
  t.deepEqual([...resolution.keys].sort(), ['helper@1.0.0', 'lib-a@1.0.0']);
  t.is(resolution.packagesByKey['helper@1.0.0'].integrity, 'sha512-h0');
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
  t.true(resolution.keys.includes('pkg@1.0.0'));
  t.true(resolution.keys.includes('pkg@2.3.4'));
  t.true(resolution.keys.includes('lib-b@1.0.0'));
});

test('resolve picks least version satisfying all requesters', async t => {
  // Entry depends on pkg@^1.0.0; lib-c depends on pkg@^1.3.0.
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const fetcher = makeFakeFetcher({
    packuments: {
      pkg: {
        versions: {
          '1.0.0': { dist: { integrity: 'sha512-a' } },
          '1.2.0': { dist: { integrity: 'sha512-b' } },
          '1.4.7': { dist: { integrity: 'sha512-c' } },
          '1.9.0': { dist: { integrity: 'sha512-d' } },
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
  // The unrelated 1.9.0 release must not pull the graph forward.
  const pkgKeys = resolution.keys.filter(k => k.startsWith('pkg@'));
  t.deepEqual(pkgKeys, ['pkg@1.4.7']);
});

/**
 * Resolve an entry `package.json` against a packument fixture.
 *
 * @param {Record<string, object>} packuments
 * @param {Record<string, unknown>} entryFields
 */
const resolveFixture = (packuments, entryFields) => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const resolveHook = makeMvsResolveHook({
    fetcher: makeFakeFetcher({ packuments }),
    makeTreeRef: makeFakeTreeRef,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const entry = JSON.stringify({ name: 'entry', ...entryFields });
  return /** @type {Promise<{ keys: string[], unmetOptionals: ReadonlyArray<{ name: string }> }>} */ (
    registry.resolve(entry, {})
  );
};

/**
 * A packument fixture whose versions carry only an integrity string.
 *
 * @param {string[]} versions
 */
const plainPackument = versions => ({
  versions: Object.fromEntries(
    versions.map(v => [v, { dist: { integrity: `sha512-${v}` } }]),
  ),
});

/**
 * A single-version `consumer` packument that depends on `pkg@range`.
 *
 * @param {string} range
 * @param {string} [source]
 */
const consumerOf = (range, source = 'dependencies') => ({
  versions: {
    '1.0.0': {
      [source]: { pkg: range },
      dist: { integrity: 'sha512-consumer' },
    },
  },
});

for (const [first, second] of [
  ['~1.2.0', '~1.3.0'],
  ['~1.3.0', '~1.2.0'],
]) {
  test(`resolve splits disjoint requirements in one major (${first} then ${second})`, async t => {
    const resolution = await resolveFixture(
      {
        pkg: plainPackument(['1.2.0', '1.2.5', '1.3.0', '1.3.4']),
        consumer: consumerOf(second),
      },
      { dependencies: { pkg: first, consumer: '^1.0.0' } },
    );
    const pkgKeys = resolution.keys.filter(k => k.startsWith('pkg@'));
    t.deepEqual(pkgKeys, ['pkg@1.2.0', 'pkg@1.3.0']);
  });
}

test('resolve joins a later range to the split group it fits', async t => {
  const resolution = await resolveFixture(
    {
      pkg: plainPackument(['1.2.0', '1.3.0', '1.3.4']),
      consumer: consumerOf('~1.3.0'),
      other: {
        versions: {
          '1.0.0': {
            dependencies: { pkg: '^1.3.2' },
            dist: { integrity: 'sha512-other' },
          },
        },
      },
    },
    { dependencies: { pkg: '~1.2.0', consumer: '^1.0.0', other: '^1.0.0' } },
  );
  const pkgKeys = resolution.keys.filter(k => k.startsWith('pkg@'));
  t.deepEqual(pkgKeys, ['pkg@1.2.0', 'pkg@1.3.4']);
});

for (const { published, range, expected } of [
  {
    published: ['1.0.0-alpha', '1.0.0-1'],
    range: '^1.0.0-0',
    expected: 'pkg@1.0.0-1',
  },
  {
    published: ['1.0.0-beta.1', '1.0.0-beta'],
    range: '^1.0.0-beta',
    expected: 'pkg@1.0.0-beta',
  },
  {
    published: ['1.0.0-beta.b', '1.0.0-beta.a'],
    range: '^1.0.0-beta',
    expected: 'pkg@1.0.0-beta.a',
  },
]) {
  test(`resolve orders pre-releases by identifier precedence (${published.join(', ')})`, async t => {
    const resolution = await resolveFixture(
      { pkg: plainPackument(published) },
      { dependencies: { pkg: range } },
    );
    t.deepEqual(resolution.keys, [expected]);
  });
}

test('resolve shares one version between a union and a later range', async t => {
  const resolution = await resolveFixture(
    {
      pkg: plainPackument(['1.0.0', '2.0.0', '2.1.0']),
      consumer: consumerOf('^2.0.0'),
    },
    { dependencies: { pkg: '^1.0.0 || ^2.0.0', consumer: '^1.0.0' } },
  );
  const pkgKeys = resolution.keys.filter(k => k.startsWith('pkg@'));
  t.deepEqual(pkgKeys, ['pkg@2.0.0']);
});

test('resolve records a failed optional tarball fetch', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const resolveHook = makeMvsResolveHook({
    fetcher: makeFakeFetcher({
      packuments: { pkg: plainPackument(['1.0.0']) },
      tarballFailures: { 'pkg@1.0.0': 'boom' },
    }),
    makeTreeRef: makeFakeTreeRef,
  });
  const registry = makeNpmReferenceRegistry({ cas, resolveHook });
  const resolution = await registry.resolve(
    JSON.stringify({
      name: 'entry',
      optionalDependencies: { pkg: '^1.0.0' },
    }),
    {},
  );
  t.deepEqual(resolution.keys, []);
  t.deepEqual(resolution.unmetOptionals, [
    {
      importer: 'entry',
      name: 'pkg',
      range: '^1.0.0',
      reason: 'tarball fetch failed: boom',
    },
  ]);
});

test('resolve rejects a range no published version satisfies', async t => {
  const error = await t.throwsAsync(() =>
    resolveFixture(
      { pkg: plainPackument(['1.2.0']) },
      { dependencies: { pkg: '^2.0.0' } },
    ),
  );
  t.is(registryErrorName(error), 'RegistryMissingPackageError');
  t.regex(error.message, /no version satisfies/);
});

test('resolve selection does not depend on requester order', async t => {
  const packuments = {
    pkg: plainPackument(['1.0.0', '1.2.0', '1.4.7', '1.9.0']),
    consumer: consumerOf('^1.3.0'),
  };
  const direct = await resolveFixture(packuments, {
    dependencies: { pkg: '^1.0.0', consumer: '^1.0.0' },
  });
  const swapped = await resolveFixture(packuments, {
    dependencies: { consumer: '^1.0.0', pkg: '^1.0.0' },
  });
  t.deepEqual(direct.keys, swapped.keys);
  t.true(direct.keys.includes('pkg@1.4.7'));
});

test('resolve gives incompatible 0.x minors separate groups', async t => {
  const resolution = await resolveFixture(
    {
      pkg: plainPackument(['0.1.0', '0.1.5', '0.2.0', '0.2.4']),
      consumer: consumerOf('^0.2.0'),
    },
    { dependencies: { pkg: '^0.1.0', consumer: '^1.0.0' } },
  );
  const pkgKeys = resolution.keys.filter(k => k.startsWith('pkg@'));
  t.deepEqual(pkgKeys, ['pkg@0.1.0', 'pkg@0.2.0']);
});

test('resolve skips pre-releases that no range names', async t => {
  // Publish order puts the release candidate first.
  const pkg = plainPackument(['1.0.0-rc.1', '1.0.0', '1.0.1']);
  const plain = await resolveFixture(
    { pkg },
    { dependencies: { pkg: '^1.0.0' } },
  );
  t.deepEqual(plain.keys, ['pkg@1.0.0']);
  const named = await resolveFixture(
    { pkg },
    { dependencies: { pkg: '^1.0.0-rc.1' } },
  );
  t.deepEqual(named.keys, ['pkg@1.0.0-rc.1']);
});

test("resolve honors a range's pre-release floor", async t => {
  const pkg = plainPackument([
    '1.0.0-alpha.1',
    '1.0.0-beta.10',
    '1.0.0-beta.2',
    '1.0.0',
  ]);
  const resolution = await resolveFixture(
    { pkg },
    { dependencies: { pkg: '^1.0.0-beta.2' } },
  );
  t.deepEqual(resolution.keys, ['pkg@1.0.0-beta.2']);
});

test('resolve orders same-release pre-releases independent of key order', async t => {
  const range = '^1.0.0-beta.1 || ^1.0.0-rc.1';
  const resolutions = await Promise.all(
    [
      ['1.0.0-beta.1', '1.0.0-rc.1'],
      ['1.0.0-rc.1', '1.0.0-beta.1'],
    ].map(versions =>
      resolveFixture(
        { pkg: plainPackument(versions) },
        { dependencies: { pkg: range } },
      ),
    ),
  );
  for (const resolution of resolutions) {
    t.deepEqual(resolution.keys, ['pkg@1.0.0-beta.1']);
  }
});

test('resolve breaks build-metadata ties by raw string', async t => {
  const resolutions = await Promise.all(
    [
      ['1.0.0+b', '1.0.0+a'],
      ['1.0.0+a', '1.0.0+b'],
    ].map(versions =>
      resolveFixture(
        { pkg: plainPackument(versions) },
        { dependencies: { pkg: '^1.0.0' } },
      ),
    ),
  );
  for (const resolution of resolutions) {
    t.deepEqual(resolution.keys, ['pkg@1.0.0+a']);
  }
});

test('resolve intersects a union range with a narrower range', async t => {
  const resolution = await resolveFixture(
    {
      pkg: plainPackument(['1.0.0', '1.3.0', '1.3.2', '2.0.0']),
      consumer: consumerOf('~1.3.0'),
    },
    { dependencies: { pkg: '^1.0.0 || ^2.0.0', consumer: '^1.0.0' } },
  );
  const pkgKeys = resolution.keys.filter(k => k.startsWith('pkg@'));
  t.deepEqual(pkgKeys, ['pkg@1.3.0']);
});

test('resolve gives an upper-bound-only range its own group', async t => {
  const resolution = await resolveFixture(
    {
      pkg: plainPackument(['1.0.0', '1.5.0', '2.0.0', '2.1.0']),
      consumer: consumerOf('^2.1.0'),
    },
    { dependencies: { pkg: '<2.0.0', consumer: '^1.0.0' } },
  );
  const pkgKeys = resolution.keys.filter(k => k.startsWith('pkg@'));
  t.deepEqual(pkgKeys, ['pkg@1.0.0', 'pkg@2.1.0']);
});

test('resolve merges duplicate ranges from several importers', async t => {
  const resolution = await resolveFixture(
    {
      pkg: plainPackument(['1.0.0', '1.2.0']),
      consumer: consumerOf('^1.2.0'),
    },
    { dependencies: { pkg: '^1.2.0', consumer: '^1.0.0' } },
  );
  const pkgKeys = resolution.keys.filter(k => k.startsWith('pkg@'));
  t.deepEqual(pkgKeys, ['pkg@1.2.0']);
});

test('resolve lets an optional range narrow a shared selection', async t => {
  // A satisfiable optional range constrains the group like any other.
  const resolution = await resolveFixture(
    {
      pkg: plainPackument(['1.0.0', '1.3.0']),
      consumer: consumerOf('^1.3.0', 'optionalDependencies'),
    },
    { dependencies: { pkg: '^1.0.0', consumer: '^1.0.0' } },
  );
  t.true(resolution.keys.includes('pkg@1.3.0'));
  t.false(resolution.keys.includes('pkg@1.0.0'));
});

test('resolve splits a conflicting optional without changing the selection', async t => {
  const resolution = await resolveFixture(
    {
      pkg: plainPackument(['1.2.0', '1.3.0']),
      consumer: consumerOf('~1.3.0', 'optionalDependencies'),
    },
    { dependencies: { pkg: '~1.2.0', consumer: '^1.0.0' } },
  );
  t.true(resolution.keys.includes('pkg@1.2.0'));
  t.true(resolution.keys.includes('pkg@1.3.0'));
  t.deepEqual(resolution.unmetOptionals, []);
});

test('resolve records an unsatisfiable optional', async t => {
  const resolution = await resolveFixture(
    {
      pkg: plainPackument(['1.2.0']),
      consumer: consumerOf('^2.0.0', 'optionalDependencies'),
    },
    { dependencies: { pkg: '~1.2.0', consumer: '^1.0.0' } },
  );
  t.deepEqual(
    resolution.keys.filter(k => k.startsWith('pkg@')),
    ['pkg@1.2.0'],
  );
  t.true(resolution.unmetOptionals.some(d => d.name === 'pkg'));
});

test('resolve prunes dependencies of a superseded selection', async t => {
  // lib@1.0.0 needs orphan, but raiser forces lib up to 1.4.0, which
  // does not. orphan must not survive in the resolution.
  const resolution = await resolveFixture(
    {
      lib: {
        versions: {
          '1.0.0': {
            dependencies: { orphan: '^1.0.0' },
            dist: { integrity: 'sha512-lib-1.0.0' },
          },
          '1.4.0': { dist: { integrity: 'sha512-lib-1.4.0' } },
        },
      },
      raiser: {
        versions: {
          '1.0.0': {
            dependencies: { lib: '^1.4.0' },
            dist: { integrity: 'sha512-raiser' },
          },
        },
      },
      orphan: plainPackument(['1.0.0']),
    },
    { dependencies: { lib: '^1.0.0', raiser: '^1.0.0' } },
  );
  t.deepEqual(resolution.keys, ['lib@1.4.0', 'raiser@1.0.0']);
});

test('resolve drops diagnostics from a superseded selection', async t => {
  // lib@1.0.0 declares an unmet peer and a missing optional; once
  // raiser forces lib up to 1.4.0 neither diagnostic applies.
  const resolution = await resolveFixture(
    {
      lib: {
        versions: {
          '1.0.0': {
            peerDependencies: { absent: '^1.0.0' },
            optionalDependencies: { missing: '^1.0.0' },
            dist: { integrity: 'sha512-lib-1.0.0' },
          },
          '1.4.0': { dist: { integrity: 'sha512-lib-1.4.0' } },
        },
      },
      raiser: {
        versions: {
          '1.0.0': {
            dependencies: { lib: '^1.4.0' },
            dist: { integrity: 'sha512-raiser' },
          },
        },
      },
    },
    { dependencies: { lib: '^1.0.0', raiser: '^1.0.0' } },
  );
  t.deepEqual(resolution.keys, ['lib@1.4.0', 'raiser@1.0.0']);
  t.deepEqual(resolution.unmetOptionals, []);
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
  t.true(resolution.unmetOptionals?.some(d => d.name === 'fsevents') ?? false);
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

test('resolve in offline mode walks transitive deps of a cached entry', async t => {
  // Online pass: resolve `parent` whose only declared dep is `child`.
  // The reference backend's `resolve()` populates the package cache
  // table with both entries; the cache row carries the snapshot of the
  // child's declared deps in the row's `packageJson` field. Offline
  // pass: resolve a different entry that depends on `parent`; the
  // resolver must walk parent's cached `child` dep rather than treating
  // the cached entry as having zero transitive deps.
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const fetcher = makeFakeFetcher({
    packuments: {
      parent: {
        versions: {
          '1.0.0': {
            dependencies: { child: '^1.0.0' },
            dist: { integrity: 'sha512-p' },
          },
        },
      },
      child: {
        versions: {
          '1.0.0': { dist: { integrity: 'sha512-c' } },
        },
      },
    },
  });
  const resolveHook = makeMvsResolveHook({
    fetcher,
    makeTreeRef: makeFakeTreeRef,
  });
  // Use an externally-held package cache table so the test can observe
  // the cached row's `packageJson` snapshot directly.
  const packages = makeMemoryPackageCacheTable();
  const registry = makeNpmReferenceRegistry({ cas, resolveHook, packages });

  // Online resolve to populate the package cache.
  const onlineEntry = JSON.stringify({
    name: 'app',
    dependencies: { parent: '^1.0.0' },
  });
  const onlineResolution = await registry.resolve(onlineEntry, {});
  t.true(onlineResolution.keys.includes('parent@1.0.0'));
  t.true(onlineResolution.keys.includes('child@1.0.0'));

  // Confirm the cache row carries the packageJson snapshot.
  const parentRow = await packages.get('parent', '1.0.0');
  t.truthy(parentRow);
  t.truthy(parentRow?.packageJson, 'cache row carries packageJson snapshot');
  const parentSnapshot = JSON.parse(parentRow?.packageJson ?? '{}');
  t.deepEqual(parentSnapshot.dependencies, { child: '^1.0.0' });

  // Offline resolve: the entry depends only on `parent`. The resolver
  // must walk parent's cached transitive deps (and surface `child` in
  // the closure) rather than treating parent as a leaf.
  const offlineEntry = JSON.stringify({
    name: 'consumer',
    dependencies: { parent: '^1.0.0' },
  });
  const offlineResolution = await registry.resolve(offlineEntry, {
    offline: true,
  });
  t.true(
    offlineResolution.keys.includes('parent@1.0.0'),
    'offline resolution includes the directly-declared parent',
  );
  t.true(
    offlineResolution.keys.includes('child@1.0.0'),
    "offline resolution walks parent's transitive child dep",
  );
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
  t.deepEqual(resolution.workspaceMismatches, [
    {
      importer: 'entry',
      name: '@endo/patterns',
      range: '^1.0.0',
      version: '0.5.0',
    },
  ]);
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
