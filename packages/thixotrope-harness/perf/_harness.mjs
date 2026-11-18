// @ts-check
/**
 * Shared perf harness (architecture.md section 11), derived from the survey
 * baseline `designs/survey/baseline.mjs`.
 *
 * A perf script `perf/<feature>.perf.mjs` does:
 *
 *   import { runPerf, stats } from './_harness.mjs';
 *   await runPerf('feature', async ({ provision }) => {
 *     const run = await provision();
 *     ...
 *     stats('feature.op', samples, { budget: { median: 250 }, ops, before, after });
 *   });
 *
 * `runPerf` takes the run lock (scripts/run-lock.mjs) in exclusive mode,
 * said explicitly rather than read from the command line's perf file name;
 * `--shared` among this process's arguments takes one shared slot instead
 * (a builder's smoke run, process.md 2) and marks every row `underLoad`. It
 * keeps state in `tmp/pf<pid>` (removed in `finally` unless KEEP_STATE=1),
 * and sets the exit code to 1 when any row missed its budget: a median (or
 * p95, p99, max, value) over 1.25 x budget, or deliveries per op over the
 * budget.
 *
 * Every row is one JSON line on stdout (and appended to PERF_OUT when set):
 *   {"metric","unit","window","samples","n","median","p95","p99","min",
 *    "max","deliveries":{"count","perOp"},"hubJsonBytes","budget","pass",
 *    "commit","workerSha256","crankBudget","loadAvg","underLoad", ...}
 *
 * `window` (the measured window, process.md 3: ms, or `{ ms, elapsedMs }`)
 * and `samples` (how many samples it held) appear only when the caller
 * passes them to `stats` or `single`, untouched: a check measured as a rate
 * over a fixed window reports both.
 *
 * Environment: IDLE_MS (idleSleepMs, default 3,600,000 so nothing sleeps
 * during a measurement), SNAP_EVERY (default 256), THIXOTROPE_CRANK_BUDGET
 * (default scripts/serve.mjs DEFAULT_CRANK_BUDGET), KEEP_STATE, PERF_OUT,
 * PERF_TEMPLATE=1 (start from the cached base state template, as
 * integration tests do, instead of fresh state).
 *
 * State starts as integration tests start it (test/template/index.js
 * `copyState`/`ensureTemplate`, and the supervisor child of scripts/serve.mjs);
 * each `provision()` emits `<feature>.provision` with how long that took.
 *
 * Run all perf scripts, one at a time under the run lock:
 *   node perf/_harness.mjs [--shared] [feature ...]
 */
import '../scripts/_init.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, readdirSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import url from 'node:url';

import { limits as harnessLimits } from '../config/defaults.js';
import { acquireRunLock } from '../scripts/run-lock.mjs';
import {
  DEFAULT_CRANK_BUDGET,
  parseCrankBudget,
  serveHarness,
} from '../scripts/serve.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const harnessRoot = path.resolve(here, '..');
const repoRoot = path.resolve(harnessRoot, '..', '..');
/** The release worker the supervisor runs unless THIXOTROPE_IRONHORSE_WORKER says otherwise. */
export const workerBinary =
  process.env.THIXOTROPE_IRONHORSE_WORKER ??
  path.join(repoRoot, 'target', 'release', 'thixotrope-ironhorse-worker');

/** Budgets fail at more than this multiple (milestones.md conventions). */
export const BUDGET_SLACK = 1.25;

/** Idle sleep for perf supervisors: long by default so no vat checkpoints mid-measurement. */
export const idleSleepMs = Number(process.env.IDLE_MS ?? 3_600_000);
export const snapshotEveryDeliveries = Number(process.env.SNAP_EVERY ?? 256);
/** The crank budget perf runs use (string, decimal). */
export const crankBudget = String(
  process.env.THIXOTROPE_CRANK_BUDGET
    ? parseCrankBudget(
        'THIXOTROPE_CRANK_BUDGET',
        process.env.THIXOTROPE_CRANK_BUDGET,
      )
    : DEFAULT_CRANK_BUDGET,
);

let failures = 0;

/**
 * The run-lock mode of a perf process: exclusive unless its arguments hold
 * `--shared` (process.md 2: exclusive mode is for recorded numbers only).
 * @param {readonly string[]} [argv]
 * @returns {'shared' | 'exclusive'}
 */
