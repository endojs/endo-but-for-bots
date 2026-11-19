#!/usr/bin/env node
// @ts-check
/**
 * Run integration files, each under its own run-lock slot and time box
 * (scripts/run-lock.mjs), several at once.
 *
 * One wrapper around the whole suite would put every file under one 10-minute
 * box, and the suite takes far longer than that run serially. Here each file
 * is its own `run-lock.mjs --label "integration <file>" -- ses-ava -- --serial
 * <file>` run: the box applies per file, every file has its own run-log line,
 * and up to `--jobs` files (default THIX_HARNESS_RUN_SLOTS, 6) run at once,
 * each in a slot of its own. A file's output is printed in one piece when it
 * ends; a summary of exit codes and times comes last.
 *
 * Usage:
 *   THIX_HARNESS_INTEGRATION=1 node scripts/test-integration.mjs
 *     [--jobs N] [--max-ms N] [--dir DIR ...] [file ...]
 *   node scripts/test-integration.mjs --list core|milestones|M3|M4|M5
 *     [--jobs N] [--max-ms N]
 *
 * With no files: every `*.test.js` and `*.test.mjs` under the `--dir`
 * directories, by default test/integration and test/template
 * (`corepack yarn test:integration`); `corepack yarn test:browser` passes
 * `--dir test/browser`. Run it through `corepack yarn`, which puts ses-ava on
 * PATH.
 *
 * `--list` runs one regression list of designs/process.md 3.1 as one batch
 * (`corepack yarn test:regression:core`, `test:regression:milestones`): the
 * core list first runs the unit and adapter lanes (`ses-ava`, no slot,
 * without THIX_HARNESS_INTEGRATION), then its files; every file of a list
 * runs with THIX_HARNESS_INTEGRATION=1, and browser files also with
 * THIX_HARNESS_BROWSER=1. The summary gives each file's held and waited
 * time from the run log (`runs.jsonl`, the line its run-lock wrapper wrote)
 * and the batch's wall time.
 *
 * Exit 0 when every file passed, 124 when one timed out and none failed
 * otherwise, else 1.
 */
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

import {
  TIMED_OUT_EXIT,
  laneOf,
  runLogPath,
  slotsFromEnv,
} from './run-lock.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);
const runLockScript = path.join(here, 'run-lock.mjs');

const USAGE =
  'Usage: test-integration.mjs [--jobs N] [--max-ms N] [--dir DIR ...] [--list NAME] [file ...]';

/** The directories `test:integration` runs when no file is named. */
export const DEFAULT_DIRS = Object.freeze([
  'test/integration',
  'test/template',
]);

/** Test file suffixes: integration files are `.test.js`, browser files `.test.mjs`. */
const TEST_SUFFIXES = Object.freeze(['.test.js', '.test.mjs']);

/**
 * The regression lists of designs/process.md 3.1 (PM ruling 2026-11-18): the
 * core list every lane runs (with the unit and adapter lanes), and one list
 * per milestone; a merge runs `core` and `milestones` as two batches. Every
 * integration, template and browser file is in exactly one list
 * (test/integration-runner.test.js), so a new file must be placed here.
 */
export const regressionLists = Object.freeze({
  core: Object.freeze([
    ...[
      'm1a-provision',
      'm1a-slice',
      'm1a-slice-crash',
      'm1a-slice-restart',
      'm1b-content',
      'm1b-context-restart',
      'm1b-exec-tool',
      'm1b-exec-tool-restart',
      'm1b-followups',
      'm1b-live',
      'm1b-pool',
      'm1b-pool-restart',
      'm1b-qc',
      'm2-archive-restart',
      'm2-archive-restart-2',
      'm2-catalog',
      'm2-history',
      'm2-lifecycle',
      'm2-lifecycle-export',
      'm2-probes',
      'm2-providers',
      'm2-queue',
      'm2-secrets',
      'm2-turns',
    ].map(name => `test/integration/${name}.test.js`),
    'test/template/template.test.js',
  ]),
  M3: Object.freeze([
    'test/integration/m3-gateway.test.js',
    'test/integration/m3-reconnect.test.js',
    'test/integration/m3-sessions.test.js',
    'test/browser/m3-ui.test.mjs',
    'test/browser/m3-ui-restart.test.mjs',
    'test/browser/m3-ui-history.test.mjs',
  ]),
  M4: Object.freeze([
    ...[
      'm4-accounts',
      'm4-catalog',
      'm4-pools',
      'm4-provision',
      'm4-reachability',
      'm4-renewal',
      'm4-restart',
      'm4-restart-renewal',
      'm4-retire',
      'm4-secrets',
      'm4-wire',
    ].map(name => `test/integration/${name}.test.js`),
    'test/browser/m4-ui.test.mjs',
  ]),
  M5: Object.freeze([
    ...[
      'm5-grants',
      'm5-grants-restart',
      'm5-labels',
      'm5-mentions',
      'm5-mentions-restart',
      'm5-objects',
      'm5-presets',
      'm5-presets-inventory',
      'm5-prompt',
      'm5-reachability',
      'm5-security',
      'm5-snapshot',
    ].map(name => `test/integration/${name}.test.js`),
    'test/browser/m5-ui.test.mjs',
  ]),
  // Reserved by WX.1 for the group of four lanes, one list each, named by
  // concept; each lane adds its files to its own list (empty until then).
  environments: Object.freeze(/** @type {string[]} */ ([])),
  context: Object.freeze(/** @type {string[]} */ ([])),
  mail: Object.freeze(
    ['mail', 'mail-restart-delivery', 'mail-restart-turn', 'subagents', 'subagents-restart'].map(
      name => `test/integration/${name}.test.js`,
    ),
  ),
  voice: Object.freeze(/** @type {string[]} */ ([])),
});

