// @ts-check
/**
 * Perf check "restart with a crashing vat" (upstream PR 1667, merge
 * 3f2b90954e; architecture.md section 11 "restart to serving"): what the
 * crash bound costs the harness at restart, and what a vat given up on looks
 * like afterwards.
 *
 *   cd packages/thixotrope-harness && node perf/crash.perf.mjs
 *
 * State: a copy of the base template (test/template/index.js), served by the
 * supervisor child of scripts/serve.mjs with idleSleepMs 2,000. Ten small
 * durable vats are made through the workspace's worker controller (`vats`):
 * `h0`..`h8` and one vat to crash. `h0` holds the crashing vat's object.
 *
 * Phases:
 *
 * (a) `h0` calls the crashing vat (`hang()`, an answer that never settles),
 *     so the frame is in that vat's journal past its snapshot; the
 *     supervisor is SIGKILLed while the vat is still awake. At the restart a
 *     killer SIGKILLs every worker process of that vat as soon as it appears, so the startup
 *     replay crashes on every attempt (`heaps/incarnations/vat-<label>-`
 *     names the incarnation, pkg/src/ironhorse/ironhorse-engine.js). Measured: time to "serving", when the
 *     control socket first accepts a connection, the kills and the
 *     supervisor's crash log lines, what `h0`'s pending call sees, what a
 *     new call into the vat sees, and the first call into each healthy vat.
 *     Bound: THIXOTROPE_MAX_DELIVERY_ATTEMPTS 5 (the harness default).
 * (d) The vat given up on: its status row, `retire()` through its facade,
 *     the disk it held before and after, and a replacement vat.
 * (b) As (a) with the replacement and the bound 2.
 * (e) Without a restart: `h0` calls a vat whose worker is killed on sight
 *     (given up after its retries), and a vat whose call runs away (a halt
 *     at the crank budget); does `h0`'s pending call break, and with what?
 * (c) A healthy restart with 10 sleeping vats (clean twice, SIGKILL once),
 *     against J-0185 and S6.
 *
 * Every row is one JSON line (PERF_OUT appends them to a file). The restart
 * rows carry the architecture budget of 15 s.
 */
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import {
  crankBudget,
  du,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
  single,
} from './_harness.mjs';

// After the harness module (it locks down first, J-0131).
const { E } = await import('@endo/far');
const { spawnSupervisorChild } = await import('../scripts/serve.mjs');
const { connect, copyState, ensureTemplate, killStrays, TEMPLATE_WORKSPACE } =
  await import('../test/template/index.js');

const run = promisify(execFile);

/** Architecture section 11: restart to serving. */
const RESTART_BUDGET_MS = 15_000;
const IDLE_MS = 2000;
const HEALTHY = 9;
/** How often the killer looks for the crashing vat's worker. */
const KILL_POLL_MS = Number(process.env.CRASH_KILL_POLL_MS ?? 20);
/** Compute frames left in the crashing vat's journal, and their size. */
const BURN_FRAMES = Number(process.env.CRASH_BURN_FRAMES ?? 8);
const BURN_N = Number(process.env.CRASH_BURN_N ?? 200_000);

/** @param {number} ms */
const round1 = ms => +ms.toFixed(1);

/**
 * The vat program: a small object that can hold a target, call it with an
 * answer that never settles, and report what became of that call.
 */
const VAT_PROGRAM = `(() => {
  let target;
  const outcomes = new Map();
  return Far('CrashProbe', {
    ping: () => 1,
    setTarget: t => { target = t; return true; },
    hang: () => new Promise(() => {}),
    burn: n => { let x = 0; for (let i = 0; i < n; i += 1) x = (x + i) % 1000003; return x; },
    spin: () => { for (;;) { /* runaway: halts at the crank budget */ } },
    callTarget: (id, method = 'hang') => {
      outcomes.set(id, 'pending');
      E(target)[method]().then(
        () => { outcomes.set(id, 'resolved'); },
        e => { outcomes.set(id, 'broken: ' + String(e && e.message)); },
      );
      return true;
    },
    outcome: id => outcomes.get(id) ?? 'none',
  });
})()`;

/**
 * Pids of processes whose command line contains `needle`.
 * @param {string} needle
 */
