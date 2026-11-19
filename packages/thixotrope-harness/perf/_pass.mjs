// @ts-check
/**
 * The recorded perf pass of one milestone (designs/process.md 3.2, PM ruling
 * 2026-11-18): the milestone's own perf checks plus the cross-check
 * (`session`, `turn`, `exec`), one after another, each as
 *
 *   node scripts/run-lock.mjs --exclusive --label perf-<name> -- node perf/<name>.perf.mjs
 *
 * in one batch (exclusive mode stops every lane while it runs, so the files
 * run back to back, not spread through the work). `perf/ui.perf.mjs` gets
 * THIX_HARNESS_BROWSER=1. First the state templates the files copy are
 * brought up to date in shared slots, each in its own boxed wrapper (quick
 * when current): the milestone templates (`m1a`, `exec`, `pool`, `m4`,
 * `m5o`, `m3-300`; `node perf/_pass.mjs templates [name ...]` builds them
 * in this process) and, for M2 and `all`, the long-session ones
 * (`perf/_long-template.mjs`). The summary gives each file's held time
 * from the run log, its exit, and the batch's wall time.
 *
 *   corepack yarn perf:pass M3        # M2 (M0-M2), M3, M4, M5, or all
 *   corepack yarn perf:pass M4 --no-templates
 *
 * `all` (every perf check) runs only when the PM asks for it (a core or
 * worker change). Exit 0 when every file exited 0, else 1 (exit 1 of a
 * check is a budget missed; see its rows).
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);

/**
 * Every perf check, by the milestone that owns it; M2 holds M0-M2's (the
 * cross-check files among them). A new check must be placed here
 * (test/perf-pass.test.js).
 */
export const perfLists = Object.freeze({
  M2: Object.freeze([
    'exec',
    'frames',
    'turn',
    'session',
    'pool',
    'concurrency',
    'gc',
    'hub',
    'hub.growth',
    'hub.sessions',
    'crank',
    'crank.mid',
    'crank.late',
    'install',
    'crash',
    'restart',
    'restart.crash',
    'queue',
    'provider',
    'import',
    'archive',
    'history',
    'history.restart',
    'journal',
    'throughput',
  ]),
  M3: Object.freeze(['gateway', 'gateway-session', 'gateway-restart', 'ui']),
  M4: Object.freeze([
    'subscriptions',
    'subscriptions-lifecycle',
    'secrets',
    'accounts',
  ]),
  M5: Object.freeze(['presets', 'creation-m5', 'exec-m5', 'tools', 'mentions']),
  // Reserved by WX.1 for the group of four lanes, named by concept; each
  // lane adds its perf checks to its own list (empty until then).
  environments: Object.freeze([
    'environments',
    'environments-git',
    'environments-restart',
  ]),
  context: Object.freeze(/** @type {string[]} */ ([])),
  mail: Object.freeze(/** @type {string[]} */ ([])),
  voice: Object.freeze(/** @type {string[]} */ ([])),
});

/** The cross-check every milestone pass ends with. */
export const CROSS_CHECK = Object.freeze(['session', 'turn', 'exec']);

/**
 * The checks of one pass, in order.
 * @param {string} milestone `M2`, `M3`, `M4`, `M5`, a lane of the next
 *   group (`environments`, `context`, `mail`, `voice`) or `all`
 * @returns {string[]}
 */
export const passFiles = milestone => {
  if (milestone === 'all') return Object.values(perfLists).flat();
  if (!Object.hasOwn(perfLists, milestone))
    throw Error(
      `unknown milestone ${milestone} (${Object.keys(perfLists).join(', ')}, all)`,
    );
  const own = perfLists[/** @type {keyof typeof perfLists} */ (milestone)];
  return [...own, ...CROSS_CHECK.filter(name => !own.includes(name))];
};

/**
 * The wrapper command of one check (relative to the package) and the
 * variables it adds.
 * @param {string} name
 * @returns {{ args: string[], env: Record<string, string> }}
 */
export const passCommand = name => ({
  args: [
    'scripts/run-lock.mjs',
    '--exclusive',
    '--label',
    `perf-${name}`,
    '--',
    process.execPath,
    `perf/${name}.perf.mjs`,
  ],
  env: name === 'ui' ? { THIX_HARNESS_BROWSER: '1' } : {},
});

/**
 * Run one command from the package with the output passed through.
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, ms: number, startedAt: number }>}
 */
const run = (args, env = {}) =>
  new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: packageRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.once('error', error => {
      process.stderr.write(`perf pass: ${error.message}\n`);
      resolve({ code: 127, ms: Date.now() - startedAt, startedAt });
    });
    child.once('close', code =>
      resolve({ code: code ?? 1, ms: Date.now() - startedAt, startedAt }),
    );
  });

