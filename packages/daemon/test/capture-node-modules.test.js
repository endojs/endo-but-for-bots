// @ts-check

/** @import { CaptureResult, ReadPowers } from '@endo/compartment-mapper' */
/** @import { ExecutionContext } from 'ava' */

import '@endo/init/debug.js';
import fs, {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { mapNodeModules } from '@endo/compartment-mapper/node-modules.js';
import { makeTreeReadPowers } from '@endo/platform/fs/lite';
import { makeLocalTree } from '@endo/platform/fs/node';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { ZipReader } from '@endo/zip/reader.js';
import test from 'ava';

import {
  captureNodeModules,
  captureNodeModulesArchive,
} from '../src/capture-node-modules.js';
import { makeFilePowers } from '../src/manager-node-powers.js';
import {
  makeMount,
  makeMountCanonical,
  makeRevocableMount,
} from '../src/mount.js';

const filePowers = makeFilePowers({ fs, path });

const rootLocation = 'file:///app/';

/**
 * @param {ExecutionContext} testContext
 * @param {string} entrySource
 */
const makeFixture = (testContext, entrySource) => {
  const directory = mkdtempSync(join(tmpdir(), 'capture-node-modules-'));
  testContext.teardown(() =>
    rmSync(directory, { recursive: true, force: true }),
  );
  const dependencyDirectory = join(
    directory,
    'node_modules',
    'tree-dependency',
  );
  mkdirSync(dependencyDirectory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'tree-application',
      version: '1.0.0',
      type: 'module',
      exports: {
        '.': {
          endo: './scan.js',
          default: './wrong.js',
        },
      },
      dependencies: {
        'tree-dependency': '1.0.0',
      },
    }),
  );
  writeFileSync(join(directory, 'scan.js'), entrySource);
  writeFileSync(join(directory, 'mapped.js'), entrySource);
  writeFileSync(
    join(directory, 'wrong.js'),
    "throw Error('the default condition must not be captured');\n",
  );
  writeFileSync(
    join(dependencyDirectory, 'package.json'),
    JSON.stringify({
      name: 'tree-dependency',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }),
  );
  writeFileSync(
    join(dependencyDirectory, 'index.js'),
    "export const value = 'captured dependency';\n",
  );
  return directory;
};

/**
 * @param {CaptureResult} capture
 * @param {string} compartmentName
 * @param {string} moduleSpecifier
 */
const sourceText = (capture, compartmentName, moduleSpecifier) => {
  const moduleSource = capture.captureSources[compartmentName][moduleSpecifier];
  if (!('bytes' in moduleSource) || moduleSource.bytes === undefined) {
    throw Error(`Expected source bytes for ${moduleSpecifier}`);
  }
  return decodeUtf8(moduleSource.bytes);
};

/**
 * Write a pre-generated compartment map naming one compartment location.
 *
 * @param {ExecutionContext} testContext
 * @param {unknown} location
 */
const makeMapFixture = (testContext, location) => {
  const directory = makeFixture(testContext, "export default 'mapped';\n");
  writeFileSync(
    join(directory, 'compartment-map.json'),
    JSON.stringify({
      tags: [],
      entry: { compartment: 'file:///app/', module: './mapped.js' },
      compartments: {
        'file:///app/': {
          name: 'tree-application',
          label: 'tree-application',
          location,
          modules: {},
        },
      },
    }),
  );
  return makeLocalTree(directory);
};

test('node-modules-with-map refuses a compartment location outside the root', async testContext => {
  await null;
  for (const location of [
    'file:///outside/',
    'file:///app/../outside/',
    'file:///app-other/',
  ]) {
    const tree = makeMapFixture(testContext, location);
    // eslint-disable-next-line no-await-in-loop
    await testContext.throwsAsync(
      () => captureNodeModules(tree, { layout: 'node-modules-with-map' }),
      { message: /location .* is not under tree root "file:\/\/\/app\/"/ },
      location,
    );
  }
});

test('node-modules-with-map normalizes a root without a trailing slash', async testContext => {
  const tree = makeMapFixture(testContext, 'file:///app-other/');
  await testContext.throwsAsync(
    () =>
      captureNodeModules(tree, {
        layout: 'node-modules-with-map',
        root: 'file:///app',
      }),
    {
      message:
        /location "file:\/\/\/app-other\/" is not under tree root "file:\/\/\/app\/"/,
    },
  );
});

