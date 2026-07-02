// user-data-delete.staging.test.mjs — INC-3 / P4 (delete-my-data). A full staging SYSTEM test: an ISOLATED
// voice-agent server on an ephemeral port with mkdtemp stores (via test-harness.cjs — NEVER the live :8778),
// SEEDED at boot with two tenants' data across every per-user store (specialists, timers, feed, custom-tools,
// chats, purses, projects+home, byo, user-record) plus a scoped cap each so nodeFor() resolves them. Proves:
//   • POST /user/data/delete as tenant A wipes ALL of A's data AND revokes A's cap (it stops resolving);
//   • tenant B's data is entirely untouched (cross-tenant isolation, fail-closed);
//   • deleting as the ROOT cap is refused (user-0/dan is non-deletable here);
//   • the confirm gate blocks an un-confirmed call;
//   • deleting twice is safe (the second call cleanly 403s on the now-revoked cap; B stays intact).
//
//   node --test packages/chat/voice-agent/user-data-delete.staging.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { startIsolatedServer } from './test-harness.cjs';
import { ownerKeyForCap } from './agent-caps.mjs';
import { hashKey } from './purse-store.mjs';

const swiss = () => crypto.randomBytes(16).toString('hex');
const chatStoreName = cap => crypto.createHash('sha256').update(String(cap)).digest('hex').slice(0, 40) + '.json';
const feedFileName = ownerKey => `feed-${String(ownerKey).replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.json`;
const byoHash = cap => crypto.createHash('sha256').update(`byo:${String(cap)}`).digest('hex').slice(0, 32);
const forkOwner = cap => `u:${crypto.createHash('sha256').update(`fork-owner:${String(cap)}`).digest('hex').slice(0, 16)}`;
const wj = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const post = async (base, route, body) => { const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, json: j }; };

// two tenants + their (separate) user-store identity tokens
const capA = swiss(); const capB = swiss();
const ownerA = ownerKeyForCap(capA); const ownerB = ownerKeyForCap(capB);
const userCapA = swiss(); const userCapB = swiss();
const chatIdA = 'chatA-1'; const chatIdB = 'chatB-1';

let srv;
let dir;

