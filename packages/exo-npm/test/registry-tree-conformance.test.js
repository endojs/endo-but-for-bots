// @ts-check
/* eslint-disable no-underscore-dangle */

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import {
  RegistryOfflineError,
  isPackageRegistryError,
  makeDeprecatedEndoRegistryAdapter,
  makeEndorNpmRegistryTree,
  makeNpmRegistryTree,
  makePackageRegistryTree,
  registryErrorName,
} from '../index.js';

const packages = harden({
  alpha: harden({
    '2.0.0': harden({
      integrity: 'sha512-alpha-2',
      packageJson: JSON.stringify({ name: 'alpha', version: '2.0.0' }),
    }),
    '1.0.0': harden({
      integrity: 'sha512-alpha-1',
      packageJson: JSON.stringify({ name: 'alpha', version: '1.0.0' }),
    }),
  }),
  '@scope/package': harden({
    '1.2.3': harden({
      integrity: 'sha512-scoped',
      packageJson: JSON.stringify({
        name: '@scope/package',
        version: '1.2.3',
      }),
    }),
  }),
  ordering: harden({
    '1.0.0': harden({
      integrity: 'sha512-ordering-stable',
      packageJson: JSON.stringify({ name: 'ordering', version: '1.0.0' }),
    }),
    '1.0.0-alpha.10': harden({
      integrity: 'sha512-ordering-alpha-10',
      packageJson: JSON.stringify({
        name: 'ordering',
        version: '1.0.0-alpha.10',
      }),
    }),
    '1.0.0-alpha.2': harden({
      integrity: 'sha512-ordering-alpha-2',
      packageJson: JSON.stringify({
        name: 'ordering',
        version: '1.0.0-alpha.2',
      }),
    }),
  }),
});

/**
 * @param {string} name
 * @param {string} version
 * @param {string} packageJson
 */
const makePackageTree = (name, version, packageJson) => {
  const packageJsonBlob = Far('PackageJsonBlob', {
    text: async () => packageJson,
    json: async () => JSON.parse(packageJson),
    streamBase64: async () => undefined,
    help: () => 'package.json',
  });
  return Far('ConformancePackageTree', {
    help: () => `${name}@${version}`,
    has: async (...path) => path.length === 1 && path[0] === 'package.json',
    list: async (...path) => (path.length === 0 ? ['package.json'] : []),
    lookup: async path =>
      (typeof path === 'string' ? path : path.join('/')) === 'package.json'
        ? packageJsonBlob
        : undefined,
    sha256: () => `sha256-${name}-${version}`,
    getInfo: async () =>
      harden({
        algorithm: 'sha256',
        hash: `hash-${name}-${version}`,
        size: 1n,
      }),
  });
};

/**
 * @param {{
 *   offline?: boolean,
 *   cachedNames?: string[],
 *   cachedVersions?: string[],
 * }} [options]
 */
const makeOperations = ({
  offline = false,
  cachedNames: initialCachedNames = [],
  cachedVersions: initialCachedVersions = [],
} = {}) => {
  const cachedNames = new Set(initialCachedNames);
  const cachedVersions = new Set(initialCachedVersions);
  return harden({
    async listVersions(name) {
      if (offline && !cachedNames.has(name)) {
        throw RegistryOfflineError(`no cached packument for ${name}`);
      }
      const packageVersions = packages[name];
      if (packageVersions === undefined) return undefined;
      cachedNames.add(name);
      return Object.keys(packageVersions);
    },
    async providePackageTree(name, version) {
      const key = `${name}@${version}`;
      if (offline && !cachedVersions.has(key)) {
        throw RegistryOfflineError(name, version);
      }
      const record = packages[name]?.[version];
      if (record === undefined) throw new RangeError(key);
      cachedVersions.add(key);
      return harden({
        treeRef: makePackageTree(name, version, record.packageJson),
        integrity: record.integrity,
      });
    },
  });
};

const backends = harden([
  harden({ name: 'Node', makeNpm: makeNpmRegistryTree }),
  harden({ name: 'Endor', makeNpm: makeEndorNpmRegistryTree }),
]);

