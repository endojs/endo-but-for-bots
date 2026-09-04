// @ts-check
/* eslint-disable no-underscore-dangle */

import test from '@endo/ses-ava/prepare-endo.js';
import { Far, passStyleOf } from '@endo/far';
import { M, mustMatch } from '@endo/patterns';

import {
  RegistryNotFoundError,
  isPackageRegistryError,
  makeLookupTreeView,
  makeNpmRegistryTree,
  makePackageRegistryTree,
  registryErrorName,
} from '../index.js';
import { comparePublishedVersions } from '../src/registry-tree.js';

const packages = harden({
  alpha: harden({
    '1.0.0': harden({ integrity: 'sha512-a1' }),
    '2.0.0': harden({ integrity: 'sha512-a2' }),
  }),
  '@scope/package': harden({
    '1.2.3': harden({ integrity: 'sha512-scoped' }),
  }),
});

const makePackageTree = (name, version) =>
  Far('HardeningPackageTree', {
    help: () => `${name}@${version}`,
    has: async (...path) => path.length === 0,
    list: async () => [],
    lookup: async () => undefined,
    sha256: () => `sha256-${name}-${version}`,
    getInfo: async () => harden({ temporal: 'immutable' }),
  });

const makeOperations = () =>
  harden({
    async listVersions(name) {
      const versions = packages[name];
      return versions === undefined ? undefined : Object.keys(versions);
    },
    async providePackageTree(name, version) {
      const record = packages[name]?.[version];
      if (record === undefined) throw new RangeError(`${name}@${version}`);
      return harden({
        treeRef: makePackageTree(name, version),
        integrity: record.integrity,
      });
    },
  });

test('comparePublishedVersions is a total order across unparseable spellings', t => {
  // A per-pair lexicographic fallback is intransitive; segregating unparseable
  // spellings after all parseable ones keeps `sort` deterministic regardless
  // of input order.
  const inputs = [
    '10.0.0',
    '9.0.0',
    '5-bad',
    '2.0.0',
    '11.0.0',
    '1.0.0',
    '7-x',
  ];
  const sorted = [...inputs].sort(comparePublishedVersions);
  // Sorting a reversed copy must yield the identical ordering.
  const reverseSorted = [...inputs].reverse().sort(comparePublishedVersions);
  t.deepEqual(sorted, reverseSorted);
  // Parseable versions all precede unparseable ones, ascending by semver.
  t.deepEqual(sorted, [
    '1.0.0',
    '2.0.0',
    '9.0.0',
    '10.0.0',
    '11.0.0',
    '5-bad',
    '7-x',
  ]);
  // Transitivity spot-check on the 3-cycle the old fallback produced.
  t.true(comparePublishedVersions('9.0.0', '10.0.0') < 0);
  t.true(comparePublishedVersions('10.0.0', '5-bad') < 0);
  t.true(comparePublishedVersions('9.0.0', '5-bad') < 0);
});

test('has and lookup agree on the @scope/package spelling with a version', async t => {
  const npm = makeNpmRegistryTree(makeOperations());
  // The has=>lookup contract must not disagree on the one slash-bearing spelling
  // npm tolerates as a leading segment.
  t.true(await npm.has('@scope/package', '1.2.3'));
  const leaf = await npm.lookup(['@scope/package', '1.2.3']);
  t.is(/** @type {any} */ (leaf).sha256(), 'sha256-@scope/package-1.2.3');
  // And it resolves the same node the single-string spelling normalizes.
  const alsoLeaf = await /** @type {any} */ (npm).lookup('@scope/package');
  const stepwise = await /** @type {any} */ (alsoLeaf).lookup('1.2.3');
  t.is(/** @type {any} */ (stepwise).sha256(), 'sha256-@scope/package-1.2.3');
});

