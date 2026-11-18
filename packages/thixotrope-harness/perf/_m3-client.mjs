// @ts-check
/**
 * M3 perf and browser fixtures (designs/m3-interfaces.md 13, 17; W3.8).
 *
 * `ensureM3Template()` builds, once per runtime identity, the cached state
 * template `m3-300`: the m1a template's provisioning, then one session of
 * 300 synthetic turns (one tool round each, `writeSyntheticExport` shape
 * `tool`) imported with `importState` and bound to a scripted backend
 * labelled `Scripted`, then a few direct turns until the import's sealing
 * backlog is drained (kept turns at most keep + segment), so the template
 * is a settled session in the archive's steady state (J-0461). Nothing is
 * grown by replaying turns beyond those few warm-up turns.
 *
 * The scripted backend's log is `tmp/m3-300-scripted.log` (shared by every
 * copy of the template in this checkout: a log path inside the build
 * directory would not survive the template's rename).
 *
 * CLI (under the run lock; nested in a held slot it passes through):
 *
 *   node perf/_m3-client.mjs template [--rebuild]
 *
 * prints one JSON line `{ metric: 'm3.template', dir, built, buildMs }`.
 */
import '../scripts/_init.mjs';
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import url from 'node:url';

const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { m1aTemplateOptions, names } =
  await import('../scripts/provision-steps.js');
const { ensureTemplate, tmpRoot } = await import('../test/template/index.js');
const { writeSyntheticExport } =
  await import('../test/integration/_m2-lifecycle.js');
const { importState } = await import('../scripts/export.mjs');
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
const { limits } = await import('../guest/lib/limits.js');

/** Imported turns of the `m3-300` session. */
export const M3_TEMPLATE_TURNS = 300;
/** Its title (the perf files and browser tests find it by its row). */
export const M3_TEMPLATE_TITLE = 'm3-300';
/** Bumped when the provisioning below changes. */
const M3_TEMPLATE_VERSION = 1;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** The template session's script: one short round per turn. */
export const m3TemplateScript = harden({
  turns: [{ rounds: [{ chunks: [{ text: 'ok' }], usage }] }],
});

/** The scripted backend's log (outside every state directory). */
export const m3TemplateLog = path.join(tmpRoot, 'm3-300-scripted.log');

/**
 * Template options for `ensureTemplate`: m1a's provisioning plus the
 * imported session.
 */
export const m3TemplateOptions = async () => {
  const base = await m1aTemplateOptions();
  return {
    id: `${base.id}-m3-300-v${M3_TEMPLATE_VERSION}`,
    /** @param {import('../test/template/index.js').ProvisionContext} context */
    provision: async context => {
      await base.provision(context);
      const { client } = context;
      const admin = await client.call('lookup', names.agentHost);
      writeFileSync(`${m3TemplateLog}.nodigest`, '');
      const backend = await E(admin).makeBackend(
        harden({
          kind: 'scripted',
          label: 'Scripted',
          script: m3TemplateScript,
          logPath: m3TemplateLog,
        }),
      );
      const file = path.join(tmpRoot, `m3-300-${process.pid}.jsonl`);
      await writeSyntheticExport(file, [
        {
          title: M3_TEMPLATE_TITLE,
          turns: M3_TEMPLATE_TURNS,
          backendLabel: 'Scripted',
          shape: 'tool',
        },
      ]);
      let result;
      try {
        result = await importState({ client, file, backends: [backend] });
      } finally {
        rmSync(file, { force: true });
      }
      const [session] = result.sessions;
      // Drain the import's sealing backlog with a few direct turns.
      const keptBound = limits.archiveKeepTurns + limits.archiveSegmentTurns;
      let n = M3_TEMPLATE_TURNS;
      for (let warm = 0; warm < 16; warm += 1) {
        // eslint-disable-next-line no-await-in-loop
        const { archive } = await E(session).getHistoryPage();
        if (n - (archive?.sealedTurns ?? 0) <= keptBound) break;
        n += 1;
        // eslint-disable-next-line no-await-in-loop
        const turn = await E(session).startTurn(
          harden({ text: `warm ${n}` }),
          Date.now(),
        );
        // eslint-disable-next-line no-await-in-loop
        await E(turn).whenFinished();
      }
    },
  };
};

