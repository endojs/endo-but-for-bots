// @ts-check
/**
 * Cached state templates for the long-session perf checks (process.md
 * section 3: large states are built by import and cached, never built inside
 * a measured file). Used by `perf/_long-session.mjs` (history, journal) and
 * `perf/throughput.perf.mjs` (M2-P1).
 *
 * Two kinds:
 *
 * - `long`: one session of `turns` synthetic turns (`writeSyntheticExport`,
 *   shape `plain` or `tool`) imported by `importState` into a copy of the
 *   exec template (`execTemplate`), bound to a scripted backend running the
 *   long-session script (J-9383), then up to 16 `startTurn` turns until the
 *   import's sealing backlog is drained, then a clean stop.
 * - `busy`: `sessions` sessions of `turns` turns each in a copy of the m1a
 *   template (`sliceTemplate`), a one-round scripted backend. Built as a
 *   chain of steps of `batch` sessions (10 sessions of 300 plain turns import
 *   in about 5 minutes; 50 at once took 26 minutes, J-9412): step k copies
 *   step k-1 and imports `batch` more sessions, so every step fits the
 *   10-minute box.
 *
 * Where: `<THIX_HARNESS_HOME>/long-session/t<key>` (the stopped state),
 * `t<key>.json` (its description, written last: a template exists when its
 * description does) and `l<key>/` (the scripted backends' event logs: a
 * backend's `logPath` is absolute and persisted in the state, so it names a
 * directory outside every copy). One copy at a time uses a template's logs
 * (`useTemplate` holds `l<key>.use` and truncates them). Templates are shared
 * by every lane on the machine.
 *
 * The key covers the base template's key (worker, boot bundles, crank
 * budget, the persisted serve settings, and the provisioned guest bundles),
 * the spec, LONG_TEMPLATE_VERSION, this file, `scripts/export.mjs`, the
 * synthetic export writer and the adapter's archive store: a change of any
 * of them builds a new template. Nothing deletes old templates
 * automatically; `--prune` removes those no current spec names.
 *
 * Build the templates of a perf check, each in its own boxed step (one child
 * `scripts/run-lock.mjs` per missing template, shared slot, 10-minute box):
 *
 *   node perf/_long-template.mjs history journal throughput   # or: all
 *   node perf/_long-template.mjs --list                       # what exists
 *
 * A perf check never builds one itself (it fails with the command to run)
 * unless LONG_TEMPLATE_BUILD=1.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { cp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import url from 'node:url';

import { limits as harnessLimits } from '../config/defaults.js';

import {
  crankBudget,
  emit,
  harnessRoot,
  loadAvg,
  runIdentity,
} from './_harness.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { acquireRunLock, harnessHome } = await import('../scripts/run-lock.mjs');
const { m1aTemplateOptions, m1bTemplateOptions } =
  await import('../scripts/provision-steps.js');
const { readServeRecord } = await import('../scripts/serve.mjs');
const { killStrays, startFromTemplate, templateKey } =
  await import('../test/template/index.js');
const { makeSlice, round1, sliceTemplate } =
  await import('../test/integration/_m1a-slice.js');
const { execTemplate } = await import('../test/integration/_m1b-exec.js');
const { writeSyntheticExport } =
  await import('../test/integration/_m2-lifecycle.js');
const { importState } = await import('../scripts/export.mjs');
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
const { limits } = await import('../guest/lib/limits.js');

/** Bump when what a template holds changes shape. */
export const LONG_TEMPLATE_VERSION = 1;