test('node-modules-with-map refuses a compartment with no location', async testContext => {
  const tree = makeMapFixture(testContext, undefined);
  await testContext.throwsAsync(
    () => captureNodeModules(tree, { layout: 'node-modules-with-map' }),
    { message: /is missing its location/ },
  );
});

test('node-modules-scan refuses an entry outside a root without a trailing slash', async testContext => {
  const directory = makeFixture(testContext, "export default 'scan';\n");
  const tree = makeLocalTree(directory);
  await testContext.throwsAsync(
    () =>
      captureNodeModules(tree, {
        layout: 'node-modules-scan',
        root: 'file:///app',
        entry: '../app-other/x.js',
      }),
    {
      message:
        /Entry location "file:\/\/\/app-other\/x.js" is not under tree root "file:\/\/\/app\/"/,
    },
  );
});

test('node-modules-with-map captures the map entry and in-place sources', async testContext => {
  const entrySource =
    "import { value } from 'tree-dependency';\nexport default 'mapped: ' + value;\n";
  const directory = makeFixture(testContext, entrySource);
  const tree = makeLocalTree(directory);
  /** @type {ReadPowers} */
  const readPowers = /** @type {any} */ (
    makeTreeReadPowers(tree, { root: rootLocation })
  );
  const compartmentMap = await mapNodeModules(
    readPowers,
    new URL('mapped.js', rootLocation).href,
  );
  writeFileSync(
    join(directory, 'compartment-map.json'),
    JSON.stringify(compartmentMap),
  );

  // A with-map capture must not rescan the root package descriptor.
  writeFileSync(join(directory, 'package.json'), '{not valid JSON');

  const capture = await captureNodeModules(tree, {
    layout: 'node-modules-with-map',
  });

  testContext.deepEqual(capture.captureCompartmentMap.entry, {
    compartment: '$root$',
    module: './mapped.js',
  });
  testContext.deepEqual(
    Object.keys(capture.captureCompartmentMap.compartments).sort(),
    ['$root$', 'tree-dependency'],
  );
  testContext.is(sourceText(capture, '$root$', './mapped.js'), entrySource);
  testContext.is(
    sourceText(capture, 'tree-dependency', './index.js'),
    "export const value = 'captured dependency';\n",
  );
});

test('node-modules-scan maps the root package export before capture', async testContext => {
  const entrySource =
    "import { value } from 'tree-dependency';\nexport default 'scanned: ' + value;\n";
  const directory = makeFixture(testContext, entrySource);
  const tree = makeLocalTree(directory);

  const capture = await captureNodeModules(tree, {
    layout: 'node-modules-scan',
  });

  testContext.deepEqual(capture.captureCompartmentMap.entry, {
    compartment: '$root$',
    module: './scan.js',
  });
  testContext.deepEqual(
    Object.keys(capture.captureCompartmentMap.compartments).sort(),
    ['$root$', 'tree-dependency'],
  );
  testContext.is(sourceText(capture, '$root$', './scan.js'), entrySource);
  testContext.false('./wrong.js' in capture.captureSources.$root$);
  testContext.is(
    sourceText(capture, 'tree-dependency', './index.js'),
    "export const value = 'captured dependency';\n",
  );
});

test('node-modules-scan archives only source parsers the XS loader runs', async testContext => {
  const entrySource =
    "import { value } from 'tree-dependency';\nexport default 'scanned: ' + value;\n";
  const directory = makeFixture(testContext, entrySource);
  const archiveBytes = await captureNodeModulesArchive(
    makeLocalTree(directory),
    { layout: 'node-modules-scan' },
  );

  const archive = new ZipReader(archiveBytes);
  const compartmentMap = JSON.parse(
    decodeUtf8(archive.read('compartment-map.json')),
  );
  const parsers = Object.values(compartmentMap.compartments).flatMap(
    compartment =>
      Object.values(compartment.modules)
        .filter(module => 'parser' in module)
        .map(module => module.parser),
  );
  testContext.true(parsers.length > 0);
  for (const parser of parsers) {
    testContext.true(['mjs', 'cjs', 'json'].includes(parser), parser);
  }
  const { compartment, module } = compartmentMap.entry;
  const { location } = compartmentMap.compartments[compartment].modules[module];
  testContext.is(
    decodeUtf8(archive.read(`${compartment}/${location}`)),
    entrySource,
  );
});

