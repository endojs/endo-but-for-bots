// roles.test.mjs — the agent-role catalog's load-bearing invariants
// ("Agent Roles and Composition Topologies…"): roles are configs; least-privilege
// rings; and the multi-agent-for-coding SYNTHESIS — parallelize read/analysis, keep
// WRITES single-threaded (every write-capable role routes to the one executor).
//
//   node --test packages/chat/voice-agent/roles.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ROLE_CATALOG, getRole, roleList, localModelFor } from './agent-roles.mjs';
import { makeFieldAgent } from './agent-caps.mjs';

const TIERS = new Set(['strong', 'mid', 'cheap']);
const VIAS = new Set(['subagent', 'dev']);

test('catalog shape: every role is a complete config tuple', () => {
  for (const r of roleList()) {
    assert.ok(r.role && r.label && r.blurb, `${r.role}: name/label/blurb`);
    assert.ok(TIERS.has(r.tier), `${r.role}: tier "${r.tier}" must be strong|mid|cheap`);
    assert.ok(VIAS.has(r.via), `${r.role}: via "${r.via}" must be subagent|dev`);
    assert.equal(typeof r.writes, 'boolean', `${r.role}: writes is boolean`);
    assert.ok(Array.isArray(r.powers), `${r.role}: powers is an array`);
    const spec = ROLE_CATALOG[r.role];
    assert.ok(spec.prompt && spec.output, `${r.role}: has a system prompt + an I/O contract`);
  }
});

test('THE WRITE RULE: every write-capable role is single-threaded (via the executor); every fan-out role is read-only', () => {
  for (const r of roleList()) {
    if (r.writes) assert.equal(r.via, 'dev', `write-capable role "${r.role}" MUST route to the single-threaded executor (via:'dev'), not run as a parallel writer`);
    if (r.via === 'subagent') assert.equal(r.writes, false, `fan-out role "${r.role}" (via:'subagent') must be read-only (writes:false)`);
  }
});

test('getRole resolves canonical names, aliases, and is case-insensitive; unknown → null', () => {
  assert.equal(getRole('planner').role, 'planner');
  assert.equal(getRole('Planner').role, 'planner');
  assert.equal(getRole('judge').role, 'critic', 'alias judge→critic');
  assert.equal(getRole('SAST').role, 'securityAudit', 'alias SAST→securityAudit (case-insensitive)');
  assert.equal(getRole('red-team').role, 'adversary');
  assert.equal(getRole('coder').role, 'executor');
  assert.equal(getRole('nope'), null);
  assert.equal(getRole(''), null);
});

test('localModelFor: tier → local model id, defaults to gemma, env-overridable per tier', () => {
  delete process.env.FIELD_AGENT_LOCAL_MID;
  assert.equal(localModelFor('cheap'), 'default');
  assert.equal(localModelFor('mid'), 'default');
  assert.equal(localModelFor('strong'), 'default'); // strong-tier FALLBACK when no API key
  assert.equal(localModelFor('nonsense'), 'default');
  process.env.FIELD_AGENT_LOCAL_MID = 'qwen-big';
  try { assert.equal(localModelFor('mid'), 'qwen-big', 'mid tier honors its env override'); assert.equal(localModelFor('cheap'), 'default', 'cheap unaffected'); }
  finally { delete process.env.FIELD_AGENT_LOCAL_MID; }
});

const mkRoot = () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-roles-'));
  return makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'auto-confirm.json'), specialistsFile: path.join(outDir, 'specialists.json') });
};

test('root holds the `roles` power; employ + listRoles are in its toolbox', () => {
  const fa = mkRoot();
  assert.ok(fa.rootNode.powers.has('roles'));
  const { toolbox } = fa.rootNode.toolbox();
  assert.equal(typeof toolbox.employ.run, 'function');
  assert.equal(typeof toolbox.employ.abort, 'function', 'employ is barge-in-cancellable');
  assert.equal(typeof toolbox.listRoles.run, 'function');
});

test('employ guards return BEFORE running any model (deterministic, offline)', async () => {
  const fa = mkRoot();
  const { toolbox } = fa.rootNode.toolbox();
  const unknown = await toolbox.employ.run({ role: 'wizard', task: 'do a thing' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown role/);
  const empty = await toolbox.employ.run({ role: 'planner', task: '   ' });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /task is required/);
});

test('listRoles exposes the menu and frames the agent as the orchestrator', async () => {
  const fa = mkRoot();
  const { toolbox } = fa.rootNode.toolbox();
  const r = await toolbox.listRoles.run();
  assert.equal(r.ok, true);
  assert.match(r.note, /ORCHESTRATOR/);
  assert.ok(r.roles.length >= 12, 'the doc enumerates ~16 archetypes; we expose at least a dozen');
  assert.ok(r.roles.find(x => x.role === 'planner') && r.roles.find(x => x.role === 'executor'));
});
