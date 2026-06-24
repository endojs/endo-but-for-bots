// magic-wand.test.mjs — the POLICY-GATED magic wand for specialists (vault [[magic wand]] + Phase 5 of the
// ocap-designate-by-reference plan). Auto-minting a named-but-missing specialist now requires a HELD wand
// policy (caller.wandBinding) that ENUMERATES allowed specializations; the minted authority is the matched
// entry's power ceiling ∩ the caller (never the LLM); an unlisted name or an unheld policy → graceful miss.
// Tested with an injected policy (+ optional injected filler) so it's fully deterministic — no model in the loop.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { makeFieldAgent } from './agent-caps.mjs';

const mk = ({ wandPolicy, fillSpecialist } = {}) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-wand-'));
  return makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'auto.json'), specialistsFile: path.join(outDir, 'specialists.json'), wandPolicy, fillSpecialist });
};
const spawn = (fa, name, powers) => fa.rootNode.toolbox({ chatId: 't' }).toolbox.spawnSpecialist.run({ name, domain: 'x', powers });

test('policy-gated wand: a name MATCHING the policy is materialized, ⊆ entry ceiling ∩ caller', async () => {
  // entry ceiling is generous (incl. home + non-delegable subagent); the caller holds only notes+web
  const fa = mk({ wandPolicy: [{ match: '*researcher*', powers: ['notes', 'web', 'home', 'subagent'], domain: 'research', instructions: 'research' }] });
  const child = await spawn(fa, 'Limited Caller', ['notes', 'web']);
  const caller = fa.specialistFor(child.id).node;
  const made = await fa.fillMissingSpecialist({ name: 'copenhagen-researcher', request: 'find spots', caller });
  assert.ok(made && made.ok, 'matched the policy → materialized');
  const g = new Set(made.granted);
  assert.ok(g.has('notes') && g.has('web'), 'gets the entry powers the caller also holds');
  assert.ok(!g.has('home'), 'entry allowed home but the CALLER lacks it → dropped (⊆ caller)');
  assert.ok(!g.has('subagent'), 'non-delegable dropped even when the entry lists it');
  assert.equal(made.viaPolicy, '*researcher*', 'records which policy entry authorized it');
});

test('policy-gated wand: the entry CEILING bounds even an all-powerful (root) caller', async () => {
  const fa = mk({ wandPolicy: [{ match: '*planner*', powers: ['notes'], domain: 'plan', instructions: 'plan' }] });
  const made = await fa.fillMissingSpecialist({ name: 'trip-planner', request: 'plan', caller: fa.rootNode });
  assert.ok(made && made.ok);
  assert.deepEqual(made.granted, ['notes'], 'only the entry-ceiling power, not all of root\'s authority');
});

test('policy-gated wand: a name matching NO entry → graceful miss (nothing minted)', async () => {
  const fa = mk({ wandPolicy: [{ match: '*researcher*', powers: ['notes'] }] });
  assert.equal(await fa.fillMissingSpecialist({ name: 'exfiltrator', request: 'x', caller: fa.rootNode }), null);
});

test('policy-gated wand: a caller that does NOT hold a wand policy cannot mint', async () => {
  const fa = mk({ wandPolicy: [{ match: '*researcher*', powers: ['notes'] }] });
  // a caller object with powers but NO wandBinding (stands in for a node not granted the wand)
  assert.equal(await fa.fillMissingSpecialist({ name: 'x-researcher', request: 'x', caller: { powers: new Set(['notes', 'web']) } }), null);
});

test('policy-gated wand: the LLM filler only flavours domain/instructions — never authority', async () => {
  let shown = null;
  const fa = mk({
    wandPolicy: [{ match: '*helper*', powers: ['notes'] }], // entry has NO domain/instructions → filler fills those
    fillSpecialist: async ({ availablePowers }) => { shown = availablePowers; return { domain: 'flavoured', powers: ['home', 'subagent'], instructions: 'flavoured persona' }; },
  });
  const made = await fa.fillMissingSpecialist({ name: 'doc-helper', request: 'x', caller: fa.rootNode });
  assert.ok(made && made.ok);
  assert.deepEqual(made.granted, ['notes'], 'powers come from the POLICY entry, NOT the filler\'s greedy request');
  assert.deepEqual([...shown].sort(), ['notes'], 'the filler only ever sees the already-granted powers');
});
