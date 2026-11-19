// @ts-check
/**
 * M5 exec perf (W5.5; designs/m5-interfaces.md 8.2), on the m5o template
 * (the m1b provisioning, the default pool, the fixture objects in the
 * workspace vat). Times are tool_call to tool_result arrival at a live
 * subscriber, as `exec.perf.mjs`. Each row is a fixed window
 * (EXEC_M5_WINDOW_MS, default 60 s):
 *
 * - `exec.powersLookup`: exec calls of 20 `E(powers).lookup('notes')`
 *   against `return 1`, alternating; per lookup = (median of the first -
 *   median of the second) / 20. Budget median <= 150 ms per lookup.
 * - `exec.membrane`: exec calls of 20 `E(calc).add(1, 2)` (each through the
 *   membrane, to the workspace vat) against 20 `E(powers).lookup('notes')`
 *   (no membrane measure: `powers` is the call's plain record, one
 *   answered send to the session vat), alternating; added ms per call =
 *   difference of medians / 20. Model code holds no raw reference to a
 *   fixture by design, so this in-vat row compares two one-hop calls; the
 *   Node row `exec.membrane.node` measures the membrane's own work for the
 *   same message (membrane E vs the plain E on one local object,
 *   alternating, EXEC_M5_NODE_MS default 10 s). Budget <= +5 ms median.
 * - `exec.scope1000`: `return 1` in a scope with 1,000 globals made by one
 *   call. Budget median <= 300 ms.
 * - too-big probes: (a) a 100 KiB argument through the membrane, 15 s cap;
 *   (b) `describeCapability` of a 200 KB `help()`, 30 s; (c) of a
 *   20,000-key `help()` answer, 30 s; (f) an exec body of 300,000
 *   iterations completes and an endless loop (far past the per-crank
 *   ceiling) is terminated, 30 s. Pass: the refusal or bounded text, no
 *   halt of the session vat or the fixture's (workspace) vat, and the
 *   session's next turn completes. Probe c's flood is answered by a
 *   disposable vat of its own (`keyFloodProgram`), which may halt: the
 *   probe shows that the session and workspace vats do not (M5-FIX).
 *
 *   node scripts/run-lock.mjs --exclusive --label exec-m5 -- node perf/exec-m5.perf.mjs
 */

import { performance } from 'node:perf_hooks';

import { emit, runPerf, single, summarize } from './_harness.mjs';
import { windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E, Far } = await import('@endo/far');
/* eslint-disable import/no-relative-packages */
const { texts, textOf } = await import('../guest/lib/interfaces.js');
const { limits } = await import('../guest/lib/limits.js');
const { makeMembrane } = await import('../guest/exec/membrane.js');
/* eslint-enable import/no-relative-packages */
const { makeSlice } = await import('../test/integration/_m1a-slice.js');
const { runTurn } = await import('../test/integration/_m1b.js');
const {
  call,
  endowedPreset,
  exec,
  fixturesOf,
  objectsTemplate,
  presetSession,
  tooBigOutcome,
  turnOf,
} = await import('../test/integration/_m5-objects.js');
const { keyFloodName, makeDisposableKeyFlood } =
  await import('../test/fixtures/m5-objects.js');

const WINDOW_MS = windowMs('EXEC_M5_WINDOW_MS', 60_000);
const NODE_MS = windowMs('EXEC_M5_NODE_MS', 10_000);
const WARMUP = 3;
const PER_CALL = 20;

const repeat = (/** @type {string} */ body) =>
  `for (let i = 0; i < ${PER_CALL}; i += 1) { ${body} } return 1;`;

const script = harden({
  turns: [
    turnOf('trivial', [exec('return 1;')]),
    turnOf('lookup20', [exec(repeat("await E(powers).lookup('notes');"))]),
    turnOf('add20', [
      exec(
        `const c = await E(powers).lookup('calc'); ${repeat('await E(c).add(1, 2);')}`,
      ),
    ]),
    turnOf('globals1000', [
      exec(
        "for (let i = 0; i < 1000; i += 1) globalThis['g' + i] = i; return 1;",
      ),
    ]),
    turnOf('probe a', [
      exec(
        "const n = await E(powers).lookup('notes'); try { await E(n).write('x'.repeat(102400)); return 'sent'; } catch (e) { return e.message; }",
      ),
    ]),
    turnOf('probe b', [call('describeCapability', { petName: 'bigHelp' })]),
    turnOf('probe c', [call('describeCapability', { petName: 'keyFlood' })]),
    turnOf('probe f1', [
      exec('let s = 0; for (let i = 0; i < 300000; i += 1) s += i; return s;'),
    ]),
    turnOf('probe f2', [exec('while (true) {}')]),
    turnOf('hello', [exec('return 2;')]),
  ],
});

