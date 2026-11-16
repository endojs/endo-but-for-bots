// @ts-check
/**
 * Perf check "turn" (milestones.md M1a perf table, W1a.7): one session of the
 * real session program on the scripted backend, from the m1a state template.
 *
 *   cd packages/thixotrope-harness && node perf/turn.perf.mjs
 *
 * Turns are submitted through the Composer and followed on a Live
 * subscription only: the measurement makes no call into the session vat,
 * so the session's journal holds only the turn's own frames (and the OCapN
 * GC frames peers send it). Frames are read from the session worker's
 * journal (`status()` journalLength, and `workers/<id>/journal.jsonl`
 * decoded to tell `op:deliver` from `op:gc-*` frames). Each frame is one
 * delivery (one crank) of the worker.
 *
 * Rows:
 * - `turn.start`: Composer stamp (the turn's `at`, adapter clock) to the
 *   scripted provider's `request` line; budget median 350 ms. Split at the
 *   provider's `round-start` line: `turn.start.open` (claim crank, the
 *   manager's open, crank B, startRound) and `turn.start.dispatch`
 *   (dispatching(0) round trip). `turn.start.client` from the control
 *   client's call. `turn.start.deliveries`: frames into the session from the
 *   submit to the request, budget 3.
 * - `turn.delta`: a delta's publish (its `delta` line) to its arrival at a
 *   Live subscriber in this process (control client, through the hub);
 *   budget median 5 ms; `deliveriesPerOp`: frames the session received
 *   while 50 deltas streamed, per delta, budget 0.
 * - `turn.round`: frames per round with 2 echo calls (a tool turn against a
 *   plain turn), budget 3; `turn.lease`: frames of a plain turn besides
 *   its start, its final round and GC frames, budget 1.
 * - `turn.tooBig.*`: a 64 KiB reply, a 300 k-character echo result and
 *   2,000-key arguments; each followed by a normal turn.
 * - `turn.frames`: the journal's frame kinds per turn kind.
 *
 * TURN_N (default 200) turns for turn.start; STREAM_TURNS (default 5) for
 * turn.delta (50 deltas each); ROUND_N (default 10) tool and plain turns.
 * IDLE_MS defaults to 1 h (perf/_harness.mjs), so the vat never sleeps.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
  single,
  stats,
} from './_harness.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
// eslint-disable-next-line import/no-relative-packages
const { texts } = await import('../guest/lib/interfaces.js');
const { generatedArgs } =
  await import('../resources/agent-host/impl/providers/scripted.js');
const { perfInputs, perfScript, STREAM_CHUNKS } =
  await import('../test/fixtures/scripts/m1a-slice.js');
const { makeSlice, sliceTemplate, waitFor } =
  await import('../test/integration/_m1a-slice.js');

const TURN_N = Number(process.env.TURN_N ?? 200);
const STREAM_TURNS = Number(process.env.STREAM_TURNS ?? 5);
const ROUND_N = Number(process.env.ROUND_N ?? 10);

/** @param {number[]} values */
const median = values => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * The OCapN operation of a journal line (`{ b64 }`): `deliver` with its
 * method or answer kind, or a GC operation.
 * @param {string} line
 */
const frameKind = line => {
  const { b64 } = JSON.parse(line);
  const text = Buffer.from(b64, 'base64')
    .toString('latin1')
    .replace(/[^\x20-\x7e]/g, '.');
  const op = /op:([a-z-]+)/.exec(text)?.[1] ?? '?';
  if (op !== 'deliver') return op;
  const method = /\d+'desc.*?\d+'([A-Za-z]+)/.exec(text)?.[1] ?? '?';
  return `deliver ${method}`;
};

