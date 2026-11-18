// @ts-check
/**
 * M5 tool perf (designs/m5-interfaces.md 8.2), on the m1b template (the
 * real session and exec programs, the default pool). A hook table: `rows`
 * is a list of `{ name, by, setup(shared) -> state, measure(window, state) }`
 * run in order, each measured over a fixed window (TOOLS_WINDOW_MS, default
 * 60 s). W5.3 writes the runner and its rows; W5.5 (`tools.inspect`) and
 * W5.6 (`grants.round`) each append one entry.
 *
 * W5.3's rows:
 * - `tools.local`: a turn whose first round calls `store`, `lookup` (JSON),
 *   `list` and `remove`, against a turn whose first round calls `echo`
 *   (both then close with a text round), alternating in one window: the
 *   added time per round is the difference of the medians; budget <= 30 ms,
 *   and 0 extra session deliveries (the four run in the round-final crank;
 *   an echo call is one adapter answer), from two short counted passes
 *   after the window.
 * - `labels.full`: turn start (the Composer's stamp on `turn-start` to the
 *   provider's `request` line, as `turn.start`) of a session holding 256
 *   labels against one holding none, alternating in one window; budget
 *   ratio of medians <= 1.1.
 * - probes (d), each capped at 30 s: an 8,193-byte `store` value (refused:
 *   its arguments are staged), the 257th label (`labelsFull`), 33
 *   attachments on `Session.enqueueMessageOnce` (refused by the guard);
 *   pass: the refusal text and the session's next turn completes with no
 *   halted vat. Probe (e), a granted schema of 3,000-unit parameters,
 *   needs W5.6's `grants` part: until it is merged the row says so.
 *
 *   node scripts/run-lock.mjs --exclusive --label tools -- node perf/tools.perf.mjs
 */
import { performance } from 'node:perf_hooks';

import { deliveries, emit, runPerf, single, summarize } from './_harness.mjs';
import { windowMs as windowLength } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
/* eslint-disable import/no-relative-packages */
const { textOf } = await import('../guest/lib/interfaces.js');
const { textOf: textOfM5 } = await import('../guest/lib/interfaces-m5.js');
const { limits } = await import('../guest/lib/limits.js');
/* eslint-enable import/no-relative-packages */
const { makeSlice, requestId } =
  await import('../test/integration/_m1a-slice.js');
const { execTemplate } = await import('../test/integration/_m1b-exec.js');
const { runTurn, turnRecords } = await import('../test/integration/_m1b.js');

const WINDOW_MS = windowLength('TOOLS_WINDOW_MS', 60_000);
const PROBE_MS = 30_000;
const WARMUP = 3;
const COUNTED = 10;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
/** @param {{ name: string, args: string, times?: number }[]} toolCalls */
const callRound = toolCalls => ({
  chunks: [{ text: 'tools' }],
  toolCalls,
  usage,
});
const closing = { chunks: [{ text: 'done' }], usage };
/**
 * @param {number} from
 * @param {number} count
 */
const stores = (from, count) =>
  Array.from({ length: count }, (_, i) => ({
    name: 'store',
    args: `{"value":${from + i},"petName":"f${from + i}"}`,
  }));

/** One script for every row: turns are chosen by their input. */
const script = harden({
  turns: [
    {
      input: 'local',
      rounds: [
        callRound([
          { name: 'store', args: '{"value":{"n":[1,2,3]},"petName":"p"}' },
          { name: 'lookup', args: '{"petName":"p"}' },
          { name: 'list', args: '{}' },
          { name: 'remove', args: '{"petName":"p"}' },
        ]),
        closing,
      ],
    },
    {
      input: 'echo',
      rounds: [callRound([{ name: 'echo', args: '{"text":"e"}' }]), closing],
    },
    {
      input: 'fill',
      rounds: [
        callRound(stores(0, 64)),
        callRound(stores(64, 64)),
        callRound(stores(128, 64)),
        callRound(stores(192, 64)),
        closing,
      ],
    },
    {
      input: 'over',
      rounds: [
        callRound([{ name: 'store', args: '{"value":0,"petName":"over"}' }]),
        closing,
      ],
    },
    { input: 'hello', rounds: [closing] },
    // W5.5 (`tools.inspect`): one describeCapability of an endowed fixture.
    {
      input: 'inspect',
      rounds: [
        callRound([
          { name: 'describeCapability', args: '{"petName":"notes"}' },
        ]),
        closing,
      ],
    },
  ],
});