/**
 * @param {number} ms
 * @param {string[]} kinds
 * @param {(kind: string) => Promise<number>} op answers the sample
 */
const alternating = async (ms, kinds, op) => {
  for (let i = 0; i < WARMUP; i += 1) {
    for (const kind of kinds) await op(kind);
  }
  /** @type {Record<string, number[]>} */
  const samples = Object.fromEntries(kinds.map(k => [k, []]));
  const end = performance.now() + ms;
  while (performance.now() < end) {
    for (const kind of kinds) samples[kind].push(await op(kind));
  }
  return samples;
};

/**
 * @template T
 * @param {number} ms
 * @param {() => Promise<T>} fn
 */
const capped = (ms, fn) =>
  Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(Error(`probe over ${ms} ms`)), ms),
    ),
  ]);

/** The membrane's own work in Node: membrane E vs plain E, one object. */
const nodeMembrane = async () => {
  const target = Far('calc', {
    /**
     * @param {number} a
     * @param {number} b
     */
    add: (a, b) => a + b,
  });
  const membrane = makeMembrane({ callE: E });
  const wrapper = /** @type {any} */ (membrane.wrap(target));
  const membraneE = /** @type {any} */ (membrane.E);
  /** @param {string} kind */
  const op = async kind => {
    const t0 = performance.now();
    for (let i = 0; i < 100; i += 1) {
      if (kind === 'membrane') await membraneE(wrapper).add(1, 2);
      else await E(target).add(1, 2);
    }
    return (performance.now() - t0) / 100;
  };
  const samples = await alternating(NODE_MS, ['membrane', 'raw'], op);
  const m = summarize(samples.membrane);
  const r = summarize(samples.raw);
  await single('exec.membrane.node', m.median - r.median, {
    budget: { value: 5 },
    extra: {
      what: 'Node: added ms per call, membrane E vs plain E on one local object (median of 100-call means)',
      membrane: m,
      raw: r,
      windowMs: NODE_MS,
      samples: samples.membrane.length + samples.raw.length,
      by: 'W5.5',
    },
  });
};

