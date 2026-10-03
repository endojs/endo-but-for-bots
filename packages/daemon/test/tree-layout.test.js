// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  detectTreeLayout,
  requestedTreeLayouts,
  resolveTreeLayout,
  treeKindForFormulaType,
} from '../src/tree-layout.js';

/**
 * A root-only tree over a record of entry names to text, offering the
 * `has`, `lookup` and `text` surface `detectTreeLayout` reads.  A `null` entry
 * exists but cannot be read as text, as a directory.
 *
 * @param {Record<string, string | null>} entries
 */
const makeFakeTree = entries =>
  harden({
    /** @param {string} name */
    has: async name => Object.hasOwn(entries, name),
    /** @param {string} name */
    lookup: async name => {
      if (!Object.hasOwn(entries, name)) {
        throw Error(`No entry ${name}`);
      }
      const content = entries[name];
      return harden({
        text: async () => {
          if (content === null) {
            throw Error(`Entry ${name} is not a file`);
          }
          return content;
        },
      });
    },
  });

test('requestedTreeLayouts lists detect and every layout', t => {
  t.deepEqual(
    [...requestedTreeLayouts],
    [
      'detect',
      'archive',
      'node-modules-with-map',
      'node-modules-scan',
      'package',
    ],
  );
  t.true(Object.isFrozen(requestedTreeLayouts));
});

test('treeKindForFormulaType names snapshots and mounts', t => {
  t.is(treeKindForFormulaType('readable-tree'), 'snapshot');
  t.is(treeKindForFormulaType('mount'), 'mount');
  t.is(treeKindForFormulaType('scratch-mount'), 'mount');
  t.is(treeKindForFormulaType('directory'), 'directory');
  t.is(treeKindForFormulaType(undefined), undefined);
});

test('detectTreeLayout reads an archive compartment map as archive', async t => {
  await null;
  const tree = makeFakeTree({
    'compartment-map.json': JSON.stringify({
      compartments: { 'app-v1.0.0': { location: 'app-v1.0.0' } },
    }),
  });
  t.is(await detectTreeLayout(tree), 'archive');
});

test('detectTreeLayout reads a file: compartment map as node-modules-with-map', async t => {
  await null;
  const tree = makeFakeTree({
    'compartment-map.json': JSON.stringify({
      compartments: {
        'file:///app/': { location: 'file:///app/' },
        'file:///app/node_modules/dep/': {
          location: 'file:///app/node_modules/dep/',
        },
      },
    }),
  });
  t.is(await detectTreeLayout(tree), 'node-modules-with-map');
});

test('detectTreeLayout reads a mixed or malformed compartment map as archive', async t => {
  await null;
  const maps = [
    {
      compartments: {
        a: { location: 'file:///app/' },
        b: { location: 'b' },
      },
    },
    { compartments: {} },
    { compartments: null },
    { compartments: { a: null } },
    { compartments: { a: { location: 7 } } },
    {},
    null,
    'archive',
  ];
  for (const map of maps) {
    const tree = makeFakeTree({ 'compartment-map.json': JSON.stringify(map) });
    // eslint-disable-next-line no-await-in-loop
    t.is(await detectTreeLayout(tree), 'archive', JSON.stringify(map));
  }
});

test('detectTreeLayout rejects a compartment map that is not JSON', async t => {
  await null;
  const tree = makeFakeTree({ 'compartment-map.json': '{ not json' });
  await t.throwsAsync(() => detectTreeLayout(tree), {
    message: /compartment-map\.json is not valid JSON/,
  });
});

test('detectTreeLayout reads a package.json root as node-modules-scan', async t => {
  await null;
  t.is(
    await detectTreeLayout(makeFakeTree({ 'package.json': '{}' })),
    'node-modules-scan',
  );
  t.is(
    await detectTreeLayout(
      makeFakeTree({
        'package.json': '{}',
        '.pnp.cjs': '',
        node_modules: null,
      }),
    ),
    'node-modules-scan',
    'a Plug-n-Play marker beside node_modules still scans',
  );
});

test('detectTreeLayout rejects a Plug-n-Play install with no node_modules', async t => {
  await null;
  for (const marker of ['.pnp.cjs', '.pnp.js']) {
    const tree = makeFakeTree({ 'package.json': '{}', [marker]: '' });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => detectTreeLayout(tree), {
      message: /matches no makeFromTree layout.*Plug'n'Play/,
    });
  }
});

test('detectTreeLayout rejects a tree that matches no layout', async t => {
  await null;
  const tree = makeFakeTree({ 'README.md': 'hello' });
  await t.throwsAsync(() => detectTreeLayout(tree), {
    message:
      /matches no makeFromTree layout: found neither compartment-map\.json/,
  });
});

test('detectTreeLayout propagates failures other than absence', async t => {
  await null;
  // A root marker that exists but cannot be read as a file is an error, not
  // a missing marker.
  await t.throwsAsync(
    () => detectTreeLayout(makeFakeTree({ 'package.json': null })),
    { message: /Entry package\.json is not a file/ },
  );
  await t.throwsAsync(
    () =>
      detectTreeLayout(
        makeFakeTree({ 'compartment-map.json': null, 'package.json': '{}' }),
      ),
    { message: /Entry compartment-map\.json is not a file/ },
  );
  const failing = harden({
    has: async () => {
      throw Error('connection lost');
    },
    lookup: async () => {
      throw Error('connection lost');
    },
  });
  await t.throwsAsync(() => detectTreeLayout(failing), {
    message: /connection lost/,
  });
});

test('resolveTreeLayout returns an explicit layout without reading the tree', async t => {
  await null;
  const tree = makeFakeTree({});
  for (const layout of /** @type {const} */ ([
    'archive',
    'node-modules-with-map',
    'node-modules-scan',
  ])) {
    // eslint-disable-next-line no-await-in-loop
    t.is(await resolveTreeLayout(tree, layout), layout);
  }
});

test('resolveTreeLayout detects when asked to', async t => {
  await null;
  const tree = makeFakeTree({ 'package.json': '{}' });
  t.is(await resolveTreeLayout(tree, 'detect'), 'node-modules-scan');
});

test('resolveTreeLayout refuses package and unknown layouts', async t => {
  await null;
  const tree = makeFakeTree({});
  await t.throwsAsync(() => resolveTreeLayout(tree, 'package'), {
    message: /layout "package" requires makeFromPackage/,
  });
  await t.throwsAsync(
    () => resolveTreeLayout(tree, /** @type {any} */ ('zip')),
    { message: /Unknown makeFromTree layout "zip"/ },
  );
});
