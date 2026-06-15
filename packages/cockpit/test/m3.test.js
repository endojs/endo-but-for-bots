// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeCockpit } from '../src/index.js';
import { exportTranscript } from '../src/backend/journal.js';

test('Builder Mode: the store seeds garden roles and authors new templates', t => {
  const { templates } = makeCockpit();
  const names = templates.list().map(tpl => tpl.name);
  t.true(names.includes('builder'));
  t.true(names.includes('investigator'));
  t.true(names.includes('liaison'));
  templates.define({
    name: 'scout',
    prompt: 'look around',
    capShape: [{ name: 'git', kind: 'git', mode: 'readOnly' }],
  });
  t.is(templates.get('scout')?.capShape[0].mode, 'readOnly');
  templates.remove('scout');
  t.is(templates.get('scout'), undefined);
  t.throws(() => templates.define(/** @type {{ name: string }} */ ({})), {
    message: /name required/,
  });
});

test('observability aggregates tokens and turns per template and model', async t => {
  const c = makeCockpit();
  const thread = c.registry.create({ templateName: 'builder', caps: [] });
  await thread.prompt('hello world');
  const s = c.o11y.summary();
  t.true(s.total.tokens > 0);
  t.is(s.total.turns, 1);
  t.true(Boolean(s.byTemplate.builder));
  t.is(s.byModel.mock.threads, 1);
});

test('steward view reflects the live registry', t => {
  const c = makeCockpit();
  c.registry.create({ templateName: 'investigator', caps: [] });
  const v = c.steward.view();
  t.is(v.autonomousLoop.totalThreads, 1);
  t.is(v.feed.length, 1);
});

test('journal export renders a thread transcript as a journal entry', async t => {
  const c = makeCockpit();
  const thread = c.registry.create({ templateName: 'builder', caps: [] });
  await thread.prompt('what branch?'); // no git cap → error, but a transcript exists
  const md = exportTranscript(thread);
  t.regex(md, /type: thread-transcript/);
  t.regex(md, /# transcript: t1 \(builder\)/);
  t.regex(md, /no git capability in scope/);
});
