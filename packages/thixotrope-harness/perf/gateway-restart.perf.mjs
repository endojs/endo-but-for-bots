// @ts-check
/* eslint-disable no-await-in-loop -- restarts run one after another */
/**
 * M3 restart rows on the imported 300-turn session (designs/m3-interfaces.md
 * 13; W3.8), split from `perf/gateway-session.perf.mjs` (K2): with them that
 * file measured every row by 555 s and then its clean stop after the SIGKILL
 * series passed the 10-minute box (exit 124, X-CLOSE J-10061). Same cached
 * `m3-300` template (`node perf/_m3-client.mjs template` first).
 *
 * - `ui.restartReady.clean`, `ui.restartReady.sigkill`: from the
 *   supervisor serving to the gateway answering a `fetch`, restarts
 *   repeated over a 150 s window per mode; budget median 2 s.
 *
 * Each row also reports, per restart, the supervisor's serve time and the
 * journal frames owed a replay at that start (the workers' delivery
 * frontier less their snapshot cut, read just before the stop or kill): the
 * daemon wakes every worker that owes a delivery and replays its suffix
 * before `serve()` resolves, so the serve time follows that sum. Restarts
 * stop once a window would end after `WINDOWS_END_MS` (6 min from the file's
 * start), which leaves the teardown (a clean stop of the supervisor, the
 * stray-process sweep, removing the copy; timed and reported as
 * `gateway-restart.teardown`) two minutes inside the 8-minute target and
 * four inside the box.
 *
 * Run (exclusive under the run lock):
 *
 *   node scripts/run-lock.mjs --exclusive --label perf-gateway-restart -- node perf/gateway-restart.perf.mjs
 */
import { du, emit, runPerf, stats } from './_harness.mjs';
import { windowMs } from './_window.mjs';

const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { performance } = await import('node:perf_hooks');
const { setTimeout: delay } = await import('node:timers/promises');
const { FEW_SAMPLES, ensureM3Template } = await import('./_m3-client.mjs');
const { startFromTemplate } = await import('../test/template/index.js');
const { connectGateway, freePort, serveGateway, useTestWrappingKey } =
  await import('../test/integration/_m3-gateway.js');

/** Restart window per mode (m3-interfaces.md 13). */
const RESTART_WINDOW_MS = windowMs('M3_RESTART_WINDOW_MS', 150_000);
/** No restart starts whose window would end after this, from the file's start. */
const WINDOWS_END_MS = windowMs('M3_RESTART_END_MS', 360_000, {
  scaled: false,
});

/** @param {string} metric @param {string} why */
const notMeasured = (metric, why) =>
  emit({ metric, notMeasured: why, pass: null });

/**
 * Journal frames each worker owes a replay (frontier less snapshot cut),
 * summed, and the largest by label.
 * @param {any} client
 */
const owedReplay = async client => {
  const { workers } = await client.call('status');
  let total = 0;
  let largest = { label: '', frames: 0 };
  /** @type {Record<string, number>} */
  const byWorker = {};
  for (const w of workers) {
    const owed = Math.max(
      0,
      Number(w.journalLength ?? 0) - Number(w.snapshot?.cut ?? 0),
    );
    total += owed;
    if (owed > 0) byWorker[String(w.debugLabel ?? w.workerId)] = owed;
    if (owed > largest.frames)
      largest = { label: String(w.debugLabel ?? w.workerId), frames: owed };
  }
  return { total, largest, byWorker };
};