for (const backend of backends) {
  test(`${backend.name} registry tree conforms to paths and node contracts`, async t => {
    const npm = backend.makeNpm(makeOperations());
    const root = makePackageRegistryTree({ npm });
    t.deepEqual(await root.list(), ['npm']);
    t.deepEqual(await root.getInfo(), { temporal: 'stable' });
    t.false(await root.has('missing-registry'));
    const missingRegistry = await t.throwsAsync(() =>
      root.lookup('missing-registry'),
    );
    t.true(missingRegistry instanceof RangeError);
    t.true(isPackageRegistryError(missingRegistry));
    t.deepEqual(await npm.getInfo(), { temporal: 'live' });
    t.false(/** @type {any} */ (npm).__getMethodNames__().includes('list'));
    const absentListError = t.throws(() => /** @type {any} */ (npm).list(), {
      instanceOf: TypeError,
    });
    t.false(isPackageRegistryError(absentListError));

    const alpha = /** @type {import('../types.js').RegistryDirectory} */ (
      await npm.lookup('alpha')
    );
    t.deepEqual(await alpha.list(), ['1.0.0', '2.0.0']);
    t.deepEqual(await alpha.getInfo(), { temporal: 'live' });
    t.true(await npm.has('alpha'));
    t.false(await npm.has('absent'));
    const alphaLeaf = /** @type {import('../types.js').RegistryVersionTree} */ (
      await alpha.lookup('1.0.0')
    );
    t.is(alphaLeaf.sha256(), 'sha256-alpha-1.0.0');
    const alphaLeafAgain =
      /** @type {import('../types.js').RegistryVersionTree} */ (
        await alpha.lookup('1.0.0')
      );
    t.is(alphaLeafAgain.sha256(), alphaLeaf.sha256());
    t.like(await alphaLeaf.getInfo(), {
      temporal: 'immutable',
      integrity: 'sha512-alpha-1',
    });
    const ordering = /** @type {import('../types.js').RegistryDirectory} */ (
      await npm.lookup('ordering')
    );
    t.deepEqual(await ordering.list(), [
      '1.0.0-alpha.2',
      '1.0.0-alpha.10',
      '1.0.0',
    ]);

    const scopedByName = await npm.lookup('@scope/package');
    const scopedByPath = await npm.lookup(['@scope', 'package']);
    const scope = /** @type {import('../types.js').RegistryHub} */ (
      await npm.lookup('@scope')
    );
    const scopedStepwise = await scope.lookup('package');
    t.is(scopedByName, scopedByPath);
    t.is(scopedByName, scopedStepwise);
    t.false(/** @type {any} */ (scope).__getMethodNames__().includes('list'));
    t.deepEqual(await scope.getInfo(), { temporal: 'live' });
    t.throws(() => /** @type {any} */ (scope).list(), {
      instanceOf: TypeError,
    });

    const missingVersion = await t.throwsAsync(() => alpha.lookup('9.9.9'));
    t.true(missingVersion instanceof RangeError);
    t.is(registryErrorName(missingVersion), 'RegistryNotFoundError');

    const missingScoped = await t.throwsAsync(() =>
      npm.lookup('@missing/package'),
    );
    t.true(missingScoped instanceof RangeError);
    t.is(registryErrorName(missingScoped), 'RegistryNotFoundError');

    const missing = await t.throwsAsync(() => npm.lookup('absent'));
    t.true(missing instanceof RangeError);
    t.is(registryErrorName(missing), 'RegistryNotFoundError');
    t.true(isPackageRegistryError(missing));
    t.is(/** @type {any} */ (missing).errorName, 'PackageRegistryError');

    for (const malformed of [
      'scope/package',
      '@scope/',
      '@scope/package/more',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const malformedError = await t.throwsAsync(() => npm.lookup(malformed));
      t.true(malformedError instanceof SyntaxError);
      t.is(registryErrorName(malformedError), 'RegistryPathSyntaxError');
      t.true(isPackageRegistryError(malformedError));
      t.is(
        /** @type {any} */ (malformedError).errorName,
        'PackageRegistryError',
      );
    }
  });
}

test('offline hub lookup distinguishes unknown from false has result', async t => {
  const npm = makeNpmRegistryTree(makeOperations({ offline: true }));
  t.false(await npm.has('uncached'));
  const error = await t.throwsAsync(() => npm.lookup('uncached'));
  t.is(registryErrorName(error), 'RegistryOfflineError');
  t.true(isPackageRegistryError(error));
});

test('offline exact-version lookup has the shared registry error family', async t => {
  const npm = makeNpmRegistryTree(
    makeOperations({ offline: true, cachedNames: ['alpha'] }),
  );
  const alpha = /** @type {import('../types.js').RegistryDirectory} */ (
    await npm.lookup('alpha')
  );
  const error = await t.throwsAsync(() => alpha.lookup('1.0.0'));
  t.is(registryErrorName(error), 'RegistryOfflineError');
  t.true(isPackageRegistryError(error));
});

test('deprecated adapter preserves old lookup, scoped name, and list shapes', async t => {
  const npm = makeNpmRegistryTree(makeOperations());
  const root = makePackageRegistryTree({ npm });
  const legacy = makeDeprecatedEndoRegistryAdapter(root);
  t.truthy(await legacy.lookup('alpha', '1.0.0'));
  t.truthy(await legacy.lookup('@scope/package', '1.2.3'));
  t.is(await legacy.lookup('absent', '1.0.0'), undefined);
  t.deepEqual(await legacy.list(), []);
});
