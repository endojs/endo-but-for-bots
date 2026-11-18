// @ts-check
// HR-SYN-7: the gateway's key and method vocabulary comes from an explicit
// list of interface tables (`guest/lib/vocabulary-tables.js`), not a file
// glob. Zero skips: every module of `guest/lib/` that exports a guard or
// pattern is listed or excluded with a reason, every interface guard such a
// module exports contributes its keys and methods, and the sets are the ones
// pinned before the change. Node only.
import '../unit/_m1a-prelude.js';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  vocabularyExclusions,
  vocabularyTables,
} from '../../guest/lib/vocabulary-tables.js';
/* eslint-enable import/no-relative-packages */
import {
  collectNames,
  harnessNames,
} from '../../resources/agent-host/impl/gateway/vocabulary.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { passStyleOf } = /** @type {GuestGlobals} */ (globalThis);

const libDir = fileURLToPath(new URL('../../guest/lib/', import.meta.url));

/** The sets as they were before HR-SYN-7 (X1's snapshot, 258 and 141). */
const before = JSON.parse(
  readFileSync(
    new URL('../fixtures/guard-snapshot-before-x1.json', import.meta.url),
    'utf8',
  ),
).vocabulary;

/**
 * @param {string} dir
 * @returns {string[]}
 */
const jsFilesOf = dir =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFilesOf(path);
    return name.endsWith('.js') ? [path] : [];
  });

/** @param {unknown} value */
const tagOf = value => {
  try {
    if (passStyleOf(value) !== 'tagged') return undefined;
  } catch {
    return undefined;
  }
  const tag = /** @type {any} */ (value)[Symbol.toStringTag];
  return /^(guard|match):/.test(tag) ? tag : undefined;
};

/**
 * The guards and patterns a module exports, directly or as the entries of
 * an exported table.
 * @param {Record<string, unknown>} namespace
 */
const guardsOf = namespace => {
  /** @type {unknown[]} */
  const found = [];
  for (const value of Object.values(namespace)) {
    if (tagOf(value) !== undefined) {
      found.push(value);
    } else if (value !== null && typeof value === 'object') {
      for (const inner of Object.values(value)) {
        if (tagOf(inner) !== undefined) found.push(inner);
      }
    }
  }
  return found;
};

/** Every table module of `guest/lib/`, by path under it. */
const tableModules = async () => {
  /** @type {Map<string, unknown[]>} */
  const modules = new Map();
  const paths = jsFilesOf(libDir).sort();
  const namespaces = await Promise.all(
    paths.map(path => import(pathToFileURL(path).href)),
  );
  paths.forEach((path, index) => {
    const guards = guardsOf(namespaces[index]);
    if (guards.length > 0) modules.set(relative(libDir, path), guards);
  });
  return modules;
};

test('every table module of guest/lib is listed or excluded', async t => {
  const modules = await tableModules();
  const listed = vocabularyTables.map(({ file }) => file);
  const excluded = Object.keys(vocabularyExclusions);
  t.deepEqual(
    [...modules.keys()].sort(),
    [...listed, ...excluded].sort(),
    'a new or renamed table module joins vocabularyTables or vocabularyExclusions',
  );
  t.is(new Set(listed).size, listed.length, 'no table is listed twice');
  for (const [file, reason] of Object.entries(vocabularyExclusions)) {
    t.true(reason.length > 0, `${file}: a reason`);
  }
});

test('every interface guard of a table module contributes its names', async t => {
  const { keys, methods } = harnessNames();
  const modules = await tableModules();
  let interfaceCount = 0;
  for (const [file, guards] of modules) {
    const interfaceGuards = guards.filter(
      guard => tagOf(guard) === 'guard:interfaceGuard',
    );
    for (const guard of interfaceGuards) {
      interfaceCount += 1;
      const own = collectNames([guard]);
      const missingKeys = [...own.keys].filter(key => !keys.has(key));
      const missingMethods = [...own.methods].filter(
        name => !methods.has(name),
      );
      const { interfaceName } = /** @type {any} */ (guard).payload;
      t.deepEqual(missingKeys, [], `${file} ${interfaceName}: keys`);
      t.deepEqual(missingMethods, [], `${file} ${interfaceName}: methods`);
    }
  }
  t.true(interfaceCount > 0);
});

test('the key and method sets are the ones before HR-SYN-7', t => {
  const { keys, methods } = harnessNames();
  t.is(keys.size, 258);
  t.is(methods.size, 141);
  t.deepEqual([...keys].sort(), before.keys);
  t.deepEqual([...methods].sort(), before.methods);
});