/**
 * A root package that depends on `shared` directly and through `middle`,
 * whose own `node_modules/shared` is an in-root link to the top-level copy,
 * as pnpm's and Yarn's linked layouts produce.
 *
 * @param {ExecutionContext} testContext
 */
const makeLinkedFixture = testContext => {
  const directory = mkdtempSync(join(tmpdir(), 'capture-node-modules-'));
  testContext.teardown(() =>
    rmSync(directory, { recursive: true, force: true }),
  );
  /**
   * @param {string} location
   * @param {object} descriptor
   * @param {string} source
   */
  const writePackage = (location, descriptor, source) => {
    mkdirSync(location, { recursive: true });
    writeFileSync(
      join(location, 'package.json'),
      JSON.stringify({
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
        ...descriptor,
      }),
    );
    writeFileSync(join(location, 'index.js'), source);
  };
  writePackage(
    directory,
    {
      name: 'linked-application',
      dependencies: { middle: '1.0.0', shared: '1.0.0' },
    },
    "import { shared } from 'shared';\nimport { middle } from 'middle';\nexport default shared === middle;\n",
  );
  writePackage(
    join(directory, 'node_modules', 'shared'),
    { name: 'shared' },
    'export const shared = {};\n',
  );
  writePackage(
    join(directory, 'node_modules', 'middle'),
    { name: 'middle', dependencies: { shared: '1.0.0' } },
    "export { shared as middle } from 'shared';\n",
  );
  mkdirSync(join(directory, 'node_modules', 'middle', 'node_modules'));
  symlinkSync(
    join('..', '..', 'shared'),
    join(directory, 'node_modules', 'middle', 'node_modules', 'shared'),
  );
  return directory;
};

test('mount canonical resolves an in-root link to its physical entry', async testContext => {
  await null;
  const directory = makeLinkedFixture(testContext);
  const mount = makeMount({ rootPath: directory, readOnly: true, filePowers });
  const canonical = makeMountCanonical(mount);
  if (canonical === undefined) {
    throw Error('Expected a canonical hook for a daemon-minted mount');
  }

  testContext.deepEqual(
    await canonical(['node_modules', 'middle', 'node_modules', 'shared']),
    ['node_modules', 'shared'],
  );
  testContext.deepEqual(await canonical(['node_modules', 'middle']), [
    'node_modules',
    'middle',
  ]);
  testContext.deepEqual(await canonical([]), []);
  // A missing path keeps its logical segments, as Node's `canonical` does.
  testContext.deepEqual(await canonical(['node_modules', 'absent']), [
    'node_modules',
    'absent',
  ]);
  // The read-only tree view of the mount carries the same hook.
  const view = makeMountCanonical(await mount.readOnly());
  if (view === undefined) {
    throw Error('Expected a canonical hook for a mount view');
  }
  testContext.deepEqual(
    await view(['node_modules', 'middle', 'node_modules', 'shared']),
    ['node_modules', 'shared'],
  );
});

test('mount canonical is absent for a tree the daemon did not mint as a mount', testContext => {
  const directory = makeLinkedFixture(testContext);
  testContext.is(makeMountCanonical(makeLocalTree(directory)), undefined);
  testContext.is(makeMountCanonical(harden({})), undefined);
});

test('mount canonical maps a sub-mount entry relative to its own root', async testContext => {
  const directory = makeLinkedFixture(testContext);
  const mount = makeMount({ rootPath: directory, readOnly: true, filePowers });
  const subMount = await mount.lookup(['node_modules']);
  const canonical = makeMountCanonical(subMount);
  if (canonical === undefined) {
    throw Error('Expected a canonical hook for a sub-mount');
  }
  testContext.deepEqual(await canonical(['middle', 'node_modules', 'shared']), [
    'shared',
  ]);
});

