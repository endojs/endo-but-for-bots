// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mapSnapshot } from '../src/map-snapshot.js';

const textEncoder = new TextEncoder();

const packageJson = (name, version, fields = {}) =>
  harden({ name, version, main: './index.js', ...fields });

const makeTree = files =>
  harden({
    async maybeReadText(pathArg) {
      const path = Array.isArray(pathArg) ? pathArg.join('/') : pathArg;
      return files[path];
    },
    async readText(pathArg) {
      const path = Array.isArray(pathArg) ? pathArg.join('/') : pathArg;
      const text = files[path];
      if (text === undefined) {
        throw new Error(`ENOENT ${path}`);
      }
      return text;
    },
  });

const makeRegistry = resolution =>
  harden({
    async resolve(packageJsonBytes) {
      tLikePackageJsonBytes(packageJsonBytes);
      return resolution;
    },
    async fetch(name, version) {
      return resolution.packagesByKey[`${name}@${version}`].treeRef;
    },
  });

const tLikePackageJsonBytes = packageJsonBytes => {
  if (!(packageJsonBytes instanceof Uint8Array)) {
    throw new Error('expected package.json bytes');
  }
};

test('mapSnapshot maps incompatible majors to distinct package compartments', async t => {
  const entryPackage = packageJson('entry', '1.0.0', {
    dependencies: { pkg: '^1.0.0', transitive: '^1.0.0' },
  });
  const pkg1 = packageJson('pkg', '1.0.0');
  const pkg2 = packageJson('pkg', '2.0.0');
  const transitive = packageJson('transitive', '1.0.0', {
    dependencies: { pkg: '^2.0.0' },
  });
  const resolution = harden({
    packagesByKey: {
      'pkg@1.0.0': {
        name: 'pkg',
        version: '1.0.0',
        packageJson: pkg1,
        treeRef: makeTree({
          'package.json': JSON.stringify(pkg1),
          'index.js': 'export const version = "one";',
        }),
        integrity: 'sha512-pkg-1',
      },
      'pkg@2.0.0': {
        name: 'pkg',
        version: '2.0.0',
        packageJson: pkg2,
        treeRef: makeTree({
          'package.json': JSON.stringify(pkg2),
          'index.js': 'export const version = "two";',
        }),
        integrity: 'sha512-pkg-2',
      },
      'transitive@1.0.0': {
        name: 'transitive',
        version: '1.0.0',
        packageJson: transitive,
        treeRef: makeTree({
          'package.json': JSON.stringify(transitive),
          'index.js': 'import "pkg";',
        }),
        integrity: 'sha512-transitive',
      },
    },
    keys: ['pkg@1.0.0', 'pkg@2.0.0', 'transitive@1.0.0'],
    resolutionHash: 'sha256-multi-major',
    diagnostics: harden({ unmetOptionals: [], workspaceVersionMismatches: [] }),
  });

  const { compartmentMap, readPowers } = await mapSnapshot({
    registry: makeRegistry(resolution),
    mount: makeTree({
      'package.json': JSON.stringify(entryPackage),
      'index.js': 'import "pkg"; import "transitive";',
    }),
    resolution,
  });

  t.is(
    compartmentMap.compartments['file:///'].scopes.pkg.compartment,
    'file:///pkg@1.0.0/',
  );
  t.is(
    compartmentMap.compartments['file:///transitive@1.0.0/'].scopes.pkg
      .compartment,
    'file:///pkg@2.0.0/',
  );
  t.deepEqual(
    await readPowers.read('file:///pkg@2.0.0/index.js'),
    textEncoder.encode('export const version = "two";'),
  );
});

test('mapSnapshot uses versionless workspace locations and keeps registry peers', async t => {
  const entryPackage = packageJson('entry', '1.0.0', {
    dependencies: { '@endo/patterns': 'workspace:^', consumer: '^1.0.0' },
  });
  const workspacePatterns = packageJson('@endo/patterns', '9.0.0');
  const registryPatterns = packageJson('@endo/patterns', '1.0.0');
  const consumer = packageJson('consumer', '1.0.0', {
    dependencies: { '@endo/patterns': '^1.0.0' },
  });
  const resolution = harden({
    packagesByKey: {
      '@endo/patterns': {
        name: '@endo/patterns',
        version: '9.0.0',
        packageJson: workspacePatterns,
        treeRef: makeTree({
          'package.json': JSON.stringify(workspacePatterns),
          'index.js': 'export const source = "workspace";',
        }),
        integrity: 'workspace:@endo/patterns@9.0.0',
        workspace: true,
      },
      '@endo/patterns@1.0.0': {
        name: '@endo/patterns',
        version: '1.0.0',
        packageJson: registryPatterns,
        treeRef: makeTree({
          'package.json': JSON.stringify(registryPatterns),
          'index.js': 'export const source = "registry";',
        }),
        integrity: 'sha512-patterns-1',
      },
      'consumer@1.0.0': {
        name: 'consumer',
        version: '1.0.0',
        packageJson: consumer,
        treeRef: makeTree({
          'package.json': JSON.stringify(consumer),
          'index.js': 'import "@endo/patterns";',
        }),
        integrity: 'sha512-consumer',
      },
    },
    keys: ['@endo/patterns', '@endo/patterns@1.0.0', 'consumer@1.0.0'],
    resolutionHash: 'sha256-workspace',
    diagnostics: harden({ unmetOptionals: [], workspaceVersionMismatches: [] }),
  });

  const { compartmentMap, readPowers } = await mapSnapshot({
    registry: makeRegistry(resolution),
    mount: makeTree({
      'package.json': JSON.stringify(entryPackage),
      'index.js': 'import "@endo/patterns"; import "consumer";',
    }),
    resolution,
  });

  t.truthy(compartmentMap.compartments['file:///@endo/patterns/']);
  t.truthy(compartmentMap.compartments['file:///@endo/patterns@1.0.0/']);
  t.is(
    compartmentMap.compartments['file:///consumer@1.0.0/'].scopes[
      '@endo/patterns'
    ].compartment,
    'file:///@endo/patterns/',
  );
  t.deepEqual(
    await readPowers.read('file:///@endo/patterns/index.js'),
    textEncoder.encode('export const source = "workspace";'),
  );
});
