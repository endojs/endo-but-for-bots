// @ts-check
/* eslint-disable no-await-in-loop -- windows run their operations in order */
/**
 * M3 perf rows on the imported 300-turn session (designs/m3-interfaces.md
 * 13; W3.8), through the gateway on the cached `m3-300` template
 * (`perf/_m3-client.mjs` `ensureM3Template`; build it first with
 * `node perf/_m3-client.mjs template` so its import is not timed here).
 * Each row is one fixed window; a window that would end after 9 min 30 s
 * is reported `not measured: file time`.
 *
 * - `ui.snapshot`: `E(session).watch()`; budget median 300 ms; the answer's
 *   JSON size is recorded against `frameBytes`.
 * - `ui.history.newest`: `E(session).getHistoryPage()` (the vat's page);
 *   budget median 300 ms.
 * - `ui.history.archived`: `E(history).page(session, cursor)` of the first
 *   archived page (`History`, adapter-local); budget median 300 ms.
 * - `ui.reconnect`: socket open to rebuilt state, as the controller does
 *   it: `fetch`, `getFactory`, `listSessions` (every page),
 *   `subscribeList(rev)`, `watch`, `subscribe(session, rev)`,
 *   `getCurrentTurn`, newest history page; budget median 1 s.
 * - `ui.restartReady.clean`, `ui.restartReady.sigkill`: from the
 *   supervisor serving to the gateway answering a `fetch`, restarts
 *   repeated over a 150 s window per mode; budget median 2 s.
 *
 * Run (exclusive under the run lock):
 *
 *   node scripts/run-lock.mjs --exclusive --label m3-session -- node perf/gateway-session.perf.mjs
 */
import { emit, runPerf, stats } from './_harness.mjs';

const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { performance } = await import('node:perf_hooks');
const { setTimeout: delay } = await import('node:timers/promises');
const {
  FEW_SAMPLES,
  WINDOW_MS,
  ensureM3Template,
  m3TemplateSession,
  makeFileClock,
  measureWindow,
} = await import('./_m3-client.mjs');
const { startFromTemplate } = await import('../test/template/index.js');
const { connectGateway, freePort, serveGateway, useTestWrappingKey } =
  await import('../test/integration/_m3-gateway.js');
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
const { limits } = await import('../guest/lib/limits.js');

/** Restart window per mode (m3-interfaces.md 13). */
const RESTART_WINDOW_MS = Number(process.env.M3_RESTART_WINDOW_MS ?? 150_000);

/** @param {string} metric @param {string} why */
const notMeasured = (metric, why) =>
  emit({ metric, notMeasured: why, pass: null });

/** @param {number[]} samples @param {number} [windowMs] */
const sampleFlags = (samples, windowMs = WINDOW_MS) => ({
  windowMs,
  ...(samples.length < FEW_SAMPLES ? { fewSamples: true } : {}),
});

/** JSON size of an answer, presences as short placeholders. @param {unknown} value */
const answerChars = value =>
  JSON.stringify(value, (_key, v) =>
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) !== Object.prototype
      ? '@slot'
      : typeof v === 'bigint'
        ? String(v)
        : v,
  ).length;

