// @ts-check
/**
 * Environments restart gate (`designs/m6-interfaces.md` section 10,
 * `environments.restart`): a state with 20 sessions that have environments
 * (each ran one command; a cached template, `env-restart-20`, built from the
 * `environments` template's provisioning) is killed (SIGKILL) and served
 * again, 5 runs. Each run: restart to serving <= 15 s; no fake process
 * group started; no idle session vat woken (`wakes` of the worker rows since
 * the start, as `perf/_restart.mjs` counts them).
 *
 *   node scripts/run-lock.mjs --shared --label env-restart-perf -- node perf/environments-restart.perf.mjs --shared
 */
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
  single,
} from './_harness.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { makeProvision, templateIdFor, names } =
  await import('../scripts/provision-steps.js');
const { ensureTemplate, killStrays, startFromTemplate } =
  await import('../test/template/index.js');
const { untilAsleep } = await import('../test/integration/_m1a-slice.js');
const {
  commandCall,
  commandTurn,
  environmentProcesses,
  environmentsSettings,
  presetOfTemplate,
} = await import('../test/integration/_environments.js');

const SESSIONS = 20;
const RUNS = 5;

const script = harden({
  turns: [commandTurn('one command', [[commandCall('printf', ['x'])]])],
});

/** The 20-session template, built once per code change and cached. */
const restartTemplate = async () => {
  const run = makeProvision(
    /** @type {any} */ ({ pool: {}, environments: environmentsSettings }),
  );
  const template = await ensureTemplate({
    id: await templateIdFor({ pool: {}, prefix: 'env20' }),
    sources: [
      'resources/environments',
      'resources/native-attach.js',
      'guest/lib/guards/environments.js',
      'perf/environments-restart.perf.mjs',
    ],
    extra: { pool: {}, environments: environmentsSettings, SESSIONS },
    provision: async context => {
      await run(context);
      const { client } = context;
      const agentHost = await client.call('lookup', names.agentHost);
      const harness = await client.call('lookup', names.harness);
      const factory = await E(E(harness).getOperator()).getFactory();
      const composer = await E(agentHost).composer();
      // No log file: the template is served under other paths later.
      const backend = await E(agentHost).makeBackend(
        harden({ kind: 'scripted', label: 'Scripted', script }),
      );
      await E(harness).configure(harden({ backends: [backend] }));
      const preset = await presetOfTemplate(factory, 'development');
      for (let i = 0; i < SESSIONS; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const session = await E(factory).createSession(
          harden({ title: `env ${i}`, preset, backend, at: Date.now() }),
        );
        // eslint-disable-next-line no-await-in-loop
        await E(composer).submit(session, 'one command', `${Date.now()}-${i}`);
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          if ((await E(session).getCurrentTurn()) === undefined) {
            // eslint-disable-next-line no-await-in-loop
            const page = await E(session).getHistoryPage();
            if (page.turns.length > 0) break;
          }
          // eslint-disable-next-line no-await-in-loop
          await delay(100);
        }
      }
    },
  });
  if (template.built)
    emit({
      metric: 'environments.restart.template',
      buildMs: template.buildMs,
      sessions: SESSIONS,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  return template;
};

/** @param {any} w */
const isSession = w => /(^| )session( |$)/.test(String(w.debugLabel ?? ''));

await runPerf('environments-restart', async () => {
  const template = await restartTemplate();
  const state = await startFromTemplate(template);
  try {
    const workers = async () => (await state.client.call('status')).workers;
    const wrong = [];
    /** @type {number[]} */
    const served = [];
    for (let run = 0; run < RUNS; run += 1) {
      // eslint-disable-next-line no-await-in-loop
      await untilAsleep(workers, isSession);
      // eslint-disable-next-line no-await-in-loop
      await state.kill();
      // eslint-disable-next-line no-await-in-loop
      await killStrays(state.root);
      const t = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const { servedMs } = await state.restart();
      const toServing = performance.now() - t;
      // Give a wrongly eager bind the time to start something.
      // eslint-disable-next-line no-await-in-loop
      await delay(3000);
      const groups = environmentProcesses(state.root);
      // eslint-disable-next-line no-await-in-loop
      const rows = (await workers()).filter(isSession);
      const woken = rows
        .filter(w => Number(w.wakes ?? 0) > 0)
        .map(w => w.debugLabel);
      if (groups.length > 0) wrong.push(`run ${run}: ${groups.length} groups`);
      if (woken.length > 0) wrong.push(`run ${run}: woken ${woken.join(', ')}`);
      served.push(servedMs);
      // eslint-disable-next-line no-await-in-loop
      await single('environments.restart.run', servedMs, {
        budget: { value: 15_000 },
        extra: {
          run,
          toServingMs: Math.round(toServing),
          sessionVats: rows.length,
          groupsStarted: groups.length,
          wokenSessions: woken,
          wokenCounted: rows.some(w => w.wakes !== undefined),
        },
      });
    }
    await single('environments.restart', Math.max(...served), {
      budget: { value: 15_000 },
      extra: {
        gate: wrong.length === 0,
        runs: served.map(ms => Math.round(ms)),
        wrong,
        sessions: SESSIONS,
      },
    });
    if (wrong.length > 0)
      emit({ metric: 'environments.restart.gate', pass: false, wrong });
  } finally {
    await state.cleanup();
  }
});