await runPerf('gateway-restart', async ({ root }) => {
  const t0 = performance.now();
  const elapsed = () => performance.now() - t0;
  const key = useTestWrappingKey('pfgr');
  /** @type {Awaited<ReturnType<typeof startFromTemplate>> | undefined} */
  let state;
  try {
    const template = await ensureM3Template();
    emit({ metric: 'gateway-restart.template', built: template.built });
    state = await startFromTemplate(template, {
      root,
      idleSleepMs: 3_600_000,
      secretsKeyFile: key.file,
    });
    const gateway = await serveGateway(state, {
      port: await freePort(),
      secretsKeyFile: key.file,
    });
    // One sign-in before the series, as gateway-session's rows did first.
    const first = await connectGateway({
      port: gateway.port,
      origin: gateway.origin,
      secret: gateway.secret,
    });
    await first.signIn();
    first.close();

    for (const mode of ['clean', 'sigkill']) {
      const metric = `ui.restartReady.${mode}`;
      if (elapsed() + RESTART_WINDOW_MS > WINDOWS_END_MS) {
        notMeasured(metric, 'file time');
        // eslint-disable-next-line no-continue
        continue;
      }
      /** @type {number[]} */
      const samples = [];
      /** @type {number[]} */
      const served = [];
      /** @type {number[]} */
      const owed = [];
      /** @type {string[]} */
      const largest = [];
      /** Owed frames by worker before the first and the last restart. */
      /** @type {Record<string, number>[]} */
      const byWorker = [];
      /** Ready time from the start of the supervisor's serve. */
      /** @type {number[]} */
      const fromStart = [];
      const end = performance.now() + RESTART_WINDOW_MS;
      let lastMs = 0;
      // Stop early rather than let one more restart pass the file's time.
      while (performance.now() < end && elapsed() + lastMs <= WINDOWS_END_MS) {
        const iterationStart = performance.now();
        const live = /** @type {NonNullable<typeof state>} */ (state);
        const replay = await owedReplay(live.client);
        owed.push(replay.total);
        largest.push(`${replay.largest.label}:${replay.largest.frames}`);
        if (byWorker.length === 0) byWorker.push(replay.byWorker);
        else byWorker[1] = replay.byWorker;
        if (mode === 'clean') await live.stop();
        else await live.kill();
        let readyAt = 0;
        let polling = true;
        const poll = (async () => {
          while (polling) {
            try {
              const client = await connectGateway({
                port: gateway.port,
                origin: gateway.origin,
                secret: gateway.secret,
              });
              await client.signIn();
              readyAt = performance.now();
              client.close();
              return;
            } catch {
              await delay(25);
            }
          }
        })();
        const restarted = await live.restart();
        const resolvedAt = performance.now();
        const servedAt =
          resolvedAt - restarted.connectedMs + restarted.servedMs;
        const deadline = performance.now() + 60_000;
        while (!readyAt && performance.now() < deadline) await delay(25);
        polling = false;
        await poll;
        if (!readyAt) throw Error(`${metric}: no fetch within 60 s of serving`);
        samples.push(readyAt - servedAt);
        fromStart.push(
          Math.round(readyAt - (resolvedAt - restarted.connectedMs)),
        );
        served.push(Math.round(restarted.servedMs));
        lastMs = performance.now() - iterationStart;
      }
      await stats(metric, samples, {
        budget: { median: 2000 },
        extra: {
          windowMs: RESTART_WINDOW_MS,
          ...(samples.length < FEW_SAMPLES ? { fewSamples: true } : {}),
          servedMs: served,
          owedReplayFrames: owed,
          largestOwed: largest,
          owedByWorkerFirst: byWorker[0] ?? null,
          owedByWorkerLast: byWorker[1] ?? null,
          readyFromServeStartMs: fromStart,
          note: 'serving = the supervisor serve() resolving; ready = the first fetch answered (negative: the gateway answered before serve() resolved); owedReplayFrames = journal frames past the snapshot cut summed over workers, read before each stop or kill',
        },
      });
    }
    emit({
      metric: 'gateway-restart.windowsTime',
      unit: 'ms',
      value: Math.round(elapsed()),
    });
  } finally {
    if (state) {
      const final = await owedReplay(state.client).catch(() => undefined);
      const kb = (() => {
        try {
          return du(state.root);
        } catch {
          return undefined;
        }
      })();
      const s0 = performance.now();
      await state.stop().catch(() => undefined);
      const stopMs = Math.round(performance.now() - s0);
      const c0 = performance.now();
      await state.cleanup();
      emit({
        metric: 'gateway-restart.teardown',
        unit: 'ms',
        stopMs,
        cleanupMs: Math.round(performance.now() - c0),
        owedReplayFrames: final?.total,
        stateKb: kb,
      });
    }
    key.remove();
    emit({
      metric: 'gateway-restart.fileTime',
      unit: 'ms',
      value: Math.round(elapsed()),
    });
  }
});
