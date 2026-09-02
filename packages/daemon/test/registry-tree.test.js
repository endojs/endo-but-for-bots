// @ts-check

/** @import { RegistryDirectory, RegistryHub } from '@endo/exo-npm' */

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { isPackageRegistryError, registryErrorName } from '@endo/exo-npm';

import { makeRegistryTable } from '../src/registry.js';
import {
  makeEndorPackageRegistryTree,
  makeNodePackageRegistryTree,
} from '../src/registry-tree.js';

const makeTree = () =>
  Far('DaemonRegistryFixtureTree', {
    help: () => 'fixture',
    has: async () => false,
    list: async () => [],
    lookup: async () => undefined,
    sha256: () => 'fixture-sha256',
    getInfo: async () => harden({ hash: 'fixture-hash' }),
  });

test('Node adapter preserves manifest and exact-version table caching', async t => {
  let versionFetches = 0;
  let treeFetches = 0;
  const backend = harden({
    async fetchVersions(name) {
      versionFetches += 1;
      return name === 'fixture' ? ['1.0.0'] : undefined;
    },
    async provideTree(name, version) {
      treeFetches += 1;
      return harden({
        treeRef: makeTree(),
        integrity: `sha512-${name}-${version}`,
      });
    },
    async readPackageJson() {
      return new Uint8Array();
    },
    sha256Hex: text => text,
  });
  const root = makeNodePackageRegistryTree(backend, {
    table: makeRegistryTable(),
    registryUrl: 'https://registry.example',
  });
  const npm = /** @type {RegistryHub} */ (await root.lookup('npm'));
  const fixture = /** @type {RegistryDirectory} */ (
    await npm.lookup('fixture')
  );
  t.deepEqual(await fixture.list(), ['1.0.0']);
  t.is(treeFetches, 0, 'listing metadata does not fetch a tarball tree');
  const first = await fixture.lookup('1.0.0');
  const second = await fixture.lookup('1.0.0');
  t.is(first, second);
  t.is(versionFetches, 1);
  t.is(treeFetches, 1);
});

test('Endor adapter preserves the integrity-failure contract', async t => {
  const encode = value => JSON.stringify(value);
  const root = makeEndorPackageRegistryTree(
    harden({
      hasPackage: () => encode({ ok: true, value: true }),
      listVersions: () => encode({ ok: true, value: ['1.0.0'] }),
      providePackageTree: () =>
        encode({
          ok: false,
          error: { kind: 'tampered', message: 'integrity mismatch' },
        }),
      makeTreeRef: () => makeTree(),
    }),
  );
  const npm = /** @type {RegistryHub} */ (await root.lookup('npm'));
  const fixture = /** @type {RegistryDirectory} */ (
    await npm.lookup('fixture')
  );
  const error = await t.throwsAsync(() => fixture.lookup('1.0.0'));
  t.is(registryErrorName(error), 'RegistryTamperedError');
});

test('Node adapter preserves offline lookup distinctions', async t => {
  const backend = harden({
    fetchVersions: async () => {
      throw Error('network must not be called');
    },
    provideTree: async () => {
      throw Error('network must not be called');
    },
    readPackageJson: async () => new Uint8Array(),
    sha256Hex: text => text,
  });
  const table = makeRegistryTable();
  table.putManifest('cached', ['1.0.0']);
  const root = makeNodePackageRegistryTree(backend, {
    table,
    registryUrl: 'https://registry.example',
    offline: true,
  });
  const npm = /** @type {RegistryHub} */ (await root.lookup('npm'));
  t.false(await npm.has('uncached'));
  const packageError = await t.throwsAsync(() => npm.lookup('uncached'));
  t.is(registryErrorName(packageError), 'RegistryOfflineError');
  t.true(isPackageRegistryError(packageError));

  const cached = /** @type {RegistryDirectory} */ (await npm.lookup('cached'));
  const versionError = await t.throwsAsync(() => cached.lookup('1.0.0'));
  t.is(registryErrorName(versionError), 'RegistryOfflineError');
  t.true(isPackageRegistryError(versionError));
});

test('Node adapter re-provides a tree after table eviction', async t => {
  let treeFetches = 0;
  const backend = harden({
    fetchVersions: async () => ['1.0.0'],
    async provideTree(name, version) {
      treeFetches += 1;
      return harden({
        treeRef: makeTree(),
        integrity: `sha512-${name}-${version}`,
      });
    },
    readPackageJson: async () => new Uint8Array(),
    sha256Hex: text => text,
  });
  const root = makeNodePackageRegistryTree(backend, {
    table: makeRegistryTable({ maxEntries: 1 }),
  });
  const npm = /** @type {RegistryHub} */ (await root.lookup('npm'));
  const first = /** @type {RegistryDirectory} */ (await npm.lookup('first'));
  const second = /** @type {RegistryDirectory} */ (await npm.lookup('second'));
  await first.lookup('1.0.0');
  await second.lookup('1.0.0');
  await first.lookup('1.0.0');
  t.is(treeFetches, 3);
});
