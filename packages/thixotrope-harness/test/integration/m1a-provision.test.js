// @ts-check
/**
 * Integration test of the factory and provisioning (M1a W1a.6) in a real
 * Ironhorse supervisor, with the factory's stand-in session program
 * (guest/factory/standin-session.js) until W1a.7 switches to
 * guest/session/main.js.
 *
 * - provisioning a fresh state directory (the state template build) runs
 *   every step; re-running it on the served state is a no-op;
 * - createSession returns a Session listed `ready` and `passive`; the R4-6
 *   `model` option is refused; a rename reaches the row through the
 *   session's RowReporter;
 * - a session vat that halts while its row says `working` is listed `lost`
 *   after a restart (start listener, D-17); the factory and another session
 *   still answer;
 * - measurements: provisioning steps (install.factory), session.createCold
 *   with the stand-in and with the stand-in padded to about 195 KB, the
 *   bundle sizes, the restart.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1a-provision -- \
 *     corepack yarn test test/integration/m1a-provision.test.js
 *
 * M1A_REBUILD=1 rebuilds the template (to measure a cold provision); the
 * template id follows the provisioned code, so a code change rebuilds it
 * anyway. PERF_OUT appends the JSON lines to a file.
 */
import '../unit/_m1a-prelude.js';

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import {
  STANDIN_HALT,
  STANDIN_WORKING,
} from '../../guest/factory/standin-session.js';
/* eslint-enable import/no-relative-packages */
import { emit, single, stats } from '../../perf/_harness.mjs';
import { bundleGuest } from '../../scripts/bundle-guest.mjs';
import {
  factoryEntry,
  guestRoot,
  loadSessionProgram,
  m1aTemplateOptions,
  makeProvision,
  names,
  sessionProgramBytes,
  standinSessionEntry,
} from '../../scripts/provision-steps.js';
import {
  ensureTemplate,
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';

takeIntegrationLock(test, 'm1a provision test');

const run = integrationEnabled ? test.serial : test.skip;

const CREATE_N = Number(process.env.M1A_CREATE_N ?? 3);
/** About the session program budget, for a cold create at full size. */
const PADDED_BYTES = 195_000;

/** @param {number} ms */
const round1 = ms => +ms.toFixed(1);

/**
 * @template T
 * @param {() => Promise<T>} fn
 */
const time = async fn => {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: round1(performance.now() - t0) };
};

/**
 * @param {() => Promise<boolean>} predicate
 * @param {number} ms
 */
const waitUntil = async (predicate, ms) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return round1(performance.now() - t0);
    // eslint-disable-next-line no-await-in-loop
    await delay(250);
  }
  return null;
};