/** @param {number} ms */
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

/** The milestone templates the perf checks copy, by name. */
const templateMakers = {
  m1a: async () =>
    (await import('../test/integration/_m1a-slice.js')).sliceTemplate(),
  exec: async () =>
    (await import('../test/integration/_m1b-exec.js')).execTemplate(),
  pool: async () =>
    (await import('../test/integration/_m1b-pool.js')).poolTemplate(),
  m4: async () => (await import('../test/integration/_m4.js')).m4Template(),
  m5o: async () =>
    (await import('../test/integration/_m5-objects.js')).objectsTemplate(),
  'm3-300': async () => (await import('./_m3-client.mjs')).ensureM3Template(),
  environments: async () =>
    (
      await import('../test/integration/_environments.js')
    ).environmentsTemplate(),
};

/** The milestone template names, in build order. */
export const TEMPLATE_NAMES = Object.freeze(Object.keys(templateMakers));

/**
 * Bring milestone templates up to date in this process (run it under a
 * shared run-lock wrapper, as `main` does).
 * @param {readonly string[]} names
 */
const ensureTemplates = async names => {
  await import('../scripts/_init.mjs');
  const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
  installGuestPrelude();
  for (const name of names) {
    if (!Object.hasOwn(templateMakers, name))
      throw Error(`unknown template ${name} (${TEMPLATE_NAMES.join(', ')})`);
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const template =
      await templateMakers[/** @type {keyof typeof templateMakers} */ (name)]();
    process.stdout.write(
      `${JSON.stringify({ metric: 'pass.template', name, key: template.key, built: template.built, ms: Date.now() - t0 })}\n`,
    );
  }
};

/** @param {string[]} argv */
const main = async argv => {
  if (argv[0] === 'templates') {
    await ensureTemplates(argv.length > 1 ? argv.slice(1) : TEMPLATE_NAMES);
    return;
  }
  const milestone = argv.find(arg => !arg.startsWith('-'));
  if (milestone === undefined)
    throw Error('Usage: perf/_pass.mjs <M2|M3|M4|M5|all> [--no-templates]');
  const files = passFiles(milestone);
  const t0 = Date.now();
  if (!argv.includes('--no-templates')) {
    const steps = [
      ...TEMPLATE_NAMES.map(name => [
        'scripts/run-lock.mjs',
        '--shared',
        '--label',
        `template-${name}`,
        '--',
        process.execPath,
        'perf/_pass.mjs',
        'templates',
        name,
      ]),
      ...(milestone === 'M2' || milestone === 'all'
        ? [['perf/_long-template.mjs', 'history', 'journal', 'throughput']]
        : []),
    ];
    for (const args of steps) {
      // eslint-disable-next-line no-await-in-loop
      const { code, ms } = await run(args);
      process.stdout.write(
        `===== templates ${args.at(-1)}: exit ${code} in ${seconds(ms)}\n`,
      );
      if (code !== 0) {
        process.exitCode = 1;
        return;
      }
    }
  }
  const tFiles = Date.now();
  /** @type {Array<{ name: string, code: number, ms: number, startedAt: number }>} */
  const results = [];
  for (const name of files) {
    const { args, env } = passCommand(name);
    // eslint-disable-next-line no-await-in-loop
    const result = await run(args, env);
    process.stdout.write(
      `===== perf ${name}: exit ${result.code} in ${seconds(result.ms)}\n`,
    );
    results.push({ name, ...result });
  }
  const { heldOf } = await import('../scripts/test-integration.mjs');
  const { laneOf, runLogPath } = await import('../scripts/run-lock.mjs');
  const rows = (await readFile(runLogPath(), 'utf8').catch(() => ''))
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));
  const lane = laneOf(packageRoot);
  let heldTotal = 0;
  process.stdout.write(
    `\n===== perf pass ${milestone}: ${files.length} files back to back, ${seconds(Date.now() - tFiles)} wall (${seconds(Date.now() - t0)} with templates)\n`,
  );
  process.stdout.write('exit     held    total  file\n');
  for (const r of results) {
    const held = heldOf(rows, {
      label: `perf-${r.name}`,
      lane,
      since: r.startedAt,
    });
    if (held) heldTotal += held.heldMs;
    process.stdout.write(
      `${r.code === 0 ? 'ok  ' : 'exit'} ${String(r.code).padStart(3)} ${(held ? seconds(held.heldMs) : 'no log').padStart(8)} ${seconds(r.ms).padStart(8)}  perf/${r.name}.perf.mjs\n`,
    );
  }
  process.stdout.write(`held in all: ${seconds(heldTotal)}\n`);
  process.exitCode = results.every(r => r.code === 0) ? 0 : 1;
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`perf pass: ${error.message}\n`);
    process.exitCode = 1;
  });
}