/** The arguments of a `store` whose value is `labelValueBytes + 1` bytes. */
const bigStore = JSON.stringify({
  value: 'v'.repeat(limits.labelValueBytes - 1),
  petName: 'big',
});
const bigScript = harden({
  turns: [
    {
      input: 'big',
      rounds: [callRound([{ name: 'store', args: bigStore }]), closing],
    },
    { input: 'hello', rounds: [closing] },
  ],
});

/**
 * Run `op` alternately for each of `kinds` for `ms`, after `WARMUP` rounds.
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
 * Run `fn`; a probe that does not finish in PROBE_MS fails its row.
 * @template T
 * @param {() => Promise<T>} fn
 */
const capped = fn =>
  Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(Error(`probe over ${PROBE_MS} ms`)), PROBE_MS),
    ),
  ]);

/**
 * @typedef {object} Shared
 * @property {any} run the provisioned state (counters, client)
 * @property {any} slice
 * @property {() => Promise<{ session: any, live: any, made: any }>} newSession
 *   a fresh session on a backend of `script`
 */

/**
 * @typedef {object} PerfRow
 * @property {string} name
 * @property {string} by the unit that wrote it
 * @property {(shared: Shared) => Promise<any>} setup
 * @property {(windowMs: number, state: any) => Promise<void>} measure
 */

