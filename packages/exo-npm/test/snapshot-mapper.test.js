import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import {
  buildCompartmentMap,
  mapSnapshot,
  makeMountReadPowers,
} from '../src/snapshot-mapper.js';

const utf8Encoder = new TextEncoder();

/**
 * Build a minimal `EndoReadableTree`-shaped exo that reads from an
 * in-memory file map. Module paths map directly to file keys.
 *
 * @param {Record<string, string>} files
 */
const makeFakeTree = files => {
  return Far('FakeReadableTree', {
    sha256: () => 'fake-hash',
    list: async () => Object.keys(files),
    lookup: async () => undefined,
    has: async path => Object.prototype.hasOwnProperty.call(files, path),
    help: () => 'FakeReadableTree',
    /**
     * @param {string | string[]} modulePath
     */
    readBytes: async modulePath => {
      const key = Array.isArray(modulePath) ? modulePath.join('/') : modulePath;
      const body = files[key];
      if (body === undefined) {
        throw Error(`FakeTree: no file at ${key}`);
      }
      return utf8Encoder.encode(body);
    },
  });
};

test('buildCompartmentMap emits one compartment per resolution key', t => {
  const entryPj = JSON.stringify({
    name: 'entry',
    version: '0.0.0',
    dependencies: { lodash: '^4.17.0', ses: '^1.0.0' },
  });
  const resolution = harden({
    packagesByKey: harden({
      'lodash@4.17.21': {
        name: 'lodash',
        version: '4.17.21',
        treeRef: makeFakeTree({}),
        integrity: 'sha512-a',
      },
      'ses@1.5.0': {
        name: 'ses',
        version: '1.5.0',
        treeRef: makeFakeTree({}),
        integrity: 'sha512-b',
      },
    }),
    keys: harden(['lodash@4.17.21', 'ses@1.5.0']),
    resolutionHash: 'h0',
  });
  const map = buildCompartmentMap({
    resolution,
    entryPackageJson: entryPj,
  });
  t.truthy(map.compartments['.'], 'entry compartment is present');
  t.truthy(map.compartments['lodash@4.17.21'], 'lodash compartment is present');
  t.truthy(map.compartments['ses@1.5.0'], 'ses compartment is present');
  t.is(map.entry.compartment, '.');
});

test('buildCompartmentMap distinguishes workspace members from registry entries', t => {
  // Workspace members carry no version segment; registry entries do.
  const entryPj = JSON.stringify({
    name: 'lib-a',
    version: '1.0.0',
    dependencies: { 'lib-b': 'workspace:^', helper: '^1.0.0' },
  });
  const resolution = harden({
    packagesByKey: harden({
      'lib-b': {
        name: 'lib-b',
        version: '0.0.0',
        treeRef: makeFakeTree({}),
        integrity: 'workspace:',
      },
      'helper@1.5.0': {
        name: 'helper',
        version: '1.5.0',
        treeRef: makeFakeTree({}),
        integrity: 'sha512-h',
      },
    }),
    keys: harden(['helper@1.5.0', 'lib-b']),
    resolutionHash: 'h1',
  });
  const map = buildCompartmentMap({
    resolution,
    entryPackageJson: entryPj,
  });
  // Workspace member at bare-name peer directory.
  t.truthy(map.compartments['lib-b']);
  t.is(map.compartments['lib-b'].location, 'lib-b');
  // Registry entry at versioned peer directory.
  t.truthy(map.compartments['helper@1.5.0']);
  t.is(map.compartments['helper@1.5.0'].location, 'helper@1.5.0');
});

test('buildCompartmentMap emits multi-major coexistence as distinct compartments', t => {
  const entryPj = JSON.stringify({
    name: 'entry',
    dependencies: { pkg: '^1.0.0' },
  });
  const resolution = harden({
    packagesByKey: harden({
      'pkg@1.0.0': {
        name: 'pkg',
        version: '1.0.0',
        treeRef: makeFakeTree({}),
        integrity: 'sha512-p1',
      },
      'pkg@2.0.0': {
        name: 'pkg',
        version: '2.0.0',
        treeRef: makeFakeTree({}),
        integrity: 'sha512-p2',
      },
    }),
    keys: harden(['pkg@1.0.0', 'pkg@2.0.0']),
    resolutionHash: 'h2',
  });
  const map = buildCompartmentMap({
    resolution,
    entryPackageJson: entryPj,
  });
  t.truthy(map.compartments['pkg@1.0.0']);
  t.truthy(map.compartments['pkg@2.0.0']);
});

