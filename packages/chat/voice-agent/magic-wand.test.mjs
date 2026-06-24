// magic-wand.test.mjs — the magic wand for specialists (vault [[magic wand]] + designs/self-healing-errors.md):
// when an agent names a specialist that doesn't exist, MATERIALIZE it instead of erroring — confined to a
// SUBSET of the caller (the cap-graph bound, so it can never escalate). Tested with an INJECTED filler (no
// model in the loop): fillMissingSpecialist only infers + spawns, so the confinement is fully deterministic.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { makeFieldAgent } from './agent-caps.mjs';

const mk = fillSpecialist => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-wand-'));
  return makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'auto.json'), specialistsFile: path.join(outDir, 'specialists.json'), fillSpecialist });
};
const spawn = (fa, name, powers) => fa.rootNode.toolbox({ chatId: 't' }).toolbox.spawnSpecialist.run({ name, domain: 'x', powers });

test('magic wand: a missing specialist is MATERIALIZED, confined ⊆ the caller (a greedy filler is clamped)', async () => {
  // the filler greedily requests powers the caller does NOT hold + a non-delegable one
  const fa = mk(async () => ({ domain: 'research', powers: ['notes', 'web', 'home', 'subagent'], instructions: 'be helpful' }));
  const child = await spawn(fa, 'Limited Caller', ['notes', 'web']); // caller holds only notes+web
  const caller = fa.specialistFor(child.id).node;
  const made = await fa.fillMissingSpecialist({ name: 'Doc Finder', request: 'find the spec', caller });
  assert.ok(made && made.ok, 'the wand materialized the specialist');
  const g = new Set(made.granted);
  assert.ok(g.has('notes') && g.has('web'), 'keeps the powers the caller holds');
  assert.ok(!g.has('home'), 'drops a power the caller does NOT hold — no escalation');
  assert.ok(!g.has('subagent'), 'drops a non-delegable power even when requested');
  const created = fa.specialistFor(made.id);
  assert.ok(created, 'the new specialist is registered + reachable by name');
  for (const p of created.node.powers) assert.ok(caller.powers.has(p), `power "${p}" is within the caller's bounds`);
});

test('magic wand: no filler wired → a missing specialist stays a graceful miss (today\'s behavior)', async () => {
  const fa = mk(undefined);
  assert.equal(await fa.fillMissingSpecialist({ name: 'X', caller: fa.rootNode }), null);
});

test('magic wand: the filler declines (null) → nothing is created', async () => {
  const fa = mk(async () => null);
  assert.equal(await fa.fillMissingSpecialist({ name: 'X', caller: fa.rootNode }), null);
});

test('magic wand: a caller with no delegable powers yields an empty-but-valid specialist (still ⊆ caller)', async () => {
  const fa = mk(async () => ({ domain: 'x', powers: ['notes', 'web'], instructions: 'hi' }));
  const child = await spawn(fa, 'Powerless', []); // caller holds nothing to grant
  const caller = fa.specialistFor(child.id).node;
  const made = await fa.fillMissingSpecialist({ name: 'Empty Helper', request: 'x', caller });
  assert.ok(made && made.ok);
  assert.deepEqual(made.granted, [], 'cannot grant powers the caller does not hold');
});