test('has does not apply the npm name charset to version or in-tree file segments', async t => {
  // Regression: `has` normalized *every* segment through the npm package-name
  // charset, while `lookup` normalizes only the leading segment. A version or
  // in-tree file whose name carries a space, `+`, or a non-ASCII character (all
  // ordinary in published packages) was therefore reported absent by `has` even
  // though `lookup` resolves it, breaking the has=>lookup agreement invariant.
  const fileNames = harden(['a b.txt', 'es5+es6.js', 'café.js']);
  const makeFileBlob = name =>
    Far('HardeningFileBlob', {
      help: () => name,
      sha256: () => `sha256-${name}`,
      getInfo: async () => harden({ temporal: 'immutable' }),
    });
  const makeVersionTree = (name, version) =>
    Far('HardeningVersionTree', {
      help: () => `${name}@${version}`,
      has: async (...path) => path.length === 0 || fileNames.includes(path[0]),
      list: async () => [...fileNames],
      lookup: async segment =>
        fileNames.includes(segment) ? makeFileBlob(segment) : undefined,
      sha256: () => `sha256-${name}-${version}`,
      getInfo: async () => harden({ temporal: 'immutable' }),
    });
  const operations = harden({
    async listVersions(name) {
      return name === 'alpha' ? ['1.0.0'] : undefined;
    },
    async providePackageTree(name, version) {
      if (name !== 'alpha' || version !== '1.0.0') {
        throw new RangeError(`${name}@${version}`);
      }
      return harden({
        treeRef: makeVersionTree(name, version),
        integrity: 'sha512-a1',
      });
    },
  });
  const npm = makeNpmRegistryTree(operations);
  for (const fileName of fileNames) {
    // eslint-disable-next-line no-await-in-loop
    t.true(await npm.has('alpha', '1.0.0', fileName), `has ${fileName}`);
    // eslint-disable-next-line no-await-in-loop
    const blob = await npm.lookup(['alpha', '1.0.0', fileName]);
    t.is(/** @type {any} */ (blob).sha256(), `sha256-${fileName}`);
  }
});

test('makeLookupTreeView withholds enumeration at every depth', async t => {
  const npm = makeNpmRegistryTree(makeOperations());
  const root = makePackageRegistryTree({ npm });
  const view = makeLookupTreeView(root);
  // The view has no `list` method at all.
  t.false(/** @type {any} */ (view).__getMethodNames__().includes('list'));
  // An empty path would resolve to the enumerable root; it must be rejected
  // rather than handing the un-attenuated tree back.
  const emptyError = await t.throwsAsync(() =>
    /** @type {any} */ (view).lookup([]),
  );
  t.is(registryErrorName(emptyError), 'RegistryPathSyntaxError');
  // A tree-shaped result one hop down is re-attenuated: still no enumeration.
  const npmView = await /** @type {any} */ (view).lookup('npm');
  t.false(typeof npmView.list === 'function');
  const alphaView = await npmView.lookup('alpha');
  t.false(typeof alphaView.list === 'function');
});

test('comparePublishedVersions is a total order past 2**53 and on build metadata', t => {
  // Release components are registry-supplied and unbounded; `Number()` collapsed
  // distinct large versions to equal and overflowed huge ones to `Infinity`
  // (`Infinity - Infinity === NaN` leaves `sort` unordered). BigInt fixes both.
  const bigLower = '9007199254740992.0.0';
  const bigHigher = '9007199254740993.0.0';
  t.true(comparePublishedVersions(bigLower, bigHigher) < 0);
  t.true(comparePublishedVersions(bigHigher, bigLower) > 0);
  const huge = `1.0.${'9'.repeat(400)}`;
  const hugeMinusOne = `1.0.${'9'.repeat(399)}8`;
  t.true(comparePublishedVersions(hugeMinusOne, huge) < 0);
  t.true(comparePublishedVersions(huge, hugeMinusOne) > 0);
  // Distinct keys that tie by semver precedence (build metadata, or a
  // leading-zero numeric prerelease identifier) must still compare distinctly
  // and antisymmetrically, or `sort` order rides the packument's key order.
  for (const [a, b] of [
    ['1.0.0+a', '1.0.0+b'],
    ['1.0.0-alpha.1', '1.0.0-alpha.01'],
  ]) {
    t.not(comparePublishedVersions(a, b), 0);
    t.is(
      Math.sign(comparePublishedVersions(a, b)),
      -Math.sign(comparePublishedVersions(b, a)),
    );
  }
  // A reversed input sorts identically — the total-order invariant.
  const inputs = [bigHigher, bigLower, '1.0.0+b', '1.0.0+a', '1.0.0'];
  t.deepEqual(
    [...inputs].sort(comparePublishedVersions),
    [...inputs].reverse().sort(comparePublishedVersions),
  );
});

