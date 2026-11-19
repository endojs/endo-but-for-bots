// @ts-check
/**
 * The recorded perf pass of designs/process.md 3.2 (`corepack yarn
 * perf:pass <milestone>`, perf/_pass.mjs): every perf check belongs to
 * exactly one milestone list, and a milestone's pass is its own files plus
 * the cross-check.
 */
import test from '@endo/ses-ava/test.js';

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  CROSS_CHECK,
  passCommand,
  passFiles,
  perfLists,
} from '../perf/_pass.mjs';
import { harnessRoot } from './_helpers.js';

test('every perf check is in exactly one milestone list', async t => {
  const names = (await readdir(path.join(harnessRoot, 'perf')))
    .filter(name => name.endsWith('.perf.mjs'))
    .map(name => name.slice(0, -'.perf.mjs'.length))
    .sort();
  const listed = Object.values(perfLists).flat();
  t.deepEqual([...listed].sort(), names);
  t.is(new Set(listed).size, listed.length);
});

test('a milestone pass is its files and the cross-check; all is every file', t => {
  t.deepEqual(CROSS_CHECK, ['session', 'turn', 'exec']);
  t.deepEqual(passFiles('M4'), [...perfLists.M4, ...CROSS_CHECK]);
  t.deepEqual(passFiles('M3'), [...perfLists.M3, ...CROSS_CHECK]);
  // M0-M2 holds the cross-check files already.
  t.deepEqual(passFiles('M2'), perfLists.M2);
  t.deepEqual(passFiles('all'), Object.values(perfLists).flat());
  t.throws(() => passFiles('M9'), { message: /unknown milestone M9/ });
  // The lists reserved by WX.1 for the next group of lanes (by concept).
  t.deepEqual(Object.keys(perfLists), [
    'M2',
    'M3',
    'M4',
    'M5',
    'environments',
    'context',
    'mail',
    'voice',
  ]);
});

test('each check runs exclusive in its own boxed wrapper, ui with the browser', t => {
  t.deepEqual(passCommand('turn'), {
    args: [
      'scripts/run-lock.mjs',
      '--exclusive',
      '--label',
      'perf-turn',
      '--',
      process.execPath,
      'perf/turn.perf.mjs',
    ],
    env: {},
  });
  t.deepEqual(passCommand('ui').env, { THIX_HARNESS_BROWSER: '1' });
});
