// @ts-check
/**
 * Provider perf (M2 W2.1a; milestones.md M2 perf checks; m2-interfaces.md
 * 8.1, 15):
 *
 * - `provider.overhead`: from the fake provider server handing an SSE event
 *   to its socket (its first byte) to the delta's arrival at an in-process
 *   subscriber of the session's channel (`E(subscription).next()`, as the
 *   gateway reads it), through Node fetch, the SSE parser, the OpenRouter
 *   provider, the shared round driver and the channel. Budget 5 ms per
 *   delta (median); 0 deliveries: the vat messages the round sends while it
 *   streams (TurnSink calls other than `dispatching` before and the final
 *   after) per delta. The provider runs in this process with a guarded fake
 *   TurnSink, as the adapter tests do: the daemon path (an `openrouter`
 *   backend made by the manager) needs `spec` and `readKey` passed to
 *   `makeProvider` (AH/index.js, W2.2's wiring, m2-interfaces.md 2.3), so
 *   no Ironhorse workload runs here.
 * - `provider.sse.parse`: `parseSse` alone over a 10 MiB OpenRouter-shaped
 *   stream in 64 KiB chunks (ms per run; MiB/s and events/s in the row).
 * - `provider.sse.stream`: the same 10 MiB stream end to end (fake server
 *   -> fetch -> parser -> provider -> round -> channel), one round, no
 *   subscriber; the reply is staged (10 MiB of text) as a real round would.
 *
 * Run under the run lock (perf/_harness.mjs): `node perf/provider.perf.mjs`.
 * Environment: PROVIDER_DELTAS (default 200), PROVIDER_DELTA_MS (default 5),
 * PROVIDER_RUNS (default 3).
 */
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Lockdown and the guest prelude before any module that needs them: static
// imports would be evaluated beside _init.mjs's top-level await.
await import('../scripts/_init.mjs');
await import('../test/unit/_m1a-prelude.js');
const { runPerf, stats } = await import('./_harness.mjs');
const { openRouterChunks, sseText, startFakeProviderServer } =
  await import('../test/fixtures/fake-provider-server.mjs');
const { makeTestBlobs } = await import('../test/adapter/_m1b-blobs.js');
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
const { interfaces } = await import('../guest/lib/interfaces.js');
const { makeEndpoint } =
  await import('../resources/agent-host/impl/endpoint.js');
const { makeTimers } = await import('../resources/agent-host/impl/timers.js');
const { makeChannelRegistry } =
  await import('../resources/agent-host/impl/channels.js');
const { makeOpenRouterProvider, openRouterAttempt } =
  await import('../resources/agent-host/impl/providers/openrouter.js');
const { parseSse } =
  await import('../resources/agent-host/impl/providers/sse.js');

const { E, Far, makeExo } = /** @type {any} */ (globalThis);

const DELTAS = Number(process.env.PROVIDER_DELTAS ?? 200);
const DELTA_MS = Number(process.env.PROVIDER_DELTA_MS ?? 5);
const RUNS = Number(process.env.PROVIDER_RUNS ?? 3);
const MIB = 1024 * 1024;
const timers = makeTimers();

const makeSink = () => {
  const calls = { dispatching: 0, progress: 0, roundFinal: 0, roundFailed: 0 };
  /** @type {() => void} */
  let settle = () => {};
  const settled = new Promise(resolve => {
    settle = () => resolve(undefined);
  });
  const turn = makeExo('Turn', interfaces.Turn, {
    getStatus: () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    cancel: () => undefined,
    whenFinished: async () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    resolve: () => undefined,
    getContent: () => harden({ records: [] }),
  });
  const sink = makeExo('TurnSink', interfaces.TurnSink, {
    dispatching: () => {
      calls.dispatching += 1;
      return true;
    },
    roundFinal: () => {
      calls.roundFinal += 1;
      settle();
    },
    roundFailed: () => {
      calls.roundFailed += 1;
      settle();
    },
    deadline: () => undefined,
    progress: () => {
      calls.progress += 1;
      return true;
    },
  });
  return { turn, sink, calls, settled };
};