test('has(name, version) does not materialize a version leaf', async t => {
  let providePackageTreeCalls = 0;
  const operations = harden({
    async listVersions(name) {
      const versions = packages[name];
      return versions === undefined ? undefined : Object.keys(versions);
    },
    async providePackageTree(name, version) {
      providePackageTreeCalls += 1;
      const record = packages[name]?.[version];
      if (record === undefined) throw new RangeError(`${name}@${version}`);
      return harden({
        treeRef: makePackageTree(name, version),
        integrity: record.integrity,
      });
    },
  });
  const npm = makeNpmRegistryTree(operations);
  // A known (name, version) is a metadata-only truth; an unknown version is
  // false. Neither may drive a tarball fetch / CAS write — a guest looping
  // `has` over a packument's version list must not consume bandwidth or disk.
  t.true(await npm.has('alpha', '1.0.0'));
  t.true(await npm.has('@scope/package', '1.2.3'));
  t.false(await npm.has('alpha', '9.9.9'));
  t.is(providePackageTreeCalls, 0);
  // The version-directory level enforces the same bound.
  const alphaDirectory = /** @type {any} */ (await npm.lookup('alpha'));
  t.true(await alphaDirectory.has('2.0.0'));
  t.false(await alphaDirectory.has('9.9.9'));
  t.is(providePackageTreeCalls, 0);
});

test('has and lookup agree on a bare scope, on both backends', async t => {
  // `lookup('@scope')` returns a scope hub unconditionally, so `has('@scope')`
  // must be true and must not ask the backend for a package literally named
  // `@scope` — which would make the two disagree, and disagree per-backend
  // since only Endor supplies `hasPackage`.
  const withoutHasPackage = makeNpmRegistryTree(makeOperations());
  t.true(await withoutHasPackage.has('@scope'));
  t.not(await withoutHasPackage.lookup('@scope'), undefined);

  const queriedNames = [];
  const withHasPackage = makeNpmRegistryTree(
    harden({
      ...makeOperations(),
      async hasPackage(name) {
        queriedNames.push(name);
        return packages[name] !== undefined;
      },
    }),
  );
  t.true(await withHasPackage.has('@scope'));
  // The backend's `hasPackage` was never consulted for the bare scope.
  t.false(queriedNames.includes('@scope'));
});

test('the hasPackage fast path is pinned for bare and scoped packages', async t => {
  // Deleting the `operations.hasPackage` branch must redden a test (prover):
  // the Endor cheap-probe path answers package existence without listVersions.
  const calls = {
    hasPackage: /** @type {string[]} */ ([]),
    listVersions: /** @type {string[]} */ ([]),
  };
  const operations = harden({
    async hasPackage(name) {
      calls.hasPackage.push(name);
      return packages[name] !== undefined;
    },
    async listVersions(name) {
      calls.listVersions.push(name);
      const versions = packages[name];
      return versions === undefined ? undefined : Object.keys(versions);
    },
    async providePackageTree(name, version) {
      const record = packages[name]?.[version];
      if (record === undefined) throw new RangeError(`${name}@${version}`);
      return harden({
        treeRef: makePackageTree(name, version),
        integrity: record.integrity,
      });
    },
  });
  const npm = makeNpmRegistryTree(operations);
  t.true(await npm.has('alpha'));
  t.true(await npm.has('@scope/package'));
  t.false(await npm.has('does-not-exist'));
  // Package-existence was answered by the cheap probe, not the version list.
  t.deepEqual(calls.hasPackage, ['alpha', '@scope/package', 'does-not-exist']);
  t.deepEqual(calls.listVersions, []);
});