const thisFile = url.fileURLToPath(import.meta.url);

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** The script of `perf/crank.perf.mjs` (J-9383's long-session table). */
export const longSessionScript = harden({
  turns: [
    {
      rounds: [
        {
          chunks: [{ text: 'a reply that calls a tool ' }],
          toolCalls: [{ name: 'echo', args: JSON.stringify({ text: 'ok' }) }],
          nativeContext: `native ${'n'.repeat(200)}`,
          usage,
        },
        {
          chunks: [{ text: 'and the closing text of the turn' }],
          nativeContext: `native after ${'m'.repeat(200)}`,
          usage,
        },
      ],
    },
  ],
});

/** One round, a short reply (every turn): the throughput sessions. */
export const busyScript = harden({
  turns: [{ rounds: [{ chunks: [{ text: 'a short reply' }], usage }] }],
});

/**
 * @typedef {{ kind: 'long', turns: number, shape: 'tool' | 'plain' }} LongSpec
 * @typedef {{ kind: 'busy', sessions: number, turns: number, shape: 'tool' | 'plain', batch: number }} BusySpec
 * @typedef {LongSpec | BusySpec} Spec
 */

/**
 * @typedef {object} TemplateMeta
 * @property {number} version
 * @property {Spec} spec
 * @property {string} key
 * @property {string[]} sessionKeys the sessions' keys (text: the template is
 *   reopened by another process, so no presence survives)
 * @property {number} turns session length after the drain (long)
 * @property {number} imported
 * @property {number} warmups
 * @property {string[]} logPaths the scripted backends' logs
 * @property {Record<string, unknown>} import the import's figures
 * @property {number} buildMs
 * @property {string} builtAt
 * @property {string} commit
 */

/** @param {string | undefined} value */
export const shapeOf = value => (value === 'tool' ? 'tool' : 'plain');

/** @param {string} text */
const numbers = text =>
  String(text)
    .split(',')
    .map(Number)
    .filter(n => Number.isSafeInteger(n) && n > 0)
    .sort((a, b) => a - b);

/**
 * The templates each perf check uses (with the same environment variables
 * the check reads).
 * @param {string} name history | journal | throughput | all
 * @param {Record<string, string | undefined>} [env]
 * @returns {Spec[]}
 */
export const specsFor = (name, env = process.env) => {
  /** @type {Spec[]} */
  const out = [];
  if (name === 'history' || name === 'all')
    for (const turns of numbers(env.HISTORY_POINTS ?? '200,1000,5000'))
      out.push({ kind: 'long', turns, shape: shapeOf(env.HISTORY_SHAPE) });
  if (name === 'journal' || name === 'all')
    for (const turns of numbers(env.JOURNAL_POINTS ?? '1000,5000'))
      out.push({ kind: 'long', turns, shape: shapeOf(env.JOURNAL_SHAPE) });
  if (name === 'throughput' || name === 'all') {
    const sessions = Number(env.THROUGHPUT_SESSIONS ?? 50);
    const turns = Number(env.THROUGHPUT_TURNS ?? 300);
    const batch = Number(env.THROUGHPUT_BATCH ?? 10);
    const shape = shapeOf(env.THROUGHPUT_SHAPE);
    for (
      let n = Math.min(batch, sessions);
      ;
      n = Math.min(n + batch, sessions)
    ) {
      out.push({ kind: 'busy', sessions: n, turns, shape, batch });
      if (n === sessions) break;
    }
  }
  if (out.length === 0 && !['history', 'journal', 'throughput'].includes(name))
    throw Error(`unknown template set ${name}`);
  // Unique, in build order.
  const seen = new Set();
  return out.filter(spec => {
    const id = JSON.stringify(spec);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/** @param {Spec} spec */
export const describeSpec = spec =>
  spec.kind === 'long'
    ? `long ${spec.turns} ${spec.shape}`
    : `busy ${spec.sessions}x${spec.turns} ${spec.shape}`;

/**
 * The chain step a busy template copies: the steps are multiples of
 * `batch`, the last one may be a remainder.
 * @param {Spec} spec
 * @returns {BusySpec | undefined}
 */
const previousOf = spec => {
  if (spec.kind !== 'busy' || spec.sessions <= spec.batch) return undefined;
  const rest = spec.sessions % spec.batch;
  return {
    ...spec,
    sessions: spec.sessions - (rest === 0 ? spec.batch : rest),
  };
};

/**
 * Whose log directory a template's backends write to: a chain's first step
 * (every step's backends keep the path they were made with).
 * @param {Spec} spec
 * @returns {Spec}
 */
const logOwnerOf = spec =>
  spec.kind === 'busy'
    ? { ...spec, sessions: Math.min(spec.batch, spec.sessions) }
    : spec;

export const templateHome = () => path.join(harnessHome(), 'long-session');

/** @type {Map<string, Promise<string>>} */
const baseKeys = new Map();
/**
 * The key of the base template a spec starts from, computed without
 * building it.
 * @param {'long' | 'busy'} kind
 */
const baseKeyOf = kind => {
  if (!baseKeys.has(kind))
    baseKeys.set(
      kind,
      (async () => {
        const options =
          kind === 'long'
            ? await m1bTemplateOptions()
            : await m1aTemplateOptions();
        return templateKey({
          crankBudget: harnessLimits.crankBudget,
          id: options.id,
        });
      })(),
    );
  return /** @type {Promise<string>} */ (baseKeys.get(kind));
};

/** @type {Promise<string> | undefined} */
let codeDigest;
/** The code that decides what a template holds. */
const codeDigestOf = () => {
  codeDigest ??= (async () => {
    const hash = createHash('sha256');
    const archive = path.join(
      harnessRoot,
      'resources',
      'agent-host',
      'impl',
      'archive',
    );
    const files = [
      thisFile,
      path.join(harnessRoot, 'scripts', 'export.mjs'),
      path.join(harnessRoot, 'test', 'integration', '_m2-lifecycle.js'),
      ...readdirSync(archive)
        .sort()
        .map(name => path.join(archive, name)),
    ];
    for (const file of files) {
      hash.update(path.relative(harnessRoot, file));
      hash.update('\0');
      hash.update(await readFile(file));
      hash.update('\0');
    }
    return hash.digest('hex');
  })();
  return codeDigest;
};

/**
 * @param {Spec} spec
 * @returns {Promise<string>}
 */
export const specKey = async spec => {
  const hash = createHash('sha256');
  const previous = previousOf(spec);
  hash.update(
    JSON.stringify({
      version: LONG_TEMPLATE_VERSION,
      base: await baseKeyOf(spec.kind),
      code: await codeDigestOf(),
      spec,
      // A chain step names the step it copies.
      previous: previous === undefined ? null : await specKey(previous),
    }),
  );
  return hash.digest('hex').slice(0, 12);
};

/** @param {Spec} spec */
const pathsOf = async spec => {
  const home = templateHome();
  const key = await specKey(spec);
  const logKey = await specKey(logOwnerOf(spec));
  return {
    key,
    dir: path.join(home, `t${key}`),
    meta: path.join(home, `t${key}.json`),
    logs: path.join(home, `l${logKey}`),
    buildLock: path.join(home, `t${key}.build`),
    useLock: path.join(home, `l${logKey}.use`),
  };
};

/**
 * The cached template of a spec, or undefined.
 * @param {Spec} spec
 * @returns {Promise<(TemplateMeta & { dir: string }) | undefined>}
 */
export const findTemplate = async spec => {
  const paths = await pathsOf(spec);
  if (!existsSync(paths.meta) || !existsSync(paths.dir)) return undefined;
  const record = await readServeRecord(paths.dir).catch(() => undefined);
  if (record?.status !== 'clean') return undefined;
  const meta = JSON.parse(await readFile(paths.meta, 'utf8'));
  return { ...meta, dir: paths.dir };
};

/** @param {Spec} spec */
const missingError = spec =>
  Error(
    `no cached template "${describeSpec(spec)}": build it first, in its own boxed step ` +
      `(not part of the measured file): node perf/_long-template.mjs ` +
      `${spec.kind === 'busy' ? 'throughput' : 'history journal'}; or set LONG_TEMPLATE_BUILD=1 to build it here`,
  );

/**
 * Build one template (the caller holds a run-lock slot). Its prerequisite
 * (the previous chain step) must exist.
 * @param {Spec} spec
 * @returns {Promise<TemplateMeta & { dir: string }>}
 */
export const buildTemplate = async spec => {
  const paths = await pathsOf(spec);
  mkdirSync(templateHome(), { recursive: true, mode: 0o700 });
  const lock = await acquireRunLock({
    lockPath: paths.buildLock,
    slots: 1,
    mode: 'shared',
    env: {},
    label: `template ${describeSpec(spec)}`,
  });
  try {
    const cached = await findTemplate(spec);
    if (cached) return cached;
    return await buildUnlocked(spec, paths);
  } finally {
    await lock.release();
  }
};

/**
 * @param {Spec} spec
 * @param {Awaited<ReturnType<typeof pathsOf>>} paths
 */
const buildUnlocked = async (spec, paths) => {
  const { key } = paths;
  const t0 = performance.now();
  const previous = previousOf(spec);
  /** @type {(TemplateMeta & { dir: string }) | undefined} */
  let before;
  if (previous !== undefined) {
    before = await findTemplate(previous);
    if (before === undefined)
      throw Error(
        `template "${describeSpec(spec)}" copies "${describeSpec(previous)}", which is not built`,
      );
  }
  const base =
    spec.kind === 'long' ? await execTemplate() : await sliceTemplate();
  // A short path: the build directory is served (socket paths <= 103 bytes).
  const building = path.join(harnessRoot, 'tmp', `lb${process.pid % 100_000}`);
  await rm(building, { recursive: true, force: true });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const state = await startFromTemplate(
    /** @type {any} */ ({
      dir: before?.dir ?? base.dir,
      crankBudget: base.crankBudget,
    }),
    {
      root: building,
      idleSleepMs: spec.kind === 'long' ? 3_600_000 : 2000,
      maxDeliveryAttempts: 5,
    },
  );
  let moved = false;
  try {
    const slice = await makeSlice(state);
    const step =
      spec.kind === 'busy' ? Math.ceil(spec.sessions / spec.batch) : 1;
    const logPath = path.join(paths.logs, `scripted-${step}.log`);
    writeFileSync(logPath, '', { mode: 0o600 });
    // The long template's drain turns need no digests (m2-interfaces 4.13).
    if (spec.kind === 'long') writeFileSync(`${logPath}.nodigest`, '');
    const backend = await E(slice.admin).makeBackend(
      harden({
        kind: 'scripted',
        label: 'Scripted',
        script: spec.kind === 'long' ? longSessionScript : busyScript,
        logPath,
      }),
    );
    const file = path.join(
      harnessRoot,
      'tmp',
      `lb${process.pid % 100_000}.jsonl`,
    );
    const count =
      spec.kind === 'busy'
        ? spec.sessions - (previousOf(spec)?.sessions ?? 0)
        : 1;
    const written = await writeSyntheticExport(
      file,
      Array.from({ length: count }, (_, i) => ({
        title:
          spec.kind === 'busy'
            ? `busy ${spec.sessions - count + i + 1}`
            : `long ${spec.turns}`,
        turns: spec.turns,
        backendLabel: 'Scripted',
        shape: spec.shape,
      })),
    );
    const result = await importState({
      client: state.client,
      file,
      backends: [backend],
    });
    await rm(file, { force: true });
    const importRow = {
      sessions: result.sessions.length,
      turns: result.turns,
      records: result.records,
      fileBytes: written.bytes,
      ms: Math.round(result.ms),
      turnsPerSecond: round1((result.turns * 1000) / result.ms),
      sealWaits: result.waits,
      sealWaitMs: Math.round(result.waitMs),
    };
    /** @type {string[]} */
    const sessionKeys = [...(before?.sessionKeys ?? [])];
    for (const session of result.sessions)
      sessionKeys.push((await E(session).getInfo()).key);
    let n = spec.turns;
    let warmups = 0;
    if (spec.kind === 'long') {
      // Drain the import's sealing backlog (kept turns <= keep + segment),
      // as a measured window must start from a settled session.
      const [session] = result.sessions;
      const keptBound = limits.archiveKeepTurns + limits.archiveSegmentTurns;
      for (;;) {
        const { archive } = await E(session).getHistoryPage();
        if (n - (archive?.sealedTurns ?? 0) <= keptBound || warmups >= 16)
          break;
        const turn = await E(session).startTurn(
          harden({ text: `c${n + 1}` }),
          Date.now(),
        );
        const status = await E(turn).whenFinished();
        if (status.state !== 'completed')
          throw Error(`drain turn ${n + 1} ended ${status.state}`);
        n += 1;
        warmups += 1;
      }
    }
    await state.stop();
    const record = await readServeRecord(building);
    if (record?.status !== 'clean')
      throw Error(
        `template supervisor did not stop cleanly: ${state.stderrTail().slice(-2000)}`,
      );
    for (const name of ['control.sock', 'peers.sock'])
      await rm(path.join(building, name), { force: true });
    await rm(paths.dir, { recursive: true, force: true });
    try {
      await rename(building, paths.dir);
    } catch {
      // Another volume: copy, then delete.
      await cp(building, paths.dir, { recursive: true });
      await rm(building, { recursive: true, force: true });
    }
    moved = true;
    const { commit } = await runIdentity();
    /** @type {TemplateMeta} */
    const meta = {
      version: LONG_TEMPLATE_VERSION,
      spec,
      key,
      sessionKeys,
      turns: n,
      imported: spec.turns,
      warmups,
      logPaths: [...(before?.logPaths ?? []), logPath],
      import: importRow,
      buildMs: Math.round(performance.now() - t0),
      builtAt: new Date().toISOString(),
      commit,
    };
    // The description last: a template exists once it is written.
    await writeFile(paths.meta, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
    emit({
      metric: `template.${spec.kind}`,
      spec: describeSpec(spec),
      key,
      turns: n,
      warmups,
      import: importRow,
      buildMs: meta.buildMs,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
    return { ...meta, dir: paths.dir };
  } finally {
    await state.cleanup();
    await killStrays(building);
    if (!moved) await rm(building, { recursive: true, force: true });
  }
};

/**
 * A cached template for one measured copy: its description, with its event
 * logs emptied and held for this copy until `release()`.
 * @param {Spec} spec
 */
export const useTemplate = async spec => {
  let meta = await findTemplate(spec);
  if (meta === undefined) {
    if (process.env.LONG_TEMPLATE_BUILD !== '1') throw missingError(spec);
    /** @type {Spec[]} */
    const chain = [spec];
    for (let p = previousOf(spec); p !== undefined; p = previousOf(p))
      chain.unshift(p);
    for (const step of chain)
      if ((await findTemplate(step)) === undefined) await buildTemplate(step);
    meta = /** @type {NonNullable<typeof meta>} */ (await findTemplate(spec));
  }
  const paths = await pathsOf(spec);
  const lock = await acquireRunLock({
    lockPath: paths.useLock,
    slots: 1,
    mode: 'shared',
    env: {},
    label: `use ${describeSpec(spec)}`,
  });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  for (const logPath of meta.logPaths) {
    writeFileSync(logPath, '', { mode: 0o600 });
  }
  return { ...meta, release: () => lock.release() };
};

/**
 * Build every missing template of the named sets, each in its own child
 * `scripts/run-lock.mjs` (a shared slot and the 10-minute box).
 * @param {string[]} names
 */
const buildSets = async names => {
  /** @type {Spec[]} */
  const specs = [];
  for (const name of names) specs.push(...specsFor(name));
  let status = 0;
  for (const spec of specs) {
    const found = await findTemplate(spec);
    if (found) {
      process.stderr.write(
        `long-template: ${describeSpec(spec)} cached (t${found.key})\n`,
      );
    } else {
      const t0 = performance.now();
      const code = await new Promise(resolve => {
        const child = spawn(
          process.execPath,
          [
            path.join(harnessRoot, 'scripts', 'run-lock.mjs'),
            '--shared',
            '--label',
            `template ${describeSpec(spec)}`,
            '--',
            process.execPath,
            thisFile,
            '--one',
            JSON.stringify(spec),
          ],
          { stdio: 'inherit' },
        );
        child.once('exit', exitCode => resolve(exitCode ?? 1));
      });
      process.stderr.write(
        `long-template: ${describeSpec(spec)} exit ${code} after ${Math.round((performance.now() - t0) / 1000)} s\n`,
      );
      if (code !== 0) {
        status = 1;
        break;
      }
    }
  }
  process.exitCode = status;
};

/** Remove templates no current spec names. */
const prune = async () => {
  const keep = new Set();
  for (const spec of specsFor('all')) keep.add(await specKey(spec));
  const home = templateHome();
  for (const name of existsSync(home) ? readdirSync(home) : []) {
    const match = /^[tl]([0-9a-f]{12})(\.json|\.build.*|\.use.*)?$/.exec(name);
    if (match && !keep.has(match[1])) {
      await rm(path.join(home, name), { recursive: true, force: true });
      process.stderr.write(`long-template: removed ${name}\n`);
    }
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const args = process.argv.slice(2);
  if (args[0] === '--one') {
    const spec = /** @type {Spec} */ (JSON.parse(args[1]));
    const lock = await acquireRunLock({
      label: `template ${describeSpec(spec)}`,
      onEvent: event =>
        process.stderr.write(`run-lock: ${JSON.stringify(event)}\n`),
    });
    try {
      await buildTemplate(spec);
    } finally {
      await lock.release();
    }
  } else if (args[0] === '--list') {
    for (const spec of specsFor('all')) {
      const found = await findTemplate(spec);
      emit({
        metric: 'template.cached',
        spec: describeSpec(spec),
        key: await specKey(spec),
        cached: found !== undefined,
        ...(found
          ? {
              turns: found.turns,
              buildMs: found.buildMs,
              builtAt: found.builtAt,
            }
          : {}),
      });
    }
  } else if (args[0] === '--prune') {
    await prune();
  } else {
    await buildSets(args.length ? args : ['all']);
  }
}