/**
 * The files of a regression list: `core`, one milestone (`M3`, `M4`,
 * `M5`) or one lane of the next group (`environments`, `context`, `mail`,
 * `voice`), or `milestones` (every list but `core`, in order).
 * @param {string} name
 * @returns {string[]}
 */
export const listFiles = name => {
  if (name === 'milestones')
    return Object.entries(regressionLists)
      .filter(([list]) => list !== 'core')
      .flatMap(([, files]) => files);
  if (!Object.hasOwn(regressionLists, name))
    throw Error(
      `unknown list ${name} (core, milestones, ${Object.keys(regressionLists)
        .filter(list => list !== 'core')
        .join(', ')})`,
    );
  return [
    ...regressionLists[/** @type {keyof typeof regressionLists} */ (name)],
  ];
};

/** @param {string[]} argv */
export const parseArgs = argv => {
  /** @type {{ jobs?: number, maxMs?: number, dirs?: string[], list?: string, files: string[] }} */
  const options = { files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--jobs' || arg === '--max-ms') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1)
        throw Error(`${arg} takes a whole number >= 1\n${USAGE}`);
      if (arg === '--jobs') options.jobs = n;
      else options.maxMs = n;
      i += 1;
    } else if (arg === '--dir') {
      const dir = argv[i + 1];
      if (dir === undefined || dir.startsWith('-'))
        throw Error(`--dir takes a directory\n${USAGE}`);
      options.dirs = [...(options.dirs ?? []), dir];
      i += 1;
    } else if (arg === '--list') {
      const name = argv[i + 1];
      if (name === undefined || name.startsWith('-'))
        throw Error(`--list takes a list name\n${USAGE}`);
      options.list = name;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw Error(`Unknown option ${arg}\n${USAGE}`);
    } else {
      options.files.push(arg);
    }
  }
  return options;
};

/**
 * The test files under `dirs`, relative to the package.
 * @param {readonly string[]} [dirs]
 */
export const defaultFiles = async (dirs = DEFAULT_DIRS) => {
  const files = [];
  for (const dir of dirs) {
    const names = await readdir(path.join(packageRoot, dir)).catch(() => []);
    for (const name of names.sort())
      if (TEST_SUFFIXES.some(suffix => name.endsWith(suffix)))
        files.push(`${dir}/${name}`);
  }
  return files;
};

/**
 * A run's held and waited time from run log rows: the first row with this
 * label and lane written by a wrapper started at or after `since` (less a
 * second of clock slack).
 * @param {Array<Record<string, any>>} rows
 * @param {{ label: string, lane: string | null, since: number }} which
 * @returns {{ heldMs: number, waitedMs: number } | undefined}
 */
export const heldOf = (rows, { label, lane, since }) => {
  const row = rows.find(
    r =>
      r.label === label && r.lane === lane && Date.parse(r.at) >= since - 1000,
  );
  return row === undefined
    ? undefined
    : { heldMs: Number(row.heldMs), waitedMs: Number(row.waitedMs) };
};

/** The run log's rows, oldest first; none when there is no log yet. */
const readRunLog = async () => {
  const text = await readFile(runLogPath(), 'utf8').catch(error => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
      return '';
    throw error;
  });
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));
};

/** @param {number} ms */
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

/**
 * The run-lock label of a file's run.
 * @param {string} file
 */
const labelOf = file => `integration ${path.basename(file)}`;

/**
 * @param {string} file
 * @param {number | undefined} maxMs
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ file: string, code: number, ms: number, startedAt: number, output: string }>}
 */
