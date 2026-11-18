// @ts-check
// The duplicate ceiling (scripts/check-duplicates.mjs; designs/process.md
// section 6): passes at today's share, fails above a ceiling it exceeds.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

const script = fileURLToPath(
  new URL('../../scripts/check-duplicates.mjs', import.meta.url),
);

/** @param {string[]} args */
const run = args =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('the source is under the duplicate ceiling', t => {
  const { status, stdout, stderr } = run([]);
  t.is(status, 0, stderr);
  t.regex(stdout, /^duplicates: \d+ of \d+ normalised lines \([\d.]+ %\)/);
});

test('a share above the ceiling fails', t => {
  const { status, stderr } = run(['--ceiling', '0']);
  t.is(status, 1);
  t.regex(stderr, /over the ceiling/);
});
