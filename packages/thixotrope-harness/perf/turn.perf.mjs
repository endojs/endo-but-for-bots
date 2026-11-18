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
 *   provider's `round-start` line: `turn.start.open` (the claim crank on
 *   held ports and startRound) and `turn.start.dispatch`
 *   (dispatching(0) round trip). `turn.start.client` from the control
 *   client's call. `turn.start.deliveries`: frames into the session from the
 *   submit to the request, budget 3.
 * - `turn.delta`: a delta's publish to its arrival at a Live subscriber in
 *   the adapter process, where the browser gateway will hold its
 *   subscriptions (the channels' live probe, writing to `tmp/live-probe/`
 *   as this run's daemon is told in its environment, both times
 *   `performance.now()` in the adapter); budget median 5 ms;
 *   `deliveriesPerOp`: frames the session received while 50 deltas
 *   streamed, per delta, budget 0.
 * - `turn.delta.client`: the same deltas from their publish (the provider's
 *   `delta` line) to their arrival at a Live subscriber in this process (a
 *   control client: every batch crosses the hub; `Date.now()` on one
 *   machine); recorded, no budget (J-0274: the hop alone is 12-25 ms).
 *
 * Log lines are paired by backend and turn: the backend's label is unique
 * to this run and it serves one session, so a turn id names one turn (the
 * template's own backends write `t1..` too, J-0293).
 * - `turn.round`: frames per round with 2 echo calls (a tool turn against a
 *   plain turn), budget 3; `turn.lease`: frames of a plain turn besides
 *   its start, its final round and GC frames, budget 1.
 * - `turn.tooBig.*`: a 64 KiB reply, a 300 k-character echo result and
 *   2,000-key arguments (all staged since M1b, so all complete); each
 *   followed by a normal turn.
 * - `turn.frames`: the journal's frame kinds per turn kind.
 *
 * TURN_WINDOW_MS (default 60 s; it was TURN_N = 200 turns) of turns back to
 * back for the turn.start rows, which carry `window` and `samples`;
 * STREAM_TURNS (default 5) for turn.delta (50 deltas each); ROUND_N
 * (default 10) tool and plain turns (frame counts, not latencies). IDLE_MS
 * defaults to 1 h (perf/_harness.mjs), so the vat never sleeps. About 3
 * minutes.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  crankBudget,
  emit,
  harnessRoot,
  loadAvg,
  runIdentity,
  runPerf,
  single,
  stats,
} from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { generatedArgs } =
  await import('../resources/agent-host/impl/providers/scripted.js');
const { perfInputs, perfScript, STREAM_CHUNKS } =
  await import('../test/fixtures/scripts/m1a-slice.js');
const { makeSlice, sliceTemplate, waitFor } =
  await import('../test/integration/_m1a-slice.js');
const { LIVE_PROBE_VARIABLE } =
  await import('../resources/agent-host/impl/channels.js');
/** Where this run's daemon writes its live probe lines (named in its env). */
const liveProbeDir = path.join(harnessRoot, 'tmp', 'live-probe');

const TURN_WINDOW_MS = windowMs('TURN_WINDOW_MS', 60_000);
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

/**
 * Lines of one kind for round 0, by turn id; refuses a turn id seen twice
 * (lines of another backend or session would pair wrongly).
 * @param {any[]} lines
 * @param {string} kind
 * @returns {Map<string, number>}
 */
const atByTurn = (lines, kind) => {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const l of lines) {
    if (l.kind === kind && l.round === 0) {
      if (out.has(l.turnId))
        throw Error(`two ${kind} lines for turn ${l.turnId} of this backend`);
      out.set(l.turnId, l.at);
    }
  }
  return out;
};

/** The live probe's lines (every adapter pid), or none. */
const readProbe = () => {
  /** @type {any[]} */
  const lines = [];
  for (const name of readdirSync(liveProbeDir)) {
    if (name.endsWith('.jsonl')) {
      const text = readFileSync(path.join(liveProbeDir, name), 'utf8');
      for (const line of text.split('\n')) {
        if (line) lines.push(JSON.parse(line));
      }
    }
  }
  return lines;
};