await runPerf('turn', async ({ provision }) => {
  const template = await sliceTemplate();
  const run = await provision({ template });
  const slice = await makeSlice(run);
  const { backend, log } = await slice.makeBackend(harden(perfScript));
  const session = await slice.createSession(backend, 'perf');
  const sub = await slice.subscribe(session);
  const worker = await slice.sessionWorker('s1');
  const journalPath = path.join(
    run.root,
    'workers',
    worker.workerId,
    'journal.jsonl',
  );
  /** The session vat's journal length (frames delivered to it). */
  const frames = async () =>
    Number((await slice.sessionWorker('s1'))?.journalLength ?? NaN);
  /**
   * Kinds of the last `n` journal frames (fewer when a snapshot truncated
   * the journal meanwhile).
   * @param {number} n
   */
  const lastKinds = n => {
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n');
    return lines.slice(1).slice(-n).map(frameKind);
  };
  /** @type {Map<string, Map<string, number>>} */
  const kindsByTurn = new Map();
  /**
   * @param {string} input
   * @param {string[]} kinds
   */
  const countKinds = (input, kinds) => {
    const counts = kindsByTurn.get(input) ?? new Map();
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    kindsByTurn.set(input, counts);
  };

  /**
   * Submit and follow the turn on the subscription.
   * @param {string} input
   * @param {{ onRequest?: (turnId: string) => Promise<void> }} [options]
   */
  const turn = async (input, { onRequest } = {}) => {
    const mark = sub.deliveries.length;
    const before = await frames();
    const clientAt = Date.now();
    await slice.submit(session, input);
    const i = await sub.until(e => e.type === 'turn-start', 30_000, mark);
    const { turnId, at } = sub.deliveries[i].event;
    if (onRequest) {
      await waitFor(
        () => log().some(l => l.kind === 'request' && l.turnId === turnId),
        30_000,
        'the request',
        5,
      );
      await onRequest(turnId);
    }
    const j = await sub.until(
      e => (e.type === 'end' || e.type === 'abort') && e.turnId === turnId,
      60_000,
      i,
    );
    const last = sub.deliveries[j].event;
    // The lease answer arrives after the settle: wait for the journal to
    // stop growing.
    let after = await frames();
    for (let k = 0; k < 20; k += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 50));
      // eslint-disable-next-line no-await-in-loop
      const again = await frames();
      if (again === after) break;
      after = again;
    }
    const n = after - before;
    const kinds = lastKinds(n);
    if (kinds.length === n) countKinds(input, kinds);
    return {
      turnId,
      at,
      clientAt,
      status: last.type === 'end' ? last.status : 'failed',
      reason: last.reason,
      frames: n,
      deliverFrames:
        kinds.length === n
          ? kinds.filter(k => k.startsWith('deliver')).length
          : NaN,
    };
  };

  // Warm up (first use of guards, the adapter's first open).
  for (let i = 0; i < 3; i += 1) await turn(perfInputs.start);

  // ---- turn.start
  const engineBefore = (await run.client.call('status')).timings;
  /** @type {Awaited<ReturnType<typeof turn>>[]} */
  const starts = [];
  for (let i = 0; i < TURN_N; i += 1) starts.push(await turn(perfInputs.start));
  const engineAfter = (await run.client.call('status')).timings;
  const lines = log();
  /** @param {string} kind */
  const atOf = kind =>
    new Map(
      lines
        .filter(l => l.kind === kind && l.round === 0)
        .map(l => [l.turnId, l.at]),
    );
  const requestAt = atOf('request');
  const roundStartAt = atOf('round-start');
  const startMs = starts.map(s => requestAt.get(s.turnId) - s.at);
  await stats('turn.start', startMs, {
    budget: { median: 350 },
    before: engineBefore,
    after: engineAfter,
    ops: TURN_N,
    extra: {
      from: 'Composer stamp (adapter clock)',
      to: 'request log line',
      daemonDeliveriesPerTurn: +(
        (engineAfter.delivery.count - engineBefore.delivery.count) /
        TURN_N
      ).toFixed(2),
      sessionFramesPerTurn: median(starts.map(s => s.frames)),
      slowest: starts
        .map((s, k) => ({ turnId: s.turnId, ms: startMs[k], frames: s.frames }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5),
    },
  });
  await stats(
    'turn.start.open',
    starts.map(s => roundStartAt.get(s.turnId) - s.at),
    {
      extra: {
        from: 'Composer stamp',
        to: 'round-start (startRound at the provider)',
      },
    },
  );
  await stats(
    'turn.start.dispatch',
    starts.map(s => requestAt.get(s.turnId) - roundStartAt.get(s.turnId)),
    { extra: { from: 'round-start', to: 'request (dispatching answered)' } },
  );
  await stats(
    'turn.start.client',
    starts.map(s => requestAt.get(s.turnId) - s.clientAt),
    { extra: { from: 'control client before submit', to: 'request' } },
  );

  // Frames into the session from the submit to the request.
  /** @type {number[]} */
  const startFrames = [];
  /** @type {string[][]} */
  const startKinds = [];
  for (let i = 0; i < ROUND_N; i += 1) {
    const before = await frames();
    await turn(perfInputs.startProbe, {
      onRequest: async () => {
        const n = (await frames()) - before;
        startFrames.push(n);
        startKinds.push(lastKinds(n));
      },
    });
  }
  const startDeliver = startKinds.map(
    ks => ks.filter(k => k.startsWith('deliver')).length,
  );
  await single('turn.start.deliveries', median(startFrames), {
    budget: { deliveriesPerOp: 3 },
    extra: {
      unit: 'frames',
      deliveries: { count: median(startFrames), perOp: median(startFrames) },
      perTurn: startFrames,
      deliverFramesPerTurn: startDeliver,
      kinds: startKinds[0],
    },
  });

  // ---- turn.delta
  /** @type {number[]} */
  const latencies = [];
  /** @type {number[]} */
  const streamingFrames = [];
  /** @type {string[]} */
  const streamingKinds = [];
  for (let i = 0; i < STREAM_TURNS; i += 1) {
    let atRequest = 0;
    const done = await turn(perfInputs.stream, {
      onRequest: async turnId => {
        atRequest = await frames();
        // Until the last delta reached the subscriber.
        await waitFor(
          () =>
            sub.deliveries.filter(
              d => d.event.type === 'delta' && d.event.turnId === turnId,
            ).length >= STREAM_CHUNKS,
          30_000,
          'the deltas',
          5,
        );
        const n = (await frames()) - atRequest;
        streamingFrames.push(n);
        streamingKinds.push(...lastKinds(n));
      },
    });
    const published = log().filter(
      l => l.kind === 'delta' && l.turnId === done.turnId,
    );
    const arrived = sub.deliveries.filter(
      d => d.event.type === 'delta' && d.event.turnId === done.turnId,
    );
    if (published.length !== STREAM_CHUNKS || arrived.length !== STREAM_CHUNKS)
      throw Error(
        `stream turn ${done.turnId}: ${published.length} published, ${arrived.length} arrived`,
      );
    arrived.forEach((d, k) => latencies.push(d.arrivedAt - published[k].at));
  }
  // Frames that arrived while the deltas streamed: deliveries the deltas
  // caused are `deliver` frames; GC frames come from peers dropping
  // references at their own pace.
  const streamDeliver = streamingKinds.filter(k =>
    k.startsWith('deliver'),
  ).length;
  const perDelta = streamDeliver / (STREAM_CHUNKS * STREAM_TURNS);
  await stats('turn.delta', latencies, {
    budget: { median: 5, deliveriesPerOp: 0 },
    extra: {
      deliveries: { count: streamDeliver, perOp: perDelta },
      framesWhileStreaming: streamingFrames,
      kindsWhileStreaming: streamingKinds,
      subscriber: 'control client through the hub',
      clock: 'Date.now() in the adapter and here',
    },
  });

  // ---- turn.round and turn.lease
  /** @type {Awaited<ReturnType<typeof turn>>[]} */
  const plain = [];
  /** @type {Awaited<ReturnType<typeof turn>>[]} */
  const tools = [];
  for (let i = 0; i < ROUND_N; i += 1) {
    plain.push(await turn(perfInputs.plain));
    const t = await turn(perfInputs.tools);
    if (t.status !== 'completed') throw Error(`tool turn ${t.status}`);
    tools.push(t);
  }
  const plainDeliver = median(plain.map(p => p.deliverFrames));
  const toolDeliver = median(tools.map(p => p.deliverFrames));
  const perRound = toolDeliver - plainDeliver;
  await single('turn.round', perRound, {
    budget: { deliveriesPerOp: 3 },
    extra: {
      unit: 'deliver frames',
      deliveries: { count: toolDeliver, perOp: perRound },
      toolTurnFrames: tools.map(p => p.frames),
      plainTurnFrames: plain.map(p => p.frames),
      callsPerRound: 2,
    },
  });
  // A plain turn's deliver frames: enqueueOnce, open answer, dispatching,
  // roundFinal, and the lease answer.
  const lease = plainDeliver - 4;
  await single('turn.lease', lease, {
    budget: { deliveriesPerOp: 1 },
    extra: {
      unit: 'deliver frames',
      deliveries: { count: lease, perOp: lease },
      plainTurnDeliverFrames: plainDeliver,
    },
  });
  emit({
    metric: 'turn.frames',
    kinds: Object.fromEntries(
      [...kindsByTurn].map(([input, counts]) => [
        input,
        Object.fromEntries(counts),
      ]),
    ),
    turnsCounted: Object.fromEntries(
      [
        [perfInputs.start, TURN_N + 3],
        [perfInputs.plain, ROUND_N],
        [perfInputs.tools, ROUND_N],
        [perfInputs.stream, STREAM_TURNS],
      ].map(([k, v]) => [k, v]),
    ),
  });

  // ---- too-big probes
  /** @type {string[]} */
  const wrong = [];
  /**
   * @param {string} metric
   * @param {string} input
   * @param {(done: any) => string[]} check problems
   */
  const probe = async (metric, input, check) => {
    const tStart = Date.now();
    const done = await turn(input);
    const ms = Date.now() - tStart;
    const after = await turn(perfInputs.start);
    const problems = [
      ...check(done),
      ...(after.status === 'completed' ? [] : [`next turn ${after.status}`]),
    ];
    const row = (await slice.sessionWorker('s1')) ?? {};
    if (row.failure) problems.push(`vat failure: ${row.failure}`);
    wrong.push(...problems.map(p => `${metric}: ${p}`));
    await single(metric, ms, {
      extra: {
        state: done.status,
        reason: done.reason ?? null,
        frames: done.frames,
        nextTurn: after.status,
        ok: problems.length === 0,
        problems,
      },
    });
  };
  await probe('turn.tooBig.reply64k', perfInputs.bigReply, done => {
    const p = [];
    if (done.status !== 'failed' || done.reason !== texts.frameLimit)
      p.push(`state ${done.status} ${done.reason}`);
    if (!log().some(l => l.kind === 'frame-limit' && l.turnId === done.turnId))
      p.push('no frame-limit line');
    return p;
  });
  await probe('turn.tooBig.echo300k', perfInputs.echo300k, done => {
    const p = [];
    if (done.status !== 'failed' || done.reason !== texts.frameLimit)
      p.push(`state ${done.status} ${done.reason}`);
    if (
      !log().some(
        l =>
          l.kind === 'echo-frame-limit' && l.opId.startsWith(`${done.turnId}/`),
      )
    )
      p.push('no echo-frame-limit line');
    return p;
  });
  await probe('turn.tooBig.keys2000', perfInputs.keys, done => {
    const p = [];
    if (done.status !== 'completed') p.push(`state ${done.status}`);
    const start = log().find(
      l => l.kind === 'echo-start' && l.opId.startsWith(`${done.turnId}/`),
    );
    if (start?.args !== generatedArgs(2000))
      p.push('echo did not get the arguments intact');
    return p;
  });

  await sub.stop();
  const last = await slice.sessionWorker('s1');
  emit({
    metric: 'turn.summary',
    turns: (await E(session).getUsage()).turns,
    sessionFrames: last?.journalLength ?? null,
    snapshotCut: last?.snapshot?.cut ?? null,
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  if (wrong.length) throw Error(wrong.join('; '));
});