/**
 * One round through the Endpoint against the fake server.
 * @param {object} options
 * @param {any} options.server
 * @param {any} options.blobs
 * @param {boolean} options.subscribe
 * @param {(text: string, at: number) => void} [options.onDelta]
 */
const oneRound = async ({ server, blobs, subscribe, onDelta }) => {
  const provider = makeOpenRouterProvider({
    label: 'perf',
    spec: { baseUrl: server.openRouterBaseUrl },
    readKey: async () => 'not a real key',
    timers,
    log: () => {},
    blobs: blobs.store,
  });
  const owner = Far('Session', {});
  const channel = makeChannelRegistry().channelFor(owner);
  let reading = Promise.resolve();
  let stop = false;
  if (subscribe) {
    const subscription = channel.subscribe();
    reading = (async () => {
      while (!stop) {
        const batch = await E(subscription).next();
        const at = performance.now();
        for (const delivery of batch.deliveries) {
          if (delivery.event.type === 'delta')
            onDelta?.(delivery.event.text, at);
        }
        if (batch.closed) return;
      }
    })();
  }
  const endpoint = makeEndpoint({
    provider,
    channel,
    timers,
    prepare: async () =>
      harden({
        transcript: [{ kind: 'message', role: 'user', content: 'hi' }],
      }),
    owner,
  });
  const fake = makeSink();
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(
    harden({
      turn: fake.turn,
      sink: fake.sink,
      turnId: 't1',
      round: 0,
      base: { count: 0, epoch: 0 },
      append: [{ kind: 'turn-started', turnId: 't1', input: 'hi', at: 1 }],
      tools: [],
      options: { modelId: 'fake-org/fake-model' },
    }),
  );
  await fake.settled;
  await timers.delay(20);
  stop = true;
  E.sendOnly(endpoint).releaseTurn(fake.turn);
  void reading.catch(() => {});
  return fake.calls;
};

