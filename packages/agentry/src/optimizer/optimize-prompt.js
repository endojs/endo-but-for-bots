// @ts-check
/* global process */
/* eslint-disable import/no-extraneous-dependencies */
/**
 * Generic CLI for the agentry prompt optimizer.
 *
 * Four modes:
 *   --help                    print usage and exit
 *   --score-log=<file> --example=<id>
 *                             score a previously-captured trace JSON file
 *                             (no LLM calls)
 *   --trial=<id> [--model=<m>]
 *                             single example, single trial (LLM required)
 *   --evaluate [--eval-models=<a,b>]
 *                             matrix run across all examples (LLM required)
 *   (default)                 GEPA-compile the system prompt (LLM required)
 *
 * The consumer supplies the package-specific bits (examples path,
 * baseline path, system prompt, trial runner, default model) via a
 * config object passed to `runOptimizerCli`. See
 * `packages/lal/optimizer/optimize-prompt.js` for the lal wiring.
 */

import './init.js';

import fs from 'node:fs/promises';

import { scoreObservedTrace } from './trace-metric.js';

/**
 * @typedef {import('./trace-metric.js').TraceExample} TraceExample
 * @typedef {import('./trace-metric.js').TraceEvent} TraceEvent
 *
 * @typedef {(input: {
 *   example: TraceExample,
 *   systemPrompt: string,
 *   model?: string,
 *   env?: Record<string, string | undefined>,
 *   timeoutMs?: number,
 * }) => Promise<{
 *   trace: TraceEvent[],
 *   replyText?: string,
 *   timedOut?: boolean,
 *   sent?: unknown,
 * }>} RunTrialFn
 *
 * @typedef {(
 *   env: NodeJS.ProcessEnv,
 *   model: string,
 *   ai: (args: any) => any,
 * ) => any} MakeAxAIFn
 *
 * @typedef {object} OptimizerCliConfig
 * @property {string} examplesPath          Absolute path to the examples JSON.
 * @property {string} [envPath]             Absolute path to a `.env` file; loaded before any LLM-touching mode.
 * @property {() => Promise<string>} [loadSystemPrompt]
 *   Async loader for the default system prompt; called lazily inside the
 *   LLM-touching modes only, after SES has been installed. The consumer's
 *   `prompts/system.js` typically calls `harden`, which would crash on
 *   non-SES paths like `--help` if eagerly imported.
 * @property {() => Promise<{ runTrial: RunTrialFn }>} loadRunTrial
 *   Async loader for the consumer's trial runner; called lazily inside the
 *   LLM-touching modes only, after SES has been installed.
 * @property {MakeAxAIFn} makeAxAI          Maps an env + model to an Ax `ai({...})` instance.
 * @property {string} [defaultModel]        Fallback model when no flag or env var supplies one.
 * @property {string} [studentModelEnvVar]  Env var holding the GEPA student model (default `AGENTRY_STUDENT_MODEL`).
 * @property {string} [teacherModelEnvVar]  Env var holding the GEPA teacher model (default `AGENTRY_TEACHER_MODEL`).
 * @property {string} [evalModelsEnvVar]    Env var holding the CSV of `--eval-models` (default `AGENTRY_EVAL_MODELS`).
 * @property {string} [legacyModelEnvVar]   Optional legacy env var for default model (e.g. `LAL_MODEL`).
 * @property {string} [scriptName]          Script name printed in --help (default `optimize:prompt`).
 */

