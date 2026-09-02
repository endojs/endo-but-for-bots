// @ts-check
/* eslint-disable no-underscore-dangle */

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

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
  // The has⇒lookup contract must not disagree on the one slash-bearing spelling
  // npm tolerates as a leading segment.
  t.true(await npm.has('@scope/package', '1.2.3'));
  const leaf = await npm.lookup(['@scope/package', '1.2.3']);
  t.is(/** @type {any} */ (leaf).sha256(), 'sha256-@scope/package-1.2.3');
  // And it resolves the same node the single-string spelling normalizes.
  const alsoLeaf = await /** @type {any} */ (npm).lookup('@scope/package');
  const stepwise = await /** @type {any} */ (alsoLeaf).lookup('1.2.3');
  t.is(/** @type {any} */ (stepwise).sha256(), 'sha256-@scope/package-1.2.3');
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

test('registry error classification survives loss of the annotated tags', async t => {
  // A structured error carries non-enumerable tags that are stripped when it
  // crosses a marshal boundary; classification must still work from the
  // message channel that does survive.
  const original = RegistryNotFoundError('/npm/example');
  // Simulate the passable copy: same message, no errorName/registryErrorName.
  const copied = harden(Error(original.message));
  t.is(/** @type {any} */ (copied).registryErrorName, undefined);
  t.is(registryErrorName(copied), 'RegistryNotFoundError');
  t.true(isPackageRegistryError(copied));
});