await runPerf('turn', async ({ provision }) => {
  const template = await sliceTemplate();
  // The adapter makes its channel registry when it starts: the live probe
  // is named in the environment of the daemon this run serves (HR-SYN-13).
  rmSync(liveProbeDir, { recursive: true, force: true });
  mkdirSync(liveProbeDir, { recursive: true });
  try {
    await measure(template, provision);
  } finally {
    if (!process.env.KEEP_STATE)
      rmSync(liveProbeDir, { recursive: true, force: true });
  }
});

/**
 * @param {any} template
 * @param {(options: any) => Promise<any>} provision
 */
async function measure(template, provision) {
  const run = await provision({
    template,
    env: { [LIVE_PROBE_VARIABLE]: liveProbeDir },
  });
  const slice = await makeSlice(run);
  const label = `perf-turn-${process.pid}`;
  const made = await slice.makeBackend(harden(perfScript), { label });
  const { backend } = made;
  /** This backend's lines only (its session is the only one using it). */
  const log = () => made.log().filter(l => l.label === label);
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
  const startWindow = await runWindow(async () => turn(perfInputs.start), {
    ms: TURN_WINDOW_MS,
  });
  const starts = startWindow.results;
  const TURN_N = starts.length;
  const startFields = windowFields(startWindow);
  const engineAfter = (await run.client.call('status')).timings;
  const lines = log();
  const requestAt = atByTurn(lines, 'request');
  const roundStartAt = atByTurn(lines, 'round-start');
  /** @param {number[]} values */
  const assertPaired = values => {
    if (values.some(v => !Number.isFinite(v)))
      throw Error('a turn.start sample has no paired log line');
    return values;
  };
  const startMs = assertPaired(
    starts.map(s => Number(requestAt.get(s.turnId)) - s.at),
  );
  await stats('turn.start', startMs, {
    budget: { median: 350 },
    before: engineBefore,
    after: engineAfter,
    ops: TURN_N,
    extra: {
      from: 'Composer stamp (adapter clock)',
      to: 'request log line',
      ...startFields,
      daemonDeliveriesPerTurn: +(
        (engineAfter.delivery.count - engineBefore.delivery.count) /
        TURN_N
      ).toFixed(2),
      sessionFramesPerTurn: median(starts.map(s => s.frames)),
      slowest: starts
        .map((s, k) => ({ turnId: s.turnId, ms: startMs[k], frames: s.frames }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5),
      // A sample can only be negative when the turn-start's `at` is not
      // the Composer stamp of this submit: keep the raw times to tell why.
      negative: starts
        .map((s, k) => ({ s, k }))
        .filter(({ k }) => startMs[k] < 0)
        .map(({ s, k }) => ({
          turnId: s.turnId,
          ms: startMs[k],
          at: s.at,
          clientAt: s.clientAt,
          roundStartAt: roundStartAt.get(s.turnId),
          requestAt: requestAt.get(s.turnId),
          previousTurnId: starts[k - 1]?.turnId,
          previousAt: starts[k - 1]?.at,
          frames: s.frames,
        })),
    },
  });
  await stats(
    'turn.start.open',
    assertPaired(starts.map(s => Number(roundStartAt.get(s.turnId)) - s.at)),
    {
      extra: {
        from: 'Composer stamp',
        to: 'round-start (startRound at the provider)',
        ...startFields,
      },
    },
  );
  await stats(
    'turn.start.dispatch',
    assertPaired(
      starts.map(
        s =>
          Number(requestAt.get(s.turnId)) - Number(roundStartAt.get(s.turnId)),
      ),
    ),
    {
      extra: {
        from: 'round-start',
        to: 'request (dispatching answered)',
        ...startFields,
      },
    },
  );
  await stats(
    'turn.start.client',
    assertPaired(starts.map(s => Number(requestAt.get(s.turnId)) - s.clientAt)),
    {
      extra: {
        from: 'control client before submit',
        to: 'request',
        ...startFields,
      },
    },
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
  /** @type {string[]} */
  const streamTurnIds = [];
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
    streamTurnIds.push(done.turnId);
  }
  // The in-process subscriber (live probe): one channel, the session's.
  const probed = readProbe().filter(l => streamTurnIds.includes(l.turnId));
  const probeChannels = [...new Set(probed.map(l => `${l.pid}/${l.channel}`))];
  if (probeChannels.length !== 1)
    throw Error(
      `live probe: stream turns on ${probeChannels.length} channels (${probeChannels.join(', ')})`,
    );
  if (probed.length !== STREAM_CHUNKS * STREAM_TURNS)
    throw Error(
      `live probe: ${probed.length} deltas, expected ${STREAM_CHUNKS * STREAM_TURNS}`,
    );
  // Frames that arrived while the deltas streamed: deliveries the deltas
  // caused are `deliver` frames; GC frames come from peers dropping
  // references at their own pace.
  // The window closes when the last delta reached the subscriber, by
  // which time the round's own roundFinal (sent right after the last
  // delta) has usually arrived too: it is the round's delivery, not a
  // delta's.
  const streamDeliver = streamingKinds.filter(
    k => k.startsWith('deliver') && k !== 'deliver roundFinal',
  ).length;
  const perDelta = streamDeliver / (STREAM_CHUNKS * STREAM_TURNS);
  await stats(
    'turn.delta',
    probed.map(l => l.ms),
    {
      budget: { median: 5, deliveriesPerOp: 0 },
      extra: {
        deliveries: { count: streamDeliver, perOp: perDelta },
        framesWhileStreaming: streamingFrames,
        kindsWhileStreaming: streamingKinds,
        subscriber:
          'in the adapter process (live probe; where the gateway subscribes)',
        clock: 'performance.now() in the adapter',
        batchSizes: [...new Set(probed.map(l => l.batch))].sort(
          (a, b) => a - b,
        ),
      },
    },
  );
  await stats('turn.delta.client', latencies, {
    extra: {
      subscriber: 'control client through the hub',
      clock: 'Date.now() in the adapter and here',
      note: 'no budget: the adapter -> hub -> client hop (J-0274)',
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
  // A plain turn's deliver frames with ports held (contract 6.1, J-9151):
  // enqueueOnce, dispatching, roundFinal, and the lease answer (`fulfill`).
  // The lease is what is left after the first three; an open answer (a
  // turn that had to open its ports) would show here as a second one.
  const lease = plainDeliver - 3;
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
  // M1b (W1b.6): text over inlineBytes is staged, so the 64 KiB reply and
  // the 300 k-character echo output complete (M1a: the frame-limit text).
  await probe('turn.tooBig.reply64k', perfInputs.bigReply, done => {
    const p = [];
    if (done.status !== 'completed')
      p.push(`state ${done.status} ${done.reason}`);
    if (log().some(l => l.kind === 'frame-limit' && l.turnId === done.turnId))
      p.push('a frame-limit line');
    return p;
  });
  await probe('turn.tooBig.echo300k', perfInputs.echo300k, done => {
    const p = [];
    if (done.status !== 'completed')
      p.push(`state ${done.status} ${done.reason}`);
    if (
      log().some(
        l =>
          l.kind === 'echo-frame-limit' && l.opId.startsWith(`${done.turnId}/`),
      )
    )
      p.push('an echo-frame-limit line');
    return p;
  });
  await probe('turn.tooBig.keys2000', perfInputs.keys, done => {
    const p = [];
    if (done.status !== 'completed') p.push(`state ${done.status}`);
    const start = log().find(
      l => l.kind === 'echo-start' && l.opId.startsWith(`${done.turnId}/`),
    );
    // M1b: 19 KB of arguments are staged; echo reads the blob and logs
    // their length (the text itself is checked in m1a-slice acceptance 9).
    if (start?.units !== generatedArgs(2000).length)
      p.push('echo did not get the whole arguments');
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
}
