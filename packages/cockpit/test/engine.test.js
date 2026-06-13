// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMockEngine, makeMockGit } from '../src/backend/engine.js';

const harness = caps => {
  const events = [];
  let scope = { E: x => x, ...caps };
  const engine = makeMockEngine({ getScope: () => scope, emit: e => events.push(e) });
  return { engine, events, setScope: s => (scope = { E: x => x, ...s }) };
};

test('the M0 tracer: "what branch?" streams the current branch', async () => {
  const { engine, events } = harness({ git: makeMockGit({ branch: 'llm' }) });
  const r = await engine.prompt('what branch?');
  assert.equal(r.status, 'ok');
  assert.equal(r.result, 'current branch: llm');
  assert.ok(events.some(e => e.kind === 'token'));
  assert.ok(events.some(e => e.kind === 'tool-call'));
});

test('revoking git drops it from scope: the agent cannot answer', async () => {
  const { engine, setScope } = harness({ git: makeMockGit() });
  setScope({}); // git revoked between turns
  const r = await engine.prompt('what branch?');
  assert.equal(r.status, 'error');
  assert.match(String(r.error), /no git capability in scope/);
});

test('read-only git literally lacks push: cannot push', async () => {
  const { engine } = harness({ git: makeMockGit({ mode: 'readOnly' }) });
  const r = await engine.prompt('push to origin');
  assert.equal(r.status, 'error');
  assert.match(String(r.error), /no push/);
});

test('read-write git can push', async () => {
  const { engine } = harness({ git: makeMockGit({ mode: 'readWrite' }) });
  const r = await engine.prompt('push');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.result, { pushed: true, branch: 'main' });
});