test.before(async () => {
  // A dir tree I fully control + pre-seed, then point the server at it via the store env-seams (opts.env wins,
  // spread last in the harness). FIELD_TIMERS_STORE is set EXPLICITLY — its default is the LIVE schedule.json.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc3-'));
  const config = path.join(dir, 'config');
  const voice = path.join(dir, 'voice');
  const dash = path.join(dir, 'dash');
  const state = path.join(dir, 'state');
  const home = path.join(dir, 'home');
  const timersFile = path.join(state, 'schedule.json');
  const projectsFile = path.join(dir, 'projects.json');
  const forksFile = path.join(voice, 'forks.json');
  for (const d of [config, voice, dash, state, home]) fs.mkdirSync(d, { recursive: true });

  // scoped caps (both tenants) — so nodeFor(capA/capB) resolves after boot (registerScoped re-arms at boot)
  wj(path.join(config, 'scoped-caps.json'), { caps: [
    { swiss: capA, powers: ['web', 'specialists', 'customtools', 'timers', 'feed'], label: 'TenantA' },
    { swiss: capB, powers: ['web', 'specialists', 'customtools', 'timers', 'feed'], label: 'TenantB' },
  ] });
  // specialists — one per tenant + a legacy (owner-less = root) record that must SURVIVE
  wj(path.join(config, 'specialists.json'), { specialists: [
    { id: 'spec-a', owner: ownerA, name: 'A-spec', domain: 'a', powers: ['web'], instructions: '', swiss: swiss(), createdAt: new Date().toISOString(), spawnedFrom: null },
    { id: 'spec-b', owner: ownerB, name: 'B-spec', domain: 'b', powers: ['web'], instructions: '', swiss: swiss(), createdAt: new Date().toISOString(), spawnedFrom: null },
    { id: 'spec-legacy', name: 'Legacy', domain: 'old', powers: ['web'], instructions: '', swiss: swiss(), createdAt: new Date().toISOString(), spawnedFrom: null },
  ] });
  // custom tools — one admitted tool per tenant
  wj(path.join(config, 'custom-tools.json'), { tools: [
    { id: 'tool-a', owner: ownerA, name: 'toolA', description: 'a', args: {}, kind: 'instance', proposedBy: 'a', status: 'admitted', createdAt: '', code: 'return async () => 1;' },
    { id: 'tool-b', owner: ownerB, name: 'toolB', description: 'b', args: {}, kind: 'instance', proposedBy: 'b', status: 'admitted', createdAt: '', code: 'return async () => 1;' },
  ] });
  // durable timers — one per tenant
  wj(timersFile, { timers: [
    { id: 't-a', owner: ownerA, kind: 'once', label: 'A', action: { type: 'notify', message: 'a' }, status: 'active', dueAt: new Date(Date.now() + 9e8).toISOString(), created: new Date().toISOString() },
    { id: 't-b', owner: ownerB, kind: 'once', label: 'B', action: { type: 'notify', message: 'b' }, status: 'active', dueAt: new Date(Date.now() + 9e8).toISOString(), created: new Date().toISOString() },
  ] });
  // per-owner feed files
  wj(path.join(dash, feedFileName(ownerA)), { entries: [{ id: 'f-a', date: new Date().toISOString(), title: 'A feed', body: 'a', status: '' }] });
  wj(path.join(dash, feedFileName(ownerB)), { entries: [{ id: 'f-b', date: new Date().toISOString(), title: 'B feed', body: 'b', status: '' }] });
  // per-cap chats
  wj(path.join(voice, 'chats', chatStoreName(capA)), { chats: [{ id: chatIdA, title: 'A chat', messages: [] }], _seq: 1 });
  wj(path.join(voice, 'chats', chatStoreName(capB)), { chats: [{ id: chatIdB, title: 'B chat', messages: [] }], _seq: 1 });
  // purses (money) — keyed hashKey(`${cap}:${sid}`); sid = the seeded chat id
  wj(path.join(voice, 'purses.json'), {
    [hashKey(`${capA}:${chatIdA}`)]: { balance: 1000, granted: 1000 },
    [hashKey(`${capB}:${chatIdB}`)]: { balance: 2000, granted: 2000 },
  });
  // byo providers
  wj(path.join(config, 'byo-providers.json'), { users: {
    [byoHash(capA)]: { provider: 'openrouter', model: 'x', updatedAt: new Date().toISOString() },
    [byoHash(capB)]: { provider: 'openrouter', model: 'y', updatedAt: new Date().toISOString() },
  } });
  // user-store records (separate identity token per tenant)
  wj(path.join(config, 'users.json'), { users: {
    [crypto.createHash('sha256').update(`user:${userCapA}`).digest('hex')]: { root: 'canonical', prefs: { t: 'a' }, createdAt: '', lastSeen: '' },
    [crypto.createHash('sha256').update(`user:${userCapB}`).digest('hex')]: { root: 'canonical', prefs: { t: 'b' }, createdAt: '', lastSeen: '' },
  } });
  // projects (+ a home folder for A's project that must be removed)
  const pidA = 'p-aaa'; const pidB = 'p-bbb';
  wj(projectsFile, { projects: {
    [pidA]: { id: pidA, name: 'A proj', owner: ownerA, chatIds: [], scheduledAgents: [], homeSubkey: `project-${pidA}`, createdAt: new Date().toISOString() },
    [pidB]: { id: pidB, name: 'B proj', owner: ownerB, chatIds: [], scheduledAgents: [], homeSubkey: `project-${pidB}`, createdAt: new Date().toISOString() },
  }, updated: new Date().toISOString() });
  fs.mkdirSync(path.join(home, `project-${pidA}`), { recursive: true });
  fs.writeFileSync(path.join(home, `project-${pidA}`, 'secret.txt'), 'A private file');
  fs.mkdirSync(path.join(home, `project-${pidB}`), { recursive: true });
  fs.writeFileSync(path.join(home, `project-${pidB}`, 'keep.txt'), 'B private file');
  // forks — one per tenant (fork-owner keying differs from ownerKey)
  const stamp = new Date().toISOString();
  wj(forksFile, { forks: {
    'fork-a': { id: 'fork-a', name: 'A fork', baseId: null, owner: forkOwner(capA), source: 'x=>x', createdAt: stamp, updatedAt: stamp, history: [{ source: 'x=>x', at: stamp, note: 'created' }] },
    'fork-b': { id: 'fork-b', name: 'B fork', baseId: null, owner: forkOwner(capB), source: 'x=>x', createdAt: stamp, updatedAt: stamp, history: [{ source: 'x=>x', at: stamp, note: 'created' }] },
  }, shares: {} });

  srv = await startIsolatedServer({ env: {
    FIELD_CONFIG_DIR: config,
    VOICE_STATE_DIR: voice,
    DASH_STATE_DIR: dash,
    FIELD_STATE_DIR: state,
    FIELD_HOME_BASE: home,
    FIELD_TIMERS_STORE: timersFile,
    SCOPED_CAPS_FILE: path.join(config, 'scoped-caps.json'),
    PROJECTS_STORE: projectsFile,
    FORKS_STORE: forksFile,
  } });
  // helper paths for on-disk assertions
  srv._paths = { config, voice, dash, home, timersFile, projectsFile, forksFile };
});