test('guest-controlled names with URL-unsafe characters are rejected', async t => {
  // The Endor lane concatenates the name into a fetch URL unescaped; a name
  // that is not npm-charset-clean must be rejected before it reaches any host
  // power, on both backends. `listVersions` must never see these.
  const seen = /** @type {string[]} */ ([]);
  const npm = makeNpmRegistryTree(
    harden({
      async listVersions(name) {
        seen.push(name);
        return undefined;
      },
      async providePackageTree() {
        throw new Error('unreached');
      },
    }),
  );
  for (const bad of ['..', 'foo?x=1', 'a/../b', '%2e%2e', 'a b', '@scope/..']) {
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(() => npm.lookup(bad));
    t.is(registryErrorName(error), 'RegistryPathSyntaxError');
    // eslint-disable-next-line no-await-in-loop
    t.false(await npm.has(bad));
  }
  t.deepEqual(seen, []);
});

test('makeLookupTreeView forwards the wrapped node integrity and consistency', async t => {
  const npm = makeNpmRegistryTree(makeOperations());
  const root = makePackageRegistryTree({ npm });
  const view = makeLookupTreeView(root);
  // The view must report the wrapped root's real consistency, not a fixed one.
  t.deepEqual(await /** @type {any} */ (view).getInfo(), {
    temporal: 'stable',
  });
  // A resolved version leaf keeps its integrity so a holder can verify it.
  const leafView = await /** @type {any} */ (view).lookup([
    'npm',
    'alpha',
    '1.0.0',
  ]);
  const info = await leafView.getInfo();
  t.is(info.temporal, 'immutable');
  t.is(info.integrity, 'sha512-a1');
});

