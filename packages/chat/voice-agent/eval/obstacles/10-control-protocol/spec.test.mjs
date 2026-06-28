// spec.test.mjs — the CodeMode control-protocol spec, runnable as a test suite:
//   node --test eval/obstacles/10-control-protocol/spec.test.mjs
// Turns each graded check into a node:test assertion (one per spec point) so a regression names the exact
// property that broke. The grade.mjs is the single source of truth; this just makes it `node --test`-shaped and
// prints the measured function-vs-marker difference.
import '@endo/init'; // SES lockdown FIRST — grade.mjs drives the real (hardened) CodeMode loop
import test from 'node:test';
import assert from 'node:assert/strict';
import { grade } from './grade.mjs';

test('CodeMode control protocol: control signals are scope functions, not text markers', async t => {
  const r = await grade();
  for (const c of r.checks) {
    // eslint-disable-next-line no-await-in-loop
    await t.test(c.name, () => assert.ok(c.pass, c.detail || c.name));
  }
  // surface the measured difference in the run output
  console.log('\nfunction vs marker —', JSON.stringify(r.difference, null, 2));
  assert.ok(r.passed, 'every control-protocol check passes');
});
