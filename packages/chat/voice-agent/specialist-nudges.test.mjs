// specialist-nudges.test.mjs — the standing-nudge scheduler: add → due → fired → reschedule, with a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeSpecialistNudges } from './specialist-nudges.mjs';

const mk = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-')), 'nudges.json');
  let t = 1_000_000;
  const s = makeSpecialistNudges({ file, now: () => t });
  return { s, tick: ms => { t += ms; }, at: () => t };
};

test('interval nudge: not due before, due after, reschedules on fire', () => {
  const { s, tick } = mk();
  const n = s.add({ specialistId: 'spec1', specialistName: 'Aether Sentry', chatId: 'c1', request: 'scan', schedule: { kind: 'interval', everyMs: 3_600_000 } });
  assert.equal(s.due().length, 0, 'not due immediately');
  tick(3_600_000);
  let d = s.due(); assert.equal(d.length, 1); assert.equal(d[0].specialistName, 'Aether Sentry');
  s.fired(n.id);
  assert.equal(s.due().length, 0, 'rescheduled — not due again right after firing');
  tick(3_600_000);
  assert.equal(s.due().length, 1, 'due again one interval later');
});

test('interval is floored at 60s (cost guard)', () => {
  const { s, tick } = mk();
  s.add({ specialistId: 'spec1', specialistName: 'X', request: 'r', schedule: { kind: 'interval', everyMs: 1000 } });
  tick(1000); assert.equal(s.due().length, 0, '1s requested but floored to 60s');
  tick(59_000); assert.equal(s.due().length, 1);
});

test('once nudge (after): fires once then deactivates', () => {
  const { s, tick } = mk();
  const n = s.add({ specialistId: 'spec1', specialistName: 'Protean Architect', request: 'draft v2', schedule: { kind: 'once', afterMs: 5000 } });
  tick(5000);
  assert.equal(s.due().length, 1);
  s.fired(n.id);
  assert.equal(s.due().length, 0);
  assert.equal(s.list()[0].status, 'done', 'once-nudge is done after firing');
});

test('once nudge (at iso): due at the absolute time', () => {
  const { s, tick, at } = mk();
  const when = new Date(at() + 10_000).toISOString();
  s.add({ specialistId: 'spec1', specialistName: 'X', request: 'r', schedule: { kind: 'once', atIso: when } });
  tick(9_000); assert.equal(s.due().length, 0);
  tick(2_000); assert.equal(s.due().length, 1);
});

test('list + cancel: by id, and by specialist name (all of a specialist’s nudges)', () => {
  const { s } = mk();
  const a = s.add({ specialistId: 'spec1', specialistName: 'Sentry', request: 'r1', schedule: { kind: 'interval', everyMs: 3_600_000 } });
  s.add({ specialistId: 'spec1', specialistName: 'Sentry', request: 'r2', schedule: { kind: 'interval', everyMs: 7_200_000 } });
  s.add({ specialistId: 'spec2', specialistName: 'Architect', request: 'r3', schedule: { kind: 'interval', everyMs: 3_600_000 } });
  assert.equal(s.list().length, 3);
  assert.equal(s.list({ specialistId: 'spec1' }).length, 2);
  assert.equal(s.cancel(a.id).removed, 1, 'cancel one by id');
  assert.equal(s.cancel('Sentry').removed, 1, 'cancel the rest by specialist name');
  assert.equal(s.list().length, 1);
});

test('no cap/secret is ever stored in a nudge record', () => {
  const { s } = mk();
  const n = s.add({ specialistId: 'spec1', specialistName: 'X', request: 'r', schedule: { kind: 'interval', everyMs: 3_600_000 } });
  assert.ok(!/cap|swiss|secret|token/i.test(JSON.stringify(n)));
});
