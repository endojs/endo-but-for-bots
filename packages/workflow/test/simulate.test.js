// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { simulateRun } from '../src/index.js';
import {
  featureChange,
  featureChangeParticipants,
} from './fixtures/feature-change.js';

const startFeatureChange = () =>
  simulateRun(featureChange, {
    input: { request: 'add dark mode', branch: 'feat/dark-mode' },
    participants: featureChangeParticipants,
  });

test('the happy path walks implement -> review -> ci -> approve -> merge', t => {
  const sim = startFeatureChange();

  t.is(sim.state, 'implementing');
  const implementation = sim.expectEffect('request', { to: 'implementer' });
  t.truthy(implementation.idempotencyKey);

  sim.inject('effect.settled', { as: 'implementation', ref: 'ref:1' });
  t.is(sim.state, 'reviewing');
  t.is(sim.context.changeSetId, 'ref:1');
  sim.expectEffect('fanout', { as: 'reviews' });

  sim.inject('fanout.joined', {
    as: 'reviews',
    results: [{ verdict: 'approve' }, { verdict: 'approve' }],
  });
  t.is(sim.state, 'testing');
  sim.expectEffect('call', { to: 'ci' });

  sim.inject('effect.settled', { as: 'ci-run' });
  t.is(sim.state, 'approving');
  sim.expectEffect('form', { to: 'approver' });

  sim.inject('form.value', { as: 'approval', values: { decision: 'yes' } });
  t.is(sim.state, 'merging');

  sim.inject('effect.settled', { as: 'merge' });
  t.is(sim.state, 'done');
  t.is(sim.final, 'succeeded');
});

test('a changes-requested verdict loops back with feedback in context', t => {
  const sim = startFeatureChange();
  sim.inject('effect.settled', { as: 'implementation', ref: 'ref:1' });
  const results = [
    { verdict: 'approve' },
    { verdict: 'changes-requested', comments: 'tighten the guard' },
  ];
  sim.inject('fanout.joined', { as: 'reviews', results });
  t.is(sim.state, 'implementing');
  t.deepEqual(sim.context.feedback, results);
  // The loop re-issues the implementation request.
  sim.expectEffect('request', { as: 'implementation' });
});

test('red CI loops back; a form decline abandons', t => {
  const sim = startFeatureChange();
  sim.inject('effect.settled', { as: 'implementation', ref: 'ref:1' });
  sim.inject('fanout.joined', {
    as: 'reviews',
    results: [{ verdict: 'approve' }],
  });
  sim.inject('effect.rejected', { as: 'ci-run', reason: 'tests failed' });
  t.is(sim.state, 'implementing');

  sim.inject('effect.settled', { as: 'implementation', ref: 'ref:2' });
  sim.inject('fanout.joined', {
    as: 'reviews',
    results: [{ verdict: 'approve' }],
  });
  sim.inject('effect.settled', { as: 'ci-run' });
  sim.inject('form.value', { as: 'approval', values: { decision: 'no' } });
  t.is(sim.state, 'abandoned');
  t.is(sim.final, 'abandoned');
});

test('an approval timeout abandons the run', t => {
  const sim = startFeatureChange();
  sim.inject('effect.settled', { as: 'implementation', ref: 'ref:1' });
  sim.inject('fanout.joined', {
    as: 'reviews',
    results: [{ verdict: 'approve' }],
  });
  sim.inject('effect.settled', { as: 'ci-run' });
  sim.inject('timeout', {});
  t.is(sim.final, 'abandoned');
});

test('settlements without a pending correlation journal as unauthorized', t => {
  const sim = startFeatureChange();
  const [record] = sim.inject('effect.settled', { as: 'nonsense' });
  t.is(record.type, 'event.unauthorized');
  t.is(sim.state, 'implementing');

  // A duplicate settlement is also unauthorized: the first consumed the
  // pending effect.
  sim.inject('effect.settled', { as: 'implementation', ref: 'ref:1' });
  const [duplicate] = sim.inject('effect.settled', {
    as: 'implementation',
    ref: 'ref:2',
  });
  t.is(duplicate.type, 'event.unauthorized');
  t.is(sim.context.changeSetId, 'ref:1');
});

test('an unhandled rejection fails the run; finished runs accept nothing', t => {
  const sim = startFeatureChange();
  sim.inject('effect.settled', { as: 'implementation', ref: 'ref:1' });
  // `reviewing` handles no effect.rejected and declares no onError.
  const records = sim.inject('effect.rejected', {
    as: 'reviews',
    reason: 'reviewer exploded',
  });
  t.is(records[records.length - 1].type, 'run.finished');
  t.is(sim.final, 'failed');

  const [after] = sim.inject('effect.settled', { as: 'reviews' });
  t.is(after.type, 'event.unauthorized');
});

test('inert events journal without a state change', t => {
  const sim = startFeatureChange();
  const [record] = sim.inject('signal.injected', { name: 'nudge' });
  t.is(record.type, 'signal.injected');
  t.is(sim.state, 'implementing');
});

test('fork-to-sandbox resumes from a journal prefix', t => {
  const sim = startFeatureChange();
  sim.inject('effect.settled', { as: 'implementation', ref: 'ref:1' });
  const prefix = sim.journal;

  const fork = simulateRun(featureChange, { priorRecords: prefix });
  t.is(fork.state, 'reviewing');
  fork.inject('fanout.joined', {
    as: 'reviews',
    results: [{ verdict: 'approve' }],
  });
  t.is(fork.state, 'testing');
  // The original simulation is untouched.
  t.is(sim.state, 'reviewing');
});

test('descriptions carry substituted input as delimited data', t => {
  const sim = startFeatureChange();
  const implementation = /** @type {{ description?: string }} */ (
    sim.journal.find(record => record.type === 'effect.issued')
  );
  t.is(
    implementation.description,
    'Implement: "add dark mode" on "feat/dark-mode"',
  );
});
