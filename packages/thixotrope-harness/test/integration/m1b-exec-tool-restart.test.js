// @ts-check
/**
 * The exec tool across cancel and restarts in a real daemon (M1b W1b.4;
 * milestones.md M1b acceptance 3 and 10 at the tool level;
 * m1b-interfaces.md 8.3):
 *
 * - 3: `globalThis.x = 5` in one exec; `return x` in the next turn after a
 *   clean restart returns 5. A turn cancelled during a 30 s exec sleep keeps
 *   the scope: the next turn's exec, sent at once while the abandoned sleep
 *   still runs, sees `x === 5` (M1b QC, J-0391: the session tells the exec
 *   vat `abandon()`, so there is no busy reset); and an abandoned loop of
 *   sleeps stops at its next sleep.
 * - 10: SIGKILL during a 30 s exec sleep, restart: the turn is
 *   outcome-unknown as soon as the daemon serves (recovery did not wait for
 *   the exec call); the next exec works and sees `x` from before. The
 *   provider got the killed turn once and the exec ran at most once (its
 *   `sleeps` counter); EXEC_KILL_DELAY_MS (default 2,000) sets the kill
 *   point after the call is sent.
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1b-exec -- \
 *     corepack yarn test test/integration/m1b-exec-tool-restart.test.js
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

// eslint-disable-next-line import/no-relative-packages
import { texts, textOf } from '../../guest/lib/interfaces.js';
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  killStrays,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1 } from './_m1a-slice.js';
import { execScript, execTemplate, execTurn, resultsOf } from './_m1b-exec.js';

takeIntegrationLock(test, 'm1b exec tool restart test');

const run = integrationEnabled ? test.serial : test.skip;

/** How long after the exec call is sent the supervisor is killed (acceptance 10). */
const KILL_DELAY_MS = Number(process.env.EXEC_KILL_DELAY_MS ?? 2000);

