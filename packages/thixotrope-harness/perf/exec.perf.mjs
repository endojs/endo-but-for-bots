// @ts-check
/**
 * Perf check "exec" (milestones.md M1b perf table, W1b.6), on the m1b
 * template (real session and exec programs, default pool of 2 session
 * spares and 1 exec spare), idle sleep 2 s so spares and finished exec vats
 * sleep as they would in service:
 *
 * - `exec.first`: the first exec call of a fresh session, after the pool
 *   settled and every exec vat is asleep: `ExecHandle.scope()` takes a
 *   sleeping spare exec vat, then `run`. Budget median 750 ms.
 * - `exec.trivial`: `return 1` on a session's warm scope. Budget 250 ms.
 * - `exec.sends.answered`: 100 `E(timer).sleep(0)` from one body, all
 *   awaited. Budget 8 s, and no MeterAbort. `exec.sends.sendOnly` is
 *   emitted as not measurable (M1b `powers` is empty: model code reaches no
 *   remote it could sendOnly to).
 * - `exec.runaway`: `while (true) {}` to the terminated result (recorded;
 *   M0's crank alone is 242-271 ms).
 * - `exec.retire`: disk returned once the lost (runaway) exec vat is
 *   retired: the bytes of its files under `heaps/snapshots` and
 *   `workers/<id>` that are gone. Budget >= 15 MB.
 * - too-big probes (`tooBig.*`): 300 tool calls in one round; a 1 MiB reply;
 *   a 10 MiB echo output (over `echoMaxUnits`: an argument error) and the
 *   largest echo output allowed (1 MiB, cut and staged); a 300 KiB exec
 *   body; an exec body building an object with 60,000 fresh keys. Pass:
 *   the session vat is not halted and the next turn completes; for the keys
 *   probe also: the exec vat halted and was retired (the next call has a
 *   fresh scope).
 *
 *   cd packages/thixotrope-harness && node perf/exec.perf.mjs
 *
 * EXEC_FIRST_N (default 5), EXEC_TRIVIAL_N (50), EXEC_SENDS_N (5).
 * Times are measured at a live subscriber: tool_call arrival to
 * tool_result arrival.
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

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
const { texts, textOf } = await import('../guest/lib/interfaces.js');
// eslint-disable-next-line import/no-relative-packages
const { limits } = await import('../guest/lib/limits.js');
const { makeSlice, untilAsleep, waitFor, round1 } =
  await import('../test/integration/_m1a-slice.js');
const { execCode, execTemplate, isExecVat } =
  await import('../test/integration/_m1b-exec.js');
const { readField, runTurn, turnRecords, isStaged } =
  await import('../test/integration/_m1b.js');

const FIRST_N = Number(process.env.EXEC_FIRST_N ?? 5);
const TRIVIAL_N = Number(process.env.EXEC_TRIVIAL_N ?? 50);
const SENDS_N = Number(process.env.EXEC_SENDS_N ?? 5);

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** @param {string} code */
const execCall = code => ({ name: 'exec', args: JSON.stringify({ code }) });
/**
 * @param {string} input
 * @param {any} call
 */
const callTurn = (input, call) => ({
  input,
  rounds: [
    { chunks: [{ text: input }], toolCalls: [call], usage },
    { chunks: [{ text: 'done' }], usage },
  ],
});

const KEYS_CODE = [
  'const o = {};',
  "for (let i = 0; i < 60000; i += 1) o['fresh' + i] = i;",
  'return Object.keys(o).length;',
].join('\n');

const script = harden({
  turns: [
    ...Object.entries(execCode).map(([input, code]) =>
      callTurn(input, execCall(code)),
    ),
    callTurn('probe calls300', {
      name: 'echo',
      args: JSON.stringify({ text: 'c' }),
      times: 300,
    }),
    {
      input: 'probe reply1m',
      rounds: [
        {
          chunks: Array.from({ length: 64 }, () => ({
            text: '0123456789abcdef',
            repeat: 1024,
          })),
          usage,
        },
      ],
    },
    callTurn('probe echo10m', {
      name: 'echo',
      args: JSON.stringify({ text: 'z', bytes: 10 * 1024 * 1024 }),
    }),
    callTurn('probe echo1m', {
      name: 'echo',
      args: JSON.stringify({ text: 'z', bytes: limits.echoMaxUnits }),
    }),
    callTurn('probe exec300k', {
      name: 'exec',
      code: { text: `// ${'p'.repeat(60)}\n`, repeat: 4800 },
    }),
    callTurn('probe keys60k', execCall(KEYS_CODE)),
    { rounds: [{ chunks: [{ text: 'hello' }], usage }] },
  ],
});

