// @ts-check
/**
 * The integration runner's file selection (scripts/test-integration.mjs):
 * the default files of `test:integration` and `test:browser` (HR-SYN-38),
 * and the regression lists of designs/process.md 3.1.
 */
import test from '@endo/ses-ava/test.js';

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  defaultFiles,
  heldOf,
  listFiles,
  parseArgs,
  regressionLists,
} from '../scripts/test-integration.mjs';
import { harnessRoot } from './_helpers.js';

/**
 * @param {string} dir
 * @param {string} suffix
 */
const filesIn = async (dir, suffix) => {
  const names = await readdir(path.join(harnessRoot, dir));
  return names
    .filter(name => name.endsWith(suffix))
    .sort()
    .map(name => `${dir}/${name}`);
};

test('test:integration with no files runs every integration and template file', async t => {
  const expected = [
    ...(await filesIn('test/integration', '.test.js')),
    ...(await filesIn('test/template', '.test.js')),
  ];
  t.true(expected.length > 40);
  t.deepEqual(await defaultFiles(), expected);
});

test('test:browser with no files runs the browser files', async t => {
  const browser = await filesIn('test/browser', '.test.mjs');
  t.true(browser.length >= 5);
  t.deepEqual(await defaultFiles(['test/browser']), browser);
  t.deepEqual(parseArgs(['--dir', 'test/browser']).dirs, ['test/browser']);
  t.deepEqual(parseArgs(['--dir', 'test/browser', 'x.test.mjs']), {
    dirs: ['test/browser'],
    files: ['x.test.mjs'],
  });
  t.throws(() => parseArgs(['--dir']), { message: /--dir takes a directory/ });
});

test('every integration, template and browser file is in exactly one regression list', async t => {
  const all = [
    ...(await filesIn('test/integration', '.test.js')),
    ...(await filesIn('test/template', '.test.js')),
    ...(await filesIn('test/browser', '.test.mjs')),
  ].sort();
  const listed = Object.values(regressionLists).flat();
  t.deepEqual([...listed].sort(), all);
  t.is(new Set(listed).size, listed.length);
  t.true(regressionLists.core.includes('test/template/template.test.js'));
  for (const file of regressionLists.core)
    t.notRegex(file, /test\/browser\//, file);
});

test('the milestones list is M3, M4 and M5 together', t => {
  t.deepEqual(listFiles('milestones'), [
    ...regressionLists.M3,
    ...regressionLists.M4,
    ...regressionLists.M5,
  ]);
  t.deepEqual(listFiles('core'), regressionLists.core);
  t.throws(() => listFiles('M9'), { message: /unknown list M9/ });
  // The lists reserved by WX.1 for the next group of lanes (by concept).
  t.deepEqual(Object.keys(regressionLists), [
    'core',
    'M3',
    'M4',
    'M5',
    'environments',
    'context',
    'mail',
    'voice',
  ]);
  t.deepEqual(parseArgs(['--list', 'core']).list, 'core');
});

test('held time comes from the run log line of this file and lane', t => {
  const rows = [
    // Another lane, the same label.
    {
      at: '2026-01-01T00:00:01.000Z',
      lane: 'other',
      agent: 'S2',
      label: 'integration a.test.js',
      heldMs: 1,
      waitedMs: 0,
    },
    // Before this run started.
    {
      at: '2025-12-31T23:59:00.000Z',
      lane: 'mine',
      agent: 'S2',
      label: 'integration a.test.js',
      heldMs: 2,
      waitedMs: 0,
    },
    {
      at: '2026-01-01T00:00:00.500Z',
      lane: 'mine',
      agent: 'S2',
      label: 'integration a.test.js',
      heldMs: 3000,
      waitedMs: 40,
    },
  ];
  const since = Date.parse('2026-01-01T00:00:00.000Z');
  t.deepEqual(
    heldOf(rows, { label: 'integration a.test.js', lane: 'mine', since }),
    { heldMs: 3000, waitedMs: 40 },
  );
  t.is(
    heldOf(rows, { label: 'integration b.test.js', lane: 'mine', since }),
    undefined,
  );
});