run('provision, create, list, lost after restart', async t => {
  t.timeout(5 * 60_000);
  /** @type {any[]} */
  const buildReports = [];
  const options = await m1aTemplateOptions({
    sessionEntry: standinSessionEntry,
    prefix: 'm1as',
    onStep: report => buildReports.push(report),
  });
  const template = await ensureTemplate({
    ...options,
    rebuild: process.env.M1A_REBUILD === '1',
  });
  const factoryBundle = await bundleGuest(factoryEntry, { guestRoot });
  const standin = await bundleGuest(standinSessionEntry, { guestRoot });
  emit({
    metric: 'm1a.provision.bundles',
    unit: 'bytes',
    factoryBytes: factoryBundle.bytes,
    factoryModules: factoryBundle.modules.length,
    standinBytes: standin.bytes,
    sessionProgramBudget: sessionProgramBytes,
  });
  t.true(factoryBundle.bytes <= 300_000, `${factoryBundle.bytes}`);
  t.true(standin.bytes <= sessionProgramBytes, `${standin.bytes}`);

  // 1. Provisioning a fresh state directory (when this run built the template).
  if (template.built) {
    t.deepEqual(
      buildReports.map(r => [r.name, r.skipped]),
      [
        ['install-native agentHost', false],
        ['inventory vats', false],
        ['install harness', false],
        ['load session program', false],
        // M1b W1b.5 appends these (the exec step runs once W1b.3's program exists).
        ['load exec program', buildReports[4]?.skipped],
        ['pool', false],
        // M5 W5.5 appends this (H-10), a no-op without options.m5Fixtures;
        // M3's gateway and M4's subscriptions steps go before it.
        ['m5 fixtures', true],
      ],
    );
    const byName = new Map(buildReports.map(r => [r.name, r]));
    await single('install.factory', byName.get('install harness')?.ms ?? NaN, {
      budget: { value: 15_000 },
      extra: { factoryBytes: factoryBundle.bytes },
    });
    emit({
      metric: 'm1a.provision.steps',
      unit: 'ms',
      steps: buildReports.map(r => ({ name: r.name, ms: r.ms })),
      buildMs: template.buildMs,
      buildSteps: template.buildSteps,
    });
  } else {
    t.log('template was cached: provisioning times not measured this run');
  }

  const state = await startFromTemplate(template, { t });
  emit({ metric: 'm1a.provision.templateStart', unit: 'ms', ...state.timings });
  const { client } = state;
  const harness = await client.call('lookup', names.harness);
  const admin = await client.call('lookup', names.agentHost);
  t.truthy(harness);
  t.truthy(admin);
  const status = await E(harness).status();
  t.is(status.program.digest, standin.digest);
  t.is(status.program.bytes, standin.bytes);
  t.is(status.sessions, 0);

  // 2. Re-running provisioning on the served state is a no-op.
  /** @returns {Promise<number>} */
  const workerCount = async () => (await client.call('status')).workers.length;
  const workersBefore = await workerCount();
  const again = await time(() =>
    makeProvision({ sessionEntry: standinSessionEntry })({ client }),
  );
  t.true(
    again.value.every(r => r.skipped),
    JSON.stringify(again.value),
  );
  t.is(await workerCount(), workersBefore);
  t.deepEqual(await E(harness).status(), status);
  emit({ metric: 'm1a.provision.rerun', unit: 'ms', value: again.ms });

  // 3. Create sessions cold, list them.
  const backend = await E(admin).makeBackend(
    harden({ kind: 'scripted', label: 'Scripted', script: { turns: [] } }),
  );
  const operator = await E(harness).getOperator();
  const factory = await E(operator).getFactory();
  const [chatOnly] = await E(factory).listPresets();
  /** @type {number[]} */
  const createMs = [];
  /** @type {any[]} */
  const sessions = [];
  for (let i = 0; i < CREATE_N; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const made = await time(() =>
      E(factory).createSession(
        harden({ title: `t${i}`, preset: chatOnly, backend }),
      ),
    );
    createMs.push(made.ms);
    sessions.push(made.value);
  }
  await stats('session.createCold', createMs, {
    budget: { median: 6000 },
    extra: { program: 'stand-in', programBytes: standin.bytes },
  });
  let page = await E(factory).listSessions();
  t.is(page.rows.length, CREATE_N);
  t.deepEqual(
    page.rows.map(r => [r.key, r.title, r.state, r.activity, r.backendTitle]),
    sessions.map((_, i) => [
      `s${i + 1}`,
      `t${i}`,
      'ready',
      'passive',
      'Scripted',
    ]),
  );
  t.is(page.rows[0].session, sessions[0]);
  t.is(await E(factory).findSession('s1'), sessions[0]);
  const info = await E(sessions[0]).getInfo();
  t.is(info.presetLabel, 'chat-only');
  t.is(info.modelId, 'scripted');
  await t.throwsAsync(
    () => E(factory).createSession(harden({ model: 'x', backend })),
    { message: texts.modelOption },
  );
  await t.throwsAsync(() => E(factory).findSession('s999'), {
    message: texts.unknownSession,
  });
  t.is(await workerCount(), workersBefore + CREATE_N);

  // RowReporter: a rename reaches the row (sendOnly, so poll).
  await E(sessions[0]).rename('renamed');
  const renamedMs = await waitUntil(
    async () => (await E(factory).listSessions()).rows[0].title === 'renamed',
    10_000,
  );
  t.not(renamedMs, null, 'the row shows the new title');

  // 4. A cold create with a program of about the session budget.
  const padded = `${standin.source}\n/* ${'p'.repeat(PADDED_BYTES - standin.bytes - 8)} */\n`;
  const paddedDigest = createHash('sha256')
    .update(padded, 'utf8')
    .digest('hex');
  const loaded = await time(() =>
    loadSessionProgram(harness, { source: padded, digest: paddedDigest }),
  );
  emit({
    metric: 'm1a.provision.loadProgram',
    unit: 'ms',
    value: loaded.ms,
    bytes: loaded.value.bytes,
    pieces: loaded.value.pieces,
  });
  /** @type {number[]} */
  const paddedMs = [];
  for (let i = 0; i < CREATE_N; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const made = await time(() =>
      E(factory).createSession(harden({ title: `p${i}`, backend })),
    );
    paddedMs.push(made.ms);
    sessions.push(made.value);
  }
  await stats('session.createCold', paddedMs, {
    budget: { median: 6000 },
    extra: { program: 'stand-in padded', programBytes: loaded.value.bytes },
  });

  // 5. A session that halts while working is listed lost after a restart.
  const doomed = sessions[1];
  await E(doomed).rename(STANDIN_WORKING);
  t.not(
    await waitUntil(
      async () =>
        (await E(factory).listSessions()).rows[1].activity === 'working',
      10_000,
    ),
    null,
  );
  const halted = await time(() =>
    E(doomed)
      .rename(STANDIN_HALT)
      .then(
        () => 'answered',
        (/** @type {Error} */ e) => e.message,
      ),
  );
  t.regex(halted.value, /the target session has been retired/);
  emit({ metric: 'm1a.provision.haltBreak', unit: 'ms', value: halted.ms });
  const restarted = await state.restart();
  emit({ metric: 'm1a.provision.restart', unit: 'ms', ...restarted });
  const harness2 = await state.client.call('lookup', names.harness);
  const factory2 = await E(await E(harness2).getOperator()).getFactory();
  const lostMs = await waitUntil(
    async () => (await E(factory2).listSessions()).rows[1].state === 'lost',
    60_000,
  );
  t.not(lostMs, null, 'the halted session is listed lost');
  emit({ metric: 'm1a.provision.lostAfterServing', unit: 'ms', value: lostMs });
  page = await E(factory2).listSessions();
  t.is(page.rows.length, 2 * CREATE_N);
  t.deepEqual(
    page.rows.map(r => r.state),
    page.rows.map((_, i) => (i === 1 ? 'lost' : 'ready')),
  );
  // The factory and another session still answer; a call on the lost one breaks.
  t.is((await E(page.rows[0].session).getInfo()).title, 'renamed');
  await t.throwsAsync(() => E(page.rows[1].session).getInfo(), {
    message: /the target session has been retired/,
  });
  // Creation still works after the restart (the program is kept). The
  // first client's presences (backend included) died with its connection,
  // so the backend is made again through the new one.
  const admin2 = await state.client.call('lookup', names.agentHost);
  const backend2 = await E(admin2).makeBackend(
    harden({ kind: 'scripted', label: 'Scripted', script: { turns: [] } }),
  );
  const after = await time(() =>
    E(factory2).createSession(harden({ title: 'after', backend: backend2 })),
  );
  t.truthy(after.value);
  emit({
    metric: 'm1a.provision.createAfterRestart',
    unit: 'ms',
    value: after.ms,
  });
});
