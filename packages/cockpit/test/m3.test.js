// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeCockpit } from '../src/index.js';
import { exportTranscript } from '../src/backend/journal.js';

test('Builder Mode: the store seeds garden roles and authors new templates', () => {
  const { templates } = makeCockpit();
  const names = templates.list().map(t => t.name);
  assert.ok(names.includes('builder'));
  assert.ok(names.includes('investigator'));
  assert.ok(names.includes('liaison'));
  templates.define({
    name: 'scout',
    prompt: 'look around',
    capShape: [{ name: 'git', kind: 'git', mode: 'readOnly' }],
  });
  assert.equal(templates.get('scout')?.capShape[0].mode, 'readOnly');
  templates.remove('scout');
  assert.equal(templates.get('scout'), undefined);
  assert.throws(() => templates.define({}), /name required/);
});

test('observability aggregates tokens and turns per template and model', async () => {
  const c = makeCockpit();
  const t = c.registry.create({ templateName: 'builder', caps: [] });
  await t.prompt('hello world');
  const s = c.o11y.summary();
  assert.ok(s.total.tokens > 0);
  assert.equal(s.total.turns, 1);
  assert.ok(s.byTemplate.builder);
  assert.equal(s.byModel.mock.threads, 1);
});

test('steward view reflects the live registry', () => {
  const c = makeCockpit();
  c.registry.create({ templateName: 'investigator', caps: [] });
  const v = c.steward.view();
  assert.equal(v.autonomousLoop.totalThreads, 1);
  assert.equal(v.feed.length, 1);
});

test('journal export renders a thread transcript as a journal entry', async () => {
  const c = makeCockpit();
  const t = c.registry.create({ templateName: 'builder', caps: [] });
  await t.prompt('what branch?'); // no git cap → error, but a transcript exists
  const md = exportTranscript(t);
  assert.match(md, /type: thread-transcript/);
  assert.match(md, /# transcript: t1 \(builder\)/);
  assert.match(md, /no git capability in scope/);
});
