// revise-loop.test.mjs — the review→revise convergence loop, deterministic (no model).
//   node --test packages/chat/voice-agent/revise-loop.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviseToConverge } from './revise-loop.mjs';

// a fake PANEL: severity is read off a marker in the source so the test is deterministic.
const fakePanel = async ({ code }) => {
  const worst = /CRITICAL/.test(code) ? 'critical' : /HIGH/.test(code) ? 'high' : /MEDIUM/.test(code) ? 'medium' : 'none';
  return { worst, findings: worst === 'none' ? [] : [{ discipline: 'ocap', severity: worst, report: `found ${worst}` }] };
};
// a fake DEVELOPER that fixes ONE severity level per round (critical→high→medium→clean).
const stepDownReviser = async ({ source }) => {
  const next = source.replace('CRITICAL', 'HIGH').replace('HIGH', 'MEDIUM').replace('MEDIUM', 'clean');
  return { source: next, resolutions: [{ finding: 'ocap (x)', action: 'integrate', how: 'addressed one level' }] };
};

test('a flagged component CONVERGES — the developer revises until the panel is satisfied', async () => {
  const r = await reviseToConverge({ record: { name: 't', description: 'd', kind: 'instance', code: 'CRITICAL bug here' }, revise: stepDownReviser, runPanel: fakePanel, maxRounds: 5 });
  assert.equal(r.converged, true, 'it converges');
  assert.ok(['none', 'low'].includes(r.review.worst), `worst is acceptable (${r.review.worst})`);
  assert.ok(r.rounds >= 1 && r.rounds <= 5, 'it took bounded rounds');
  assert.ok(r.reviseLog.every(e => !e.error), 'every round recorded its resolutions (no errors)');
  assert.match(r.source, /clean/, 'the final source is the revised one');
});

test('an already-clean component needs NO revise rounds', async () => {
  const r = await reviseToConverge({ record: { name: 't', description: 'd', code: 'all clean' }, revise: stepDownReviser, runPanel: fakePanel, maxRounds: 3 });
  assert.equal(r.rounds, 0);
  assert.equal(r.converged, true);
});

test('maxRounds bounds the loop — a developer that never improves stops (no infinite churn)', async () => {
  const noOp = async ({ source }) => ({ source, resolutions: [] }); // returns the same source → no progress
  const r = await reviseToConverge({ record: { name: 't', description: 'd', code: 'CRITICAL' }, revise: noOp, runPanel: fakePanel, maxRounds: 3 });
  assert.equal(r.converged, false, 'does not falsely converge');
  assert.ok(r.rounds <= 3, 'bounded by maxRounds');
  assert.equal(r.review.worst, 'critical', 'reports the still-unresolved severity');
});

test('a reviser that produces no source is recorded as an error, loop stops safely', async () => {
  const empty = async () => ({ source: '', resolutions: [] });
  const r = await reviseToConverge({ record: { name: 't', description: 'd', code: 'HIGH' }, revise: empty, runPanel: fakePanel, maxRounds: 3 });
  assert.equal(r.converged, false);
  assert.ok(r.reviseLog.some(e => e.error), 'the empty-source round is logged as an error');
});
