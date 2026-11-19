// @ts-check
/**
 * Environments across restarts (`designs/m6-interfaces.md` section 9: 4
 * (home across turns and a SIGKILL), 8, 11, 12; kill points K3 and K8 of
 * section 7), in a real daemon on the `environments` template with the
 * fake runtime:
 *
 * - 4: a file written to `$HOME` in one turn is read in the next, and
 *   again after a supervisor SIGKILL and restart;
 * - 11 / K8: the environments adapter process alone is killed during
 *   `sleep 5`: that call records `commandOutcomeUnknown`, the turn goes on
 *   to its final answer, and the next command in the same turn works (the
 *   port is reopened, the adapter rebuilt);
 * - 12 / K3: a supervisor SIGKILL during `sleep 600`: after the restart
 *   the turn is `outcome-unknown`, the process group is gone (the new
 *   bind's sweep), and the next turn's command works;
 * - 8: after the restart no fake group runs until a session's first
 *   command;
 * - K6 / K7: a SIGKILL right after `emergencyStop` and `deleteSession` were
 *   sent: after the restart the stop is `stopping` (resume refused with
 *   `finishStopFirst`) or done, a retried stop answers `stopped` and resume
 *   works; the delete finishes, its environment directory is gone and the
 *   trash is empty.
 *
 *   THIX_AGENT=W6.7 corepack yarn test:integration test/integration/environments-restart.test.js
 */
import '../unit/_m1a-prelude.js';

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  killStrays,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, waitFor } from './_m1a-slice.js';
import { runTurn, turnRecords } from './_m1b.js';
import {
  commandCall,
  commandTurn,
  environmentKeys,
  environmentProcesses,
  environmentsAdapter,
  environmentsTemplate,
  killEnvironmentsAdapter,
  startEnvironmentSession,
  toolResultsOf,
} from './_environments.js';

takeIntegrationLock(test, 'environments restart test');

const run = integrationEnabled ? test.serial : test.skip;

const readHome = commandCall('sh', ['-c', 'cat "$HOME/note"']);

const script = harden({
  turns: [
    commandTurn('write home', [
      [commandCall('sh', ['-c', 'printf kept > "$HOME/note"'])],
    ]),
    commandTurn('read home', [[readHome]]),
    commandTurn('runner restart', [
      [commandCall('sleep', ['5'])],
      [commandCall('printf', ['after'])],
    ]),
    commandTurn('daemon kill', [[commandCall('sleep', ['600'])]]),
    commandTurn('after restart', [[readHome]]),
  ],
});