run('exec across cancel, a clean restart and a SIGKILL', async t => {
  t.timeout(5 * 60_000);
  const tStart = performance.now();
  const template = await execTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const identity = {
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  };
  const made = await slice.makeBackend(harden(execScript));
  let session = await slice.createSession(made.backend, 'exec restart');
  const { key } = await E(session).getInfo();
  let live = await slice.subscribe(session);

  /** Serve again (after `stop` or `kill`) and find the session again. */
  const reopen = async () => {
    await live.stop();
    const restarted = await state.restart();
    const t1 = performance.now();
    await slice.refresh();
    session = await E(slice.factory).findSession(key);
    live = await slice.subscribe(session);
    return { ...restarted, t1 };
  };

  // ---- 3a: x survives a clean restart
  t.is((await execTurn(slice, session, live, 'exec set')).result, '5');
  const clean = await reopen();
  const afterClean = await execTurn(slice, session, live, 'exec get');
  t.is(afterClean.result, '5');
  emit({
    metric: 'exec.restart.clean',
    unit: 'ms',
    value: afterClean.callMs,
    what: 'the first exec after a clean restart (tool_call to tool_result; the exec vat wakes)',
    servedMs: clean.servedMs,
    ...identity,
  });

  // ---- 3b: cancel during a 30 s sleep keeps the scope; the next exec runs
  // at once in it (acceptance 3 as written)
  const sleeping = await execTurn(slice, session, live, 'exec sleep30', {
    wait: 'call',
  });
  // Let the run reach the exec vat and its sleep before the cancel.
  await delay(1000);
  await E(sleeping.turn).cancel();
  const cancelled = await E(sleeping.turn).whenFinished();
  t.is(cancelled.state, 'cancelled');
  t.deepEqual((await resultsOf(session, sleeping.turnId)).results, [
    textOf.errorResult(texts.execAbandoned),
  ]);
  const sleepLeftMs =
    /** @type {number} */ (sleeping.callAt) + 30_000 - Date.now();
  const afterCancel = await execTurn(slice, session, live, 'exec get');
  t.true(sleepLeftMs > 20_000, 'the abandoned sleep was still running');
  t.is(afterCancel.result, '5', 'the scope was kept, without a busy reset');
  emit({
    metric: 'exec.afterCancel',
    unit: 'ms',
    value: afterCancel.callMs,
    what: 'the next turn exec right after a cancelled 30 s sleep (abandon, same scope)',
    sleepLeftMs,
    ...identity,
  });

  // ---- 3c: an abandoned loop of sleeps stops (it may finish the step its
  // sleep in flight resumes, then its next sleep is dead)
  const ticker = await execTurn(slice, session, live, 'exec ticker', {
    wait: 'call',
  });
  await delay(1600);
  await E(ticker.turn).cancel();
  await E(ticker.turn).whenFinished();
  const ticksAtCancel = Number(
    (await execTurn(slice, session, live, 'exec ticks')).result,
  );
  await delay(3000);
  const ticksLater = Number(
    (await execTurn(slice, session, live, 'exec ticks')).result,
  );
  t.true(ticksAtCancel >= 1, `the loop ran (${ticksAtCancel} ticks)`);
  t.true(
    ticksLater - ticksAtCancel <= 1,
    `the abandoned loop stopped (${ticksAtCancel} -> ${ticksLater} ticks)`,
  );
  emit({
    metric: 'exec.abandonedLoop',
    ticksAtCancel,
    ticksLater,
    ...identity,
  });

  // ---- 10: SIGKILL during a 30 s sleep
  t.is((await execTurn(slice, session, live, 'exec set')).result, '5');
  const sleepsBefore = Number(
    (await execTurn(slice, session, live, 'exec sleeps')).result,
  );
  const killed = await execTurn(slice, session, live, 'exec sleep30', {
    wait: 'call',
  });
  // Let the run reach the exec vat and its sleep before the kill
  // (EXEC_KILL_DELAY_MS, default 2,000; a shorter one may kill before it).
  await delay(KILL_DELAY_MS);
  const atKill = Date.now();
  await state.kill();
  await killStrays(state.root);
  const restarted = await reopen();
  const firstRead = await resultsOf(session, killed.turnId);
  const readMs = round1(performance.now() - restarted.t1);
  const readSinceCallMs = Date.now() - /** @type {number} */ (killed.callAt);
  t.is(firstRead.state, 'outcome-unknown', 'recovered at serving');
  t.deepEqual(firstRead.results, [texts.toolOutcomeUnknown]);
  const next = await execTurn(slice, session, live, 'exec get', {
    ms: 90_000,
  });
  emit({
    metric: 'exec.restart.sigkill',
    unit: 'ms',
    value: restarted.servedMs,
    what: 'SIGKILL during a 30 s exec sleep: served, then the turn read outcome-unknown, then the next exec',
    turnStateAtFirstRead: firstRead.state,
    firstReadAfterServedMs: readMs,
    killAfterCallMs: atKill - /** @type {number} */ (killed.callAt),
    firstReadSinceCallMs: readSinceCallMs,
    nextResult: next.result,
    nextCallMs: next.callMs,
    ...identity,
  });
  const sleepsAfter = Number(
    (await execTurn(slice, session, live, 'exec sleeps')).result,
  );
  const killedRequests = made
    .log()
    .filter(
      (/** @type {any} */ l) =>
        l.kind === 'request' && l.turnId === killed.turnId,
    ).length;
  emit({
    metric: 'exec.restart.sigkill.once',
    killDelayMs: KILL_DELAY_MS,
    sleepsBefore,
    sleepsAfter,
    killedRequests,
    ...identity,
  });
  t.true(readSinceCallMs < 30_000, 'recovery did not wait for the sleep');
  t.is(next.result, '5', 'the exec vat survived and keeps x');
  t.is(next.endStatus, 'completed');
  t.true(
    sleepsAfter - sleepsBefore <= 1,
    `the killed exec was evaluated at most once (${sleepsBefore} -> ${sleepsAfter})`,
  );
  t.is(killedRequests, 1, 'the provider got the killed turn once');

  await live.stop();
  emit({
    metric: 'm1b.exec.restart.file',
    unit: 'ms',
    value: round1(performance.now() - tStart),
    ...identity,
  });
});
