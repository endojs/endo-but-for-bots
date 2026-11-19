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
 * - W2.1b: `provider.overhead.anthropic`, `provider.sse.attempt.anthropic`
 *   and `provider.sse.stream.anthropic`: the same through the Anthropic
 *   Messages provider; `provider.retry.passThrough`: the 10 MiB OpenRouter
 *   attempt with and without the retry wrapper in front (the cost of
 *   holding and passing events); `provider.retry.wait`: how far the second
 *   attempt after a 429 with `Retry-After: 1` lands from its scheduled
 *   wait (from the 429's arrival to the second request at the server).
 *
 * `provider.sse.parse` is measured first, before the fake server starts: a
 * 10 s window with no network between two network windows let the server's
 * keep-alive timeout close the pooled connection under the next fetch.
 *
 * Fixed windows (M2-P1, process.md section 3): each row repeats its run
 * (one round, one parse, one attempt) back to back for PROVIDER_WINDOW_MS
 * (default 10 s; nine rows, about 1.5 minutes) and reports `window`,
 * `windowMs`, `runs`, `runsPerSecond` and, from the samples, `n` (deltas for
 * the overhead rows, runs for the others), median and p99.
 *
 * Run under the run lock (perf/_harness.mjs): `node perf/provider.perf.mjs`.
 * Environment: PROVIDER_DELTAS (default 200), PROVIDER_DELTA_MS (default 5),
 * PROVIDER_WINDOW_MS (default 10,000).
 */
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { windowMs as windowLength } from './_window.mjs';

// Lockdown and the guest prelude before any module that needs them: static
// imports would be evaluated beside _init.mjs's top-level await.
await import('../scripts/_init.mjs');
await import('../test/unit/_m1a-prelude.js');
const { runPerf, stats } = await import('./_harness.mjs');
const { anthropicEvents, openRouterChunks, sseText, startFakeProviderServer } =
  await import('../test/fixtures/fake-provider-server.mjs');
const { makeTestBlobs } = await import('../test/adapter/_m1b-blobs.js');
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
const { interfaces } = await import('../guest/lib/interfaces.js');
const { makeEndpoint } =
  await import('../resources/agent-host/impl/endpoint.js');
const { makeTimers } = await import('../resources/agent-host/impl/timers.js');
const { makeChannelRegistry } =
  await import('../resources/agent-host/impl/channels.js');
const { makeOpenRouterProvider, openRouterAttempt, openRouterKind } =
  await import('../resources/agent-host/impl/providers/openrouter.js');
const { parseSse } =
  await import('../resources/agent-host/impl/providers/sse.js');
const { anthropicAttempt, anthropicKind, makeAnthropicProvider } =
  await import('../resources/agent-host/impl/providers/anthropic.js');
const { makeRetry, openRouterDelay } =
  await import('../resources/agent-host/impl/providers/retry.js');

const { E, Far, makeExo } = /** @type {any} */ (globalThis);

const DELTAS = Number(process.env.PROVIDER_DELTAS ?? 200);
const DELTA_MS = Number(process.env.PROVIDER_DELTA_MS ?? 5);
const WINDOW_MS = windowLength('PROVIDER_WINDOW_MS', 10_000);
const MIB = 1024 * 1024;
const timers = makeTimers();

/**
 * Run `once(run)` back to back for WINDOW_MS (at least once); the row
 * fields that say how many runs and samples the window held.
 * @param {(run: number) => Promise<void>} once
 */
const forWindow = async once => {
  const t0 = performance.now();
  let runs = 0;
  do {
    await once(runs);
    runs += 1;
  } while (performance.now() - t0 < WINDOW_MS);
  const windowMs = performance.now() - t0;
  return {
    runs,
    fields: {
      window: WINDOW_MS,
      windowMs: Math.round(windowMs),
      runs,
      runsPerSecond: +((runs * 1000) / windowMs).toFixed(2),
    },
  };
};

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
    // WX.1: the context window's method; nothing here asks to compact.
    compacted: () => harden({ go: false }),
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
 * @param {'openrouter' | 'anthropic'} [options.kind]
 * @param {(kind: string, fields?: any) => void} [options.log]
 */
const oneRound = async ({
  server,
  blobs,
  subscribe,
  onDelta,
  kind = 'openrouter',
  log = () => {},
}) => {
  const anthropic = kind === 'anthropic';
  const provider = (anthropic ? makeAnthropicProvider : makeOpenRouterProvider)(
    {
      label: 'perf',
      spec: {
        baseUrl: anthropic ? server.anthropicBaseUrl : server.openRouterBaseUrl,
      },
      readKey: async () => 'not a real key',
      timers,
      log,
      blobs: blobs.store,
    },
  );
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
    unexpectedFailure: (anthropic ? anthropicKind : openRouterKind)
      .unexpectedFailure,
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
      options: {
        modelId: anthropic ? 'claude-fake-1' : 'fake-org/fake-model',
      },
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

  // ---- 10 MiB stream. Built, and its parse row measured, before the fake
  // server starts: the parse window has no network, and a 10 s pause after
  // the overhead window let the server's keep-alive timeout (5 s) close the
  // pooled connection under the next fetch (ECONNRESET, M2-P1).
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
  const w2 = await forWindow(async run => {
    events = 0;
    const t0 = performance.now();

    for await (const event of parseSse(chunks)) {
      if (event.data !== '') events += 1;
    }
    parseMs.push(performance.now() - t0);
  });
  const medianParse = [...parseMs].sort((a, b) => a - b)[
    Math.floor(parseMs.length / 2)
  ];
  await stats('provider.sse.parse', parseMs, {
    extra: {
      ...w2.fields,
      samples: parseMs.length,
      bytes: bytes.length,
      events,
      mibPerSecond: +(bytes.length / MIB / (medianParse / 1000)).toFixed(1),
      eventsPerSecond: Math.round(events / (medianParse / 1000)),
      chunkBytes: 65_536,
    },
  });

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
    const w1 = await forWindow(async run => {
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
    });
    const ops = samples.length;
    await stats('provider.overhead', samples, {
      budget: { median: 5, deliveriesPerOp: 0 },
      before: { delivery: { count: 0, milliseconds: 0 } },
      after: { delivery: { count: streamingCalls, milliseconds: 0 } },
      ops,
      extra: {
        ...w1.fields,
        samples: samples.length,
        deltasPerRun: DELTAS,
        deltaSpacingMs: DELTA_MS,
        path: 'fake server socket write -> fetch -> parseSse -> openrouter -> runProviderRound -> channel -> E(subscription).next()',
        deliveriesSource:
          'TurnSink messages sent while streaming (in-process provider; daemon wiring is W2.2/W2.9)',
      },
    });

    // The attempt alone (fetch, parser, chunk reading; no round driver).
    /** @type {number[]} */
    const attemptMs = [];
    /** @type {number[]} deltas yielded per run (one per network read) */
    const attemptDeltas = [];
    const w3 = await forWindow(async run => {
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
    });
    const medianAttempt = [...attemptMs].sort((a, b) => a - b)[
      Math.floor(attemptMs.length / 2)
    ];
    await stats('provider.sse.attempt', attemptMs, {
      extra: {
        ...w3.fields,
        samples: attemptMs.length,
        bytes: bytes.length,
        events: count,
        deltasYielded: attemptDeltas,
        mibPerSecond: +(bytes.length / MIB / (medianAttempt / 1000)).toFixed(1),
      },
    });

    /** @type {number[]} */
    const streamMs = [];
    const w4 = await forWindow(async run => {
      server.setPlan([{ events: big }]);
      const blobs = makeTestBlobs({ dir: path.join(blobDir, `s${run}`) });
      const t0 = performance.now();

      const calls = await oneRound({ server, blobs, subscribe: false });
      streamMs.push(performance.now() - t0 - 20);
      if (calls.roundFinal !== 1)
        throw Error('the 10 MiB round did not finish');
    });
    const medianStream = [...streamMs].sort((a, b) => a - b)[
      Math.floor(streamMs.length / 2)
    ];
    await stats('provider.sse.stream', streamMs, {
      extra: {
        ...w4.fields,
        samples: streamMs.length,
        bytes: bytes.length,
        deltas: count,
        replyBytes: count * piece.length,
        mibPerSecond: +(bytes.length / MIB / (medianStream / 1000)).toFixed(1),
      },
    });

    // ---- W2.1b: the Anthropic provider, the same rows
    /** @type {number[]} */
    const aSamples = [];
    let aStreamingCalls = 0;
    const w5 = await forWindow(async run => {
      written.clear();
      const deltas = Array.from({ length: DELTAS }, (_, i) => `d${i} `);
      // Events: message_start, ping, content_block_start, then the deltas.
      server.setPlan([
        { events: anthropicEvents({ deltas }), delayMs: DELTA_MS },
      ]);
      /** @type {number[]} */
      const arrivals = [];
      const blobs = makeTestBlobs({ dir: path.join(blobDir, `a${run}`) });
      const calls = await oneRound({
        server,
        blobs,
        subscribe: true,
        kind: 'anthropic',
        onDelta: (_text, at) => arrivals.push(at),
      });
      aStreamingCalls += calls.progress;
      arrivals.slice(0, DELTAS).forEach((at, i) => {
        const sent = written.get(i + 3);
        if (sent !== undefined) aSamples.push(at - sent);
      });
      if (arrivals.length !== DELTAS)
        throw Error(`expected ${DELTAS} deltas, saw ${arrivals.length}`);
    });
    await stats('provider.overhead.anthropic', aSamples, {
      budget: { median: 5, deliveriesPerOp: 0 },
      before: { delivery: { count: 0, milliseconds: 0 } },
      after: { delivery: { count: aStreamingCalls, milliseconds: 0 } },
      ops: aSamples.length,
      extra: {
        ...w5.fields,
        samples: aSamples.length,
        deltasPerRun: DELTAS,
        deltaSpacingMs: DELTA_MS,
        path: 'fake server socket write -> fetch -> parseSse -> anthropic (retry wrapper) -> runProviderRound -> channel -> E(subscription).next()',
      },
    });

    const aBig = anthropicEvents({
      deltas: Array.from({ length: count }, () => piece),
    });
    const aBytes = new TextEncoder().encode(sseText(aBig)).length;
    /** @type {number[]} */
    const aAttemptMs = [];
    const w6 = await forWindow(async run => {
      server.setPlan([{ events: aBig }]);
      let seen = 0;
      const t0 = performance.now();
      for await (const event of anthropicAttempt({
        url: `${server.anthropicBaseUrl}/v1/messages`,
        key: 'not a real key',
        body: { model: 'claude-fake-1', stream: true, messages: [] },
        signal: new AbortController().signal,
        timeoutMs: 600_000,
      })) {
        if ('delta' in event) seen += event.delta.length;
      }
      aAttemptMs.push(performance.now() - t0);
      if (seen !== count * piece.length)
        throw Error(`anthropic attempt saw ${seen} units`);
    });
    const aMedianAttempt = [...aAttemptMs].sort((a, b) => a - b)[
      Math.floor(aAttemptMs.length / 2)
    ];
    await stats('provider.sse.attempt.anthropic', aAttemptMs, {
      extra: {
        ...w6.fields,
        samples: aAttemptMs.length,
        bytes: aBytes,
        events: count,
        mibPerSecond: +(aBytes / MIB / (aMedianAttempt / 1000)).toFixed(1),
      },
    });
    /** @type {number[]} */
    const aStreamMs = [];
    const w7 = await forWindow(async run => {
      server.setPlan([{ events: aBig }]);
      const blobs = makeTestBlobs({ dir: path.join(blobDir, `as${run}`) });
      const t0 = performance.now();
      const calls = await oneRound({
        server,
        blobs,
        subscribe: false,
        kind: 'anthropic',
      });
      aStreamMs.push(performance.now() - t0 - 20);
      if (calls.roundFinal !== 1)
        throw Error('the 10 MiB Anthropic round did not finish');
    });
    const aMedianStream = [...aStreamMs].sort((a, b) => a - b)[
      Math.floor(aStreamMs.length / 2)
    ];
    await stats('provider.sse.stream.anthropic', aStreamMs, {
      extra: {
        ...w7.fields,
        samples: aStreamMs.length,
        bytes: aBytes,
        deltas: count,
        mibPerSecond: +(aBytes / MIB / (aMedianStream / 1000)).toFixed(1),
      },
    });

    // ---- W2.1b: the retry wrapper's own cost, and its wait's accuracy
    const retry = makeRetry({ timers, delayMs: openRouterDelay });
    /** @type {number[]} */
    const bare = [];
    /** @type {number[]} */
    const wrapped = [];
    const w8 = await forWindow(async run => {
      for (const wrap of [false, true]) {
        server.setPlan([{ events: big }]);
        const signal = new AbortController().signal;
        /** @param {AbortSignal} attemptSignal */
        const attempt = attemptSignal =>
          openRouterAttempt({
            url: `${server.openRouterBaseUrl}/chat/completions`,
            key: 'not a real key',
            body: { model: 'fake-org/fake-model', stream: true, messages: [] },
            signal: attemptSignal,
            timeoutMs: 600_000,
          });
        const t0 = performance.now();
        for await (const _ of wrap
          ? retry({ attempt, signal })
          : attempt(signal)) {
          // drain
        }
        (wrap ? wrapped : bare).push(performance.now() - t0);
      }
    });
    const median = (/** @type {number[]} */ xs) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    await stats('provider.retry.passThrough', wrapped, {
      extra: {
        ...w8.fields,
        samples: wrapped.length,
        bytes: bytes.length,
        bareMedianMs: +median(bare).toFixed(1),
        wrappedMedianMs: +median(wrapped).toFixed(1),
        overheadMs: +(median(wrapped) - median(bare)).toFixed(1),
      },
    });
    /** @type {number[]} */
    const waitError = [];
    const w9 = await forWindow(async run => {
      server.setPlan([
        { status: 429, headers: { 'retry-after': '1' } },
        { events: openRouterChunks({ deltas: ['ok'] }) },
      ]);
      const before = server.requests().length;
      /** @type {number[]} */
      const retries = [];
      const blobs = makeTestBlobs({ dir: path.join(blobDir, `r${run}`) });
      await oneRound({
        server,
        blobs,
        subscribe: false,
        log: kind => {
          if (kind === 'retry') retries.push(performance.now());
        },
      });
      const [first, second] = server.requests().slice(before);
      // The 429 left at `first.receivedAt` (no body to wait for); the
      // second request's arrival minus the 1,000 ms wait is the slack.
      waitError.push(second.receivedAt - first.receivedAt - 1000);
      if (retries.length !== 1) throw Error('expected one retry');
    });
    await stats('provider.retry.wait', waitError, {
      extra: {
        ...w9.fields,
        samples: waitError.length,
        scheduledMs: openRouterDelay(1, 1000),
        what: 'second request arrival - first request arrival - 1000 ms',
      },
    });
  } finally {
    await server.close();
    rmSync(blobDir, { recursive: true, force: true });
  }
});