test.after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

test('tenant A resolves + has its data BEFORE delete', async () => {
  const chats = await post(srv.base, '/chats/load', { cap: capA });
  assert.equal(chats.status, 200, 'A cap resolves for /chats/load');
  assert.equal(chats.json.data.chats[0].id, chatIdA, 'A sees its own chat');
  const feed = await post(srv.base, '/feed/load', { cap: capA });
  assert.ok(feed.json.items.some(i => i.id === 'f-a'), 'A sees its own feed entry');
});

test('deleting as ROOT is refused (user-0/dan is non-deletable)', async () => {
  const r = await post(srv.base, '/user/data/delete', { cap: srv.cap, confirm: 'DELETE' });
  assert.equal(r.status, 403, 'root delete is refused');
  assert.equal(r.json.ok, false);
  // root's data (the legacy specialist) is untouched — the store file still has it
  const specs = JSON.parse(fs.readFileSync(path.join(srv._paths.config, 'specialists.json'), 'utf8')).specialists;
  assert.ok(specs.some(s => s.id === 'spec-legacy'), "root's legacy specialist survives");
});

test('the confirm gate blocks an un-confirmed delete', async () => {
  const r = await post(srv.base, '/user/data/delete', { cap: capA, userCap: userCapA });
  assert.equal(r.status, 400, 'no confirm → 400');
  assert.equal(r.json.requiresConfirm, true);
  // nothing deleted — A still resolves
  const chats = await post(srv.base, '/chats/load', { cap: capA });
  assert.equal(chats.status, 200, 'A still resolves (nothing was deleted)');
});