export const perfLockMode = (argv = process.argv) =>
  argv.includes('--shared') ? 'shared' : 'exclusive';

/** The mode `runPerf` took the lock in (undefined outside `runPerf`). */
/** @type {'shared' | 'exclusive' | undefined} */
let lockMode;
/** Rows that missed a budget so far in this process. */
export const failureCount = () => failures;

/** @param {Record<string, unknown>} row */
export const emit = row => {
  const line = `${JSON.stringify(row)}\n`;
  process.stdout.write(line);
  if (process.env.PERF_OUT) appendFileSync(process.env.PERF_OUT, line);
  return row;
};

/** @param {number} value */
const round3 = value => +value.toFixed(3);

/**
 * @param {number[]} samples
 */
export const summarize = samples => {
  if (!samples.length) throw Error('summarize needs at least one sample');
  const s = [...samples].sort((a, b) => a - b);
  /** @param {number} p */
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    median: round3(q(0.5)),
    p95: round3(q(0.95)),
    p99: round3(q(0.99)),
    min: round3(s[0]),
    max: round3(s[s.length - 1]),
  };
};

/**
 * @typedef {object} Budget
 * @property {number} [median]
 * @property {number} [p95]
 * @property {number} [p99]
 * @property {number} [max]
 * @property {number} [value] for single-shot metrics
 * @property {number} [deliveriesPerOp] compared exactly, no slack
 */

/**
 * Compare observed numbers with a budget: latencies fail above
 * BUDGET_SLACK x budget, deliveries per op above the budget itself.
 * @param {Record<string, any>} observed
 * @param {Budget | undefined} budget
 * @returns {{ pass: boolean | null, exceeded: string[] }} pass is null without a budget
 */
export const checkBudget = (observed, budget) => {
  if (!budget) return { pass: null, exceeded: [] };
  const exceeded = [];
  for (const key of /** @type {const} */ ([
    'median',
    'p95',
    'p99',
    'max',
    'value',
  ])) {
    const limit = budget[key];
    const seen = observed[key];
    if (limit === undefined) {
      // No budget for this statistic.
    } else if (typeof seen !== 'number') exceeded.push(`${key}: not measured`);
    else if (seen > limit * BUDGET_SLACK)
      exceeded.push(`${key}: ${seen} > ${BUDGET_SLACK} x ${limit}`);
  }
  if (budget.deliveriesPerOp !== undefined) {
    const seen = observed.deliveries?.perOp;
    if (typeof seen !== 'number')
      exceeded.push('deliveriesPerOp: not measured');
    else if (seen > budget.deliveriesPerOp)
      exceeded.push(`deliveriesPerOp: ${seen} > ${budget.deliveriesPerOp}`);
  }
  return { pass: exceeded.length === 0, exceeded };
};

/** Machine load average (1, 5, 15 minutes). */
export const loadAvg = () => os.loadavg().map(v => +v.toFixed(2));

/** @type {{ commit: string, workerSha256: string | null, slotCeiling: number, gcPolicy: string, hubStore: string } | undefined} */
let identity;
/** The commit (with "-dirty" for local changes) and the worker's SHA-256. */
export const runIdentity = async () => {
  if (identity) return identity;
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], {
      cwd: harnessRoot,
    })
      .toString()
      .trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], {
      cwd: repoRoot,
    })
      .toString()
      .trim();
    if (dirty) commit += '-dirty';
  } catch {
    // Not a git checkout: leave "unknown".
  }
  /** @type {string | null} */
  let workerSha256 = null;
  try {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) =>
      createReadStream(workerBinary)
        .on('data', chunk => hash.update(chunk))
        .on('end', resolve)
        .on('error', reject),
    );
    workerSha256 = hash.digest('hex');
  } catch {
    // No worker built: recorded as null.
  }
  // The served daemon's slot ceiling (scripts/serve.mjs default, M1b QC).
  const slotCeiling = Number(
    process.env.THIXOTROPE_SLOT_CEILING ?? harnessLimits.slotCeiling,
  );
  identity = {
    commit,
    workerSha256,
    slotCeiling,
    // The supervisor's defaults when unset (CC-022, CC-024).
    gcPolicy: process.env.THIXOTROPE_GC_POLICY ?? 'allocation',
    hubStore: process.env.THIXOTROPE_HUB_STORE ?? 'log',
  };
  return identity;
};

