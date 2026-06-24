// spawn-confinement.test.mjs — the ocap invariant for sub-agent spawning (dan's "trees within bounds" rule).
// A specialist is spawned WITHOUT a confirmation proposal (it's structurally within bounds), is confined to a
// SUBSET of its spawner's powers, the non-delegable powers (subagent/app/selfImprove — the ones that escape the
// cap graph to the host/root) are never passed down even when requested + held, and a specialist granted
// `specialists` can itself spawn → trees nest, each level ⊆ its parent. (NB: enforcement is name-set membership
// today — the by-reference migration is tracked in ~/TODO/ocap-designate-by-reference.md.)
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { makeFieldAgent } from './agent-caps.mjs';

const mkRoot = () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-spawn-'));
  return makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'auto-confirm.json'), specialistsFile: path.join(outDir, 'specialists.json') });
};

test('spawnSpecialist spawns DIRECTLY (no confirmation proposal) when within bounds', async () => {
  const fa = mkRoot();
  const { toolbox } = fa.rootNode.toolbox({ chatId: 't' });
  const r = await toolbox.spawnSpecialist.run({ name: 'Notes Helper', domain: 'notes', powers: ['notes', 'web'] });
  assert.equal(r.ok, true);
  assert.ok(r.id, 'returns a spawned id');
  // the OLD path returned a confirmation proposal ({ proposalId / pending / needsConfirm }); the direct spawn
  // returns the spec itself — proving creating a sub-agent within bounds is no longer gated.
  assert.ok(!r.proposalId && !r.pending && !r.needsConfirm, 'spawned immediately — no confirmation proposal');
  assert.deepEqual([...r.powers].sort(), ['notes', 'web'], 'confined to exactly the requested in-bounds subset');
  // cap hygiene: the spawn result must not leak the specialist's swissnum / invite url to the agent
  assert.ok(!r.url && !r.swiss && !JSON.stringify(r).includes('#cap='), 'spawn result carries no cap/swissnum');
});

test('a specialist is a SUBSET of its spawner — non-delegable + un-held powers are dropped (no escalation)', async () => {
  const fa = mkRoot(); // root holds ALL powers, including the non-delegable subagent/app/selfImprove
  const { toolbox } = fa.rootNode.toolbox({ chatId: 't' });
  const r = await toolbox.spawnSpecialist.run({ name: 'Greedy', domain: 'x', powers: ['notes', 'subagent', 'app', 'selfImprove', 'specialists', 'roles', 'delegate', 'not-a-power'] });
  assert.equal(r.ok, true);
  const got = new Set(r.powers);
  assert.ok(got.has('notes') && got.has('specialists') && got.has('roles') && got.has('delegate'), 'delegable (in-graph) powers pass down');
  assert.ok(!got.has('subagent') && !got.has('app') && !got.has('selfImprove'), 'host/root powers are NON-delegable — never passed down even though root holds them');
  assert.ok(!got.has('not-a-power'), 'a non-existent power is dropped');
});

test('trees nest: a specialist granted `specialists` spawns its OWN sub-specialist, ⊆ its bounds', async () => {
  const fa = mkRoot();
  const root = fa.rootNode.toolbox({ chatId: 't' }).toolbox;
  // child gets a strict subset INCLUDING the spawn power
  const child = await root.spawnSpecialist.run({ name: 'Parent Agent', domain: 'p', powers: ['notes', 'web', 'specialists'] });
  assert.equal(child.ok, true);
  const childRec = fa.specialistFor(child.id);
  assert.ok(childRec && childRec.node, 'the spawned child node is reachable');
  assert.ok(childRec.node.powers.has('specialists'), 'child holds the spawn power → it can build its own sub-agents');
  // the child spawns a grandchild, REQUESTING more than it holds → grandchild attenuated to the child's bounds
  const grand = await childRec.node.toolbox({ chatId: 't' }).toolbox.spawnSpecialist.run({ name: 'Grandchild', domain: 'g', powers: ['notes', 'web', 'home', 'specialists'] });
  assert.equal(grand.ok, true);
  const got = new Set(grand.powers);
  assert.ok(got.has('notes') && got.has('web') && got.has('specialists'), 'grandchild keeps the child-held subset');
  assert.ok(!got.has('home'), 'grandchild CANNOT gain `home` — the child never held it (no escalation up the tree)');
  // transitive invariant: grandchild ⊆ child (so ⊆ root)
  const grandRec = fa.specialistFor(grand.id);
  for (const p of grandRec.node.powers) assert.ok(childRec.node.powers.has(p), `grandchild power "${p}" is within the child's bounds`);
});
