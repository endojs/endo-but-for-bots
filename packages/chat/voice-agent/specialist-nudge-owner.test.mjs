// specialist-nudge-owner.test.mjs — INC-2 caveat: a standing nudge fires its specialist in the RIGHT owner
// namespace. A nudge runs SERVER-SIDE (no cap in hand); it now carries the specialist's `owner` (tagged at
// scheduleSpecialist) and resolves scoped to it. Before, runSpecialistNudge used a cross-owner (`anyOwner`)
// lookup, so a same-slug specialist under a DIFFERENT owner could be woken.
//
// Offline + safe: specialists run on the `default` model, so pointing AGENT_LLM at a dead loopback port makes a
// resolved run fail FAST at the network with NO external provider call (the anthropic:/openrouter: paths are
// never taken). We assert the RESOLUTION outcome, not the model output.
//
//   node --test packages/chat/voice-agent/specialist-nudge-owner.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-nudge-'));
process.env.FIELD_HOME_BASE = path.join(TMP, 'home');
process.env.FIELD_CONFIG_DIR = path.join(TMP, 'config');
process.env.OBJECTS_FILE = path.join(TMP, 'objects.json');
process.env.SCOPED_CAPS_FILE = path.join(TMP, 'scoped.json');
// keep any resolved run OFFLINE: dead LLM + no operator keys / ~/.env, so nothing ever leaves the box.
process.env.AGENT_LLM = 'http://127.0.0.1:9/v1/chat/completions';
process.env.HOST_ENV_FILE = path.join(TMP, 'no.env');
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

const { makeFieldAgent, ownerKeyForCap } = await import('./agent-caps.mjs');

const SPEC_FILE = path.join(TMP, 'spec.json');
const mk = () => makeFieldAgent({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-nudge-out-')), baseUrl: 'http://test.invalid', autoConfirmFile: path.join(TMP, `ac-${Math.random().toString(16).slice(2)}.json`), specialistsFile: SPEC_FILE });

test('a nudge resolves within its tagged owner; a same-slug specialist under a different owner is NOT woken', async () => {
  fs.writeFileSync(SPEC_FILE, JSON.stringify({ specialists: [] }));
  const fa = mk();
  const a = fa.mintScopedCap({ powers: ['specialists', 'web'], label: 'TenantA' });
  const b = fa.mintScopedCap({ powers: ['specialists', 'web'], label: 'TenantB' });
  const ownerA = ownerKeyForCap(a.swiss);
  const ownerB = ownerKeyForCap(b.swiss);
  const tb = swiss => fa.nodeFor(swiss).toolbox({ chatId: 'c' }).toolbox;

  // Tenant A spawns "ZephyrGuard"; tenant B has NO such specialist.
  const spawned = await tb(a.swiss).spawnSpecialist.run({ name: 'ZephyrGuard', domain: 'a-domain', powers: ['web'], instructions: 'A guard' });
  assert.ok(spawned.ok && spawned.id, 'A spawned its specialist');
  const specId = spawned.id;

  // NEGATIVE — a nudge tagged owner=B must NOT resolve A's same-slug specialist (the bug: anyOwner found it).
  const foreign = await fa.runSpecialistNudge({ specialistId: specId, specialistName: 'ZephyrGuard', owner: ownerB, request: 'scan', schedule: { kind: 'once', afterMs: 0 } });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'specialist no longer exists', "owner B's namespace has no ZephyrGuard → refused (not cross-owner resolved)");

  // POSITIVE — a nudge tagged owner=A resolves A's specialist (gets PAST resolution; the run then only fails on
  // the dead LLM, which is NOT the resolution error).
  const own = await fa.runSpecialistNudge({ specialistId: specId, specialistName: 'ZephyrGuard', owner: ownerA, request: 'scan', schedule: { kind: 'once', afterMs: 0 } });
  assert.notEqual(own.error, 'specialist no longer exists', 'owner A resolves + fires its own specialist');

  // BACK-COMPAT — a legacy nudge with NO owner tag still resolves cross-owner (old behavior preserved).
  const legacy = await fa.runSpecialistNudge({ specialistId: specId, specialistName: 'ZephyrGuard', request: 'scan', schedule: { kind: 'once', afterMs: 0 } });
  assert.notEqual(legacy.error, 'specialist no longer exists', 'a legacy owner-less nudge still finds the specialist');
});

test('a nudge tagged with a tenant owner fires that tenant specialist, resolving only within its namespace', async () => {
  fs.writeFileSync(SPEC_FILE, JSON.stringify({ specialists: [] }));
  const fa = mk();
  const a = fa.mintScopedCap({ powers: ['specialists', 'web'], label: 'TenantA2' });
  const ownerA = ownerKeyForCap(a.swiss);
  const tb = swiss => fa.nodeFor(swiss).toolbox({ chatId: 'c2' }).toolbox;
  const spawned = await tb(a.swiss).spawnSpecialist.run({ name: 'Watcher', domain: 'a', powers: ['web'], instructions: 'A' });

  // The nudge carries the specialist's owner (as scheduleSpecialist tags it). Resolution stays inside ownerA.
  const rec = fa.specialistNudges.add({ specialistId: spawned.id, specialistName: 'Watcher', owner: ownerA, chatId: 'c2', request: 'go', schedule: { kind: 'once', afterMs: 0 } });
  assert.equal(rec.owner, ownerA, 'the nudge records the tenant owner, not root');
  const fired = await fa.runSpecialistNudge(rec);
  assert.notEqual(fired.error, 'specialist no longer exists', 'the tenant nudge resolves + fires its own specialist');

  // and root's namespace can't be used to reach it
  const asRoot = await fa.runSpecialistNudge({ ...rec, owner: 'root' });
  assert.equal(asRoot.error, 'specialist no longer exists', "the tenant's specialist is invisible from the root namespace");
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
