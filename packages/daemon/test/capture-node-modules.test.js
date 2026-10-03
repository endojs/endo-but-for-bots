// @ts-check

/** @import { CaptureResult, ReadPowers } from '@endo/compartment-mapper' */
/** @import { ExecutionContext } from 'ava' */

import '@endo/init/debug.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mapNodeModules } from '@endo/compartment-mapper/node-modules.js';
import { makeTreeReadPowers } from '@endo/platform/fs/lite';
import { makeLocalTree } from '@endo/platform/fs/node';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import test from 'ava';

import { captureNodeModules } from '../src/capture-node-modules.js';

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
