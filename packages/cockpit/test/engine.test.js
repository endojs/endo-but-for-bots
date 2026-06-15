// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeMockEngine, makeMockGit } from '../src/backend/engine.js';

const harness = caps => {
  const events = [];
  let scope = { E: x => x, ...caps };
  const engine = makeMockEngine({
    getScope: () => scope,
    emit: e => events.push(e),
  });
  return { engine, events, setScope: s => (scope = { E: x => x, ...s }) };
};

test('the M0 tracer: "what branch?" streams the current branch', async t => {
  const { engine, events } = harness({ git: makeMockGit({ branch: 'llm' }) });
  const r = await engine.prompt('what branch?');
  t.is(r.status, 'ok');
  t.is(r.result, 'current branch: llm');
  t.true(events.some(e => e.kind === 'token'));
  t.true(events.some(e => e.kind === 'tool-call'));
});

test('revoking git drops it from scope: the agent cannot answer', async t => {
  const { engine, setScope } = harness({ git: makeMockGit() });
  setScope({}); // git revoked between turns
  const r = await engine.prompt('what branch?');
  t.is(r.status, 'error');
  t.regex(String(r.error), /no git capability in scope/);
});

test('read-only git literally lacks push: cannot push', async t => {
  const { engine } = harness({ git: makeMockGit({ mode: 'readOnly' }) });
  const r = await engine.prompt('push to origin');
  t.is(r.status, 'error');
  t.regex(String(r.error), /no push/);
});

test('read-write git can push', async t => {
  const { engine } = harness({ git: makeMockGit({ mode: 'readWrite' }) });
  const r = await engine.prompt('push');
  t.is(r.status, 'ok');
  t.deepEqual(r.result, { pushed: true, branch: 'main' });
});
