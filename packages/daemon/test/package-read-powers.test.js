// @ts-check
// Unit tests for the worker-side `makeFromPackage` read powers
// (packages/daemon/src/package-read-powers.js).  They run compartment-mapper's
// real `importLocation` over in-memory trees standing in for the source tree
// and the resolved packages' CAS trees, so no daemon or registry is needed.

import test from '@endo/ses-ava/prepare-endo.js';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { blobFromBytes } from '@endo/platform/blob';
import {
  importPackage,
  makePackageReadPowers,
} from '../src/package-read-powers.js';

const MemoryTreeInterface = M.interface('MemoryTree', {
  has: M.call().rest(M.arrayOf(M.string())).returns(M.boolean()),
  list: M.call().rest(M.arrayOf(M.string())).returns(M.arrayOf(M.string())),
  lookup: M.call(M.or(M.string(), M.arrayOf(M.string()))).returns(
    M.remotable(),
  ),
});

/**
 * A read-only tree over nested plain objects whose leaves are file text.
 *
 * @param {Record<string, any>} contents
 * @returns {any}
 */
const makeMemoryTree = contents => {
  /** @param {readonly string[]} segments */
  const walk = segments => {
    let node = contents;
    for (const segment of segments) {
      if (typeof node !== 'object' || !Object.hasOwn(node, segment)) {
        return undefined;
      }
      node = node[segment];
    }
    return node;
  };
  /** @param {unknown} node */
  const wrap = node =>
    typeof node === 'string'
      ? blobFromBytes(encodeUtf8(node))
      : makeMemoryTree(/** @type {Record<string, any>} */ (node));
  return makeExo('MemoryTree', MemoryTreeInterface, {
    /** @param {string[]} segments */
    has: (...segments) => walk(segments) !== undefined,
    /** @param {string[]} segments */
    list: (...segments) => {
      const node = walk(segments);
      if (typeof node !== 'object') {
        throw Error(`Not a directory: ${segments.join('/')}`);
      }
      return Object.keys(node).sort();
    },
    /** @param {string | readonly string[]} nameOrPath */
    lookup: nameOrPath => {
      const segments =
        typeof nameOrPath === 'string' ? [nameOrPath] : nameOrPath;
      const node = walk(segments);
      if (node === undefined) {
        throw Error(`No such entry: ${segments.join('/')}`);
      }
      return wrap(node);
    },
  });
};

/**
 * @param {string} name
 * @param {string} version
 * @param {Record<string, string>} dependencies
 * @param {string} source
 */
const makePackage = (name, version, dependencies, source) =>
  harden({
    name,
    version,
    integrity: '',
    treeRef: makeMemoryTree({
      'package.json': JSON.stringify({
        name,
        version,
        type: 'module',
        main: 'index.js',
        dependencies,
      }),
      'index.js': source,
    }),
  });

/**
 * Resolution where the entry wants `dep-a@^1` and `dep-b@^1`, and `dep-b`
 * wants `dep-a@^2`, so two majors of `dep-a` coexist.
 */
const makeMultiMajorResolution = () => {
  const packages = [
    makePackage('dep-a', '1.2.0', {}, 'export const major = 1;'),
    makePackage('dep-a', '2.0.1', {}, 'export const major = 2;'),
    makePackage(
      'dep-b',
      '1.0.0',
      { 'dep-a': '^2.0.0' },
      "export { major as dependencyMajor } from 'dep-a';",
    ),
    makePackage('dep-c', '1.0.0', {}, 'export const undeclared = true;'),
  ];
  const packagesByKey = Object.fromEntries(
    packages.map(entry => [`${entry.name}@${entry.version}`, entry]),
  );
  return harden({
    packagesByKey,
    keys: Object.keys(packagesByKey).sort(),
  });
};

/**
 * @param {string} indexSource
 * @param {Record<string, any>} [extraFiles]
 */
const makeEntryTree = (indexSource, extraFiles = {}) =>
  makeMemoryTree({
    'package.json': JSON.stringify({
      name: 'entry',
      version: '0.0.0',
      type: 'module',
      main: 'index.js',
      dependencies: { 'dep-a': '^1.0.0', 'dep-b': '^1.0.0' },
    }),
    'index.js': indexSource,
    ...extraFiles,
  });

const multiMajorIndex = `
  import { major } from 'dep-a';
  import { dependencyMajor } from 'dep-b';
  export const majors = { entry: major, dependency: dependencyMajor };
`;

test('each package links the major its own range selects', async t => {
  const namespace = await importPackage({
    globals: {},
    entryTree: makeEntryTree(multiMajorIndex),
    resolution: makeMultiMajorResolution(),
  });
  t.deepEqual(namespace.majors, { entry: 1, dependency: 2 });
});

test('a node_modules directory inside the source tree is shadowed', async t => {
  const entryTree = makeEntryTree(multiMajorIndex, {
    node_modules: {
      'dep-a': {
        'package.json': JSON.stringify({
          name: 'dep-a',
          version: '1.9.9',
          type: 'module',
          main: 'index.js',
        }),
        'index.js': 'export const major = 9;',
      },
    },
  });
  const namespace = await importPackage({
    globals: {},
    entryTree,
    resolution: makeMultiMajorResolution(),
  });
  t.deepEqual(namespace.majors, { entry: 1, dependency: 2 });
});