const runFile = (file, maxMs, env) =>
  new Promise(resolve => {
    const t0 = Date.now();
    const chunks = [];
    const child = spawn(
      process.execPath,
      [
        runLockScript,
        '--label',
        labelOf(file),
        ...(maxMs === undefined ? [] : ['--max-ms', String(maxMs)]),
        '--',
        'ses-ava',
        '--',
        '--serial',
        file,
      ],
      { cwd: packageRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    const done = (/** @type {number} */ code) =>
      resolve({
        file,
        code,
        ms: Date.now() - t0,
        startedAt: t0,
        output: Buffer.concat(chunks).toString(),
      });
    child.once('error', error => {
      chunks.push(Buffer.from(`${error.message}\n`));
      done(127);
    });
    child.once('close', code => done(code ?? 1));
  });

/**
 * The environment a list's part runs with.
 * @param {'unit' | 'integration' | 'browser'} part
 */
const envFor = part => {
  const env = { ...process.env };
  delete env.THIX_HARNESS_INTEGRATION;
  delete env.THIX_HARNESS_BROWSER;
  delete env.THIX_HARNESS_SPIKES;
  if (part !== 'unit') env.THIX_HARNESS_INTEGRATION = '1';
  if (part === 'browser') env.THIX_HARNESS_BROWSER = '1';
  return env;
};

/** The unit and adapter lanes, no slot: exit code and wall time. */
const runUnitLanes = () =>
  new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn('ses-ava', [], {
      cwd: packageRoot,
      env: envFor('unit'),
      stdio: 'inherit',
    });
    child.once('error', error => {
      process.stderr.write(`test-integration: ${error.message}\n`);
      resolve({ code: 127, ms: Date.now() - t0 });
    });
    child.once('close', code =>
      resolve({ code: code ?? 1, ms: Date.now() - t0 }),
    );
  });

/** @param {string[]} argv */
const main = async argv => {
  const options = parseArgs(argv);
  if (options.list !== undefined && (options.files.length || options.dirs))
    throw Error(`--list takes no files and no --dir\n${USAGE}`);
  const t0 = Date.now();
  /** @type {{ code: number, ms: number } | undefined} */
  let unit;
  if (options.list === 'core') {
    process.stdout.write('===== unit and adapter lanes (ses-ava, no slot)\n');
    unit = await runUnitLanes();
  }
  const files =
    options.list !== undefined
      ? listFiles(options.list)
      : options.files.length
        ? options.files
        : await defaultFiles(options.dirs);
  /** @param {string} file */
  const envOf = file =>
    options.list === undefined
      ? process.env
      : envFor(file.startsWith('test/browser/') ? 'browser' : 'integration');
  const jobs = Math.min(options.jobs ?? slotsFromEnv(), files.length);
  const tFiles = Date.now();
  /** @type {Awaited<ReturnType<typeof runFile>>[]} */
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      const result = await runFile(file, options.maxMs, envOf(file));
      process.stdout.write(
        `\n===== ${result.file}: exit ${result.code} in ${seconds(result.ms)}\n${result.output}`,
      );
      results.push(result);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  const filesWall = Date.now() - tFiles;
  const rows = await readRunLog().catch(error => {
    process.stderr.write(
      `test-integration: run log not read: ${error.message}\n`,
    );
    return [];
  });
  const lane = laneOf(packageRoot);
  let heldTotal = 0;
  process.stdout.write(
    `\n===== ${options.list === undefined ? 'integration' : `list ${options.list}`}: ${files.length} files, ${jobs} at once, ${seconds(filesWall)} wall\n`,
  );
  process.stdout.write('exit     held   waited    total  file\n');
  for (const r of results.sort((a, b) => a.file.localeCompare(b.file))) {
    const held = heldOf(rows, {
      label: labelOf(r.file),
      lane,
      since: r.startedAt,
    });
    if (held) heldTotal += held.heldMs;
    process.stdout.write(
      `${r.code === 0 ? 'ok  ' : 'FAIL'} ${String(r.code).padStart(3)} ${(held ? seconds(held.heldMs) : 'no log').padStart(8)} ${(held ? seconds(held.waitedMs) : '-').padStart(8)} ${seconds(r.ms).padStart(8)}  ${r.file}\n`,
    );
  }
  process.stdout.write(`held in all: ${seconds(heldTotal)}\n`);
  if (unit)
    process.stdout.write(
      `unit and adapter lanes: exit ${unit.code}, ${seconds(unit.ms)} wall\n`,
    );
  if (options.list !== undefined)
    process.stdout.write(
      `===== list ${options.list}: ${seconds(Date.now() - t0)} wall in all\n`,
    );
  const failed = results.filter(r => r.code !== 0);
  if (unit && unit.code !== 0) process.exitCode = 1;
  else if (failed.length === 0) process.exitCode = 0;
  else if (failed.every(r => r.code === TIMED_OUT_EXIT))
    process.exitCode = TIMED_OUT_EXIT;
  else process.exitCode = 1;
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`test-integration: ${error.message}\n`);
    process.exitCode = 1;
  });
}