/** @param {string} name */
const argFor = name => {
  const match = process.argv.slice(2).find(arg => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : '';
};

/** @param {string} name */
const hasFlag = name => process.argv.slice(2).includes(name);

/** @param {string} value */
const csvValues = value =>
  value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

/** @param {string} scriptName */
const printUsage = scriptName => {
  console.log(`Usage:
  yarn ${scriptName} --help
  yarn ${scriptName} --score-log=<trace.json> --example=<id>
  yarn ${scriptName} --trial=<id> [--model=<model>]
  yarn ${scriptName} --evaluate [--eval-models=<a,b>]
  yarn ${scriptName} [--optimizer=gepa|ace|bootstrap] [--rounds=4] [--eval-models=<a,b>]

LLM-touching modes (--trial, --evaluate, default GEPA) read provider keys
from ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY (the consumer's
makeAxAI may translate additional / legacy keys).

--score-log scores a previously-captured trace JSON file with no LLM call;
the file must be the .trace[] array a trial would have produced.`);
};

/** @param {string} envPath */
const loadEnv = async envPath => {
  let text;
  try {
    text = await fs.readFile(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  }
};

/**
 * @param {string} traceFile
 * @param {string} id
 * @param {Array<{ id: string }>} examples
 */
const scoreLogFile = async (traceFile, id, examples) => {
  const example = examples.find(item => item.id === id);
  if (!example) {
    throw new Error(`Unknown example "${id}"`);
  }
  const trace = JSON.parse(await fs.readFile(traceFile, 'utf8'));
  return {
    example: id,
    trace,
    score: scoreObservedTrace(trace, /** @type {any} */ (example)),
  };
};

/**
 * @param {{
 *   runTrial: RunTrialFn,
 *   example: { id: string },
 *   systemPrompt: string,
 *   model?: string,
 * }} input
 */
const runScoredTrial = async ({ runTrial, example, systemPrompt, model }) => {
  const result = await runTrial(
    /** @type {any} */ ({ example, systemPrompt, model }),
  );
  return harden({
    example: example.id,
    model,
    replyText: result.replyText,
    timedOut: result.timedOut,
    trace: result.trace,
    score: scoreObservedTrace(result.trace, /** @type {any} */ (example)),
  });
};

/**
 * Run the optimizer CLI against the supplied config. The config wires
 * the consumer-specific paths (examples, env), trial-runner loader, and
 * Ax provider factory into the generic optimizer flow.
 *
 * @param {OptimizerCliConfig} config
 */
export const runOptimizerCli = async config => {
  const {
    examplesPath,
    envPath,
    loadSystemPrompt,
    loadRunTrial,
    makeAxAI,
    defaultModel,
    studentModelEnvVar = 'AGENTRY_STUDENT_MODEL',
    teacherModelEnvVar = 'AGENTRY_TEACHER_MODEL',
    evalModelsEnvVar = 'AGENTRY_EVAL_MODELS',
    legacyModelEnvVar,
    scriptName = 'optimize:prompt',
  } = config;

  if (hasFlag('--help') || hasFlag('-h')) {
    printUsage(scriptName);
    return;
  }

  /** @type {Array<{ id: string }>} */
  const examples = JSON.parse(await fs.readFile(examplesPath, 'utf8'));

  const scoreLogPath = argFor('--score-log');
  if (scoreLogPath) {
    const exampleId = argFor('--example');
    if (!exampleId) {
      throw new Error('--example=<id> is required with --score-log');
    }
    const report = await scoreLogFile(scoreLogPath, exampleId, examples);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // LLM-touching modes from here on down. These pull in the consumer's
  // agent transitively (lal's agent.js loads @endo/marshal -> @endo/errors
  // and requires SES). Lazy-import so `--help` / `--score-log` continue
  // to run without SES.
  await import('@endo/init');
  if (envPath) {
    await loadEnv(envPath);
  }
  const [
    { ai },
    { AgentryPromptProgram, makePromptOptimizer, traceMetric },
    { DEFAULT_MODEL, expandExamplesByModel, summarizeModelTrials },
    { runTrial },
    defaultSystemPrompt,
  ] = await Promise.all([
    import('@ax-llm/ax'),
    import('./ax-harness.js'),
    import('./model-matrix.js'),
    loadRunTrial(),
    loadSystemPrompt ? loadSystemPrompt() : Promise.resolve(''),
  ]);

  const trialId = argFor('--trial');
  if (trialId) {
    const example = examples.find(
      (/** @type {any} */ item) => item.id === trialId,
    );
    if (!example) {
      throw new Error(`Unknown example "${trialId}"`);
    }
    const report = await runScoredTrial({
      runTrial,
      example,
      systemPrompt: defaultSystemPrompt,
      model:
        argFor('--model') ||
        (legacyModelEnvVar ? process.env[legacyModelEnvVar] : undefined) ||
        defaultModel,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const evalModels = csvValues(
    argFor('--eval-models') ||
      process.env[evalModelsEnvVar] ||
      (legacyModelEnvVar ? process.env[legacyModelEnvVar] : '') ||
      defaultModel ||
      DEFAULT_MODEL,
  );

  if (hasFlag('--evaluate')) {
    /** @type {Awaited<ReturnType<typeof runScoredTrial>>[]} */
    const trials = [];
    for (const model of evalModels) {
      for (const example of examples) {
        // Matrix evaluation is intentionally serial to keep provider
        // pressure predictable across heterogeneous rate limits.
        // eslint-disable-next-line no-await-in-loop
        trials.push(
          // eslint-disable-next-line no-await-in-loop
          await runScoredTrial({
            runTrial,
            example,
            systemPrompt: defaultSystemPrompt,
            model,
          }),
        );
      }
    }
    console.log(
      JSON.stringify(
        {
          mode: 'evaluate',
          models: evalModels,
          summary: summarizeModelTrials(trials),
          trials,
        },
        null,
        2,
      ),
    );
    return;
  }

  const optimizerKind = argFor('--optimizer') || 'gepa';
  if (!['gepa', 'ace', 'bootstrap'].includes(optimizerKind)) {
    throw new Error(`Unknown optimizer "${optimizerKind}"`);
  }
  const rounds = Number(argFor('--rounds') || 4);
  const maxMetricCalls = Number(argFor('--max-metric-calls') || 40);
  const validationCount = Math.max(1, Math.ceil(examples.length * 0.2));
  const trainBase = examples.slice(0, -validationCount);
  const validationBase = examples.slice(-validationCount);
  const train = expandExamplesByModel(trainBase, evalModels);
  const validation = expandExamplesByModel(validationBase, evalModels);
  const studentModel =
    process.env[studentModelEnvVar] ||
    (legacyModelEnvVar ? process.env[legacyModelEnvVar] : '') ||
    evalModels[0];
  if (!studentModel) {
    throw new Error(
      `${legacyModelEnvVar ? `${legacyModelEnvVar} or ` : ''}${studentModelEnvVar} is required`,
    );
  }
  const teacherModel = process.env[teacherModelEnvVar] || studentModel;
  const studentAI = makeAxAI(process.env, studentModel, ai);
  const teacherAI = makeAxAI(process.env, teacherModel, ai);
  let trialCount = 0;
  const program = new AgentryPromptProgram(async input => {
    trialCount += 1;
    return runTrial(input);
  }, defaultSystemPrompt);
  const optimizer = makePromptOptimizer(
    /** @type {'gepa' | 'ace' | 'bootstrap'} */ (optimizerKind),
    {
      studentAI,
      teacherAI,
      rounds,
    },
  );
  const result = await optimizer.compile(program, train, traceMetric, {
    validationExamples: validation,
    maxMetricCalls,
  });
  console.log(
    JSON.stringify(
      {
        optimizer: optimizerKind,
        rounds,
        evalModels,
        examples: {
          train: trainBase.map((/** @type {any} */ e) => e.id),
          validation: validationBase.map((/** @type {any} */ e) => e.id),
        },
        bestScore: result.bestScore,
        trialCount,
        optimizedSystemPrompt: result.optimizedProgram?.instruction,
      },
      null,
      2,
    ),
  );
};
harden(runOptimizerCli);
