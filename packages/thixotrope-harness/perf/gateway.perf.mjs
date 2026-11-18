// @ts-check
/* eslint-disable no-await-in-loop -- windows run their operations in order */
/**
 * M3 gateway perf rows (designs/m3-interfaces.md 13; W3.8). Each row is one
 * fixed window (60 s, `M3_WINDOW_MS`), never a count of runs; the file
 * stops opening windows that would end after 9 min 30 s and reports them
 * `not measured: file time`.
 *
 * - `gateway.fetch`: open a WebSocket, `fetch(secret)` (timed), close;
 *   sequential. Budget median 50 ms, 0 vat deliveries per sign-in.
 * - `gateway.guard`: the bridge's pre-dispatch check (`GW/guard.js`) of one
 *   call of `frameBytes` whose arguments are records of vocabulary keys,
 *   in this process. Budget median 2 ms per call.
 * - `ui.call`: `E(session).listPending()` from a signed-in client,
 *   sequential. Budget median 150 ms.
 * - `ui.submit`: `Composer.submit` while a turn runs (a stalled turn),
 *   receipt latency; each queued entry is cancelled after its sample.
 *   Budget median 150 ms.
 * - `ui.deltaFanout`: five clients subscribed to one session while a
 *   scripted round streams a chunk every 50 ms: from the provider's publish
 *   (its `delta` line, `Date.now()` in the adapter) to each client's
 *   arrival (`Date.now()` here, one machine). Budget median 5 ms; vat
 *   deliveries while deltas stream, per delta, budget 0.
 * - Answers (XA): `ui.call`, `ui.submit` and `ui.deltaFanout` also report
 *   the most questions a client held at once during the window
 *   (`answers.peak`: asked and not yet dropped, which bounds the gateway's
 *   answer table) against `answersPerConnection`; `answers.boundHit` true
 *   would mean the bridge forgot settled answers during a well-behaved
 *   window.
 * - `gateway.probes`: one each of a 100 KiB argument, 2,000 fresh keys,
 *   depth 33, 33 calls in flight and 4,097 exports: each refused with its
 *   text (the exports probe closes the connection with `tooManyObjects`),
 *   no halt, and no worker's journal grows for the refused calls.
 *
 * Run (exclusive under the run lock):
 *
 *   node scripts/run-lock.mjs --exclusive --label m3-gateway -- node perf/gateway.perf.mjs
 */
import { emit, runPerf, stats } from './_harness.mjs';

const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { performance } = await import('node:perf_hooks');
const { setTimeout: delay } = await import('node:timers/promises');
const { FEW_SAMPLES, WINDOW_MS, journalTotal, makeFileClock, measureWindow } =
  await import('./_m3-client.mjs');
const { makeSlice, requestId, sliceTemplate, waitFor } =
  await import('../test/integration/_m1a-slice.js');
const { collect } = await import('../test/integration/_m1a-slice.js');
const { connectGateway, serveGateway, useTestWrappingKey } =
  await import('../test/integration/_m3-gateway.js');
const { inspectCall, defaultGuardLimits } =
  await import('../resources/agent-host/impl/gateway/guard.js');
const { harnessNames } =
  await import('../resources/agent-host/impl/gateway/vocabulary.js');
const { closeCodes, gatewayLimits, gatewayTexts } =
  await import('../resources/agent-host/impl/gateway/contract-m3.js');

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** Chunks of one fan-out round (100 x 50 ms = 5 s). */
const FAN_CHUNKS = 100;
const FAN_CLIENTS = 5;

const gatewayScript = harden({
  turns: [
    {
      input: 'stall',
      rounds: [{ chunks: [{ text: 'stalling' }], stall: 'untilCancel' }],
    },
    {
      input: 'fan',
      rounds: [
        {
          chunks: Array.from({ length: FAN_CHUNKS }, (_, i) => ({
            text: `d${i} `,
          })),
          chunkDelayMs: 50,
          usage,
        },
      ],
    },
    { rounds: [{ chunks: [{ text: 'ok' }], usage }] },
  ],
});

