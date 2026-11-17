// @ts-check
import '@endo/init/debug.js';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import test from 'ava';

import { makeFlootExecution } from '../../floot-execution.js';

const state = value => harden({ state: value, supported: true });
const session = (overrides = {}) =>
  Far('ExecutionSession', {
    __getMethodNames__: () =>
      harden(['getExecutionState', 'emergencyStop', 'resume']),
    getExecutionState: () => state('running'),
    emergencyStop: () => state('stopped'),
    resume: () => state('running'),
    ...overrides,
  });
const view = () => makeFlootExecution({ notify: () => undefined });

test('stop waits for remote cleanup and failure stays blocked and retryable', async t => {
  const pending = makePromiseKit();
  const started = makePromiseKit();
  let fails = true;
  const execution = view();
  await execution.select(
    session({
      emergencyStop: async () => {
        started.resolve(undefined);
        await pending.promise;
        if (fails) throw Error('cleanup failed');
        return state('stopped');
      },
    }),
  );
  const stop = execution.stop();
  await started.promise;
  t.like(execution.getState(), {
    state: 'stopping',
    changing: true,
    blocked: true,
  });
  pending.resolve(undefined);
  await stop;
  t.like(execution.getState(), {
    state: 'stopping',
    changing: false,
    error: 'cleanup failed',
    blocked: true,
  });
  fails = false;
  await execution.stop();
  t.is(execution.getState().state, 'stopped');
});

test('stop supersedes pending resume and ignores its late result', async t => {
  const pending = makePromiseKit();
  const started = makePromiseKit();
  let stops = 0;
  const execution = view();
  await execution.select(
    session({
      getExecutionState: () => state('stopped'),
      resume: () => {
        started.resolve(undefined);
        return pending.promise;
      },
      emergencyStop: () => {
        stops += 1;
        return state('stopped');
      },
    }),
  );
  const resume = execution.resume();
  await started.promise;
  await execution.stop();
  t.is(stops, 1);
  pending.resolve(state('running'));
  await resume;
  t.like(execution.getState(), {
    state: 'stopped',
    blocked: true,
    changing: false,
  });
});

test('late stop cannot repaint a different selected session', async t => {
  const pending = makePromiseKit();
  const started = makePromiseKit();
  const execution = view();
  await execution.select(
    session({
      emergencyStop: () => {
        started.resolve(undefined);
        return pending.promise;
      },
    }),
  );
  const stop = execution.stop();
  await started.promise;
  await execution.select(session());
  pending.resolve(state('stopped'));
  await stop;
  t.like(execution.getState(), {
    state: 'running',
    blocked: false,
    changing: false,
  });
});
