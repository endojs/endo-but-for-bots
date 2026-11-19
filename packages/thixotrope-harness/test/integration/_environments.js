// @ts-check
/**
 * Helpers of the environments integration files and perf checks
 * (`designs/m6-interfaces.md` 3.11): the `environments` state template (the
 * real session and exec programs, the factory's default pool, and the
 * environments resource installed, configured with the fake runtime and
 * attached to the factory), a session of a built-in preset, scripted tool
 * rounds of `runCommand` and `exec`, the live fake process groups of a
 * state, the environments adapter process (CC-092's workaround), and the
 * D-M6-14 grep for the state directory's path. AVA skips files starting
 * with an underscore.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { defaultAllowedCommands } from '../../guest/lib/guards/environments.js';
/* eslint-enable import/no-relative-packages */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import { liveGroupsOf } from '../../resources/environments/impl/runtime-fake.js';
import { makeProvision, templateIdFor } from '../../scripts/provision-steps.js';
import { ensureTemplate } from '../template/index.js';
import { adapterProcess } from './_adapter-processes.js';
import { grepState } from './_m2-secrets.js';

/**
 * The template's `EnvironmentSettings` (acceptance, section 9 header): the
 * fake runtime and the default allowlist plus the test programs.
 */
export const environmentsSettings = harden({
  runtime: 'fake',
  allowedCommands: [
    ...defaultAllowedCommands,
    'true',
    'printf',
    'sleep',
    'cat',
    'head',
    'id',
  ],
});

/**
 * Sources the template's provisioning installs beyond the harness's own
 * (the environments manager is installed code; its adapter loads `impl/`
 * at run time, so an `impl/` change needs no new template, but keying it
 * keeps the template honest).
 */
const environmentsSources = harden([
  'resources/environments',
  'resources/native-attach.js',
  'guest/lib/guards/environments.js',
]);

/**
 * The `environments` template: the m1b provisioning with the factory's
 * default pool, plus the environments steps (`60-environments.js`).
 */
export const environmentsTemplate = async () => {
  /** @type {any[]} */
  const steps = [];
  const run = makeProvision({
    pool: {},
    environments: environmentsSettings,
    onStep: report => steps.push(report),
  });
  const template = await ensureTemplate({
    id: await templateIdFor({ pool: {}, prefix: 'env' }),
    sources: [...environmentsSources],
    extra: { pool: {}, environments: environmentsSettings },
    /** @param {{ client: any, connect?: any }} context */
    provision: async context => {
      await run(context);
    },
  });
  if (template.built)
    emit({
      metric: 'environments.template',
      buildMs: template.buildMs,
      steps: steps.map(s => ({
        name: s.name,
        ms: s.ms,
        skipped: s.skipped,
        ...(s.detail ? { detail: s.detail } : {}),
      })),
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  return template;
};

/**
 * A built-in preset by its template name (`development`, `new-project`,
 * `general`, `chat-only`).
 * @param {any} factory
 * @param {string} template
 */
export const presetOfTemplate = async (factory, template) => {
  for (const preset of await E(factory).listPresets()) {
    // eslint-disable-next-line no-await-in-loop
    const info = await E(preset).describe();
    if (info.template === template && info.builtIn) return preset;
  }
  throw Error(`no built-in preset ${template}`);
};

/**
 * A session of a built-in preset on `backend`.
 * @param {any} slice from makeSlice
 * @param {any} backend
 * @param {string} [template]
 * @param {string} [title]
 */
export const startEnvironmentSession = async (
  slice,
  backend,
  template = 'development',
  title = template,
) =>
  E(slice.factory).createSession(
    harden({
      title,
      preset: await presetOfTemplate(slice.factory, template),
      backend,
      at: Date.now(),
    }),
  );

const usage = harden({
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * A scripted round of tool calls.
 * @param {{ name: string, args: string }[]} toolCalls
 */
export const toolRound = toolCalls =>
  harden({ chunks: [{ text: 'tools' }], toolCalls, usage });
export const closingRound = harden({ chunks: [{ text: 'done' }], usage });

/**
 * A `runCommand` tool call.
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ timeoutMs?: number }} [options]
 */
export const commandCall = (command, args = [], options = undefined) =>
  harden({
    name: 'runCommand',
    args: JSON.stringify(
      options === undefined ? { command, args } : { command, args, options },
    ),
  });

/**
 * An `exec` tool call.
 * @param {string} code
 */
export const execCall = code =>
  harden({ name: 'exec', args: JSON.stringify({ code }) });

/**
 * A tool call by name with JSON arguments.
 * @param {string} name
 * @param {unknown} args
 */
export const toolCall = (name, args) =>
  harden({
    name,
    args: typeof args === 'string' ? args : JSON.stringify(args),
  });

/**
 * A scripted turn: one round per entry of `rounds` (each a list of calls),
 * then a closing text round.
 * @param {string} input
 * @param {{ name: string, args: string }[][]} rounds
 */
export const commandTurn = (input, rounds) =>
  harden({ input, rounds: [...rounds.map(toolRound), closingRound] });

/**
 * The tool results of a turn's records in call order (the log keeps them
 * in completion order; the intents records give the order of the calls):
 * `{ result, failed }`.
 * @param {any[]} records from turnRecords
 */
export const toolResultsOf = records => {
  const order = records
    .filter(r => r.kind === 'tool-intents')
    .flatMap(r => r.intents.map((/** @type {any} */ i) => i.opId));
  return records
    .filter(r => r.kind === 'tool-result')
    .sort((a, b) => order.indexOf(a.opId) - order.indexOf(b.opId))
    .map(r => ({ result: r.result, failed: r.failed === true }));
};

/**
 * The live fake process groups of every environment of a state
 * (`<root>/environments/sessions/<key>/run/`).
 * @param {string} root
 * @returns {{ key: string, pgid: number }[]}
 */
export const environmentProcesses = root => {
  const sessions = path.join(root, 'environments', 'sessions');
  /** @type {string[]} */
  let keys = [];
  try {
    keys = readdirSync(sessions);
  } catch {
    return [];
  }
  return keys.flatMap(key =>
    liveGroupsOf(path.join(sessions, key, 'run')).map(pgid => ({
      key,
      pgid,
    })),
  );
};

/**
 * The environment directories of a state (`e<n>` keys).
 * @param {string} root
 */
export const environmentKeys = root => {
  try {
    return readdirSync(path.join(root, 'environments', 'sessions')).sort();
  } catch {
    return [];
  }
};

/** A text only the environments loader's bundle holds. */
const LOADER_NEEDLE = 'loadEnvironments';

/**
 * The environments adapter's process (CC-092's workaround), or undefined.
 * @param {string} root
 */
export const environmentsAdapter = root => adapterProcess(root, LOADER_NEEDLE);

/**
 * SIGKILL the environments adapter process alone; answers its pid.
 * @param {string} root
 */
export const killEnvironmentsAdapter = root => {
  const found = environmentsAdapter(root);
  if (found === undefined) throw Error('no environments adapter process');
  process.kill(found.pid, 'SIGKILL');
  return found.pid;
};

/**
 * Where the state directory's absolute path appears in a vat's heap,
 * journal or snapshot (D-M6-14; acceptance 17): the `heaps/` and `workers/`
 * trees of the state, in every encoding `grepState` tries.
 * @param {string} root
 */
export const stateHasPath = async root => {
  const hits = [];
  for (const dir of ['heaps', 'workers']) {
    // eslint-disable-next-line no-await-in-loop
    hits.push(...(await grepState(path.join(root, dir), root)));
  }
  return hits;
};