/**
 * Sizes of the files under `dirs` (path -> bytes).
 * @param {string[]} dirs
 */
const filesUnder = dirs => {
  /** @type {Map<string, number>} */
  const out = new Map();
  /** @param {string} dir */
  const walk = dir => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        st = undefined;
      }
      if (st?.isDirectory()) walk(full);
      else if (st) out.set(full, st.size);
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
};

let ownFailures = 0;

await runPerf('exec', async ({ provision }) => {
  const template = await execTemplate();
  const state = await provision({ template, idleSleepMs: 2000 });
  const slice = await makeSlice(state);
  const { harness } = slice;
  const made = await slice.makeBackend(script);

  /**
   * One turn with one exec call; the call's time at the live subscriber.
   * @param {any} session
   * @param {any} live
   * @param {string} input
   * @param {number} [ms]
   */
  const execTurn = async (session, live, input, ms = 60_000) => {
    const r = await runTurn(slice, session, live, input, ms);
    const after = live.deliveries.slice(r.from);
    const call = after.find(
      (/** @type {any} */ d) =>
        d.event.type === 'tool_call' && d.event.turnId === r.turnId,
    );
    const result = after.find(
      (/** @type {any} */ d) =>
        d.event.type === 'tool_result' && d.event.turnId === r.turnId,
    );
    return {
      ...r,
      result: result?.event.result,
      callMs:
        call && result ? round1(result.arrivedAt - call.arrivedAt) : undefined,
    };
  };

  // ---- exec.first
  /** @type {number[]} */
  const firstMs = [];
  /** @type {any} */
  let main;
  for (let i = 0; i < FIRST_N; i += 1) {
    const session = await slice.createSession(made.backend, `first ${i}`);
    await E(harness).whenSettled();
    await untilAsleep(slice.workers, isExecVat);
    const live = await slice.subscribe(session);
    const r = await execTurn(session, live, 'exec trivial');
    if (r.result !== '1') throw Error(`exec.first: result ${r.result}`);
    firstMs.push(/** @type {number} */ (r.callMs));
    if (i === 0) main = { session, live };
    else await live.stop();
  }
  await stats('exec.first', firstMs, {
    budget: { median: 750 },
    extra: {
      what: 'tool_call to tool_result; first exec of a fresh session takes a sleeping spare exec vat (pool settled, exec vats asleep)',
    },
  });

  // ---- exec.trivial
  /** @type {number[]} */
  const trivialMs = [];
  const before = await state.counters();
  for (let i = 0; i < TRIVIAL_N; i += 1) {
    const r = await execTurn(main.session, main.live, 'exec trivial');
    trivialMs.push(/** @type {number} */ (r.callMs));
  }
  const after = await state.counters();
  await stats('exec.trivial', trivialMs, {
    budget: { median: 250 },
    before,
    after,
    ops: TRIVIAL_N,
    extra: {
      what: 'tool_call to tool_result on a warm scope; deliveries are whole turns (two rounds each)',
    },
  });

  // ---- exec.sends
  /** @type {number[]} */
  const sendsMs = [];
  for (let i = 0; i < SENDS_N; i += 1) {
    const r = await execTurn(main.session, main.live, 'exec sends');
    if (r.result !== '100') throw Error(`exec.sends: result ${r.result}`);
    sendsMs.push(/** @type {number} */ (r.callMs));
  }
  const failedVats = (await slice.workers()).filter(w => w.failure);
  await stats('exec.sends.answered', sendsMs, {
    budget: { median: 8000 },
    extra: {
      what: '100 E(timer).sleep(0) from one body, all awaited',
      meterAborts: failedVats.length,
      depends: 'C-7',
    },
  });
  if (failedVats.length) ownFailures += 1;
  emit({
    metric: 'exec.sends.sendOnly',
    pass: null,
    budget: { median: 1000 },
    measured: false,
    why: 'M1b powers is empty: model code reaches no remote object it could sendOnly to (M5)',
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });

  // ---- exec.runaway and exec.retire
  const execRows = async () => (await slice.workers()).filter(isExecVat);
  const set = await execTurn(main.session, main.live, 'exec set');
  if (set.result !== '5') throw Error(`exec set: ${set.result}`);
  // The exec vat serving main: the one whose journal grows on a call.
  const journals = new Map(
    (await execRows()).map(w => [w.workerId, Number(w.journalLength)]),
  );
  await execTurn(main.session, main.live, 'exec trivial');
  const grown = (await execRows()).filter(
    w => Number(w.journalLength) > (journals.get(w.workerId) ?? Infinity),
  );
  if (grown.length !== 1) throw Error(`exec vat of main: ${grown.length}`);
  const [victim] = grown;
  // Let it checkpoint (its snapshot is the disk a retire returns).
  await untilAsleep(slice.workers, w => w.workerId === victim.workerId);
  const dirs = [
    path.join(state.root, 'heaps', 'snapshots'),
    path.join(state.root, 'workers', victim.workerId),
  ];
  const filesBefore = filesUnder(dirs);
  const victimRow = (await slice.workers()).find(
    w => w.workerId === victim.workerId,
  );
  const loop = await execTurn(main.session, main.live, 'exec loop', 60_000);
  const terminated = loop.result === textOf.errorResult(texts.execTerminated);
  await single('exec.runaway', /** @type {number} */ (loop.callMs), {
    extra: {
      what: 'tool_call to tool_result: run, MeterAbort, the retired break, the terminated result',
      terminated,
      recorded: 'M0 crank alone 242-271 ms',
    },
  });
  if (!terminated) ownFailures += 1;
  const tRetire = performance.now();
  await waitFor(
    async () =>
      !(await slice.workers()).some(w => w.workerId === victim.workerId),
    30_000,
    'the lost exec vat retired',
    100,
  );
  const retireMs = round1(performance.now() - tRetire);
  // Files are removed by the store after the row: wait for them, bounded.
  /** @type {Map<string, number>} */
  let filesAfter = filesUnder(dirs);
  const victimFiles = [...filesBefore.keys()].filter(
    f =>
      f.includes(victim.workerId) ||
      (victimRow?.snapshot?.hash && f.includes(victimRow.snapshot.hash)),
  );
  for (let waited = 0; waited < 10_000; waited += 250) {
    filesAfter = filesUnder(dirs);
    if (victimFiles.every(f => !filesAfter.has(f))) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const removed = [...filesBefore].filter(([f]) => !filesAfter.has(f));
  const returnedBytes = removed.reduce((sum, [, size]) => sum + size, 0);
  const minBytes = 15 * 1000 * 1000;
  const retirePass = returnedBytes >= minBytes;
  if (!retirePass) ownFailures += 1;
  emit({
    metric: 'exec.retire',
    unit: 'bytes',
    value: returnedBytes,
    budget: { atLeast: minBytes },
    pass: retirePass,
    removedFiles: removed.map(([f, size]) => ({
      file: path.relative(state.root, f),
      size,
    })),
    victimSnapshot: victimRow?.snapshot ?? null,
    victimFilesStillThere: victimFiles.filter(f => filesAfter.has(f)).length,
    retireAfterResultMs: retireMs,
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  const fresh = await execTurn(main.session, main.live, 'exec get');
  emit({
    metric: 'exec.runaway.next',
    unit: 'ms',
    value: fresh.callMs,
    freshScope: fresh.result === '-1',
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });

  // ---- too-big probes: each on main; the next turn must complete
  const content = await E(slice.admin).content();
  /**
   * @param {string} metric
   * @param {string} input
   * @param {(r: any, records: any[]) => Promise<Record<string, unknown>>} check
   *   facts; a `problems` array of strings marks a failure
   */
  const probe = async (metric, input, check) => {
    const t0 = performance.now();
    const r = await runTurn(slice, main.session, main.live, input, 180_000);
    const ms = performance.now() - t0;
    const records = await turnRecords(r.turn);
    const facts = await check(r, records);
    const problems = /** @type {string[]} */ (facts.problems ?? []);
    const next = await runTurn(slice, main.session, main.live, 'hi');
    if (next.end.status !== 'completed')
      problems.push(`next turn ${next.end.status}`);
    const sessionRows = (await slice.workers()).filter(w =>
      /session/.test(w.debugLabel ?? ''),
    );
    const halted = sessionRows.filter(w => w.failure);
    if (halted.length) problems.push(`session vat halted: ${halted.length}`);
    if (problems.length) ownFailures += 1;
    await single(metric, ms, {
      extra: {
        status: r.end.status,
        reason: r.end.reason ?? null,
        ...facts,
        problems,
        ok: problems.length === 0,
        nextTurn: next.end.status,
      },
    });
  };

  await probe('tooBig.calls300', 'probe calls300', async r => {
    const problems = [];
    if (r.end.status !== 'failed' || r.end.reason !== texts.frameLimit)
      problems.push(`expected failed with the frame-limit text`);
    return { problems };
  });
  await probe('tooBig.reply1m', 'probe reply1m', async (r, records) => {
    const problems = [];
    const settled = records.find(x => x.kind === 'round-settled');
    if (r.end.status !== 'completed') problems.push('not completed');
    let units = 0;
    if (settled && isStaged(settled.text)) {
      const text = await readField(content, settled.text);
      units = text.length;
      if (text !== '0123456789abcdef'.repeat(1024 * 64))
        problems.push('reply text differs');
    } else problems.push('reply not staged');
    return { problems, units };
  });
  await probe('tooBig.echo10m', 'probe echo10m', async (r, records) => {
    const result = records.find(x => x.kind === 'tool-result');
    const problems = [];
    if (r.end.status !== 'completed') problems.push('not completed');
    if (!result?.failed)
      problems.push('a 10 MiB echo request should be an argument error');
    return {
      problems,
      result: isStaged(result?.result)
        ? result.result.preview
        : String(result?.result).slice(0, 200),
    };
  });
  await probe('tooBig.echo1m', 'probe echo1m', async (r, records) => {
    const result = records.find(x => x.kind === 'tool-result');
    const problems = [];
    if (r.end.status !== 'completed') problems.push('not completed');
    const text = await readField(content, result?.result);
    if (text.length > limits.toolOutputUnits) problems.push('not cut');
    if (!text.endsWith(textOf.truncationMarker(limits.echoMaxUnits)))
      problems.push('no R4-46 marker');
    return { problems, resultUnits: text.length };
  });
  await probe('tooBig.exec300k', 'probe exec300k', async (r, records) => {
    const result = records.find(x => x.kind === 'tool-result');
    const problems = [];
    if (r.end.status !== 'completed') problems.push('not completed');
    if (!String(result?.result).includes('exec source too large'))
      problems.push(`result ${String(result?.result).slice(0, 200)}`);
    return { problems };
  });
  const execBefore = new Set((await execRows()).map(w => w.workerId));
  await probe('tooBig.keys60k', 'probe keys60k', async (r, records) => {
    const result = records.find(x => x.kind === 'tool-result');
    const text = String(
      isStaged(result?.result) ? result.result.preview : result?.result,
    );
    const problems = [];
    if (r.end.status !== 'completed') problems.push('not completed');
    // The vat does not halt (the engine's RangeError is catchable, J-0333):
    // it answers `exhausted` and the session retires it (M1b QC, J-0390).
    const halted = text === textOf.errorResult(texts.execTerminated);
    const exhausted = text === textOf.errorResult(texts.execExhausted);
    if (!halted && !exhausted)
      problems.push('the exec vat neither halted nor answered exhausted');
    // Retired: an exec vat of before is gone.
    await new Promise(resolve => setTimeout(resolve, 2000));
    const now = new Set((await execRows()).map(w => w.workerId));
    const retired = [...execBefore].filter(id => !now.has(id)).length;
    if (retired === 0) problems.push('the exec vat was not retired');
    return {
      problems,
      result: text.slice(0, 300),
      execVatsRetired: retired,
    };
  });
  // After the keys probe: how a call on that scope behaves now.
  const afterKeys = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await execTurn(main.session, main.live, 'exec trivial');
    afterKeys.push(/** @type {number} */ (r.callMs));
  }
  await stats('tooBig.keys60k.nextTrivial', afterKeys, {
    extra: {
      what: 'exec.trivial on the same session after the 60,000-key probe (a fresh scope since J-0390; before, the surviving vat with an exhausted name table took 928-951 ms, J-0333)',
    },
  });
  await main.live.stop();
});

if (ownFailures) process.exitCode = 1;