test('a resolved package the importer does not declare is absent', async t => {
  await t.throwsAsync(
    importPackage({
      globals: {},
      entryTree: makeEntryTree("export { undeclared } from 'dep-c';"),
      resolution: makeMultiMajorResolution(),
    }),
    { message: message => message.includes('dep-c') },
  );
});

test('canonical names one location per resolved package', async t => {
  const { readPowers } = makePackageReadPowers({
    entryTree: makeEntryTree(multiMajorIndex),
    resolution: makeMultiMajorResolution(),
  });
  const { canonical } = /** @type {any} */ (readPowers);
  t.is(
    await canonical('file:///entry/node_modules/dep-a/'),
    'file:///packages/dep-a@1.2.0/',
  );
  t.is(
    await canonical(
      'file:///entry/node_modules/dep-b/node_modules/dep-a/index.js',
    ),
    'file:///packages/dep-a@2.0.1/index.js',
  );
  t.is(
    await canonical('file:///packages/dep-b@1.0.0/node_modules/dep-a/'),
    'file:///packages/dep-a@2.0.1/',
  );
  t.is(
    await canonical('file:///entry/node_modules/dep-c/'),
    'file:///entry/node_modules/dep-c/',
  );
});

test('maybeRead reports a directory or a missing file as absent', async t => {
  const { readPowers } = makePackageReadPowers({
    entryTree: makeEntryTree(multiMajorIndex, {
      lib: { 'index.js': 'export default 1;' },
    }),
    resolution: makeMultiMajorResolution(),
  });
  const { maybeRead } = /** @type {any} */ (readPowers);
  t.is(await maybeRead('file:///entry/lib'), undefined);
  t.is(await maybeRead('file:///entry/missing.js'), undefined);
  t.is(await maybeRead('file:///outside/index.js'), undefined);
  t.truthy(await maybeRead('file:///entry/lib/index.js'));
});

test('an explicit entry module runs instead of the package entry', async t => {
  const namespace = await importPackage({
    globals: {},
    entryTree: makeEntryTree(multiMajorIndex, {
      'other.js': "export { major } from 'dep-a';",
    }),
    resolution: makeMultiMajorResolution(),
    entry: 'other.js',
  });
  t.is(namespace.major, 1);
});

test('an entry outside the package root is refused', t => {
  t.throws(
    () =>
      makePackageReadPowers({
        entryTree: makeEntryTree(multiMajorIndex),
        resolution: makeMultiMajorResolution(),
        entry: '../packages/dep-a@1.2.0/index.js',
      }),
    { message: /outside the package root/ },
  );
});

test('read returns package file bytes and refuses an unreachable location', async t => {
  const { readPowers } = makePackageReadPowers({
    entryTree: makeEntryTree(multiMajorIndex),
    resolution: makeMultiMajorResolution(),
  });
  const { read } = /** @type {any} */ (readPowers);
  const bytes = await read('file:///entry/node_modules/dep-a/index.js');
  t.is(new TextDecoder().decode(bytes), 'export const major = 1;');
  await t.throwsAsync(read('file:///outside/index.js'), {
    message: /no such package file/,
  });
});

test('malformed and unknown locations are absent', async t => {
  const { readPowers } = makePackageReadPowers({
    entryTree: makeEntryTree(multiMajorIndex),
    resolution: makeMultiMajorResolution(),
  });
  const { maybeRead, canonical } = /** @type {any} */ (readPowers);
  const unknownPackage = await maybeRead(
    'file:///packages/dep-z@1.0.0/index.js',
  );
  t.is(unknownPackage, undefined);
  t.is(await maybeRead('file:///packages/%E0%A4%A/index.js'), undefined);
  t.is(
    await maybeRead('file:///entry/node_modules/%E0%A4%A/index.js'),
    undefined,
  );
  t.is(await maybeRead('file:///entry/node_modules/@scope'), undefined);
  t.is(await maybeRead('file:///entry/%E0%A4%A.js'), undefined);
  t.is(await maybeRead('file:///entry/lib//index.js'), undefined);
  t.is(
    await canonical('file:///packages/dep-z@1.0.0/index.js'),
    'file:///packages/dep-z@1.0.0/index.js',
  );
});

test('maybeRead rethrows a read failure on an entry that is not a directory', async t => {
  const { readPowers } = makePackageReadPowers({
    entryTree: makeEntryTree(multiMajorIndex, { 'broken.js': 42 }),
    resolution: makeMultiMajorResolution(),
  });
  const { maybeRead } = /** @type {any} */ (readPowers);
  await t.throwsAsync(maybeRead('file:///entry/broken.js'));
});

test('a package without an entry module needs an explicit entry', async t => {
  await t.throwsAsync(
    importPackage({
      globals: {},
      entryTree: makeMemoryTree({
        'package.json': JSON.stringify({
          name: 'entry',
          version: '0.0.0',
          type: 'module',
          exports: { './other': './other.js' },
        }),
        'other.js': 'export const other = true;',
      }),
      resolution: makeMultiMajorResolution(),
    }),
    { message: /no entry module/ },
  );
});