await runPerf('exec-m5', async ({ provision }) => {
  const template = await objectsTemplate();
  const run = await provision({ template });
  const slice = await makeSlice(run);
  const fixtures = await fixturesOf(run);
  const made = await slice.makeBackend(script);
  const preset = await endowedPreset(
    slice,
    {
      notes: fixtures.notes,
      calc: fixtures.calc,
      bigHelp: fixtures.bigHelp,
      // Probe c's flood halts the vat that answers it: a disposable vat.
      keyFlood: await makeDisposableKeyFlood(run.client),
    },
    { label: 'Exec perf', backend: made.backend },
  );
  const open = async () => {
    const session = await presetSession(slice, preset, made.backend, 'perf');
    const live = await slice.subscribe(session);
    return { session, live };
  };
  /**
   * One exec or tool call turn: tool_call to tool_result arrival.
   * @param {{ session: any, live: any }} s
   * @param {string} input
   * @param {number} [ms]
   */
  const timed = async (s, input, ms = 60_000) => {
    const r = await runTurn(slice, s.session, s.live, input, ms);
    const of = (/** @type {string} */ type) =>
      s.live.deliveries.find(
        (/** @type {any} */ d, /** @type {number} */ i) =>
          i >= r.from && d.event.type === type && d.event.turnId === r.turnId,
      );
    const c = of('tool_call');
    const result = of('tool_result');
    return {
      status: r.end.status,
      ms: result.arrivedAt - c.arrivedAt,
      result: result.event.result,
    };
  };
  /** @param {{ session: any, live: any }} s */
  const sample = s => async (/** @type {string} */ kind) => {
    const r = await timed(s, kind);
    if (r.status !== 'completed') throw Error(`${kind}: ${r.status}`);
    return r.ms;
  };
  const halted = async () =>
    (await slice.workers())
      .filter(
        (/** @type {any} */ w) =>
          w.failure &&
          !/^(spare )?exec \d+$/.test(w.debugLabel ?? '') &&
          // Probe c's disposable vat may halt; it holds nothing else.
          !String(w.debugLabel ?? '').includes(keyFloodName),
      )
      .map((/** @type {any} */ w) => w.debugLabel);

  // ---- exec.powersLookup
  const main = await open();
  const lookups = await alternating(
    WINDOW_MS,
    ['lookup20', 'trivial'],
    sample(main),
  );
  const l20 = summarize(lookups.lookup20);
  const triv = summarize(lookups.trivial);
  await single('exec.powersLookup', (l20.median - triv.median) / PER_CALL, {
    budget: { value: 150 },
    extra: {
      what: `ms per E(powers).lookup: (median exec of ${PER_CALL} lookups - median return 1) / ${PER_CALL}`,
      lookup20: l20,
      trivial: triv,
      windowMs: WINDOW_MS,
      samples: lookups.lookup20.length + lookups.trivial.length,
      by: 'W5.5',
    },
  });

  // ---- exec.membrane (in vat, then Node)
  const sends = await alternating(
    WINDOW_MS,
    ['add20', 'lookup20'],
    sample(main),
  );
  const a20 = summarize(sends.add20);
  const k20 = summarize(sends.lookup20);
  await single('exec.membrane', (a20.median - k20.median) / PER_CALL, {
    budget: { value: 5 },
    extra: {
      what: `added ms per call: membrane-wrapped E(calc).add (workspace vat) vs E(powers).lookup (session vat, no membrane measure), difference of medians / ${PER_CALL}`,
      add20: a20,
      lookup20: k20,
      windowMs: WINDOW_MS,
      samples: sends.add20.length + sends.lookup20.length,
      by: 'W5.5',
    },
  });
  await nodeMembrane();

  // ---- exec.scope1000
  const wide = await open();
  const made1000 = await timed(wide, 'globals1000');
  if (made1000.result !== '1') throw Error(`globals1000: ${made1000.result}`);
  const scope = await alternating(WINDOW_MS, ['trivial'], sample(wide));
  const sc = summarize(scope.trivial);
  await single('exec.scope1000', sc.median, {
    budget: { value: 300 },
    extra: {
      what: 'return 1 in a scope holding 1,000 globals (made by one call)',
      trivial: sc,
      makeMs: made1000.ms,
      windowMs: WINDOW_MS,
      samples: scope.trivial.length,
      by: 'W5.5',
    },
  });
  await wide.live.stop();

  // ---- too-big probes
  /**
   * @param {string} name
   * @param {number} capMs
   * @param {(result: any) => boolean} check
   * @param {(result: any) => unknown} [describe]
   */
  const probe = async (name, capMs, check, describe = r => r) => {
    const before = await halted();
    const s = await open();
    const t0 = performance.now();
    /** @type {Record<string, unknown>} */
    let detail;
    let pass = false;
    try {
      const r = await capped(capMs, () => timed(s, name, capMs));
      const next = await timed(s, 'hello');
      pass = check(r.result) && next.status === 'completed';
      detail = {
        result: describe(r.result),
        callMs: r.ms,
        next: next.status,
      };
    } catch (error) {
      detail = { error: String(/** @type {any} */ (error)?.message) };
    }
    const stopped = (await halted()).filter(label => !before.includes(label));
    const ok = pass && stopped.length === 0;
    // `single` sets `pass` from the budget: a failed probe reports twice
    // its cap so the row fails too.
    await single(
      `exec.tooBig.${name.replace(' ', '.')}`,
      ok ? performance.now() - t0 : 2 * capMs,
      {
        budget: { value: capMs },
        extra: {
          ...detail,
          probePass: ok,
          elapsedMs: Math.round(performance.now() - t0),
          halted: stopped,
          by: 'W5.5',
        },
      },
    );
    await s.live.stop();
  };
  /** @param {any} result */
  const text = result =>
    typeof result === 'string'
      ? result.slice(0, 200)
      : result?.preview?.slice(0, 200);

  const tooLarge = textOf.membraneTooLarge(0, limits.membraneArgBytes);
  await probe(
    'probe a',
    15_000,
    // The exec result is the refusal text rendered as JSON: compare the
    // opening quote and the text up to the byte count.
    r =>
      typeof r === 'string' &&
      r.startsWith(`"${tooLarge.slice(0, tooLarge.indexOf('0'))}`),
    text,
  );
  const terminated = textOf.errorResult(texts.inspectTerminated);
  // The shared predicate of m5-objects' big help (stopped, hub-refused or
  // staged).
  await probe(
    'probe b',
    30_000,
    r => tooBigOutcome(r) !== undefined,
    r =>
      tooBigOutcome(r) === 'staged'
        ? { staged: r?.bytes, preview: text(r) }
        : tooBigOutcome(r),
  );
  await probe(
    'probe c',
    30_000,
    r =>
      r === terminated ||
      r === textOf.errorResult(texts.execExhausted) ||
      (typeof r === 'string' && r.startsWith('{"methods":')),
    text,
  );
  await probe('probe f1', 30_000, r => r === String(299_999 * 150_000), text);
  await probe(
    'probe f2',
    30_000,
    r => typeof r === 'string' && r.startsWith('Error: '),
    text,
  );
  emit({ metric: 'exec-m5.done', by: 'W5.5' });
  await main.live.stop();
});