test('makePackageRegistryTree does not leak intrinsics through inherited keys', async t => {
  const npm = makeNpmRegistryTree(makeOperations());
  const root = makePackageRegistryTree({ npm });
  for (const polluted of [
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(() => root.lookup(polluted));
    t.is(registryErrorName(error), 'RegistryNotFoundError');
    // eslint-disable-next-line no-await-in-loop
    t.false(await root.has(polluted));
  }
});

test('registry errors are passable and classify across the real marshal boundary', async t => {
  // A structured error must stay passable: an own property outside
  // {message, stack, cause, errors} makes an error non-passable regardless of
  // enumerability, so the classification rides `makeError`'s out-of-band
  // `tagError` tag (same-vat) and the message channel (cross-boundary), never an
  // own property. Exercise the *real* boundary rather than a hand-built copy.
  const original = harden(RegistryNotFoundError('/npm/example'));
  t.true(original instanceof RangeError);
  // passStyleOf throws for a non-passable error; M.error() is the pattern a
  // return guard applies. Both must accept the error.
  t.is(passStyleOf(original), 'error');
  t.notThrows(() => mustMatch(original, M.error()));
  // The message is the surviving classification channel once the out-of-band tag
  // is dropped by a marshal round-trip (simulated here by a bare copy).
  const copied = harden(Error(original.message));
  t.is(registryErrorName(copied), 'RegistryNotFoundError');
  t.true(isPackageRegistryError(copied));
});

test('has treats an undefined in-tree lookup as absent, not present', async t => {
  // breaker: the Endor lane's leaf `lookup` returns `undefined` (rather than
  // throwing) for a missing in-tree entry. `has` folded any non-throw into
  // `true`, so an absent path inside a real version tree read as present. The
  // fixture's `lookup` returns `undefined` like the Endor lane; `has` must
  // agree with `lookup`: absent => false, and `lookup` => undefined (no throw).
  const npm = makeNpmRegistryTree(makeOperations());
  const root = makePackageRegistryTree({ npm });
  t.false(await npm.has('alpha', '1.0.0', 'nope'));
  t.false(await root.has('npm', 'alpha', '1.0.0', 'nope'));
  const alphaDirectory = /** @type {any} */ (await npm.lookup('alpha'));
  t.false(await alphaDirectory.has('1.0.0', 'nope'));
  // The known (package, version) pair is still present.
  t.true(await npm.has('alpha', '1.0.0'));
  t.is(await npm.lookup(['alpha', '1.0.0', 'nope']), undefined);
});

test('has validates the charset on the split scoped spelling', async t => {
  // corner-prober / spec-keeper: `has('@scope', part)` composes
  // `${scope}/${part}` and reached `listVersions`/`hasPackage` unvalidated,
  // while `lookup` validates the same segment. Both the two-argument split form
  // and the array spelling must reject the same names `lookup` rejects, and the
  // backend must never see the composed bad name.
  const seen = /** @type {string[]} */ ([]);
  const npm = makeNpmRegistryTree(
    harden({
      async listVersions(name) {
        seen.push(name);
        return undefined;
      },
      async providePackageTree() {
        throw new Error('unreached');
      },
    }),
  );
  for (const part of ['..', 'foo?x=1', '%2e%2e%2fetc', 'a b']) {
    // eslint-disable-next-line no-await-in-loop
    t.false(await npm.has('@scope', part));
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(() => npm.lookup(['@scope', part]));
    t.is(registryErrorName(error), 'RegistryPathSyntaxError');
  }
  t.deepEqual(seen, []);
});

test('a zero-published-versions package reads as absent on both backends', async t => {
  // corner-prober: `versionsFor` treated only `undefined` as absent, so an
  // empty version list meant "exists" on the Node lane while Endor's
  // `!versions.is_empty()` reported absent — a per-backend divergence. An empty
  // list must read as not-found for both `has` and `lookup`.
  const npm = makeNpmRegistryTree(
    harden({
      async listVersions(name) {
        return name === 'empty' ? [] : undefined;
      },
      async providePackageTree() {
        throw new Error('unreached');
      },
    }),
  );
  t.false(await npm.has('empty'));
  const error = await t.throwsAsync(() => npm.lookup('empty'));
  t.is(registryErrorName(error), 'RegistryNotFoundError');
});

test('@registry has traverses with has, never materializing a version leaf', async t => {
  // locksmith: the root installed at every host's `@registry` implemented `has`
  // as a `lookup`-based traversal, so `has('npm', name, version)` materialized a
  // version leaf (tarball fetch + CAS write). A guest holding `@registry` could
  // turn the free predicate into unbounded egress. `has` must exercise no more
  // authority than the child's own `has`.
  let providePackageTreeCalls = 0;
  const operations = harden({
    async listVersions(name) {
      const versions = packages[name];
      return versions === undefined ? undefined : Object.keys(versions);
    },
    async providePackageTree(name, version) {
      providePackageTreeCalls += 1;
      const record = packages[name]?.[version];
      if (record === undefined) throw new RangeError(`${name}@${version}`);
      return harden({
        treeRef: makePackageTree(name, version),
        integrity: record.integrity,
      });
    },
  });
  const npm = makeNpmRegistryTree(operations);
  const root = makePackageRegistryTree({ npm });
  t.true(await root.has('npm', 'alpha', '1.0.0'));
  t.true(await root.has('npm', '@scope/package', '1.2.3'));
  t.false(await root.has('npm', 'alpha', '9.9.9'));
  // The scope hub's `has` likewise consults metadata only.
  const scope = /** @type {any} */ (await npm.lookup('@scope'));
  t.true(await scope.has('package', '1.2.3'));
  t.false(await scope.has('package', '9.9.9'));
  t.is(providePackageTreeCalls, 0);
});
