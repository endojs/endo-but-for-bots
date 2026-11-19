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
// Also the session program's growth for this lane (seam B-1).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import path from 'node:path';

/* eslint-disable import/no-relative-packages */
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

test('the session program grows by at most the environments cap over the WX.1 base (B-1)', async t => {
  // milestones.md "Caps as set": 6,400 bytes over 233,126 for the
  // environments lane. The shared call table (`tools/call-table.js`, WX.1's
  // export for this lane and the mail lane, D-M6-17) is first bundled by
  // this lane; its bytes are reported apart (J-12041).
  const WX1_BASE = 233_126;
  const CAP = 6400;
  const { source, bytes } = await bundleGuest(
    path.join(harnessRoot, 'guest', 'session', 'main.js'),
  );
  // The call table's bytes: its module section, its functor block and the
  // other head lines that name it (the bundle's own layout).
  const header = / (\d+)\. guest \.\/session\/tools\/call-table\.js ===\n/.exec(
    source,
  );
  t.truthy(header, 'the call table is bundled');
  const index = Number(/** @type {RegExpExecArray} */ (header)[1]);
  const start = /** @type {RegExpExecArray} */ (header).index;
  const end = source.indexOf('\n// === ', start + 1);
  const firstSection = source.indexOf('\n// === ');
  const head = source.slice(0, firstSection);
  const blockStart = head.indexOf(`functors[${index}]({`);
  const block = head.slice(blockStart, head.indexOf('\n});\n', blockStart) + 5);
  const named = head
    .split('\n')
    .filter(line => /makeCallTable|call-table\.js/.test(line))
    .filter(line => !block.includes(line));
  const callTableBytes =
    Buffer.byteLength(source.slice(start, end)) +
    Buffer.byteLength(block) +
    named.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  const row = {
    metric: 'environments.bundles.session',
    bytes,
    growth: bytes - WX1_BASE,
    callTableBytes,
    ownGrowth: bytes - WX1_BASE - callTableBytes,
    cap: CAP,
  };
  t.log(JSON.stringify(row));
  t.true(row.ownGrowth <= CAP, JSON.stringify(row));
});