/**
 * Find or build the `m3-300` template (about 40 s to import once).
 * Answers the `Template` (its `dir` is the cached state directory), which
 * `startFromTemplate` and the perf harness's `provision({ template })` take.
 * @param {{ rebuild?: boolean }} [options]
 */
export const ensureM3Template = async ({ rebuild = false } = {}) =>
  ensureTemplate({ ...(await m3TemplateOptions()), rebuild });

/**
 * The `m3-300` session's row through a factory (a page's or the control
 * client's).
 * @param {any} factory
 */
export const m3TemplateSession = async factory => {
  /** @type {any} */
  let after;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await E(factory).listSessions(
      harden(after === undefined ? { limit: 50 } : { after, limit: 50 }),
    );
    const row = page.rows.find(
      (/** @type {any} */ r) => r.title === M3_TEMPLATE_TITLE,
    );
    if (row) return row;
    if (page.next === undefined) throw Error('no m3-300 session');
    after = page.next;
  }
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'template') {
    process.stderr.write(
      'usage: node perf/_m3-client.mjs template [--rebuild]\n',
    );
    process.exitCode = 2;
  } else {
    const { acquireRunLock } = await import('../scripts/run-lock.mjs');
    const lock = await acquireRunLock({ label: 'm3 template' });
    try {
      const t0 = performance.now();
      const template = await ensureM3Template({
        rebuild: rest.includes('--rebuild'),
      });
      process.stdout.write(
        `${JSON.stringify({
          metric: 'm3.template',
          dir: path.relative(process.cwd(), template.dir),
          built: template.built,
          ms: Math.round(performance.now() - t0),
          ...(template.buildSteps ? { steps: template.buildSteps } : {}),
        })}\n`,
      );
    } catch (error) {
      process.stderr.write(`m3 template: ${error}\n`);
      process.exitCode = 1;
    } finally {
      await lock.release();
    }
  }
}

/** Every M3 perf file ends its windows by 9 min 30 s (m3-interfaces.md 13). */
export const FILE_BUDGET_MS = 9.5 * 60_000;
/** The default window of one measured point. */
export const WINDOW_MS = Number(process.env.M3_WINDOW_MS ?? 60_000);
/** Fewer samples than this in a window are flagged `fewSamples`. */
export const FEW_SAMPLES = 30;

/**
 * The file clock: whether a window of `ms` still ends inside the file's
 * 9 min 30 s.
 */
export const makeFileClock = () => {
  const t0 = performance.now();
  return {
    elapsed: () => performance.now() - t0,
    /** @param {number} ms */
    fits: ms => performance.now() - t0 + ms <= FILE_BUDGET_MS,
  };
};

/**
 * Run `fn` back to back for `ms`; answer each run's duration (ms) and
 * whatever it returned.
 * @template T
 * @param {number} ms
 * @param {(i: number) => Promise<T>} fn
 */
export const measureWindow = async (ms, fn) => {
  /** @type {number[]} */
  const samples = [];
  /** @type {T[]} */
  const results = [];
  const end = performance.now() + ms;
  for (let i = 0; performance.now() < end; i += 1) {
    const t = performance.now();
    // eslint-disable-next-line no-await-in-loop
    results.push(await fn(i));
    samples.push(performance.now() - t);
  }
  return { samples, results };
};

/** Sum of every worker's journal length (deliveries persisted). @param {any} client */
export const journalTotal = async client => {
  const { workers } = await client.call('status');
  return workers.reduce(
    (/** @type {number} */ sum, /** @type {any} */ w) =>
      sum + Number(w.journalLength ?? 0),
    0,
  );
};
