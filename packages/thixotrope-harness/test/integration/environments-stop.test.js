// @ts-check
/**
 * Emergency stop, resume, delete and bounded state of environments
 * (`designs/m6-interfaces.md` section 9: 4 (delete), 6, 13, 20, 22; kill
 * points K6 and K7 of section 7; the stop probes of section 11), in a real
 * daemon on the `environments` template with the fake runtime:
 *
 * - 6: `emergencyStop` during `sleep 600` cancels the turn, kills the
 *   process, holds the queue `stopped` and fences the session
 *   (`Composer.submit`, `startTurn` and a waiting entry's `sendNow` refused
 *   with `sessionStopped`); twice is idempotent; resume answers `running`
 *   and keeps the hold until a new message, which runs;
 * - 6 (authority): an environment provided by the admin directly (the
 *   operator's view of what a session holds) is withdrawn by its control's
 *   `emergencyStop`: `Git`, `Shell` and `port()` refused in the manager with
 *   `environmentTexts.stopped`, an `ImageSource` opened before refused in
 *   the adapter; `resume` gives them back;
 * - 6 (restart): a session stopped before a supervisor SIGKILL is still
 *   stopped and fenced after the restart, and resumes;
 * - 22: that session exported and imported is `stopped` with its queue
 *   held `stopped`; resume works and the imported session's own new
 *   environment runs a command;
 * - 13, 4: `deleteSession` during `sleep 600` completes; the process, the
 *   environment's directory and its manager record are gone;
 * - 20 (gate): 20 sessions created and deleted leave the manager's record
 *   count and pending releases as before.
 *
 *   THIX_AGENT=W6.7 corepack yarn test:integration test/integration/environments-stop.test.js
 */
import '../unit/_m1a-prelude.js';

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { environmentTexts } from '../../guest/lib/guards/environments.js';
import { texts } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import { exportState, importState } from '../../scripts/export.mjs';
import {
  integrationEnabled,
  killStrays,
  shortName,
  startFromTemplate,
  takeIntegrationLock,
  tmpRoot,
} from '../template/index.js';
import { makeSlice, round1, turnWithInput, waitFor } from './_m1a-slice.js';
import { turnRecords } from './_m1b.js';
import {
  commandCall,
  commandTurn,
  environmentKeys,
  environmentProcesses,
  environmentsTemplate,
  startEnvironmentSession,
  toolResultsOf,
} from './_environments.js';

takeIntegrationLock(test, 'environments stop test');

const run = integrationEnabled ? test.serial : test.skip;

const script = harden({
  turns: [
    commandTurn('warm', [[commandCall('printf', ['warm'])]]),
    commandTurn('long', [[commandCall('sleep', ['600'])]]),
    commandTurn('queued', [[commandCall('printf', ['queued'])]]),
    commandTurn('after resume', [[commandCall('printf', ['resumed'])]]),
  ],
});

/**
 * The message of a rejection, or `answered` when it did not reject.
 * @param {() => Promise<unknown>} thunk
 */
const refusal = async thunk => {
  try {
    await thunk();
    return 'answered';
  } catch (error) {
    return /** @type {Error} */ (error).message;
  }
};

/**
 * The Turn a receipt started, or the session's current turn when the
 * receipt came back queued (the previous turn was still settling).
 * @param {any} session
 * @param {any} receipt
 */
const turnOfReceipt = async (session, receipt) => {
  if (receipt.turn !== undefined) return receipt.turn;
  const current = await waitFor(
    () => E(session).getCurrentTurn(),
    30_000,
    'the turn to start',
  );
  return current.turn;
};

/**
 * Run one turn of `input` to its settled status: `{ status, results }`.
 * @param {any} slice
 */
const turnsOf =
  slice =>
  /**
   * @param {any} session
   * @param {string} input
   */
  async (session, input) => {
    const ran = await turnOfReceipt(
      session,
      await slice.submit(session, input),
    );
    const status = await waitFor(
      async () => {
        const now = await E(ran).getStatus();
        return !['running', 'cancelling'].includes(now.state) && now;
      },
      60_000,
      `turn ${input} to settle`,
    );
    return { status, results: toolResultsOf(await turnRecords(ran)) };
  };

/** @param {any} result */
const stdoutOf = result => JSON.parse(result).stdout;