test('mount canonical refuses a link that resolves outside the tree root', async testContext => {
  const directory = makeLinkedFixture(testContext);
  const outside = mkdtempSync(join(tmpdir(), 'capture-node-modules-outside-'));
  testContext.teardown(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(directory, 'node_modules', 'escape'));
  // A sibling of a sub-mount's root is inside the mount's confinement but
  // outside the tree the sub-mount presents, and is refused the same way.
  mkdirSync(join(directory, 'packages', 'member'), { recursive: true });
  symlinkSync(
    join('..', '..', 'node_modules', 'shared'),
    join(directory, 'packages', 'member', 'sibling'),
  );

  const mount = makeMount({ rootPath: directory, readOnly: true, filePowers });
  const canonical = makeMountCanonical(mount);
  if (canonical === undefined) {
    throw Error('Expected a canonical hook for a daemon-minted mount');
  }
  await testContext.throwsAsync(() => canonical(['node_modules', 'escape']), {
    message:
      /Unsupported layout: "node_modules\/escape" resolves outside the mount root/,
  });

  const memberMount = await mount.lookup(['packages', 'member']);
  const memberCanonical = makeMountCanonical(memberMount);
  if (memberCanonical === undefined) {
    throw Error('Expected a canonical hook for a sub-mount');
  }
  await testContext.throwsAsync(() => memberCanonical(['sibling']), {
    message: /Unsupported layout: "sibling" resolves outside the mount root/,
  });
});

test('mount canonical returns a missing location and reports a link loop', async testContext => {
  const directory = makeLinkedFixture(testContext);
  symlinkSync('loop', join(directory, 'node_modules', 'loop'));

  const mount = makeMount({ rootPath: directory, readOnly: true, filePowers });
  const canonical = makeMountCanonical(mount);
  if (canonical === undefined) {
    throw Error('Expected a canonical hook for a daemon-minted mount');
  }
  testContext.deepEqual(await canonical(['node_modules', 'absent']), [
    'node_modules',
    'absent',
  ]);
  // A symlink loop is not a missing dependency.
  await testContext.throwsAsync(() => canonical(['node_modules', 'loop']), {
    code: 'ELOOP',
  });
});

test('mount canonical is refused once the mount is revoked', async testContext => {
  const directory = makeLinkedFixture(testContext);
  const { mount, control } = makeRevocableMount({
    rootPath: directory,
    readOnly: true,
    filePowers,
  });
  const canonical = makeMountCanonical(mount);
  if (canonical === undefined) {
    throw Error('Expected a canonical hook for a daemon-minted mount');
  }
  control.revoke();
  await testContext.throwsAsync(() => canonical(['node_modules', 'shared']), {
    message: /revoked/,
  });
});

test('node-modules-scan over a mount loads a linked package as one compartment', async testContext => {
  const directory = makeLinkedFixture(testContext);

  // Without the daemon's hook, the linked path is a second package.
  const unlinked = await captureNodeModules(makeLocalTree(directory), {
    layout: 'node-modules-scan',
  });
  testContext.is(
    Object.keys(unlinked.captureCompartmentMap.compartments).length,
    4,
  );

  const mount = makeMount({ rootPath: directory, readOnly: true, filePowers });
  const capture = await captureNodeModules(mount, {
    layout: 'node-modules-scan',
  });
  testContext.deepEqual(
    Object.keys(capture.captureCompartmentMap.compartments).sort(),
    ['$root$', 'middle', 'shared'],
  );
  testContext.is(
    sourceText(capture, 'shared', './index.js'),
    'export const shared = {};\n',
  );
});

test('node-modules-scan over a mount rejects a dependency linked outside the root', async testContext => {
  const directory = makeLinkedFixture(testContext);
  const outside = mkdtempSync(join(tmpdir(), 'capture-node-modules-outside-'));
  testContext.teardown(() => rmSync(outside, { recursive: true, force: true }));
  rmSync(join(directory, 'node_modules', 'shared'), { recursive: true });
  writeFileSync(
    join(outside, 'package.json'),
    JSON.stringify({ name: 'shared', version: '1.0.0', type: 'module' }),
  );
  symlinkSync(outside, join(directory, 'node_modules', 'shared'));

  const mount = makeMount({ rootPath: directory, readOnly: true, filePowers });
  await testContext.throwsAsync(
    () => captureNodeModules(mount, { layout: 'node-modules-scan' }),
    { message: /Unsupported layout: .* resolves outside the mount root/ },
  );
});