/**
 * Bytes of the hub's persisted state under a state directory (the log
 * store's image plus log, else the whole-file `hub.json`), or null when
 * there is none yet.
 * @param {string} root
 */
export const hubJsonBytes = async root => {
  for (const dir of [path.join(root, 'heaps'), root]) {
    // The log store (CC-024, the default since 72ef46f905) keeps an image
    // and a log; its hub.json is only a marker that older builds refuse.
    const logged = await Promise.all(
      ['hub-image.json', 'hub-log.jsonl'].map(name =>
        stat(path.join(dir, name)).catch(() => undefined),
      ),
    );
    if (logged.some(info => info?.isFile()))
      return logged.reduce((sum, info) => sum + (info?.size ?? 0), 0);
    const info = await stat(path.join(dir, 'hub.json')).catch(() => undefined);
    if (info?.isFile()) return info.size;
  }
  return null;
};

/**
 * @typedef {Record<string, { count: number, milliseconds: number }>} Timings
 */

/**
 * Engine counter deltas between two `status().timings` readings.
 * @param {Timings} before
 * @param {Timings} after
 */
export const delta = (before, after) =>
  Object.fromEntries(
    Object.keys(after).map(k => [
      k,
      {
        count: after[k].count - (before[k]?.count ?? 0),
        ms: +(after[k].milliseconds - (before[k]?.milliseconds ?? 0)).toFixed(
          1,
        ),
      },
    ]),
  );

/**
 * Durable vat deliveries between two readings, in total and per operation.
 * The engine counts every delivery to every vat, so the reading includes
 * deliveries the measurement did not cause (admin calls, other vats).
 * @param {Timings} before
 * @param {Timings} after
 * @param {number} ops
 */
export const deliveries = (before, after, ops) => {
  const count = after.delivery.count - before.delivery.count;
  return { count, perOp: ops ? +(count / ops).toFixed(3) : null };
};

/**
 * The `window` and `samples` fields of a row, when given.
 * @param {{ window?: unknown, samples?: number }} given
 */
const windowPassThrough = ({ window, samples }) => ({
  ...(window === undefined ? {} : { window }),
  ...(samples === undefined ? {} : { samples }),
});

/**
 * Emit one latency row with the standard context and budget verdict.
 * @param {string} metric
 * @param {number[]} values milliseconds
 * @param {object} [options]
 * @param {Budget} [options.budget]
 * @param {Timings} [options.before] engine timings before the samples
 * @param {Timings} [options.after] engine timings after the samples
 * @param {number} [options.ops] operations the samples cover (default: values)
 * @param {string} [options.root] state directory, for hubJsonBytes
 * @param {unknown} [options.window] the measured window: ms, or
 *   `{ ms, elapsedMs }` as `perf/_window.mjs` builds it (passed through)
 * @param {number} [options.samples] samples the window held (passed through)
 * @param {Record<string, unknown>} [options.extra]
 */
export const stats = async (
  metric,
  values,
  {
    budget,
    before,
    after,
    ops = values.length,
    root,
    window,
    samples,
    extra = {},
  } = {},
) => {
  const summary = summarize(values);
  const row = {
    metric,
    unit: 'ms',
    ...windowPassThrough({ window, samples }),
    ...summary,
    ...(before && after
      ? {
          deliveries: deliveries(before, after, ops),
          engine: delta(before, after),
        }
      : {}),
    ...(root ? { hubJsonBytes: await hubJsonBytes(root) } : {}),
    ...extra,
  };
  return finishRow(row, budget);
};

/**
 * Emit a single-value row (start, restart, install).
 * @param {string} metric
 * @param {number} value milliseconds
 * @param {{ budget?: Budget, window?: unknown, samples?: number, extra?: Record<string, unknown> }} [options]
 *   `window` and `samples` are passed through as for `stats`
 */
export const single = async (
  metric,
  value,
  { budget, window, samples, extra = {} } = {},
) =>
  finishRow(
    {
      metric,
      unit: 'ms',
      ...windowPassThrough({ window, samples }),
      value: round3(value),
      ...extra,
    },
    budget,
  );