run('home, runner restart alone, SIGKILL during a command', async t => {
  t.timeout(5 * 60_000);
  const t0 = performance.now();
  const template = await environmentsTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const identity = { ...(await runIdentity()), loadAvg: loadAvg() };
  const { backend } = await slice.makeBackend(script);
  let session = await startEnvironmentSession(slice, backend);
  const { key } = await E(session).getInfo();
  let live = await slice.subscribe(session);
  t.teardown(() => live.stop());
  /** @param {string} input */
  const turn = async input => {
    const ran = await runTurn(slice, session, live, input);
    const results = toolResultsOf(await turnRecords(ran.turn));
    t.log(input, ran.end.status, JSON.stringify(results).slice(0, 600));
    return { ...ran, results };
  };
  /** @param {any} result */
  const stdoutOf = result => JSON.parse(result).stdout;

  // 4: home across two turns.
  await turn('write home');
  const read = await turn('read home');
  t.is(stdoutOf(read.results[0].result), 'kept', 'home survives a turn');
  const [key0] = environmentKeys(state.root);

  // 11 / K8: the environments adapter alone killed during a command.
  const adapterBefore = environmentsAdapter(state.root);
  t.truthy(adapterBefore, 'the environments adapter runs');
  const from = live.deliveries.length;
  let receipt = await slice.submit(session, 'runner restart');
  await waitFor(
    () => environmentProcesses(state.root).length > 0,
    30_000,
    'sleep 5 running',
  );
  const killedPid = killEnvironmentsAdapter(state.root);
  const tKill = performance.now();
  await live.until(
    event => event.type === 'end' || event.type === 'abort',
    60_000,
    from,
  );
  const runnerRestartMs = performance.now() - tKill;
  const restartStatus = await E(receipt.turn).getStatus();
  t.is(restartStatus.state, 'completed', 'the turn goes on to its answer');
  const restarted = toolResultsOf(await turnRecords(receipt.turn));
  t.log('runner restart', JSON.stringify(restarted));
  t.deepEqual(
    restarted.map(r => r.failed),
    [true, false],
    'the killed command failed, the next one ran',
  );
  t.true(
    String(restarted[0].result).includes(texts.commandOutcomeUnknown),
    'the killed command records commandOutcomeUnknown',
  );
  t.is(stdoutOf(restarted[1].result), 'after', 'the next command ran');
  const adapterAfter = environmentsAdapter(state.root);
  t.truthy(adapterAfter, 'a new adapter process runs');
  t.not(adapterAfter?.pid, killedPid, 'it is a new process');

  // 12 / K3: SIGKILL of the supervisor during a command.
  receipt = await slice.submit(session, 'daemon kill');
  const { turnId: killedTurnId } = await E(receipt.turn).getStatus();
  await waitFor(
    () => environmentProcesses(state.root).length > 0,
    30_000,
    'sleep 600 running',
  );
  await live.stop();
  await state.kill();
  await killStrays(state.root);
  t.true(
    environmentProcesses(state.root).length > 0,
    'the fake group outlives the supervisor (a container would too)',
  );
  const tRestart = performance.now();
  const served = await state.restart();
  await slice.refresh();
  // 8: the new bind sweeps the leftover; nothing starts by itself.
  await waitFor(
    () => environmentProcesses(state.root).length === 0,
    60_000,
    'the leftover group swept by the new bind',
  );
  const sweptMs = performance.now() - tRestart;
  session = await E(slice.factory).findSession(key);
  live = await slice.subscribe(session);
  const page = await E(session).getHistoryPage();
  const killedTurn = page.turns.find(
    (/** @type {any} */ tp) => tp.turnId === killedTurnId,
  );
  const settled = killedTurn?.records.find(
    (/** @type {any} */ r) => r.kind === 'turn-settled',
  );
  t.is(settled?.status, 'outcome-unknown', 'the turn is outcome-unknown');
  t.deepEqual(
    environmentProcesses(state.root),
    [],
    'no fake group runs before a first command',
  );
  const after = await turn('after restart');
  t.is(
    stdoutOf(after.results[0].result),
    'kept',
    'home survives the SIGKILL and the next command works',
  );

  // K6 and K7: a SIGKILL right after an emergency stop and a delete were
  // sent, before either answered.
  // Client presences held before the supervisor restart are disconnected.
  const { backend: currentBackend } = await slice.makeBackend(script);
  const stopping = await startEnvironmentSession(
    slice,
    currentBackend,
    'development',
    'k6',
  );
  const { key: stoppingKey } = await E(stopping).getInfo();
  const doomed = await startEnvironmentSession(
    slice,
    currentBackend,
    'development',
    'k7',
  );
  const { key: doomedKey } = await E(doomed).getInfo();
  const doomedLive = await slice.subscribe(doomed);
  await runTurn(slice, doomed, doomedLive, 'write home');
  await doomedLive.stop();
  const doomedDirs = environmentKeys(state.root).filter(k => k !== key0);
  E(stopping)
    .emergencyStop()
    .catch(() => {});
  E(slice.factory)
    .deleteSession(doomed)
    .catch(() => {});
  await live.stop();
  await state.kill();
  await killStrays(state.root);
  await state.restart();
  await slice.refresh();
  const k6 = await E(slice.factory).findSession(stoppingKey);
  const k6State = (await E(k6).getExecutionState()).state;
  t.log('K6: after the restart the session is', k6State);
  if (k6State === 'stopping')
    await t.throwsAsync(() => E(k6).resume(), {
      message: texts.finishStopFirst,
    });
  t.deepEqual(
    await E(k6).emergencyStop(),
    { state: 'stopped', supported: true },
    'K6: the retried emergency stop answers stopped',
  );
  t.deepEqual(
    await E(k6).resume(),
    { state: 'running', supported: true },
    'K6: then resume works',
  );
  // K7: the delete resumes at this start and finishes.
  await waitFor(
    async () => {
      try {
        await E(slice.factory).findSession(doomedKey);
        return false;
      } catch {
        return true;
      }
    },
    60_000,
    'K7: the delete finished after the restart',
  );
  await waitFor(
    () => doomedDirs.every(k => !environmentKeys(state.root).includes(k)),
    30_000,
    "K7: the deleted session's environment directory gone",
  );
  t.deepEqual(
    readdirSync(path.join(state.root, 'environments', 'trash')),
    [],
    'K7: the trash is empty',
  );

  emit({
    metric: 'environments.restart.acceptance',
    runnerRestartToEndMs: round1(runnerRestartMs),
    restartServedMs: served.servedMs,
    sweptAfterRestartMs: round1(sweptMs),
    wallMs: round1(performance.now() - t0),
    ...identity,
  });
});