test('makeMountReadPowers reads from entry compartment', async t => {
  const entrySource = makeFakeTree({ 'index.js': 'export const x = 1;' });
  const resolution = harden({
    packagesByKey: harden({}),
    keys: harden([]),
    resolutionHash: '',
  });
  const powers = makeMountReadPowers({ entrySource, resolution });
  const bytes = await powers.read('./index.js');
  t.is(new TextDecoder().decode(bytes), 'export const x = 1;');
});

test('makeMountReadPowers reads from a registry-resolved peer directory', async t => {
  const sesFiles = { 'lockdown.js': 'export const lockdown = () => {};' };
  const sesTree = makeFakeTree(sesFiles);
  const entrySource = makeFakeTree({ 'index.js': "import 'ses';" });
  const resolution = harden({
    packagesByKey: harden({
      'ses@1.0.0': {
        name: 'ses',
        version: '1.0.0',
        treeRef: sesTree,
        integrity: 'sha512-s',
      },
    }),
    keys: harden(['ses@1.0.0']),
    resolutionHash: '',
  });
  const powers = makeMountReadPowers({ entrySource, resolution });
  const bytes = await powers.read('ses@1.0.0/lockdown.js');
  t.is(new TextDecoder().decode(bytes), 'export const lockdown = () => {};');
});

test('makeMountReadPowers reads from a scoped-package peer directory', async t => {
  const patternsFiles = { 'src/main.js': 'export const M = {};' };
  const patternsTree = makeFakeTree(patternsFiles);
  const entrySource = makeFakeTree({});
  const resolution = harden({
    packagesByKey: harden({
      '@endo/patterns@1.2.1': {
        name: '@endo/patterns',
        version: '1.2.1',
        treeRef: patternsTree,
        integrity: 'sha512-p',
      },
    }),
    keys: harden(['@endo/patterns@1.2.1']),
    resolutionHash: '',
  });
  const powers = makeMountReadPowers({ entrySource, resolution });
  const bytes = await powers.read('@endo/patterns@1.2.1/src/main.js');
  t.is(new TextDecoder().decode(bytes), 'export const M = {};');
});

test('makeMountReadPowers reads from a workspace member compartment', async t => {
  const libBFiles = { 'index.js': 'module.exports = 42;' };
  const libBTree = makeFakeTree(libBFiles);
  const entrySource = makeFakeTree({});
  const resolution = harden({
    packagesByKey: harden({
      'lib-b': {
        name: 'lib-b',
        version: '0.0.0',
        treeRef: libBTree,
        integrity: 'workspace:',
      },
    }),
    keys: harden(['lib-b']),
    resolutionHash: '',
  });
  const powers = makeMountReadPowers({ entrySource, resolution });
  const bytes = await powers.read('lib-b/index.js');
  t.is(new TextDecoder().decode(bytes), 'module.exports = 42;');
});

test('mapSnapshot produces the {compartmentMap, resolution, readPowers} trio', async t => {
  const sesTree = makeFakeTree({ 'index.js': '/* ses */' });
  const entrySource = makeFakeTree({ 'main.js': "import 'ses';" });
  const entryPj = JSON.stringify({
    name: 'app',
    dependencies: { ses: '^1.0.0' },
  });
  const resolution = harden({
    packagesByKey: harden({
      'ses@1.5.0': {
        name: 'ses',
        version: '1.5.0',
        treeRef: sesTree,
        integrity: 'sha512-s',
      },
    }),
    keys: harden(['ses@1.5.0']),
    resolutionHash: 'h-snapshot',
  });
  const result = await mapSnapshot({
    resolution,
    entrySource,
    entryPackageJson: entryPj,
  });
  t.truthy(result.compartmentMap, 'compartmentMap is returned');
  t.is(result.resolution.resolutionHash, 'h-snapshot');
  // The read powers can read the entry.
  const bytes = await result.readPowers.read('./main.js');
  t.is(new TextDecoder().decode(bytes), "import 'ses';");
  // And the registry-resolved compartment.
  const sesBytes = await result.readPowers.read('ses@1.5.0/index.js');
  t.is(new TextDecoder().decode(sesBytes), '/* ses */');
});

test('mapSnapshot canonical preserves the input location', async t => {
  const entrySource = makeFakeTree({});
  const resolution = harden({
    packagesByKey: harden({}),
    keys: harden([]),
    resolutionHash: '',
  });
  const result = await mapSnapshot({
    resolution,
    entrySource,
    entryPackageJson: JSON.stringify({ name: 'entry' }),
  });
  t.is(await result.readPowers.canonical('any-location'), 'any-location');
});
