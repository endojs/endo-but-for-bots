/* global globalThis */
import './ses-lockdown.js';
import test from 'ava';
import fs from 'node:fs';
import url from 'node:url';
import { mapNodeModules } from '../node-modules.js';
import { makeReadNowPowers, makeReadPowers } from '../node-powers.js';
import {
  getModulePaths,
  wrap,
} from '../src/parse-cjs-shared-export-wrapper.js';
import { loadFromMap } from '../import-lite.js';
import {
  makeImportHookMaker,
  makeImportNowHookMaker,
} from '../src/import-hook.js';
import { defaultParserForLanguage } from '../import-parsers.js';
import { makeProjectFixtureReadPowers } from './project-fixture.js';

/**
 * @import {ProjectFixture} from './test.types.js';
 */

/**
 * Replaces each `globalThis[name]` with a value that throws on any use and
 * returns a function that restores the originals.
 * Modules that captured the intrinsic at initialization are unaffected.
 *
 * @param {string[]} names
 * @returns {() => void}
 */
const poisonGlobals = names => {
  const descriptors = names.map(
    name =>
      /** @type {PropertyDescriptor} */ (
        Object.getOwnPropertyDescriptor(globalThis, name)
      ),
  );
  const poisons = names.map(name => {
    const fail = () => {
      throw Error(`ambient ${name} used after module initialization`);
    };
    return new Proxy(function poisoned() {}, {
      get: fail,
      apply: fail,
      construct: fail,
    });
  });
  names.forEach((name, index) => {
    Object.defineProperty(globalThis, name, {
      value: poisons[index],
      writable: true,
      enumerable: false,
      configurable: true,
    });
  });
  return () => {
    names.forEach((name, index) => {
      Object.defineProperty(globalThis, name, descriptors[index]);
    });
  };
};

/**
 * Calls `thunk` synchronously while the named globals are poisoned.
 *
 * @template T
 * @param {string[]} names
 * @param {() => T} thunk
 * @returns {T}
 */
const withPoisonedGlobals = (names, thunk) => {
  const restore = poisonGlobals(names);
  try {
    return thunk();
  } finally {
    restore();
  }
};

test.serial(
  'node-powers fallback URL conversions ignore a replaced URL',
  async t => {
    const { fileURLToPath, pathToFileURL } = makeReadPowers(
      /** @type {any} */ ({ fs }),
    );
    if (!fileURLToPath || !pathToFileURL) {
      t.fail('makeReadPowers must provide URL conversions');
      return;
    }
    const location = 'file:///expected/path';
    const expectedPath = url.fileURLToPath(location);
    const expectedLocation = url.pathToFileURL(expectedPath).href;
    withPoisonedGlobals(['URL'], () => {
      t.is(fileURLToPath(location), expectedPath);
      t.is(`${pathToFileURL(expectedPath)}`, expectedLocation);
    });
  },
);

test.serial('node-powers read ignores a replaced Promise', async t => {
  const powers = makeReadPowers({ fs, url });
  // `read` uses `Promise` synchronously, before its first `await`.
  // Poisoning only that span keeps the test runner's own promises working.
  const bytes = await withPoisonedGlobals(['Promise'], () =>
    powers.read(import.meta.url),
  );
  t.true(bytes.length > 0);
});

test.serial('getModulePaths ignores a replaced URL', async t => {
  const readPowers = /** @type {any} */ ({
    fileURLToPath: url.fileURLToPath,
  });
  const expected = {
    filename: url.fileURLToPath('file:///a/b/c.js'),
    dirname: url.fileURLToPath('file:///a/b'),
  };
  withPoisonedGlobals(['URL'], () => {
    t.deepEqual(getModulePaths(readPowers, 'file:///a/b/c.js'), expected);
  });
});

test.serial(
  'CommonJS export wrapper ignores replaced Proxy and Set',
  async t => {
    /** @type {Record<string, any>} */
    const moduleEnvironmentRecord = {};
    withPoisonedGlobals(['Proxy', 'Set'], () => {
      const { module } = wrap({
        moduleEnvironmentRecord,
        compartment: /** @type {any} */ ({ globalThis }),
        resolvedImports: {},
        location: 'file:///a/b/c.js',
        readPowers: undefined,
      });
      module.exports.assigned = 1;
      Object.defineProperty(module.exports, 'defined', {
        value: 2,
        enumerable: true,
      });
    });
    t.is(moduleEnvironmentRecord.assigned, 1);
    t.is(moduleEnvironmentRecord.defined, 2);
  },
);

test.serial(
  'import hook resolves locations despite a replaced URL',
  async t => {
    /** @type {ProjectFixture} */
    const fixture = {
      root: 'app',
      graph: { app: ['dep'], dep: [] },
      entrypoint: 'file:///node_modules/app/index.js',
    };
    const readPowers = makeProjectFixtureReadPowers(fixture);
    const compartmentMap = await mapNodeModules(
      readPowers,
      /** @type {string} */ (fixture.entrypoint),
    );
    const application = await loadFromMap(readPowers, compartmentMap, {
      parserForLanguage: defaultParserForLanguage,
    });
    const restore = poisonGlobals(['URL']);
    try {
      const { namespace } = await application.import();
      t.truthy(namespace);
    } finally {
      restore();
    }
  },
);

test.serial('import hook makers ignore replaced Map and Set', t => {
  const readPowers = makeReadNowPowers({ fs, url });
  const baseLocation = 'file:///a/';
  /** @type {any} */
  const compartmentOptions = {
    packageLocation: 'file:///a/b/',
    packageName: 'b',
    attenuators: {},
    parse: () => {
      throw Error('unexpected parse');
    },
    shouldDeferError: () => false,
    compartments: {},
  };
  const hookMakerOptions = {
    entryCompartmentName: 'file:///a/',
    entryModuleSpecifier: './index.js',
    moduleSourceHook: undefined,
  };
  withPoisonedGlobals(['Map', 'Set'], () => {
    const makeImportHook = makeImportHookMaker(
      readPowers,
      baseLocation,
      hookMakerOptions,
    );
    t.is(typeof makeImportHook(compartmentOptions), 'function');
    const makeImportNowHook = makeImportNowHookMaker(
      readPowers,
      baseLocation,
      hookMakerOptions,
    );
    t.is(typeof makeImportNowHook(compartmentOptions), 'function');
  });
});