const pidsNaming = async needle => {
  const { stdout } = await run('ps', ['-axo', 'pid=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes(needle))
    .map(line => Number(line.slice(0, line.indexOf(' '))));
};

/**
 * Kill every process naming `needle` as soon as it appears, until stopped.
 * @param {string} needle
 * @param {number} t0 performance.now() the times are relative to
 */
const startKiller = (needle, t0) => {
  /** @type {{ pid: number, ms: number }[]} */
  const kills = [];
  const seen = new Set();
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      const pids = await pidsNaming(needle).catch(() => []);
      for (const pid of pids) {
        if (!seen.has(pid)) {
          seen.add(pid);
          try {
            process.kill(pid, 'SIGKILL');
            kills.push({ pid, ms: round1(performance.now() - t0) });
          } catch {
            // Gone already.
          }
        }
      }

      await delay(KILL_POLL_MS);
    }
  })();
  return {
    kills,
    stop: async () => {
      stopped = true;
      await done;
    },
  };
};

/**
 * Try to connect to the control socket every `everyMs` until it works.
 * @param {string} root
 * @param {number} t0
 * @param {number} [everyMs]
 */
const startProber = (root, t0, everyMs = 250) => {
  let stopped = false;
  let tries = 0;
  /** @type {number | null} */
  let firstOkMs = null;
  /** @type {string | null} */
  let lastError = null;
  const done = (async () => {
    while (!stopped && firstOkMs === null) {
      tries += 1;
      try {
        const client = await Promise.race([
          connect(root),
          delay(2000).then(() => {
            throw Error('connect timed out');
          }),
        ]);
        firstOkMs = round1(performance.now() - t0);
        client.close();
      } catch (error) {
        lastError = String(/** @type {Error} */ (error)?.message).slice(0, 120);
      }

      await delay(everyMs);
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await done;
      return { tries, firstOkMs, lastError };
    },
  };
};

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} [timeoutMs]
 */
const attempt = async (fn, timeoutMs = 60_000) => {
  const t0 = performance.now();
  try {
    const value = await Promise.race([
      fn(),
      delay(timeoutMs).then(() => {
        throw Error(`no answer in ${timeoutMs} ms`);
      }),
    ]);
    return { ok: true, ms: round1(performance.now() - t0), value };
  } catch (error) {
    return {
      ok: false,
      ms: round1(performance.now() - t0),
      error: String(/** @type {Error} */ (error)?.message ?? error).slice(
        0,
        300,
      ),
    };
  }
};

/** @param {number[]} values */
const summary = values => {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  return {
    n: s.length,
    median: round1(s[Math.floor(s.length / 2)]),
    max: round1(s[s.length - 1]),
    min: round1(s[0]),
  };
};