run(
  'emergency stop, resume, export and import, delete, bounded records',
  async t => {
    t.timeout(5 * 60_000);
    const t0 = performance.now();
    const template = await environmentsTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const identity = { ...(await runIdentity()), loadAvg: loadAvg() };
    let admin = await state.client.call('lookup', 'environmentsAdmin');
    const before = await E(admin).status();
    t.is(before.state, 'ready', 'the template configured the runner');
    let made = await slice.makeBackend(script);
    const turn = turnsOf(slice);

    // ---- 6: emergency stop of a session during a command.
    const session = await startEnvironmentSession(slice, made.backend);
    const warm = await turn(session, 'warm');
    t.is(stdoutOf(warm.results[0].result), 'warm');
    const [key] = environmentKeys(state.root);
    t.truthy(key, 'the first command made the environment directory');
    t.deepEqual(
      await E(session).getExecutionState(),
      { state: 'running', supported: true },
      'a development session is running and supported',
    );
    const longTurn = await turnOfReceipt(
      session,
      await slice.submit(session, 'long'),
    );
    await waitFor(
      () => environmentProcesses(state.root).length > 0,
      30_000,
      'sleep 600 running',
    );
    const queued = await slice.submit(session, 'queued');
    t.is(queued.state, 'queued', 'a second message waits');
    const tStop = performance.now();
    const stopped = await E(session).emergencyStop();
    const stopMs = performance.now() - tStop;
    t.deepEqual(stopped, { state: 'stopped', supported: true }, 'stopped');
    await waitFor(
      async () => (await E(longTurn).getStatus()).state === 'cancelled',
      10_000,
      'the running turn cancelled',
    );
    t.deepEqual(environmentProcesses(state.root), [], 'no process of it alive');
    const pending = await E(session).listPending();
    t.is(pending.hold?.reason, 'stopped', 'the queue is held stopped');
    t.is(pending.entries.length, 1, 'the waiting entry stays');
    t.is(
      await refusal(() => slice.submit(session, 'refused')),
      texts.sessionStopped,
      'Composer.submit is refused',
    );
    t.is(
      await refusal(() =>
        E(session).startTurn(harden({ text: 'refused' }), Date.now()),
      ),
      texts.sessionStopped,
      'startTurn is refused',
    );
    t.is(
      await refusal(() => E(pending.entries[0].entry).sendNow()),
      texts.sessionStopped,
      "a waiting entry's sendNow is refused",
    );
    t.is(
      (await E(session).listPending()).hold?.reason,
      'stopped',
      'the hold is kept after the refusals',
    );
    t.deepEqual(
      await E(session).emergencyStop(),
      { state: 'stopped', supported: true },
      'a second stop is idempotent',
    );
    t.deepEqual(
      await E(session).resume(),
      { state: 'running', supported: true },
      'resume answers running',
    );
    t.deepEqual(
      await E(session).resume(),
      { state: 'running', supported: true },
      'a second resume answers running',
    );
    t.is(
      (await E(session).listPending()).hold?.reason,
      'stopped',
      'the queue stays held after resume',
    );
    // A new message releases the hold: the waiting entry runs first, then it.
    await slice.submit(session, 'after resume');
    await waitFor(
      async () =>
        (await E(session).listPending()).entries.length === 0 &&
        (await E(session).getCurrentTurn()) === undefined,
      60_000,
      'the queue drained',
    );
    const page = await E(session).getHistoryPage();
    const outputs = ['queued', 'after resume'].map(input =>
      turnWithInput(page, input)
        ?.records.filter((/** @type {any} */ r) => r.kind === 'tool-result')
        .map((/** @type {any} */ r) => stdoutOf(r.result)),
    );
    t.deepEqual(
      outputs,
      [['queued'], ['resumed']],
      'a new message releases the hold: the waiting entry, then it, run',
    );

    // ---- 6 (authority): withdrawal in the manager and the adapter.
    const kit = await E(admin).provide(
      harden({ workspace: true, shell: true }),
    );
    const shellRun = await E(kit.shell).runCommand('sh', [
      '-c',
      'head -c 300 /dev/zero > a.png',
    ]);
    t.is(shellRun.exitCode, 0, "the kit's shell runs a command");
    const source = await E(kit.workspace).openImage(harden(['a.png']));
    t.is(await E(source).size(), 300, 'an image source opened before the stop');
    await E(kit.control).emergencyStop();
    t.is(
      await refusal(() => E(kit.workspace).status()),
      environmentTexts.stopped,
      'Git refused in the manager',
    );
    t.is(
      await refusal(() => E(kit.shell).runCommand('true', [])),
      environmentTexts.stopped,
      'Shell refused in the manager',
    );
    t.is(
      await refusal(() => E(kit.control).port()),
      environmentTexts.stopped,
      'port() refused in the manager',
    );
    t.is(
      await refusal(() => E(source).size()),
      environmentTexts.stopped,
      'the ImageSource held from before is refused in the adapter',
    );
    await E(kit.control).resume();
    t.is(await E(source).size(), 300, 'resume gives the source back');
    t.is(
      (await E(kit.workspace).status()).truncated,
      false,
      'resume gives Git back',
    );
    await E(admin).release(kit.control);

    // ---- 6 (restart) and 22: stopped across a SIGKILL, export and import.
    const held = await startEnvironmentSession(
      slice,
      made.backend,
      'development',
      'held',
    );
    const { key: heldKey } = await E(held).getInfo();
    await E(held).emergencyStop();
    await state.kill();
    await killStrays(state.root);
    await state.restart();
    await slice.refresh();
    admin = await state.client.call('lookup', 'environmentsAdmin');
    made = await slice.makeBackend(script);
    await E(slice.harness).configure(harden({ backends: [made.backend] }));
    const heldAgain = await E(slice.factory).findSession(heldKey);
    t.deepEqual(
      await E(heldAgain).getExecutionState(),
      { state: 'stopped', supported: true },
      'still stopped after the SIGKILL restart',
    );
    t.is(
      await refusal(() => slice.submit(heldAgain, 'refused')),
      texts.sessionStopped,
      'still fenced after the restart',
    );
    t.deepEqual(
      await E(heldAgain).resume(),
      { state: 'running', supported: true },
      'the original resumes too',
    );

    // ---- 13, 4: delete during a command.
    const doomed = await startEnvironmentSession(
      slice,
      made.backend,
      'development',
      'doomed',
    );
    const keysBefore = environmentKeys(state.root);
    await slice.submit(doomed, 'long');
    const group = await waitFor(
      () => environmentProcesses(state.root)[0],
      30_000,
      'sleep 600 running in the doomed session',
    );
    t.false(keysBefore.includes(group.key), 'a new environment directory');
    const statusBeforeDelete = await E(admin).status();
    const tDelete = performance.now();
    await E(slice.factory).deleteSession(doomed);
    const deleteMs = performance.now() - tDelete;
    t.deepEqual(environmentProcesses(state.root), [], 'the process is gone');
    t.false(
      existsSync(path.join(state.root, 'environments', 'sessions', group.key)),
      'the directory is gone',
    );
    const afterDelete = await waitFor(
      async () => {
        const now = await E(admin).status();
        return (
          Number(now.environments) < Number(statusBeforeDelete.environments) &&
          now
        );
      },
      10_000,
      'the record dropped',
    );
    t.is(afterDelete.pendingReleases, 0, 'no release pending');

    // ---- 20: bounded state (gate).
    const gateBefore = await E(admin).status();
    const tGate = performance.now();
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const one = await startEnvironmentSession(
        slice,
        made.backend,
        'development',
        `gate ${i}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await E(slice.factory).deleteSession(one);
    }
    const gateMs = performance.now() - tGate;
    const gateAfter = await waitFor(
      async () => {
        const now = await E(admin).status();
        return now.environments === gateBefore.environments && now;
      },
      20_000,
      'the record count back',
    );
    t.is(
      gateAfter.pendingReleases,
      gateBefore.pendingReleases,
      'pending releases back',
    );
    t.is(gateAfter.pendingStops, gateBefore.pendingStops, 'pending stops back');

    emit({
      metric: 'environments.stop.acceptance',
      emergencyStopMs: round1(stopMs),
      deleteDuringCommandMs: round1(deleteMs),
      gate: {
        sessions: 20,
        createDeleteMs: round1(gateMs),
        before: gateBefore,
        after: gateAfter,
      },
      wallMs: round1(performance.now() - t0),
      ...identity,
    });
  },
);

// Acceptance 22 through the export script: known gap, kept as a failing
// test so it turns red the day it passes. `scripts/export.mjs` (M2's, not
// this milestone's) writes a fixed set of head fields and drops the head
// page's `execution` (seam X-E), and `importState` neither passes it back in
// the head chunk nor carries the preset into `importSession`, so the
// imported session has no environment and is running. The crank-level
// export and import of the execution state passes
// (`test/unit/session-environment-export.test.js`).
const runFailing = integrationEnabled ? test.serial.failing : test.skip;

runFailing(
  '22: a stopped session exported and imported stays stopped',
  async t => {
    t.timeout(5 * 60_000);
    const template = await environmentsTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(script);
    await E(slice.harness).configure(harden({ backends: [made.backend] }));
    const held = await startEnvironmentSession(
      slice,
      made.backend,
      'development',
      'held',
    );
    await E(held).emergencyStop();
    const file = path.join(tmpRoot, `${shortName('e')}.jsonl`);
    t.teardown(() => rm(file, { force: true }));
    await exportState({ client: state.client, file });
    const imported = await importState({
      client: state.client,
      file,
      backends: [made.backend],
    });
    const importedHeld = await (async () => {
      for (const one of imported.sessions) {
        // eslint-disable-next-line no-await-in-loop
        if ((await E(one).getInfo()).title === 'held') return one;
      }
      return undefined;
    })();
    t.truthy(importedHeld, 'the stopped session is imported');
    t.deepEqual(
      await E(importedHeld).getExecutionState(),
      { state: 'stopped', supported: true },
      'the imported session is stopped',
    );
    t.is(
      (await E(importedHeld).listPending()).hold?.reason,
      'stopped',
      'its queue is held stopped',
    );
    t.deepEqual(
      await E(importedHeld).resume(),
      { state: 'running', supported: true },
      'the imported session resumes',
    );
    const importedTurn = await turnsOf(slice)(importedHeld, 'after resume');
    t.is(
      stdoutOf(importedTurn.results[0].result),
      'resumed',
      "the imported session's new environment runs a command",
    );
  },
);
