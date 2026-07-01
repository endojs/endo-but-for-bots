import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeDelegateProposal, LOW_RISK_POWERS, DESTRUCTIVE_POWERS } from './delegate.mjs';

const APPROVAL = 'spin up an attenuated agent';

test('single low-risk power the caller holds → direct execution, NO approval prompt', () => {
  const r = composeDelegateProposal({ proposals: 'Look up the weather.', powers: ['research'], callerPowers: ['research', 'web'] });
  assert.equal(r.directExec, true, 'should signal direct execution');
  assert.ok(!r.message.includes(APPROVAL), 'must NOT contain the approval-prompt text');
  assert.deepEqual(r.powers, ['research']);
});

test('single low-risk `web` power the caller holds → direct execution', () => {
  const r = composeDelegateProposal({ proposals: 'Fetch a page.', powers: ['web'], callerPowers: new Set(['web']) });
  assert.equal(r.directExec, true);
  assert.ok(!r.message.includes(APPROVAL));
});

test('callerPowers omitted → still short-circuits a single low-risk power', () => {
  const r = composeDelegateProposal({ proposals: 'Search.', powers: ['research'] });
  assert.equal(r.directExec, true);
  assert.ok(!r.message.includes(APPROVAL));
});

test('MULTI-power request still routes through the approval prompt', () => {
  const r = composeDelegateProposal({ proposals: 'Do a lot.', powers: ['research', 'web'], callerPowers: ['research', 'web'] });
  assert.equal(r.directExec, false, 'multi-power must NOT be direct-exec');
  assert.ok(r.message.includes(APPROVAL), 'must contain the approval-prompt text');
  assert.ok(r.message.includes('research, web'));
});

test('destructive single power (host) still routes through the approval prompt', () => {
  const r = composeDelegateProposal({ proposals: 'Edit files.', powers: ['host'], callerPowers: ['host'] });
  assert.equal(r.directExec, false);
  assert.ok(r.message.includes(APPROVAL));
});

test('destructive single power (home) still routes through the approval prompt', () => {
  const r = composeDelegateProposal({ proposals: 'Write files.', powers: ['home'], callerPowers: ['home'] });
  assert.equal(r.directExec, false);
  assert.ok(r.message.includes(APPROVAL));
});

test('single low-risk power the caller does NOT hold → approval prompt (real grant to review)', () => {
  const r = composeDelegateProposal({ proposals: 'Research.', powers: ['research'], callerPowers: ['web'] });
  assert.equal(r.directExec, false);
  assert.ok(r.message.includes(APPROVAL));
});

test('a non-listed power (e.g. images) is treated as not-low-risk → approval prompt', () => {
  const r = composeDelegateProposal({ proposals: 'Make an image.', powers: ['images'], callerPowers: ['images'] });
  assert.equal(r.directExec, false);
  assert.ok(r.message.includes(APPROVAL));
});

test('no powers requested → empty proposals, no approval prompt, not direct-exec', () => {
  const r = composeDelegateProposal({ proposals: 'Nothing to do.', powers: [] });
  assert.equal(r.directExec, false);
  assert.ok(!r.message.includes(APPROVAL));
});

test('classification sets are exported and sane', () => {
  assert.ok(LOW_RISK_POWERS.has('research') && LOW_RISK_POWERS.has('web'));
  assert.ok(DESTRUCTIVE_POWERS.has('host') && DESTRUCTIVE_POWERS.has('home'));
});