await runPerf('crash', async ({ root }) => {
  const budget = BigInt(crankBudget);
  const template = await ensureTemplate({ crankBudget: budget });
  await copyState(template.dir, root);

  /** @type {import('../scripts/serve.mjs').SupervisorChild | undefined} */
  let started;
  /** @type {any} */
  let client;
  /** @type {{ ms: number, text: string }[]} */
  let logLines = [];
  /** The crash bound of the supervisor now serving. */
  let currentBound = 0;

  /**
   * Serve the state with a crash bound; collect the supervisor's crash log
   * lines with their times.
   * @param {number} maxDeliveryAttempts
   * @param {number} t0
   */
  const serve = async (maxDeliveryAttempts, t0) => {
    logLines = [];
    currentBound = maxDeliveryAttempts;
    started = spawnSupervisorChild(
      {
        statePath: root,
        crankBudget: budget,
        idleSleepMs: IDLE_MS,
        maxDeliveryAttempts,
      },
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let partial = '';
    started.child.stderr?.on('data', bytes => {
      const lines = `${partial}${String(bytes)}`.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (
          /crashed while resuming|quarantined|retry after a crash|crash count/.test(
            line,
          )
        )
          logLines.push({
            ms: round1(performance.now() - t0),
            text: line.slice(0, 240),
          });
      }
    });
    await started.served;
    const servedMs = round1(performance.now() - t0);
    client = await connect(root, { workspace: TEMPLATE_WORKSPACE });
    // Presences die with the client that held them: look the controller up
    // again on every new connection.

    if (vats !== undefined) vats = await client.call('lookup', 'vats');
    return servedMs;
  };
  const closeClient = () => {
    try {
      client?.close();
    } catch {
      // Gone with its supervisor.
    }
    client = undefined;
  };
  const kill = async () => {
    closeClient();
    if (started?.running()) started.child.kill('SIGKILL');
    await started?.exited;
  };
  const stop = async () => {
    closeClient();
    if (!started?.running()) return;
    started.child.kill('SIGTERM');
    await Promise.race([
      started.exited,
      delay(60_000).then(() => {
        started?.child.kill('SIGKILL');
        return started?.exited;
      }),
    ]);
  };

  /** @returns {Promise<any[]>} */
  const workers = async () => (await client.call('status')).workers;
  /** @param {any} w */
  const uncheckpointed = w =>
    Number(w.snapshot?.cut ?? 0) < Number(w.journalLength);
  /**
   * @param {string[]} ids
   * @param {number} [timeoutMs]
   */
  const untilAsleep = async (ids, timeoutMs = 120_000) => {
    const t0 = performance.now();
    const want = new Set(ids);
    for (;;) {
      const rows = (await workers()).filter(w => want.has(w.workerId));
      if (
        rows.length === want.size &&
        rows.every(w => !w.awake && !uncheckpointed(w))
      )
        return round1(performance.now() - t0);
      if (performance.now() - t0 > timeoutMs)
        throw Error(`vats did not sleep in ${timeoutMs} ms`);

      await delay(250);
    }
  };

  /** @type {Map<string, { label: string, workerId: string }>} */
  const vatsByLabel = new Map();
  /** @type {any} */
  let vats;

  /** @param {string} label */
  const makeVat = async label => {
    const facade = await E(vats).createWorker(label);
    const workerId = await E(facade).getId();
    const obj = await E(facade).evaluate(VAT_PROGRAM, {});
    await client.call('keep', `o-${label}`, obj);
    await client.call('keep', `f-${label}`, facade);
    vatsByLabel.set(label, { label, workerId });
    return { label, workerId };
  };
  /** @param {string} label */
  const objOf = label => client.call('lookup', `o-${label}`);

  /**
   * The disk a worker holds: its store directory and its snapshot image.
   * @param {string} workerId
   */
  const workerDisk = async workerId => {
    const dir = path.join(root, 'workers', workerId);
    const kib = await stat(dir)
      .then(() => du(dir))
      .catch(() => null);
    const row = (await workers()).find(w => w.workerId === workerId);
    const ref = row?.snapshot?.ref;
    const image =
      typeof ref === 'string'
        ? await readdir(path.join(root, 'heaps', 'snapshots'))
            .then(names => names.filter(name => name.startsWith(ref)))
            .catch(() => [])
        : [];
    return { storeKiB: kib, snapshotFiles: image.length };
  };

  /**
   * One crashing restart: `h0` calls the bad vat, the supervisor is
   * SIGKILLed while the bad vat is awake with its call unsnapshotted, and
   * it is served again under `bound` with the bad vat's workers killed on
   * sight.
   * @param {string} badLabel
   * @param {number} bound
   * @param {string} phase
   */
  const crashingRestart = async (badLabel, bound, phase) => {
    const bad = vatsByLabel.get(badLabel);
    if (!bad) throw Error(`no vat ${badLabel}`);
    const h0 = await objOf('h0');
    await E(h0).setTarget(await objOf(badLabel));
    await untilAsleep([...vatsByLabel.values()].map(v => v.workerId));
    const callId = `call-${phase}`;
    await E(h0).callTarget(callId);
    // Frames that cost compute, so that a replay lasts longer than the
    // killer takes to see the worker: a retry that completes is progress,
    // and the count starts afresh (J-9047).
    const badObj = await objOf(badLabel);
    const burnMs = [];
    for (let i = 0; i < BURN_FRAMES; i += 1) {
      const tBurn = performance.now();

      await E(badObj).burn(BURN_N);
      burnMs.push(performance.now() - tBurn);
    }
    // Wait until the bad vat has the call in its journal past its snapshot.
    const tWait = performance.now();
    /** @type {any} */
    let badRow;
    for (;;) {
      badRow = (await workers()).find(w => w.workerId === bad.workerId);
      if (badRow && uncheckpointed(badRow)) break;
      if (performance.now() - tWait > 5000)
        throw Error(`${badLabel} has no unsnapshotted journal`);

      await delay(20);
    }
    const atKill = {
      badAwake: badRow.awake,
      badJournal: Number(badRow.journalLength),
      badCut: Number(badRow.snapshot?.cut ?? 0),
      sinceCallMs: round1(performance.now() - tWait),
      burnFrames: BURN_FRAMES,
      burnN: BURN_N,
      burnMs: summary(burnMs),
    };
    await kill();
    await killStrays(root);

    const t0 = performance.now();
    const killer = startKiller(
      `${root}/heaps/incarnations/vat-${badLabel}-`,
      t0,
    );
    const prober = startProber(root, t0);
    const servedMs = await serve(bound, t0);
    const probe = await prober.stop();
    // Keep killing a little after serving: a retry still owed would show.
    await delay(1500);
    await killer.stop();

    const rows = await workers();
    const badAfter = rows.find(w => w.workerId === bad.workerId);
    // h0's pending call: wait for it to settle (h0 again: the old client's
    // presences died with it).
    const h0Again = await objOf('h0');
    const tOutcome = performance.now();
    let outcome = 'none';
    for (;;) {
      outcome = String(await E(h0Again).outcome(callId));
      if (outcome !== 'pending' || performance.now() - tOutcome > 30_000) break;

      await delay(250);
    }
    const outcomeWaitMs = round1(performance.now() - tOutcome);
    const directCall = await attempt(
      async () => E(await objOf(badLabel)).ping(),
      30_000,
    );
    const healthyCalls = [];
    for (let i = 1; i < HEALTHY; i += 1) {
      const result = await attempt(async () => E(await objOf(`h${i}`)).ping());
      healthyCalls.push(result);
    }
    const row = {
      metric: `crash.restart.${phase}`,
      unit: 'ms',
      value: servedMs,
      maxDeliveryAttempts: bound,
      atKill,
      servedMs,
      controlSocket: probe,
      kills: killer.kills,
      killPollMs: KILL_POLL_MS,
      crashLog: logLines,
      bad: {
        failure: badAfter?.failure ?? null,
        crash: badAfter?.crash ?? null,
        awake: badAfter?.awake ?? null,
        journalLength: badAfter?.journalLength ?? null,
        snapshotCut: badAfter?.snapshot?.cut ?? null,
      },
      pendingCaller: { outcome, settledWithinMs: outcomeWaitMs },
      directCall,
      healthyFirstCall: {
        ok: healthyCalls.filter(r => r.ok).length,
        of: healthyCalls.length,
        ms: summary(healthyCalls.map(r => r.ms)),
        errors: healthyCalls.filter(r => !r.ok).map(r => r.error),
      },
      awakeAfter: rows.filter(w => w.awake).length,
    };
    await single(row.metric, servedMs, {
      budget: { value: RESTART_BUDGET_MS },
      extra: Object.fromEntries(
        Object.entries(row).filter(
          ([k]) => !['metric', 'value', 'unit'].includes(k),
        ),
      ),
    });
    return row;
  };

  /**
   * A healthy restart (clean or SIGKILL) with every vat asleep.
   * @param {'clean' | 'sigkill'} how
   */
  const healthyRestart = async how => {
    await untilAsleep((await workers()).map(w => w.workerId));
    if (how === 'sigkill') {
      await kill();
      await killStrays(root);
    } else await stop();
    const t0 = performance.now();
    const servedMs = await serve(5, t0);
    const connectedMs = round1(performance.now() - t0);
    const rows = await workers();
    const ids = new Set([...vatsByLabel.values()].map(v => v.workerId));
    const mine = rows.filter(w => ids.has(w.workerId));
    await single(`crash.restart.healthy.${how}`, servedMs, {
      budget: { value: RESTART_BUDGET_MS },
      extra: {
        connectedMs,
        sleepingVats: mine.length,
        vatsWoken: mine.filter(w => w.awake).length,
        daemonWorkers: rows.length,
        awakeWorkers: rows.filter(w => w.awake).length,
        maxDeliveryAttempts: 5,
        stateKiB: du(root),
      },
    });
    return servedMs;
  };

  try {
    const t0 = performance.now();
    const firstServedMs = await serve(5, t0);
    await emit({
      metric: 'crash.setup',
      template: template.key,
      templateBuilt: template.built,
      servedMs: firstServedMs,
      idleSleepMs: IDLE_MS,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
    await client.call('evaluate', "(inventory.set('vats', vats), true)");
    vats = await client.call('lookup', 'vats');
    const tMake = performance.now();
    const labels = [
      ...Array.from({ length: HEALTHY }, (_, i) => `h${i}`),
      'crasha',
    ];
    // Four at a time, as S6 does.
    let next = 0;
    const lane = async () => {
      while (next < labels.length) {
        const label = labels[next];
        next += 1;

        await makeVat(label);
      }
    };
    await Promise.all(Array.from({ length: 4 }, lane));
    await emit({
      metric: 'crash.makeVats',
      vats: labels.length,
      ms: round1(performance.now() - tMake),
      loadAvg: loadAvg(),
    });

    // (a) bound 5.
    const a = await crashingRestart('crasha', 5, 'bound5');

    // (d) the vat given up on.
    const badA = /** @type {{ workerId: string }} */ (
      vatsByLabel.get('crasha')
    );
    const rowBefore = (await workers()).find(w => w.workerId === badA.workerId);
    const diskBefore = await workerDisk(badA.workerId);
    const rootBeforeKiB = du(root);
    const facade = await client.call('lookup', 'f-crasha');
    const retired = await attempt(() => E(facade).retire());
    await delay(500);
    const rowAfter = (await workers()).find(w => w.workerId === badA.workerId);
    const diskAfter = await workerDisk(badA.workerId);
    const rootAfterKiB = du(root);
    const callAfterRetire = await attempt(
      async () => E(await objOf('crasha')).ping(),
      30_000,
    );
    vatsByLabel.delete('crasha');
    const tReplace = performance.now();
    await makeVat('crashb');
    const replaceMs = round1(performance.now() - tReplace);
    const replacementPing = await attempt(async () =>
      E(await objOf('crashb')).ping(),
    );
    await emit({
      metric: 'crash.givenUp',
      statusRow: rowBefore
        ? {
            failure: rowBefore.failure ?? null,
            crash: rowBefore.crash ?? null,
            awake: rowBefore.awake,
            journalLength: rowBefore.journalLength,
            snapshotCut: rowBefore.snapshot?.cut ?? null,
            debugLabel: rowBefore.debugLabel ?? null,
          }
        : null,
      retire: retired,
      listedAfterRetire: rowAfter !== undefined,
      diskBefore,
      diskAfter,
      rootKiB: { before: rootBeforeKiB, after: rootAfterKiB },
      callAfterRetire,
      replacement: {
        label: 'crashb',
        makeMs: replaceMs,
        ping: replacementPing,
      },
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });

    // (b) bound 2.
    const b = await crashingRestart('crashb', 2, 'bound2');
    const facadeB = await client.call('lookup', 'f-crashb');
    await attempt(() => E(facadeB).retire());
    vatsByLabel.delete('crashb');

    // (e) Without a restart: does a guest vat's pending call into a vat that
    // is given up on (or halts) break? (a) and (b) found h0's call still
    // pending 30 s after the give-up at startup.
    for (const [label, how] of /** @type {const} */ ([
      ['livec', 'crash'],
      ['liveh', 'halt'],
    ])) {
      const made = await makeVat(label);

      const h0 = await objOf('h0');

      await E(h0).setTarget(await objOf(label));

      await untilAsleep([...vatsByLabel.values()].map(v => v.workerId));
      const tLive = performance.now();
      const killer =
        how === 'crash'
          ? startKiller(`${root}/heaps/incarnations/vat-${label}-`, tLive)
          : undefined;
      const callId = `call-live-${how}`;

      await E(h0).callTarget(callId, how === 'crash' ? 'hang' : 'spin');
      /** @type {number | null} */
      let failureMs = null;
      /** @type {number | null} */
      let settledMs = null;
      let outcome = 'pending';
      /** @type {any} */
      let row;
      while (performance.now() - tLive < 90_000) {
        row = (await workers()).find(w => w.workerId === made.workerId);
        if (failureMs === null && row?.failure)
          failureMs = round1(performance.now() - tLive);

        outcome = String(await E(h0).outcome(callId));
        if (outcome !== 'pending') {
          settledMs = round1(performance.now() - tLive);
          break;
        }
        if (
          failureMs !== null &&
          performance.now() - tLive - failureMs > 30_000
        )
          break;

        await delay(250);
      }

      await killer?.stop();

      const directCall = await attempt(
        async () => E(await objOf(label)).ping(),
        30_000,
      );

      await emit({
        metric: `crash.live.${how}`,
        maxDeliveryAttempts: currentBound,
        kills: killer?.kills ?? [],
        failure: row?.failure ?? null,
        failureSeenMs: failureMs,
        pendingCaller: { outcome, settledMs },
        directCall,
        ...(await runIdentity()),
        crankBudget,
        loadAvg: loadAvg(),
      });

      const facadeLive = await client.call('lookup', `f-${label}`);

      await attempt(() => E(facadeLive).retire());
      vatsByLabel.delete(label);
    }

    // (c) healthy restarts with 10 sleeping vats.
    await makeVat(`h${HEALTHY}`);
    const healthy = [];
    for (const how of /** @type {const} */ (['clean', 'clean', 'sigkill'])) {
      healthy.push({ how, servedMs: await healthyRestart(how) });
    }
    await emit({
      metric: 'crash.summary',
      bound5ServedMs: a.servedMs,
      bound2ServedMs: b.servedMs,
      healthy,
      startupWaitedMs: {
        bound5: round1(a.servedMs - Math.min(...healthy.map(h => h.servedMs))),
        bound2: round1(b.servedMs - Math.min(...healthy.map(h => h.servedMs))),
      },
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  } finally {
    await stop().catch(() => kill());
    await killStrays(root);
  }
});
