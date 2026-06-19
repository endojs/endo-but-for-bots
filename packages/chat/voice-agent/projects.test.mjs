// projects.test.mjs — the Project data-model foundation. node --test projects.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// isolate the store
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-test-'));
process.env.PROJECTS_STORE = path.join(tmp, 'projects.json');
const P = await import('./projects.mjs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('create + list + shared home subkey', () => {
  const p = P.createProject('Self-Improvement');
  assert.equal(p.name, 'Self-Improvement');
  assert.equal(p.homeSubkey, `project-${p.id}`);             // one shared home folder for the project
  assert.equal(P.projectHomeSubkey(p.id), p.homeSubkey);
  assert.ok(P.listProjects().some(x => x.id === p.id));
});

test('chats attach/detach and a chat resolves back to its project (shared home)', () => {
  const p = P.createProject('Garden');
  P.attachChat(p.id, 'chat-A');
  P.attachChat(p.id, 'chat-A');                              // idempotent
  P.attachChat(p.id, 'chat-B');
  assert.deepEqual(P.getProject(p.id).chatIds, ['chat-A', 'chat-B']);
  assert.equal(P.projectForChat('chat-A').id, p.id);        // server uses this to bind the shared home
  P.detachChat(p.id, 'chat-A');
  assert.deepEqual(P.getProject(p.id).chatIds, ['chat-B']);
});

test('scheduled agents: add/list/update/remove with a tool ring + cadence', () => {
  const p = P.createProject('SI');
  const a = P.addScheduledAgent(p.id, {
    name: 'garden-scan', prompt: 'Review unconnected notes & tools; propose cap-wirings.',
    tools: ['notes-ro', 'propose'], schedule: { kind: 'weekly', day: 0, at: '03:00' }, model: 'default',
  });
  assert.match(a.id, /^sched-/);
  assert.deepEqual(a.tools, ['notes-ro', 'propose']);
  assert.equal(a.schedule.kind, 'weekly');
  assert.equal(P.listScheduledAgents(p.id).length, 1);
  P.updateScheduledAgent(p.id, a.id, { enabled: false });
  assert.equal(P.listScheduledAgents(p.id)[0].enabled, false);
  P.removeScheduledAgent(p.id, a.id);
  assert.equal(P.listScheduledAgents(p.id).length, 0);
});

test('a scheduled agent requires a prompt and a schedule', () => {
  const p = P.createProject('guards');
  assert.throws(() => P.addScheduledAgent(p.id, { prompt: '', schedule: { kind: 'daily', at: '02:00' } }), /needs a prompt/);
  assert.throws(() => P.addScheduledAgent(p.id, { prompt: 'x' }), /needs a schedule/);
});