test('DELETE wipes ALL of tenant A + revokes A cap; tenant B is fully intact', async () => {
  const r = await post(srv.base, '/user/data/delete', { cap: capA, userCap: userCapA, confirm: 'DELETE' });
  assert.equal(r.status, 200, 'delete succeeds');
  assert.equal(r.json.ok, true);
  const d = r.json.deleted;
  // summary reflects real deletions (no swissnum/owner-key echoed — counts only)
  assert.equal(d.specialists, 1, 'A specialist removed');
  assert.equal(d.timers, 1, 'A timer removed');
  assert.equal(d.customTools, 1, 'A tool removed');
  assert.equal(d.projects, 1, 'A project removed');
  assert.equal(d.forks, 1, 'A fork removed');
  assert.equal(d.capsRevoked, 1, 'A scoped cap revoked');
  assert.equal(d.userRecord, true, "A's user-store record removed");
  assert.equal(d.chats, true); assert.equal(d.feed, true); assert.equal(d.byo, true);
  assert.ok(!JSON.stringify(r.json).includes(capA), 'no presenting swissnum in the response (cap-hygiene)');

  // A's cap NO LONGER RESOLVES (revoked)
  const gone = await post(srv.base, '/chats/load', { cap: capA });
  assert.equal(gone.status, 403, 'A cap is revoked — /chats/load now 403s');

  // ── on-disk ground truth: A gone, B present, root legacy present ──
  const specs = JSON.parse(fs.readFileSync(path.join(srv._paths.config, 'specialists.json'), 'utf8')).specialists;
  assert.ok(!specs.some(s => s.id === 'spec-a'), 'A specialist gone from disk');
  assert.ok(specs.some(s => s.id === 'spec-b'), 'B specialist intact');
  assert.ok(specs.some(s => s.id === 'spec-legacy'), 'root legacy specialist intact');

  const timers = JSON.parse(fs.readFileSync(srv._paths.timersFile, 'utf8')).timers;
  assert.ok(!timers.some(t => t.id === 't-a'), 'A timer gone');
  assert.ok(timers.some(t => t.id === 't-b'), 'B timer intact');

  const tools = JSON.parse(fs.readFileSync(path.join(srv._paths.config, 'custom-tools.json'), 'utf8')).tools;
  assert.ok(!tools.some(t => t.id === 'tool-a'), 'A tool gone');
  assert.ok(tools.some(t => t.id === 'tool-b'), 'B tool intact');

  assert.ok(!fs.existsSync(path.join(srv._paths.dash, feedFileName(ownerA))), 'A feed file gone');
  assert.ok(fs.existsSync(path.join(srv._paths.dash, feedFileName(ownerB))), 'B feed file intact');

  assert.ok(!fs.existsSync(path.join(srv._paths.voice, 'chats', chatStoreName(capA))), 'A chats file gone');
  assert.ok(fs.existsSync(path.join(srv._paths.voice, 'chats', chatStoreName(capB))), 'B chats file intact');

  const purses = JSON.parse(fs.readFileSync(path.join(srv._paths.voice, 'purses.json'), 'utf8'));
  assert.ok(!(hashKey(`${capA}:${chatIdA}`) in purses), 'A purse gone');
  assert.ok(hashKey(`${capB}:${chatIdB}`) in purses, 'B purse intact');

  const users = JSON.parse(fs.readFileSync(path.join(srv._paths.config, 'users.json'), 'utf8')).users;
  assert.ok(!(crypto.createHash('sha256').update(`user:${userCapA}`).digest('hex') in users), 'A user-record gone');
  assert.ok(crypto.createHash('sha256').update(`user:${userCapB}`).digest('hex') in users, 'B user-record intact');

  const byo = JSON.parse(fs.readFileSync(path.join(srv._paths.config, 'byo-providers.json'), 'utf8')).users;
  assert.ok(!(byoHash(capA) in byo), 'A byo gone');
  assert.ok(byoHash(capB) in byo, 'B byo intact');

  const projs = JSON.parse(fs.readFileSync(srv._paths.projectsFile, 'utf8')).projects;
  assert.ok(!Object.values(projs).some(p => p.owner === ownerA), 'A project gone');
  assert.ok(Object.values(projs).some(p => p.owner === ownerB), 'B project intact');
  assert.ok(!fs.existsSync(path.join(srv._paths.home, 'project-p-aaa')), "A's home folder gone");
  assert.ok(fs.existsSync(path.join(srv._paths.home, 'project-p-bbb', 'keep.txt')), "B's home folder intact");

  const forks = JSON.parse(fs.readFileSync(srv._paths.forksFile, 'utf8')).forks;
  assert.ok(!('fork-a' in forks), 'A fork gone');
  assert.ok('fork-b' in forks, 'B fork intact');

  // tenant B still fully works over HTTP
  const bChats = await post(srv.base, '/chats/load', { cap: capB });
  assert.equal(bChats.status, 200, 'B cap still resolves');
  assert.equal(bChats.json.data.chats[0].id, chatIdB, 'B sees its chat');
  const bFeed = await post(srv.base, '/feed/load', { cap: capB });
  assert.ok(bFeed.json.items.some(i => i.id === 'f-b'), 'B still sees its feed');
});

test('deleting twice is safe (second call cleanly 403s; B stays intact)', async () => {
  const again = await post(srv.base, '/user/data/delete', { cap: capA, userCap: userCapA, confirm: 'DELETE' });
  assert.equal(again.status, 403, 'the revoked cap safely 403s (no crash, no over-delete)');
  // B untouched by the double-delete
  const bChats = await post(srv.base, '/chats/load', { cap: capB });
  assert.equal(bChats.status, 200, 'B still resolves after A double-delete');
});
