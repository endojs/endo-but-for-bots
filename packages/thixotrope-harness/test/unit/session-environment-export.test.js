// @ts-check
// The execution state through export and import (guest/session/export.js
// seam X-E, guest/session/environment.js; m6-interfaces.md 4.5, D-M6-9,
// X-07, acceptance 22 at crank level): a running session's head page
// carries no `execution`; a stopped or stopping one exports `stopped`; an
// import re-applies `stopped`, holds the queue `stopped` even with nothing
// waiting, and withdraws the imported session's own new environment
// (`emergencyStop` sent to it); resume then works and the hold stays. An
// import into a session without an environment keeps it stopped and
// unsupported. Over fakes built from the real guards.
// The as-built program contains the environment part and its call table.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import path from 'node:path';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { texts } from '../../guest/lib/interfaces.js';
import { bundleGuest } from '../../scripts/bundle-guest.mjs';
/* eslint-enable import/no-relative-packages */
import {
  AT,
  drain,
  makeEnvironmentSession,
  makeFakeEnvironment,
  requestId,
} from './_session-environment.js';
import { harnessRoot } from '../_helpers.js';

/**
 * Move every export page of `from` into `to`.
 * @param {any} from SessionInternal
 * @param {any} to SessionInternal
 */
const moveSession = (from, to) => {
  /** @type {string | undefined} */
  let cursor;
  for (;;) {
    const page = from.exportState(cursor);
    to.importState(page);
    if (page.part === 'end') return;
    cursor = page.next;
  }
};

test('a running session exports no execution state', async t => {
  const s = await makeEnvironmentSession({
    environment: makeFakeEnvironment(),
  });
  t.false('execution' in s.internal.exportState());
});

test('a stopping session exports stopped, as a stopped one does', async t => {
  const env = makeFakeEnvironment({ holdStops: true });
  const s = await makeEnvironmentSession({ environment: env });
  const answer = s.session.emergencyStop();
  await drain();
  t.is(s.session.getExecutionState().state, 'stopping');
  t.deepEqual(s.internal.exportState().execution, {
    state: 'stopped',
    supported: true,
  });
  env.stops[0].resolve(undefined);
  await answer;
  t.deepEqual(s.internal.exportState().execution, {
    state: 'stopped',
    supported: true,
  });
});

test('an import of a stopped session: stopped, held even with an empty queue, the new environment withdrawn; resume works', async t => {
  const source = await makeEnvironmentSession({
    environment: makeFakeEnvironment(),
  });
  await source.session.emergencyStop();
  const env = makeFakeEnvironment();
  const target = await makeEnvironmentSession({ environment: env });
  const head = source.internal.exportState();
  target.internal.importState(head);
  // The head chunk's crank: stopped, held, the emergency stop sent.
  t.deepEqual(target.session.getExecutionState(), {
    state: 'stopped',
    supported: true,
  });
  t.is(target.session.listPending().hold?.reason, 'stopped');
  t.is(target.session.listPending().entries.length, 0);
  await drain();
  t.deepEqual(env.sent('emergencyStop'), [['emergencyStop']]);
  // The rest of the export.
  let cursor = head.next;
  for (;;) {
    const page = source.internal.exportState(cursor);
    target.internal.importState(page);
    if (page.part === 'end') break;
    cursor = page.next;
  }
  t.throws(
    () => target.session.enqueueOnce(harden({ text: 'x' }), requestId(), AT),
    { message: texts.sessionStopped },
  );
  t.deepEqual(await target.session.resume(), {
    state: 'running',
    supported: true,
  });
  t.deepEqual(env.sent('resume'), [['resume']]);
  t.is(target.session.listPending().hold?.reason, 'stopped', 'still held');
  t.false('execution' in target.internal.exportState());
});

test('an import of a running session leaves the new one running and unheld', async t => {
  const source = await makeEnvironmentSession({
    environment: makeFakeEnvironment(),
  });
  const env = makeFakeEnvironment();
  const target = await makeEnvironmentSession({ environment: env });
  moveSession(source.internal, target.internal);
  await drain();
  t.is(target.session.getExecutionState().state, 'running');
  t.is(target.session.listPending().hold, undefined);
  t.deepEqual(env.log, []);
});

test('an import into a session without an environment: stopped and unsupported; stop refused; resume answers running', async t => {
  const source = await makeEnvironmentSession({
    environment: makeFakeEnvironment(),
  });
  await source.session.emergencyStop();
  const target = await makeEnvironmentSession();
  moveSession(source.internal, target.internal);
  t.deepEqual(target.session.getExecutionState(), {
    state: 'stopped',
    supported: false,
  });
  t.is(target.session.listPending().hold?.reason, 'stopped');
  await t.throwsAsync(target.session.emergencyStop(), {
    message: texts.noEnvironmentToStop,
  });
  t.deepEqual(await target.session.resume(), {
    state: 'running',
    supported: false,
  });
});

test('the provisioned session includes the environment and shared call table within its program budget', async t => {
  const { modules, bytes } = await bundleGuest(
    path.join(harnessRoot, 'guest', 'session', 'main.js'),
  );
  t.true(modules.includes('session/environment.js'));
  t.true(modules.includes('session/tools/call-table.js'));
  t.true(bytes <= limits.sessionProgramBytes, `${bytes} bytes`);
});