/**
 * @param {Record<string, any>} row
 * @param {Budget | undefined} budget
 */
const finishRow = async (row, budget) => {
  const { pass, exceeded } = checkBudget(row, budget);
  if (pass === false) failures += 1;
  return emit({
    ...row,
    ...(budget ? { budget } : {}),
    pass,
    ...(exceeded.length ? { exceeded } : {}),
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
    ...(lockMode === 'shared' ? { underLoad: true } : {}),
  });
};

/**
 * Time one async operation, emitting a single-value row.
 * @template T
 * @param {string} metric
 * @param {() => Promise<T>} fn
 * @param {{ budget?: Budget, extra?: Record<string, unknown> }} [options]
 * @returns {Promise<T>}
 */
export const timed = async (metric, fn, options) => {
  const t = performance.now();
  const value = await fn();
  await single(metric, performance.now() - t, options);
  return value;
};

/** @param {string} root */
export const du = root =>
  Number(execFileSync('du', ['-sk', root]).toString().split('\t')[0]);

/**
 * Resident memory of this state directory's workers.
 * @param {string} root
 */
export const workerRss = root => {
  try {
    const out = execFileSync('ps', ['-axo', 'rss=,command=']).toString();
    const rows = out
      .split('\n')
      .filter(line => line.includes(`${root}/runtime/`))
      .map(line => Number(line.trim().split(/\s+/)[0]));
    return { workers: rows.length, rssKiB: rows.reduce((a, b) => a + b, 0) };
  } catch {
    return {};
  }
};

/**
 * @typedef {object} Provisioned
 * @property {string} root
 * @property {any} client the workspace control client (`call`, `close`)
 * @property {() => Promise<Timings>} counters engine timings now
 * @property {(label: string) => Promise<{ serveMs: number }>} restart clean close and serve again, emitting `<label>.restart`
 * @property {Record<string, unknown>} timings how the state was started:
 *   copyMs (template), servedMs, createWorkspaceMs (fresh), totalMs, and
 *   template / templateBuilt / templateBuildMs for `template: true`
 * @property {() => Promise<void>} close clean stop, then SIGKILL any process still naming the root
 */

/**
 * Start state the way integration tests do (test/template/index.js): with a
 * template, copy it with `copyState` (APFS clone, sockets skipped, root
 * 0700) and select its workspace `w`; without one, serve a fresh directory
 * and create `workspace`. Either way the supervisor is the child process of
 * scripts/serve.mjs `spawnSupervisorChild` (through `serveHarness`): the
 * crank-budget rule, the environment allowlist for adapters, and a stop if
 * this process dies.
 * @param {object} options
 * @param {string} options.root state directory (must not exist with a template)
 * @param {string} [options.workspace] for fresh state (default `bench`)
 * @param {boolean | string | import('../test/template/index.js').Template} [options.template]
 *   true: the base template (`ensureTemplate()`, built once and cached);
 *   a Template from `ensureTemplate`; or a cleanly stopped state directory.
 *   Default: PERF_TEMPLATE=1 means true.
 * @param {number} [options.idleSleepMs]
 * @param {number} [options.snapshotEveryDeliveries]
 * @returns {Promise<Provisioned>}
 */