await runPerf('gateway-session', async ({ root }) => {
  const clock = makeFileClock();
  const key = useTestWrappingKey('pfgs');
  /** @type {Awaited<ReturnType<typeof startFromTemplate>> | undefined} */
  let state;
  try {
    const template = await ensureM3Template();
    emit({ metric: 'gateway-session.template', built: template.built });
    state = await startFromTemplate(template, {
      root,
      idleSleepMs: 3_600_000,
    });
    const gateway = await serveGateway(state, { port: await freePort() });
    const page = await gateway.connect();
    const factory = await E(page.powers.operator).getFactory();
    const row = await m3TemplateSession(factory);
    const session = row.session;
    const history = page.powers.history;

    // ---- ui.snapshot
    if (clock.fits(WINDOW_MS)) {
      const { samples, results } = await measureWindow(WINDOW_MS, () =>
        E(session).watch(),
      );
      const chars = answerChars(results[results.length - 1]);
      await stats('ui.snapshot', samples, {
        budget: { median: 300 },
        extra: {
          ...sampleFlags(samples),
          answerChars: chars,
          frameBytes: limits.frameBytes,
          withinFrame: chars <= limits.frameBytes,
        },
      });
    } else notMeasured('ui.snapshot', 'file time');

    // ---- ui.history.newest
    if (clock.fits(WINDOW_MS)) {
      const { samples, results } = await measureWindow(WINDOW_MS, () =>
        E(session).getHistoryPage(),
      );
      const last = /** @type {any} */ (results[results.length - 1]);
      await stats('ui.history.newest', samples, {
        budget: { median: 300 },
        extra: {
          ...sampleFlags(samples),
          turns: last.turns.length,
          answerChars: answerChars(last),
          archive: last.archive,
        },
      });
    } else notMeasured('ui.history.newest', 'file time');

    // ---- ui.history.archived
    if (clock.fits(WINDOW_MS + 10_000)) {
      let p = await E(session).getHistoryPage();
      while (!p.archived && p.next !== undefined) {
        p = await E(session).getHistoryPage(p.next);
      }
      const cursor = p.archived ? p.next : undefined;
      if (cursor === undefined) {
        notMeasured('ui.history.archived', 'no archived page');
      } else {
        const { samples, results } = await measureWindow(WINDOW_MS, () =>
          E(history).page(session, cursor),
        );
        const last = /** @type {any} */ (results[results.length - 1]);
        await stats('ui.history.archived', samples, {
          budget: { median: 300 },
          extra: {
            ...sampleFlags(samples),
            turns: last.turns.length,
            answerChars: answerChars(last),
          },
        });
      }
    } else notMeasured('ui.history.archived', 'file time');

    // ---- ui.reconnect
    if (clock.fits(WINDOW_MS)) {
      const { samples } = await measureWindow(WINDOW_MS, async () => {
        const client = await connectGateway({
          port: gateway.port,
          origin: gateway.origin,
          secret: gateway.secret,
        });
        const powers = await client.signIn();
        const f = await E(powers.operator).getFactory();
        /** @type {any[]} */
        const rows = [];
        let listRev = 0;
        /** @type {any} */
        let after;
        for (;;) {
          const listed = await E(f).listSessions(
            harden(after === undefined ? { limit: 50 } : { after, limit: 50 }),
          );
          rows.push(...listed.rows);
          listRev = listed.rev;
          if (listed.next === undefined) break;
          after = listed.next;
        }
        await E(powers.live).subscribeList(listRev);
        const active = rows.find(r => r.title === row.title)?.session;
        const snapshot = await E(active).watch();
        await Promise.all([
          E(powers.live).subscribe(active, snapshot.rev),
          E(active).getCurrentTurn(),
          E(active).getHistoryPage(),
        ]);
        client.close();
        await client.closed;
      });
      await stats('ui.reconnect', samples, {
        budget: { median: 1000 },
        extra: {
          ...sampleFlags(samples),
          steps:
            'open, fetch, getFactory, listSessions*, subscribeList, watch, then subscribe + getCurrentTurn + newest page together',
        },
      });
    } else notMeasured('ui.reconnect', 'file time');
    page.close();

    // ---- ui.restartReady (clean, sigkill)
    for (const mode of ['clean', 'sigkill']) {
      const metric = `ui.restartReady.${mode}`;
      if (!clock.fits(RESTART_WINDOW_MS)) {
        notMeasured(metric, 'file time');
        // eslint-disable-next-line no-continue
        continue;
      }
      /** @type {number[]} */
      const samples = [];
      /** @type {number[]} */
      const served = [];
      const end = performance.now() + RESTART_WINDOW_MS;
      let lastMs = 0;
      // Stop early rather than let one more restart pass the file's time.
      while (performance.now() < end && clock.fits(lastMs)) {
        const iterationStart = performance.now();
        const live = /** @type {NonNullable<typeof state>} */ (state);
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
        served.push(Math.round(restarted.servedMs));
        lastMs = performance.now() - iterationStart;
      }
      await stats(metric, samples, {
        budget: { median: 2000 },
        extra: {
          ...sampleFlags(samples, RESTART_WINDOW_MS),
          servedMs: served,
          note: 'serving = the supervisor serve() resolving; ready = the first fetch answered',
        },
      });
    }
    emit({
      metric: 'gateway-session.fileTime',
      unit: 'ms',
      value: Math.round(clock.elapsed()),
    });
  } finally {
    await state?.cleanup();
    key.remove();
  }
});
