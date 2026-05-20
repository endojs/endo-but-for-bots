#!/usr/bin/env node
// @ts-check
/* global process */
/* eslint-disable import/no-extraneous-dependencies */
/**
 * CLI entry for the lal prompt optimizer.
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
 * The LLM-touching modes (--trial, --evaluate, default) are deferred
 * to a future engagement; they remain wired here so the CLI surface is
 * complete, but the brief instructs us not to run them in this dispatch.
 */

import './init.js';

import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

// IMPORTANT: any module that touches lal's `agent.js` (i.e. trial-runner)
// pulls in `@endo/marshal` -> `@endo/errors`, which throws unless SES is
// installed. The LLM-touching modes do `await import('...trial-runner.js')`
// (and matching ax-harness / model-matrix imports) lazily so `--help`
// and `--score-log` can run without SES.

import { scoreObservedTrace } from './trace-metric.js';

const dirname = path.dirname(url.fileURLToPath(import.meta.url));
const examplesPath = path.join(dirname, 'examples.json');
const envPath = path.join(dirname, '..', '.env');

/** @param {string} name */
const argFor = name => {
  const match = process.argv.slice(2).find(arg => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : '';
};

const hasFlag = name => process.argv.slice(2).includes(name);

/** @param {string} value */
const csvValues = value =>
  value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

const printUsage = () => {
  console.log(`Usage:
  yarn optimize:prompt --help
  yarn optimize:prompt --score-log=<trace.json> --example=<id>
  yarn optimize:prompt --trial=<id> [--model=<model>]
  yarn optimize:prompt --evaluate [--eval-models=<a,b>]
  yarn optimize:prompt [--optimizer=gepa|ace|bootstrap] [--rounds=4] [--eval-models=<a,b>]

LLM-touching modes (--trial, --evaluate, default GEPA) read provider keys
from ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY, or the legacy
LAL_AUTH_TOKEN + LAL_HOST + LAL_MODEL trio (see packages/lal/*.env.example).

--score-log scores a previously-captured trace JSON file with no LLM call;
the file must be the .trace[] array a trial would have produced.`);
};

const loadExamples = async () =>
  JSON.parse(await fs.readFile(examplesPath, 'utf8'));

const loadEnv = async () => {
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
 *   runTrial: (input: any) => Promise<any>,
 *   example: { id: string },
 *   systemPrompt: string,
 *   model?: string,
 * }} input
 */
const runScoredTrial = async ({ runTrial, example, systemPrompt, model }) => {
  const result = await runTrial({ example, systemPrompt, model });
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
 * Wire the named provider into an Ax `ai()` factory. Accepts `ai` as a
 * parameter so the caller can lazily import `@ax-llm/ax` (Ax is only
 * needed for the LLM-touching modes; `--help` and `--score-log` must
 * not pull it in).
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} model
 * @param {(args: any) => any} ai - the `ai` factory from `@ax-llm/ax`
 */
const makeAxAI = (env, model, ai) => {
  const host = (env.LAL_HOST || '').toLowerCase();
  if (host.includes('anthropic.com') || model.startsWith('anthropic/')) {
    return ai({
      name: 'anthropic',
      apiKey: env.ANTHROPIC_API_KEY || env.LAL_AUTH_TOKEN || '',
      config: { model: model.replace(/^anthropic\//, '') },
    });
  }
  if (
    host.includes('generativelanguage.googleapis.com') ||
    model.startsWith('google/') ||
    model.startsWith('gemini')
  ) {
    return ai({
      name: 'google-gemini',
      apiKey: env.GEMINI_API_KEY || env.LAL_AUTH_TOKEN || '',
      config: { model: model.replace(/^google\//, '') },
    });
  }
  if (host.includes('openai.com') || model.startsWith('openai/')) {
    return ai({
      name: 'openai',
      apiKey: env.OPENAI_API_KEY || env.LAL_AUTH_TOKEN || '',
      config: { model: model.replace(/^openai\//, '') },
    });
  }
  if (host.includes('openrouter.ai') || model.startsWith('openrouter/')) {
    return ai({
      name: 'openrouter',
      apiKey: env.OPENROUTER_API_KEY || env.LAL_AUTH_TOKEN || '',
      config: { model: model.replace(/^openrouter\//, '') },
    });
  }
  return ai({
    name: 'ollama',
    config: { model: model.replace(/^ollama\//, '') },
  });
};

const main = async () => {
  if (hasFlag('--help') || hasFlag('-h')) {
    printUsage();
    return;
  }

  const examples = await loadExamples();

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

  // LLM-touching modes from here on down. These pull in lal's agent.js
  // transitively, which loads @endo/marshal -> @endo/errors and fails
  // unless SES has been installed. Lazy-import so `--help` /
  // `--score-log` continue to run without SES.
  await import('@endo/init');
  await loadEnv();
  const [
    { ai },
    { LalPromptProgram, makePromptOptimizer, traceMetric },
    { runTrial: defaultRunTrial },
    { DEFAULT_MODEL, expandExamplesByModel, summarizeModelTrials },
  ] = await Promise.all([
    import('@ax-llm/ax'),
    import('./ax-harness.js'),
    import('./trial-runner.js'),
    import('./model-matrix.js'),
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
      runTrial: defaultRunTrial,
      example,
      systemPrompt: '',
      model: argFor('--model') || process.env.LAL_MODEL,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const evalModels = csvValues(
    argFor('--eval-models') ||
      process.env.LAL_OPTIMIZER_EVAL_MODELS ||
      process.env.LAL_MODEL ||
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
            runTrial: defaultRunTrial,
            example,
            systemPrompt: '',
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
    process.env.LAL_OPTIMIZER_STUDENT_MODEL ||
    process.env.LAL_MODEL ||
    evalModels[0];
  if (!studentModel) {
    throw new Error('LAL_MODEL or LAL_OPTIMIZER_STUDENT_MODEL is required');
  }
  const teacherModel = process.env.LAL_OPTIMIZER_TEACHER_MODEL || studentModel;
  const studentAI = makeAxAI(process.env, studentModel, ai);
  const teacherAI = makeAxAI(process.env, teacherModel, ai);
  let trialCount = 0;
  const program = new LalPromptProgram(async input => {
    trialCount += 1;
    return defaultRunTrial(input);
  });
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

if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