/** @type {PerfRow[]} */
const rows = [
  {
    name: 'tools.local',
    by: 'W5.3',
    setup: async shared => {
      const s = await shared.newSession();
      return { ...s, shared };
    },
    measure: async (windowMs, { session, live, shared }) => {
      /** @param {string} kind */
      const turn = async kind => {
        const t0 = performance.now();
        const r = await runTurn(shared.slice, session, live, kind);
        if (r.end.status !== 'completed')
          throw Error(`${kind}: ${r.end.status}`);
        return performance.now() - t0;
      };
      const samples = await alternating(windowMs, ['local', 'echo'], turn);
      /** @param {string} kind */
      const counted = async kind => {
        const before = await shared.run.counters();
        for (let i = 0; i < COUNTED; i += 1) await turn(kind);
        const after = await shared.run.counters();
        return /** @type {number} */ (deliveries(before, after, COUNTED).perOp);
      };
      const localDeliveries = await counted('local');
      const echoDeliveries = await counted('echo');
      const local = summarize(samples.local);
      const echo = summarize(samples.echo);
      const added = +(local.median - echo.median).toFixed(3);
      await single('tools.local', added, {
        budget: { value: 30 },
        extra: {
          what: 'added ms per round: median local-tools turn - median echo turn',
          local,
          echo,
          deliveriesPerTurn: {
            local: localDeliveries,
            echo: echoDeliveries,
          },
          extraDeliveries: +(localDeliveries - echoDeliveries).toFixed(2),
          deliveriesPass: localDeliveries <= echoDeliveries,
          windowMs,
          samples: samples.local.length + samples.echo.length,
          by: 'W5.3',
        },
      });
    },
  },
  {
    name: 'labels.full',
    by: 'W5.3',
    setup: async shared => {
      const full = await shared.newSession();
      const fill = await runTurn(
        shared.slice,
        full.session,
        full.live,
        'fill',
        120_000,
      );
      const failed = (await turnRecords(fill.turn)).filter(
        r => r.kind === 'tool-result' && r.failed,
      );
      if (failed.length) throw Error(`fill: ${failed[0].result}`);
      const empty = await shared.newSession();
      return { full, empty, shared };
    },
    measure: async (windowMs, { full, empty, shared }) => {
      /** @param {{ session: any, live: any, made: any }} s */
      const start = async s => {
        const r = await runTurn(shared.slice, s.session, s.live, 'hello');
        const started = s.live.deliveries.find(
          (/** @type {any} */ d, /** @type {number} */ i) =>
            i >= r.from &&
            d.event.type === 'turn-start' &&
            d.event.turnId === r.turnId,
        );
        const request = s.made
          .log()
          .find(
            (/** @type {any} */ l) =>
              l.kind === 'request' && l.turnId === r.turnId,
          );
        return Number(request?.at) - Number(started?.event.at);
      };
      const samples = await alternating(windowMs, ['full', 'empty'], kind =>
        start(kind === 'full' ? full : empty),
      );
      const f = summarize(samples.full);
      const e = summarize(samples.empty);
      const ratio = +(f.median / Math.max(e.median, 0.001)).toFixed(3);
      await single('labels.full', ratio, {
        budget: { value: 1.1 },
        extra: {
          unit: 'ratio of median turn starts (256 labels / none)',
          full: f,
          empty: e,
          labels: limits.maxLabels,
          windowMs,
          samples: samples.full.length + samples.empty.length,
          by: 'W5.3',
        },
      });
    },
  },
  {
    name: 'tooBig.d',
    by: 'W5.3',
    setup: async shared => ({ shared }),
    measure: async (_windowMs, { shared }) => {
      const { slice } = shared;
      /**
       * @param {string} name
       * @param {() => Promise<Record<string, unknown>>} fn
       */
      const probe = async (name, fn) => {
        const t0 = performance.now();
        /** @type {Record<string, unknown>} */
        let detail;
        let pass = false;
        try {
          detail = await capped(fn);
          pass = detail.pass === true;
        } catch (error) {
          detail = { error: String(/** @type {any} */ (error)?.message) };
        }
        const halted = (await slice.workers()).filter(
          (/** @type {any} */ w) => w.failure,
        );
        await single(`tools.tooBig.${name}`, performance.now() - t0, {
          budget: { value: PROBE_MS },
          extra: {
            ...detail,
            pass: pass && halted.length === 0,
            halted: halted.map((/** @type {any} */ w) => w.debugLabel),
            by: 'W5.3',
          },
        });
      };

      // (d1) an 8,193-byte value: its arguments are staged, refused.
      await probe('storeValue8193', async () => {
        const made = await slice.makeBackend(bigScript);
        const session = await slice.createSession(made.backend, 'probe big');
        const live = await slice.subscribe(session);
        const r = await runTurn(slice, session, live, 'big');
        const [result] = (await turnRecords(r.turn)).filter(
          x => x.kind === 'tool-result',
        );
        const expected = textOf.errorResult(
          textOfM5.argumentsTooLarge(
            'store',
            Buffer.byteLength(bigStore),
            limits.inlineBytes,
          ),
        );
        const next = await runTurn(slice, session, live, 'hello');
        await live.stop();
        return {
          pass: result?.result === expected && next.end.status === 'completed',
          result: result?.result,
        };
      });

      // (d2) the 257th label.
      await probe('label257', async () => {
        const s = await shared.newSession();
        await runTurn(slice, s.session, s.live, 'fill', 25_000);
        const r = await runTurn(slice, s.session, s.live, 'over');
        const [result] = (await turnRecords(r.turn)).filter(
          x => x.kind === 'tool-result',
        );
        const next = await runTurn(slice, s.session, s.live, 'hello');
        await s.live.stop();
        return {
          pass:
            result?.result ===
              textOf.errorResult(textOfM5.labelsFull(limits.maxLabels)) &&
            next.end.status === 'completed',
          result: result?.result,
        };
      });

      // (d3) 33 attachments: refused by the Session guard before any part.
      await probe('attachments33', async () => {
        const s = await shared.newSession();
        const attachment = harden({ label: 'a', value: s.made.backend });
        const refused = await E(s.session)
          .enqueueMessageOnce(
            harden({ text: 'x' }),
            requestId(),
            Date.now(),
            harden(Array(limits.maxAttachments + 1).fill(attachment)),
          )
          .then(
            () => undefined,
            (/** @type {any} */ error) => String(error?.message ?? error),
          );
        const next = await runTurn(slice, s.session, s.live, 'hello');
        await s.live.stop();
        return {
          pass:
            typeof refused === 'string' &&
            /enqueueMessageOnce/.test(refused) &&
            next.end.status === 'completed',
          refused: refused?.slice(0, 200),
        };
      });
    },
  },
  {
    name: 'tooBig.e',
    by: 'W5.3',
    setup: async shared => ({ shared }),
    measure: async (_windowMs, { shared }) => {
      // Needs W5.6's grants part (SessionGrants.grantTool): until it is
      // merged, `Session.grants()` answers notBuilt and the row says so.
      const { slice } = shared;
      const s = await shared.newSession();
      const grants = await E(s.session)
        .grants()
        .catch((/** @type {any} */ error) => error);
      await s.live.stop();
      if (grants instanceof Error) {
        emit({
          metric: 'tools.tooBig.grantedSchema3000',
          pass: null,
          skipped: 'needs the grants part (W5.6); run by W5.9',
          answer: String(grants.message).slice(0, 200),
          by: 'W5.3',
        });
        return;
      }
      // W5.9: grant the fixture tool whose schema parameters are about 3,000
      // units (W5.4's `bigSchemaTool`): `refused-schema` by the inspector
      // in the exec vat, no halted vat, and the session's next turn runs.
      const t0 = performance.now();
      /** @type {Record<string, unknown>} */
      let detail;
      try {
        detail = await capped(async () => {
          const { makeM5Fixtures } =
            await import('../test/fixtures/m5-objects.js');
          const fixtures = await makeM5Fixtures(shared.run.client);
          const g = await E(grants).grantTool(fixtures.bigSchemaTool);
          /** @type {any} */
          let info = await E(g).describe();
          while (info.state === 'pending') {
            await new Promise(resolve => setTimeout(resolve, 100));
            info = await E(g).describe();
          }
          const next = await shared.newSession();
          const hello = await runTurn(slice, next.session, next.live, 'hello');
          await next.live.stop();
          return {
            pass:
              info.state === 'refused-schema' &&
              /characters of JSON; the limit is/.test(String(info.reason)) &&
              hello.end.status === 'completed',
            state: info.state,
            reason: String(info.reason).slice(0, 200),
          };
        });
      } catch (error) {
        detail = {
          pass: false,
          error: String(/** @type {any} */ (error)?.message),
        };
      }
      const halted = (await slice.workers()).filter(
        (/** @type {any} */ w) => w.failure,
      );
      await single('tools.tooBig.grantedSchema3000', performance.now() - t0, {
        budget: { value: PROBE_MS },
        extra: {
          ...detail,
          pass: detail.pass === true && halted.length === 0,
          halted: halted.map((/** @type {any} */ w) => w.debugLabel),
          by: 'W5.9',
        },
      });
    },
  },
  {
    // W5.6 (8.2 `grants.round`): turn start (as `labels.full`) of a session
    // with 32 offered grants against one with none, alternating in one
    // window; budget median <= 350 ms. The per-round tool set (S1) with 32
    // grants is also timed in Node over the window's end (the engine's
    // share is not separable from the turn start; reported as Node ms).
    name: 'grants.round',
    by: 'W5.6',
    setup: async shared => {
      const { makeM5Fixtures } = await import('../test/fixtures/m5-objects.js');
      const fixtures = await makeM5Fixtures(shared.run.client);
      const granted = await shared.newSession();
      const grants = await E(granted.session).grants();
      /** @type {any[]} */
      const handles = [];
      for (let i = 0; i < limits.maxGrantedTools; i += 1) {
        const tool = await E(fixtures.tools).make(`g${i}`);
        handles.push(await E(grants).grantTool(tool));
      }
      const t0 = performance.now();
      for (;;) {
        const states = (await E(grants).list()).map(
          (/** @type {any} */ g) => g.state,
        );
        if (states.every((/** @type {string} */ s) => s !== 'pending')) {
          if (!states.every((/** @type {string} */ s) => s === 'offered'))
            throw Error(`grants not offered: ${states.join(',')}`);
          break;
        }
        if (performance.now() - t0 > PROBE_MS)
          throw Error('grants still pending after 30 s');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const offeredMs = performance.now() - t0;
      const plain = await shared.newSession();
      return { granted, plain, shared, offeredMs };
    },
    measure: async (windowMs, { granted, plain, shared, offeredMs }) => {
      /** @param {{ session: any, live: any, made: any }} s */
      const start = async s => {
        const r = await runTurn(shared.slice, s.session, s.live, 'hello');
        const started = s.live.deliveries.find(
          (/** @type {any} */ d, /** @type {number} */ i) =>
            i >= r.from &&
            d.event.type === 'turn-start' &&
            d.event.turnId === r.turnId,
        );
        const request = s.made
          .log()
          .find(
            (/** @type {any} */ l) =>
              l.kind === 'request' && l.turnId === r.turnId,
          );
        return Number(request?.at) - Number(started?.event.at);
      };
      const samples = await alternating(windowMs, ['granted', 'plain'], kind =>
        start(kind === 'granted' ? granted : plain),
      );
      const g = summarize(samples.granted);
      const p = summarize(samples.plain);
      // S1 in Node: toolSetFor with 32 described grants (fake inspector).
      /* eslint-disable import/no-relative-packages */
      const { makeGrants } = await import('../guest/session/tools/granted.js');
      const { toolSetFor, toolSources, toolTable } =
        await import('../guest/session/tool-table.js');
      /* eslint-enable import/no-relative-packages */
      /** @type {any} */
      let part;
      const runtime = harden({
        services: harden({}),
        get grants() {
          return part;
        },
      });
      part = makeGrants(runtime, {
        inspectFor: () => async (/** @type {any} */ request) =>
          harden({
            status: 'ok',
            description: harden({
              name: `g${handlesOf(request.target)}`,
              description: 'The fixture tool: echoes its text argument.',
              parameters: '{"type":"object"}',
            }),
          }),
      });
      /** @type {Map<any, number>} */
      const numbered = new Map();
      /** @param {any} target */
      const handlesOf = target => {
        if (!numbered.has(target)) numbered.set(target, numbered.size);
        return numbered.get(target);
      };
      const ports = harden({ tools: harden([]), since: 1 });
      part.entriesFor(ports);
      const { Far } = /** @type {any} */ (globalThis);
      for (let i = 0; i < limits.maxGrantedTools; i += 1) {
        part.facet.grantTool(Far(`g${i}`, {}));
      }
      await new Promise(resolve => setImmediate(resolve));
      /** @type {number[]} */
      const sets = [];
      const end = performance.now() + Math.min(windowMs, 10_000);
      while (performance.now() < end) {
        const t0 = performance.now();
        const set = toolSetFor(
          ports,
          toolTable,
          harden({}),
          toolSources,
          runtime,
        );
        sets.push(performance.now() - t0);
        if (set.descriptions.length < limits.maxGrantedTools)
          throw Error('the Node tool set lost grants');
      }
      const s1 = summarize(sets);
      await single('grants.round', g.median, {
        budget: { value: 350 },
        extra: {
          unit: 'ms, median turn start (turn-start to provider request) with 32 offered grants',
          granted: g,
          plain: p,
          addedMs: +(g.median - p.median).toFixed(3),
          toolSetNodeMs: s1,
          toolSetBudgetMs: 10,
          toolSetPass: s1.median <= 10,
          grantsOfferedMs: +offeredMs.toFixed(1),
          windowMs,
          samples: samples.granted.length + samples.plain.length,
          by: 'W5.6',
        },
      });
    },
  },
  {
    // W5.5 (8.2 `tools.inspect`): `describeCapability` of a workspace-vat
    // fixture endowed to the session, tool_call to tool_result arrival
    // (session -> exec -> fixture -> exec -> session); budget median <=
    // 300 ms over the window.
    name: 'tools.inspect',
    by: 'W5.5',
    setup: async shared => {
      const { makeM5Fixtures } = await import('../test/fixtures/m5-objects.js');
      const { endowedPreset, presetSession } =
        await import('../test/integration/_m5-objects.js');
      const fixtures = await makeM5Fixtures(shared.run.client);
      const made = await shared.slice.makeBackend(script);
      const preset = await endowedPreset(
        shared.slice,
        { notes: fixtures.notes },
        { label: 'Inspect perf', backend: made.backend },
      );
      const session = await presetSession(
        shared.slice,
        preset,
        made.backend,
        'tools inspect',
      );
      const live = await shared.slice.subscribe(session);
      return { session, live, shared };
    },
    measure: async (windowMs, { session, live, shared }) => {
      const once = async () => {
        const r = await runTurn(shared.slice, session, live, 'inspect');
        if (r.end.status !== 'completed')
          throw Error(`inspect: ${r.end.status}`);
        const of = (/** @type {string} */ type) =>
          live.deliveries.find(
            (/** @type {any} */ d, /** @type {number} */ i) =>
              i >= r.from &&
              d.event.type === type &&
              d.event.turnId === r.turnId,
          );
        const result = of('tool_result');
        if (
          typeof result?.event.result !== 'string' ||
          !result.event.result.startsWith('{"methods":')
        )
          throw Error(`inspect: ${String(result?.event.result).slice(0, 200)}`);
        return result.arrivedAt - of('tool_call').arrivedAt;
      };
      const samples = await alternating(windowMs, ['inspect'], once);
      const inspect = summarize(samples.inspect);
      await single('tools.inspect', inspect.median, {
        budget: { value: 300 },
        extra: {
          what: 'describeCapability of a workspace-vat fixture: tool_call to tool_result arrival',
          inspect,
          windowMs,
          samples: samples.inspect.length,
          by: 'W5.5',
        },
      });
      await live.stop();
    },
  },
];

await runPerf('tools', async ({ provision }) => {
  const template = await execTemplate();
  const run = await provision({ template });
  const slice = await makeSlice(run);
  /** @type {Shared} */
  const shared = {
    run,
    slice,
    newSession: async () => {
      const made = await slice.makeBackend(script);
      const session = await slice.createSession(made.backend, 'tools perf');
      const live = await slice.subscribe(session);
      return { session, live, made };
    },
  };
  const only = process.env.TOOLS_ROWS?.split(',');
  for (const row of rows.filter(r => !only || only.includes(r.name))) {
    const t0 = performance.now();
    const state = await row.setup(shared);
    const setupMs = performance.now() - t0;
    await row.measure(WINDOW_MS, state);
    emit({
      metric: `${row.name}.setup`,
      unit: 'ms',
      value: +setupMs.toFixed(1),
      by: row.by,
    });
  }
});