await runPerf('provider', async ({ root }) => {
  mkdirSync(root, { recursive: true });
  const blobDir = path.join(root, 'blobs');
  mkdirSync(blobDir, { recursive: true });

  // ---- provider.overhead
  /** @type {Map<number, number>} event index -> write time */
  const written = new Map();
  const server = await startFakeProviderServer({
    trace: ({ event, at }) => written.set(event, at),
  });
  try {
    /** @type {number[]} */
    const samples = [];
    let streamingCalls = 0;
    for (let run = 0; run < RUNS; run += 1) {
      written.clear();
      const deltas = Array.from({ length: DELTAS }, (_, i) => `d${i} `);
      // Events: a comment, the role chunk, then one chunk per delta.
      server.setPlan([
        { events: openRouterChunks({ deltas }), delayMs: DELTA_MS },
      ]);
      /** @type {number[]} */
      const arrivals = [];
      const blobs = makeTestBlobs({ dir: path.join(blobDir, `o${run}`) });

      const calls = await oneRound({
        server,
        blobs,
        subscribe: true,
        onDelta: (_text, at) => arrivals.push(at),
      });
      // TurnSink messages while the round streamed: progress checkpoints.
      streamingCalls += calls.progress;
      arrivals.slice(0, DELTAS).forEach((at, i) => {
        const sent = written.get(i + 2);
        if (sent !== undefined) samples.push(at - sent);
      });
      if (arrivals.length !== DELTAS)
        throw Error(`expected ${DELTAS} deltas, saw ${arrivals.length}`);
    }
    const ops = samples.length;
    await stats('provider.overhead', samples, {
      budget: { median: 5, deliveriesPerOp: 0 },
      before: { delivery: { count: 0, milliseconds: 0 } },
      after: { delivery: { count: streamingCalls, milliseconds: 0 } },
      ops,
      extra: {
        deltasPerRun: DELTAS,
        deltaSpacingMs: DELTA_MS,
        runs: RUNS,
        path: 'fake server socket write -> fetch -> parseSse -> openrouter -> runProviderRound -> channel -> E(subscription).next()',
        deliveriesSource:
          'TurnSink messages sent while streaming (in-process provider; daemon wiring is W2.2/W2.9)',
      },
    });

    // ---- 10 MiB stream
    const piece = 'x'.repeat(64);
    // As many delta events as make 10 MiB on the wire.
    const one = sseText(openRouterChunks({ deltas: [piece] }).slice(2, 3));
    const count = Math.floor((10 * MIB) / one.length);
    const big = openRouterChunks({
      deltas: Array.from({ length: count }, () => piece),
    });
    const text = sseText(big);
    const bytes = new TextEncoder().encode(text);
    /** @type {Uint8Array[]} */
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 65_536)
      chunks.push(bytes.subarray(i, i + 65_536));
    /** @type {number[]} */
    const parseMs = [];
    let events = 0;
    for (let run = 0; run < RUNS; run += 1) {
      events = 0;
      const t0 = performance.now();

      for await (const event of parseSse(chunks)) {
        if (event.data !== '') events += 1;
      }
      parseMs.push(performance.now() - t0);
    }
    const medianParse = [...parseMs].sort((a, b) => a - b)[
      Math.floor(parseMs.length / 2)
    ];
    await stats('provider.sse.parse', parseMs, {
      extra: {
        bytes: bytes.length,
        events,
        mibPerSecond: +(bytes.length / MIB / (medianParse / 1000)).toFixed(1),
        eventsPerSecond: Math.round(events / (medianParse / 1000)),
        chunkBytes: 65_536,
      },
    });

    // The attempt alone (fetch, parser, chunk reading; no round driver).
    /** @type {number[]} */
    const attemptMs = [];
    /** @type {number[]} deltas yielded per run (one per network read) */
    const attemptDeltas = [];
    for (let run = 0; run < RUNS; run += 1) {
      server.setPlan([{ events: big }]);
      let seen = 0;
      let reads = 0;
      const t0 = performance.now();
      for await (const event of openRouterAttempt({
        url: `${server.openRouterBaseUrl}/chat/completions`,
        key: 'not a real key',
        body: { model: 'fake-org/fake-model', stream: true, messages: [] },
        signal: new AbortController().signal,
        timeoutMs: 600_000,
      })) {
        if ('delta' in event) {
          seen += event.delta.length;
          reads += 1;
        }
      }
      attemptMs.push(performance.now() - t0);
      if (seen !== count * piece.length)
        throw Error(`attempt saw ${seen} of ${count * piece.length} units`);
      attemptDeltas.push(reads);
    }
    const medianAttempt = [...attemptMs].sort((a, b) => a - b)[
      Math.floor(attemptMs.length / 2)
    ];
    await stats('provider.sse.attempt', attemptMs, {
      extra: {
        bytes: bytes.length,
        events: count,
        deltasYielded: attemptDeltas,
        mibPerSecond: +(bytes.length / MIB / (medianAttempt / 1000)).toFixed(1),
      },
    });

    /** @type {number[]} */
    const streamMs = [];
    for (let run = 0; run < RUNS; run += 1) {
      server.setPlan([{ events: big }]);
      const blobs = makeTestBlobs({ dir: path.join(blobDir, `s${run}`) });
      const t0 = performance.now();

      const calls = await oneRound({ server, blobs, subscribe: false });
      streamMs.push(performance.now() - t0 - 20);
      if (calls.roundFinal !== 1)
        throw Error('the 10 MiB round did not finish');
    }
    const medianStream = [...streamMs].sort((a, b) => a - b)[
      Math.floor(streamMs.length / 2)
    ];
    await stats('provider.sse.stream', streamMs, {
      extra: {
        bytes: bytes.length,
        deltas: count,
        replyBytes: count * piece.length,
        mibPerSecond: +(bytes.length / MIB / (medianStream / 1000)).toFixed(1),
      },
    });
  } finally {
    await server.close();
    rmSync(blobDir, { recursive: true, force: true });
  }
});
