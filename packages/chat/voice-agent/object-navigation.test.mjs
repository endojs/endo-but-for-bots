// object-navigation.test.mjs — runs eval obstacle 09 (navigating a new Endo object) in the regular node:test
// suite, so the guard that "our initial prompts give agents enough context to comfortably navigate new
// objects" runs on every `node --test`, not only under the eval harness. Deterministic (no live model/network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@endo/init';
import { grade } from './eval/obstacles/09-object-navigation/grade.mjs';

test('eval obstacle 09: the agent context teaches navigating a new, self-documenting Endo object', async () => {
  const r = await grade();
  const failed = r.checks.filter(c => !c.pass);
  assert.equal(r.passed, true, `failing checks: ${JSON.stringify(failed, null, 1)}`);
});