export const provision = async ({
  root,
  workspace: freshWorkspace = 'bench',
  template = process.env.PERF_TEMPLATE === '1',
  idleSleepMs: idle = idleSleepMs,
  snapshotEveryDeliveries: snapshotEvery = snapshotEveryDeliveries,
}) => {
  const { TEMPLATE_WORKSPACE, connect, copyState, ensureTemplate, killStrays } =
    await import('../test/template/index.js');
  const tStart = performance.now();
  /** @type {Record<string, unknown>} */
  const timings = {};
  /** @type {string | undefined} */
  let templateDir;
  if (template === true) {
    const made = await ensureTemplate({ crankBudget: BigInt(crankBudget) });
    templateDir = made.dir;
    timings.template = made.key;
    timings.templateBuilt = made.built;
    if (made.built) timings.templateBuildMs = made.buildMs;
  } else if (typeof template === 'string') templateDir = template;
  else if (template) templateDir = template.dir;
  const workspace = templateDir ? TEMPLATE_WORKSPACE : freshWorkspace;
  if (templateDir) {
    const tStep = performance.now();
    await copyState(templateDir, root);
    timings.copyMs = round3(performance.now() - tStep);
  } else await mkdir(root, { recursive: true, mode: 0o700 });
  const serve = () =>
    serveHarness({
      statePath: root,
      crankBudget: BigInt(crankBudget),
      idleSleepMs: idle,
      snapshotEveryDeliveries: snapshotEvery,
    });
  let tStep = performance.now();
  let served = await serve();
  timings.servedMs = round3(performance.now() - tStep);
  if (!templateDir) {
    tStep = performance.now();
    const admin = await connect(root);
    await admin.call('createWorkspace', workspace);
    admin.close();
    timings.createWorkspaceMs = round3(performance.now() - tStep);
  }
  let client = await connect(root, { workspace });
  timings.totalMs = round3(performance.now() - tStart);
  const self = {
    root,
    timings,
    get client() {
      return client;
    },
    counters: async () => (await client.call('status')).timings,
    /** @param {string} label */
    restart: async label => {
      const t0 = performance.now();
      client.close();
      await served.close();
      const closeMs = performance.now() - t0;
      const t1 = performance.now();
      served = await serve();
      const serveMs = performance.now() - t1;
      client = await connect(root, { workspace });
      await single(`${label}.restart`, serveMs, {
        extra: {
          closeMs: round3(closeMs),
          stateKiB: du(root),
          ...workerRss(root),
        },
      });
      return { serveMs };
    },
    close: async () => {
      client.close();
      try {
        await served.close();
      } finally {
        await killStrays(root);
      }
    },
  };
  return self;
};

/**
 * Run one perf feature: run lock, fresh state directory, cleanup, exit code.
 * @param {string} feature
 * @param {(tools: { root: string, provision: (options?: Partial<Parameters<typeof provision>[0]>) => Promise<Provisioned> }) => Promise<void>} fn
 */
export const runPerf = async (feature, fn) => {
  lockMode = perfLockMode();
  const lock = await acquireRunLock({
    label: `perf ${feature}`,
    mode: lockMode,
    onEvent: event =>
      process.stderr.write(`run-lock: ${JSON.stringify(event)}\n`),
  });
  // Unix socket paths are limited to 103 bytes: keep the state path short.
  const root = path.join(harnessRoot, 'tmp', `pf${process.pid}`);
  /** @type {Provisioned[]} */
  const opened = [];
  try {
    await fn({
      root,
      provision: async (options = {}) => {
        const run = await provision({ root, ...options });
        opened.push(run);
        await single(`${feature}.provision`, Number(run.timings.totalMs), {
          extra: { start: run.timings },
        });
        return run;
      },
    });
  } catch (error) {
    failures += 1;
    emit({
      metric: `${feature}.error`,
      error: String(/** @type {Error} */ (error)?.message ?? error).slice(
        0,
        500,
      ),
      pass: false,
    });
  } finally {
    for (const run of opened.reverse()) {
      await run
        .close()
        .catch(error =>
          emit({ metric: `${feature}.closeError`, error: String(error) }),
        );
    }
    if (!process.env.KEEP_STATE)
      await rm(root, { recursive: true, force: true });
    await lock.release();
  }
  if (failures) process.exitCode = 1;
};

/** @param {string[]} args feature names, and `--shared` for every check */
const runAll = async args => {
  const shared = args.includes('--shared');
  const features = args.filter(arg => arg !== '--shared');
  const names = features.length
    ? features
    : readdirSync(here)
        .filter(name => name.endsWith('.perf.mjs'))
        .map(name => name.slice(0, -'.perf.mjs'.length))
        .sort();
  let status = 0;
  for (const name of names) {
    // Each script takes the lock itself; one at a time.
    const code = await new Promise(resolve => {
      const child = spawn(
        process.execPath,
        [path.join(here, `${name}.perf.mjs`), ...(shared ? ['--shared'] : [])],
        { stdio: 'inherit' },
      );
      child.once('exit', exitCode => resolve(exitCode ?? 1));
    });
    if (code !== 0) status = 1;
  }
  process.exitCode = status;
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  await runAll(process.argv.slice(2));
}
