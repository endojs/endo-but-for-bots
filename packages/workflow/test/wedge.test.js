// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { simulateRun } from '../src/index.js';

// A parent that spawns a child and only handles the success outcome. A
// failed child must FAIL the parent, not wedge it.
const successOnlyParent = harden({
  name: 'success-only',
  version: 1,
  participants: { worker: { description: 'w' } },
  initial: 'delegating',
  states: {
    delegating: {
      entry: [
        { effect: 'spawn', workflow: 'child', participants: {}, as: 'sub' },
      ],
      on: {
        'child.finished': {
          when: { as: 'sub', final: 'succeeded' },
          target: 'done',
        },
      },
    },
    done: { final: 'succeeded' },
  },
});

test('an unhandled child failure fails the parent instead of wedging', t => {
  const sim = simulateRun(successOnlyParent, { participants: { worker: 'w' } });
  t.is(sim.state, 'delegating');
  const records = sim.inject('child.finished', {
    as: 'sub',
    final: 'failed',
  });
  t.is(sim.final, 'failed');
  const finished = records.find(record => record.type === 'run.finished');
  t.truthy(finished);
  t.regex(/** @type {string} */ (finished?.reason), /no transition handles/u);
});

// A guard that dereferences a field the event does not carry throws a
// TypeError; the run must fail with a diagnostic, not wedge (engine) or
// throw uncaught (simulator/engine divergence).
const throwingGuard = harden({
  name: 'throwing-guard',
  version: 1,
  participants: { worker: { description: 'w' } },
  initial: 'waiting',
  states: {
    waiting: {
      entry: [{ effect: 'request', to: 'worker', as: 'ask' }],
      onError: 'failed',
      on: {
        'effect.settled': {
          when: { as: 'ask' },
          guard: '({ event }) => event.missing.deep === 1',
          target: 'done',
        },
      },
    },
    done: { final: 'succeeded' },
    failed: { final: 'failed' },
  },
});

test('a throwing guard fails the run with a diagnostic, not a wedge', t => {
  const sim = simulateRun(throwingGuard, { participants: { worker: 'w' } });
  const records = sim.inject('effect.settled', { as: 'ask', value: 1 });
  t.is(sim.final, 'failed');
  const finished = records.find(record => record.type === 'run.finished');
  t.regex(/** @type {string} */ (finished?.reason), /expression error/u);
});

test('a reducer returning a non-object fails the run with a diagnostic', t => {
  const badAssign = harden({
    name: 'bad-assign',
    version: 1,
    participants: { worker: { description: 'w' } },
    initial: 'waiting',
    states: {
      waiting: {
        entry: [{ effect: 'request', to: 'worker', as: 'ask' }],
        onError: 'failed',
        on: {
          'effect.settled': {
            when: { as: 'ask' },
            assign: '({ event }) => event.value',
            target: 'done',
          },
        },
      },
      done: { final: 'succeeded' },
      failed: { final: 'failed' },
    },
  });
  const sim = simulateRun(badAssign, { participants: { worker: 'w' } });
  sim.inject('effect.settled', { as: 'ask', value: 42 });
  t.is(sim.final, 'failed');
});

test('an unhandled settlement routes to onError when declared', t => {
  const withOnError = harden({
    name: 'with-onerror',
    version: 1,
    participants: { worker: { description: 'w' } },
    initial: 'waiting',
    states: {
      waiting: {
        entry: [{ effect: 'request', to: 'worker', as: 'ask' }],
        onError: 'cleanup',
        on: {
          'effect.settled': {
            when: { as: 'ask' },
            guard: '({ event }) => event.value === "expected"',
            target: 'done',
          },
        },
      },
      done: { final: 'succeeded' },
      cleanup: { final: 'abandoned' },
    },
  });
  const sim = simulateRun(withOnError, { participants: { worker: 'w' } });
  // The guard rejects (value !== 'expected'), no other candidate; onError
  // catches it rather than wedging.
  sim.inject('effect.settled', { as: 'ask', value: 'unexpected' });
  t.is(sim.state, 'cleanup');
  t.is(sim.final, 'abandoned');
});