/** @param {string} metric @param {string} why */
const notMeasured = (metric, why) =>
  emit({ metric, notMeasured: why, pass: null });

/**
 * The answers a window's clients held at most (see the header).
 * @param {{ answers: () => { held: number, peak: number } }[]} clients
 */
const answersOf = clients => {
  const peak = Math.max(...clients.map(c => c.answers().peak));
  return {
    answers: {
      peak,
      held: clients.map(c => c.answers().held),
      bound: gatewayLimits.answersPerConnection,
      boundHit: peak >= gatewayLimits.answersPerConnection,
    },
  };
};

/** @param {number[]} samples */
const sampleFlags = samples => ({
  windowMs: WINDOW_MS,
  ...(samples.length < FEW_SAMPLES ? { fewSamples: true } : {}),
});

await runPerf('gateway', async ({ provision }) => {
  const clock = makeFileClock();
  const key = useTestWrappingKey('pfgw');
  try {
    const template = await sliceTemplate();
    const run = await provision({ template });
    const slice = await makeSlice(run);
    const made = await slice.makeBackend(gatewayScript, { label: 'Gw' });
    await E(slice.harness).configure(harden({ backends: [made.backend] }));
    const gateway = await serveGateway(run);
    const page = await gateway.connect();
    const factory = await E(page.powers.operator).getFactory();
    const [preset] = await E(factory).listPresets();
    const [backend] = await E(factory).listBackends();
    const session = await E(factory).createSession(
      harden({ title: 'perf', preset, backend, at: Date.now() }),
    );

    // ---- gateway.fetch
    if (clock.fits(WINDOW_MS)) {
      const before = await run.counters();
      const { samples } = await measureWindow(WINDOW_MS, async () => {
        const client = await connectGateway({
          port: gateway.port,
          origin: gateway.origin,
          secret: gateway.secret,
        });
        const t = performance.now();
        await client.signIn();
        const ms = performance.now() - t;
        client.close();
        await client.closed;
        return ms;
      }).then(({ results }) => ({ samples: results }));
      const after = await run.counters();
      await stats('gateway.fetch', samples, {
        budget: { median: 50, deliveriesPerOp: 0 },
        before,
        after,
        extra: { ...sampleFlags(samples), timed: 'fetch only' },
      });
    } else notMeasured('gateway.fetch', 'file time');

    // ---- gateway.guard (in process)
    if (clock.fits(WINDOW_MS)) {
      const { keys: vocabulary, methods } = harnessNames({ log: () => {} });
      // Records of vocabulary keys up to frameBytes.
      const record = { title: 'a title', key: 's1', text: 'some text here' };
      /** @type {any[]} */
      const items = [];
      let body = '';
      for (;;) {
        const next = JSON.stringify(['rename', [[...items, record]]]);
        if (Buffer.byteLength(next) > defaultGuardLimits.frameBytes) break;
        items.push(record);
        body = next;
      }
      const message = {
        type: 'CTP_CALL',
        questionID: 'q-1',
        target: 'o-1',
        method: { body, slots: [] },
      };
      const held = { value: {}, local: false };
      const { samples } = await measureWindow(WINDOW_MS, async () => {
        const refusal = inspectCall({
          message,
          targetOf: () => held,
          vocabulary,
          methods,
          isLargeCall: () => false,
          inFlight: 0,
        });
        if (refusal) throw Error(`guard refused: ${refusal.text}`);
      });
      await stats('gateway.guard', samples, {
        budget: { median: 2 },
        extra: {
          ...sampleFlags(samples),
          bodyBytes: Buffer.byteLength(body),
          records: items.length,
          vocabularyKeys: vocabulary.size,
        },
      });
    } else notMeasured('gateway.guard', 'file time');

    // ---- ui.call
    if (clock.fits(WINDOW_MS)) {
      page.resetAnswersPeak();
      const before = await run.counters();
      const { samples } = await measureWindow(WINDOW_MS, () =>
        E(session).listPending(),
      );
      const after = await run.counters();
      await stats('ui.call', samples, {
        budget: { median: 150 },
        before,
        after,
        extra: {
          ...sampleFlags(samples),
          call: 'Session.listPending',
          ...answersOf([page]),
        },
      });
    } else notMeasured('ui.call', 'file time');

    // ---- ui.submit while a turn runs
    if (clock.fits(WINDOW_MS + 10_000)) {
      page.resetAnswersPeak();
      const stalled = await E(page.powers.composer).submit(
        session,
        'stall',
        requestId(),
      );
      /** @type {number[]} */
      const samples = [];
      const end = performance.now() + WINDOW_MS;
      for (let i = 0; performance.now() < end; i += 1) {
        const t = performance.now();
        const receipt = await E(page.powers.composer).submit(
          session,
          `queued ${i}`,
          requestId(),
        );
        samples.push(performance.now() - t);
        if (receipt.state !== 'queued')
          throw Error(`submit while a turn runs: ${receipt.state}`);
        await E(receipt.entry).cancel();
      }
      await E(stalled.turn).cancel();
      await E(stalled.turn).whenFinished();
      await stats('ui.submit', samples, {
        budget: { median: 150 },
        extra: {
          ...sampleFlags(samples),
          note: 'each entry cancelled after its sample',
          ...answersOf([page]),
        },
      });
    } else notMeasured('ui.submit', 'file time');

    // ---- ui.deltaFanout
    if (clock.fits(WINDOW_MS + 15_000)) {
      const clients = [page];
      for (let i = 1; i < FAN_CLIENTS; i += 1)
        clients.push(await gateway.connect());
      const feeds = [];
      for (const client of clients) {
        const own =
          client === page
            ? session
            : await E(await E(client.powers.operator).getFactory()).findSession(
                (await E(session).getInfo()).key,
              );
        const { rev } = await E(own).watch();
        feeds.push(collect(await E(client.powers.live).subscribe(own, rev)));
      }
      for (const client of clients) client.resetAnswersPeak();
      /** @type {number[]} */
      const latencies = [];
      let deltas = 0;
      let deliveriesWhileStreaming = 0;
      const end = performance.now() + WINDOW_MS;
      while (performance.now() < end) {
        const receipt = await E(page.powers.composer).submit(
          session,
          'fan',
          requestId(),
        );
        const { turnId } = await E(receipt.turn).getStatus();
        const isDelta = (/** @type {any} */ e) =>
          e.type === 'delta' && e.turnId === turnId;
        await feeds[0].until(isDelta, 30_000);
        const c0 = await run.counters();
        await Promise.all(
          feeds.map(feed =>
            waitFor(
              () => feed.events().filter(isDelta).length >= FAN_CHUNKS,
              60_000,
              'every delta',
              5,
            ),
          ),
        );
        const c1 = await run.counters();
        deliveriesWhileStreaming += c1.delivery.count - c0.delivery.count;
        await E(receipt.turn).whenFinished();
        const published = made
          .log()
          .filter(l => l.kind === 'delta' && l.turnId === turnId);
        for (const feed of feeds) {
          const arrived = feed.deliveries.filter(d => isDelta(d.event));
          arrived.forEach((d, k) => {
            if (published[k]) latencies.push(d.arrivedAt - published[k].at);
          });
        }
        deltas += published.length;
      }
      for (const feed of feeds) await feed.stop();
      const fanAnswers = answersOf(clients);
      for (const client of clients.slice(1)) client.close();
      await stats('ui.deltaFanout', latencies, {
        budget: { median: 5, deliveriesPerOp: 0 },
        extra: {
          ...sampleFlags(latencies),
          clients: FAN_CLIENTS,
          deltas,
          deliveries: {
            count: deliveriesWhileStreaming,
            perOp: deltas
              ? +(deliveriesWhileStreaming / deltas).toFixed(4)
              : null,
          },
          clock:
            'provider delta line (adapter Date.now) to client arrival (Date.now)',
          note: 'deliveries counted between the first delta and the last delta reaching every client (all vats)',
          ...fanAnswers,
        },
      });
    } else notMeasured('ui.deltaFanout', 'file time');

    // ---- probes
    if (clock.fits(60_000)) {
      /** @type {Record<string, unknown>} */
      const probes = {};
      /**
       * @param {string} name
       * @param {() => Promise<unknown>} call
       * @param {string} text
       */
      const probe = async (name, call, text) => {
        const j0 = await journalTotal(run.client);
        const t = performance.now();
        const error = await call().then(
          () => undefined,
          e => e,
        );
        const ms = performance.now() - t;
        const j1 = await journalTotal(run.client);
        const refused = String(error?.message ?? '').includes(text);
        probes[name] = { refused, ms: Math.round(ms), journalGrowth: j1 - j0 };
        return refused && j1 === j0;
      };
      const results = [
        await probe(
          'kib100',
          () => E(session).rename('x'.repeat(100 * 1024)),
          gatewayTexts.messageTooLarge,
        ),
        await probe(
          'keys2000',
          () =>
            E(session).rename(
              harden(
                Object.fromEntries(
                  Array.from({ length: 2000 }, (_, i) => [`k${i}`, 0]),
                ),
              ),
            ),
          gatewayTexts.unexpectedField,
        ),
        await probe(
          'depth33',
          () => {
            /** @type {any} */
            let nested = [];
            for (let i = 1; i < 33; i += 1) nested = [nested];
            return E(session).rename(harden(nested));
          },
          gatewayTexts.tooDeep,
        ),
      ];
      // 33 calls in flight: at least one refused, the rest answered.
      const flight = await Promise.allSettled(
        Array.from({ length: 33 }, () => E(session).listPending()),
      );
      const flightRefused = flight.filter(
        r =>
          r.status === 'rejected' &&
          String(r.reason?.message).includes(gatewayTexts.tooManyCalls),
      ).length;
      probes.inFlight33 = {
        refused: flightRefused,
        answered: flight.filter(r => r.status === 'fulfilled').length,
      };
      results.push(flightRefused >= 1);
      // 4,097 exports on one connection: list subscriptions, each closed
      // in the channel but its presence kept by the client.
      const hog = await gateway.connect();
      const t = performance.now();
      let made4097 = 0;
      /** Kept: a presence the client drops is released (CTP_DROP). */
      const kept = [];
      for (let i = 0; i < 4097; i += 1) {
        const sub = await E(hog.powers.live)
          .subscribeList()
          .catch(() => undefined);
        if (!sub) break;
        made4097 += 1;
        kept.push(sub);
        void E(sub)
          .close()
          .catch(() => {});
      }
      const closed = await Promise.race([
        hog.closed,
        delay(10_000).then(() => undefined),
      ]);
      probes.exports4097 = {
        made: made4097,
        closeCode: closed?.code,
        ms: Math.round(performance.now() - t),
      };
      results.push(closed?.code === closeCodes.tooManyObjects);
      // No halt: the session still answers.
      const still = await E(session)
        .listPending()
        .then(
          () => true,
          () => false,
        );
      probes.stillServing = still;
      results.push(still);
      emit({
        metric: 'gateway.probes',
        probes,
        pass: results.every(Boolean),
      });
    } else notMeasured('gateway.probes', 'file time');
    page.close();
    emit({
      metric: 'gateway.fileTime',
      unit: 'ms',
      value: Math.round(clock.elapsed()),
    });
  } finally {
    key.remove();
  }
});
