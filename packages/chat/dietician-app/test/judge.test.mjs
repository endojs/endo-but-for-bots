// judge.test.mjs — the verdict parser + the judge's UNKNOWN-safe fallback (ported from dietician.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeJudge } from '../providers/judge.mjs';
import { parseVerdict, EVAL_SYS } from '../prompt.mjs';

test('parseVerdict extracts + validates the verdict JSON (tolerant of surrounding prose/fences)', () => {
  assert.equal(parseVerdict('blah {"verdict":"VIABLE","summary":"ok"} trailing').verdict, 'VIABLE');
  assert.equal(parseVerdict('```json\n{"verdict":"SKIP"}\n```').verdict, 'SKIP');
  assert.equal(parseVerdict('{"verdict":"MAYBE"}'), null, 'an invalid verdict word → null');
  assert.equal(parseVerdict('no json here'), null);
});

test('EVAL_SYS embeds the spec + the person name + the strict output schema', () => {
  const s = EVAL_SYS({ spec: 'NO ONION OR GARLIC', person: 'alexa' });
  assert.match(s, /\*\*Alexa\*\*/, 'person name capitalised into the rubric');
  assert.match(s, /NO ONION OR GARLIC/, 'spec embedded verbatim');
  assert.match(s, /VIABLE\|BORDERLINE\|SKIP\|UNKNOWN/, 'the exact verdict schema is required');
});

test('judge: valid reply parses; bad reply / no menu → UNKNOWN; local fallback works', async () => {
  const good = makeJudge({ complete: async () => '{"verdict":"VIABLE","cuisine":"steakhouse","summary":"plain ribeye clean","promising_dishes":[{"name":"Ribeye","modifications":"no butter","residual_risk":"none"}],"avoid_outright":["x — y"],"kitchen_flexibility":"high"}' });
  const v = await good.evaluate({ spec: 'x', person: 'alexa', place: { name: 'Grill', primary_type: 'steak_house' }, menu: '# menu\nribeye' });
  assert.equal(v.verdict, 'VIABLE');
  assert.equal(v.promising_dishes.length, 1);

  const bad = makeJudge({ complete: async () => 'I cannot answer that' });
  assert.equal((await bad.evaluate({ spec: 'x', person: 'alexa', place: { name: 'G' }, menu: '# menu' })).verdict, 'UNKNOWN', 'unparseable → UNKNOWN');

  const noMenu = makeJudge({ complete: async () => { throw new Error('should not be called'); } });
  assert.equal((await noMenu.evaluate({ spec: 'x', person: 'alexa', place: { name: 'G' }, menu: '' })).verdict, 'UNKNOWN', 'no menu → model not called, UNKNOWN');

  const fb = makeJudge({ complete: async () => '', localComplete: async () => '{"verdict":"BORDERLINE"}' });
  assert.equal((await fb.evaluate({ spec: 'x', person: 'alexa', place: { name: 'G' }, menu: '# menu' })).verdict, 'BORDERLINE', 'falls back to localComplete');
});
