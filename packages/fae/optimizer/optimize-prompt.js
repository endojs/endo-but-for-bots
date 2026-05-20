#!/usr/bin/env node
// @ts-check
/* global process */
/* eslint-disable import/no-extraneous-dependencies */

import './init.js';

import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

import { ai } from '@ax-llm/ax';

import {
  FaePromptProgram,
  makePromptOptimizer,
  traceMetric,
} from './ax-harness.js';
import { parseWorkerLogTrace, scoreObservedTrace } from './trace-metric.js';
import {
  guestSystemPromptSections,
  makeGuestSystemPrompt,
} from '../src/system-prompt.js';
import { summarizeModelTrials } from './model-matrix.js';
import examplesCorpus from './examples.js';

const dirname = path.dirname(url.fileURLToPath(import.meta.url));
const envPath = path.join(dirname, '..', '.env');

/**
 * @param {string} name
 */
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
  yarn optimize:prompt --score-log=<worker.log> --example=<id>
  yarn optimize:prompt --trial=<id> [--model=<model>] [--runner=<module.js>]
  yarn optimize:prompt --evaluate [--eval-models=<a,b>] [--runner=<module.js>]
  yarn optimize:prompt [--runner=<module.js>] [--optimizer=gepa|ace|bootstrap] [--rounds=4] [--eval-models=<a,b>]

Without --runner, the built-in daemon runner starts a fresh Endo daemon for each
trial. A custom runner module must export async runTrial({ example,
adoptionSection, systemPrompt, model }) and return { trace } or { workerLog }.`);
};

const loadExamples = async () => examplesCorpus;

const loadEnv = async () => {
  let text;
  try {
    text = await fs.readFile(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
};

/**
 * @param {string} runnerPath
 */
const loadRunner = async runnerPath => {
  const runnerUrl = runnerPath
    ? url.pathToFileURL(path.resolve(process.cwd(), runnerPath))
    : new URL('./daemon-runner.js', import.meta.url);
  const runnerModule = await import(runnerUrl.href);
  if (typeof runnerModule.runTrial !== 'function') {
    throw new Error('runner module must export async runTrial(...)');
  }
  return runnerModule;
};

/**
 * @param {string} workerLog
 * @param {string} id
 * @param {Array<{ id: string }>} examples
 */
const scoreLog = (workerLog, id, examples) => {
  const example = examples.find(item => item.id === id);
  if (!example) {
    throw new Error(`Unknown example "${id}"`);
  }
  const trace = parseWorkerLogTrace(workerLog);
  return {
    example: id,
    trace,
    score: scoreObservedTrace(trace, example),
  };
};

/**
 * @param {{
 *   runnerModule: { runTrial: Function },
 *   example: { id: string },
 *   adoptionSection: string,
 *   model?: string,
 * }} input
 */
const runScoredTrial = async ({
  runnerModule,
  example,
  adoptionSection,
  model,
}) => {
  const result = await runnerModule.runTrial({
    example,
    adoptionSection,
    systemPrompt: makeGuestSystemPrompt({ adoption: adoptionSection }),
    model,
  });
  const trace =
    result.trace ||
    parseWorkerLogTrace(
      typeof result.workerLog === 'string' ? result.workerLog : '',
    );
  return harden({
    example: example.id,
    model,
    replyText: result.replyText,
    timedOut: result.timedOut,
    trace,
    score: scoreObservedTrace(trace, example, { timedOut: result.timedOut }),
  });
};

/**
 * @param {Array<object>} examples
 * @param {string[]} models
 */
const expandExamplesByModel = (examples, models) =>
  models.length > 0
    ? models.flatMap(model => examples.map(example => ({ ...example, model })))
    : examples;

/**
 * Resolve the provider name from the host URL. Mirrors makeAxAI's
 * provider-selection logic so the banner and the provenance header
 * name the provider that will actually be used.
 *
 * @param {string} host
 */
const resolveProviderName = host => {
  if (host.includes('openrouter.ai')) return 'openrouter';
  if (host.includes('anthropic.com')) return 'anthropic';
  if (host.includes('generativelanguage.googleapis.com'))
    return 'google-gemini';
  if (host.includes('api.openai.com')) return 'openai';
  return 'ollama';
};

/**
 * Print a one-line banner naming the LLM provider and model the run is
 * about to use. Reads from ENDO_LLM_HOST / ENDO_LLM_MODEL first, then
 * falls back to LAL_HOST / LAL_MODEL (the api-key-injection wrapper
 * exports both families). The banner is written to stderr so it does
 * not contaminate the JSON the script prints to stdout.
 *
 * @param {NodeJS.ProcessEnv} env
 */
const printProviderBanner = env => {
  const host = env.ENDO_LLM_HOST || env.LAL_HOST || '';
  const model = env.ENDO_LLM_MODEL || env.LAL_MODEL || '(unset)';
  const provider = host ? resolveProviderName(host) : '(unset)';
  console.error(`Provider: ${provider}, Model: ${model}`);
};

/**
 * Standardized provenance header for optimizer output JSON. Every JSON
 * the optimizer writes leads with these fields so a future reader can
 * tell which provider and model(s) produced the numbers:
 *
 *   { recordedAt: ISO date (UTC),
 *     provider:   resolved provider name from the host URL,
 *     models:     string[] (always an array; single-model runs ship a
 *                 one-element array). }
 *
 * The same shape is mirrored in the on-disk findings.json and
 * prompt-baseline.json checked into the repo so recorded artifacts and
 * fresh writes share one schema.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} models
 */
const provenanceHeader = (env, models) => {
  const host = env.ENDO_LLM_HOST || env.LAL_HOST || '';
  return {
    recordedAt: new Date().toISOString().slice(0, 10),
    provider: host ? resolveProviderName(host) : '(unset)',
    models,
  };
};

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} model
 */
const makeAxAI = (env, model) => {
  const host = env.LAL_HOST || '';
  const apiKey = env.LAL_AUTH_TOKEN || '';
  if (host.includes('openrouter.ai')) {
    return ai({
      name: 'openrouter',
      apiKey,
      config: { model },
    });
  }
  if (host.includes('anthropic.com')) {
    return ai({
      name: 'anthropic',
      apiKey,
      config: { model },
    });
  }
  if (host.includes('generativelanguage.googleapis.com')) {
    return ai({
      name: 'google-gemini',
      apiKey,
      config: { model },
    });
  }
  if (host.includes('api.openai.com')) {
    return ai({
      name: 'openai',
      apiKey,
      config: { model },
    });
  }
  return ai({
    name: 'ollama',
    config: { model },
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
    const report = scoreLog(
      await fs.readFile(scoreLogPath, 'utf8'),
      exampleId,
      examples,
    );
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const runnerPath = argFor('--runner');
  const trialId = argFor('--trial');
  if (trialId) {
    await loadEnv();
    printProviderBanner(process.env);
    const example = examples.find(item => item.id === trialId);
    if (!example) {
      throw new Error(`Unknown example "${trialId}"`);
    }
    const runnerModule = await loadRunner(runnerPath);
    const adoptionSection = guestSystemPromptSections.adoption;
    const report = await runScoredTrial({
      runnerModule,
      example,
      adoptionSection,
      model: argFor('--model') || process.env.LAL_MODEL,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await loadEnv();
  printProviderBanner(process.env);
  const runnerModule = await loadRunner(runnerPath);
  const evalModels = csvValues(
    argFor('--eval-models') ||
      process.env.FAE_OPTIMIZER_EVAL_MODELS ||
      process.env.LAL_MODEL ||
      '',
  );
  if (evalModels.length === 0) {
    throw new Error(
      'LAL_MODEL or FAE_OPTIMIZER_EVAL_MODELS is required for optimizer runs',
    );
  }
  if (hasFlag('--evaluate')) {
    const adoptionSection = guestSystemPromptSections.adoption;
    /** @type {Awaited<ReturnType<typeof runScoredTrial>>[]} */
    const trials = [];
    for (const model of evalModels) {
      for (const example of examples) {
        // Matrix evaluation is intentionally serial to keep provider pressure
        // predictable across heterogeneous rate limits.
        // eslint-disable-next-line no-await-in-loop
        trials.push(
          // eslint-disable-next-line no-await-in-loop
          await runScoredTrial({
            runnerModule,
            example,
            adoptionSection,
            model,
          }),
        );
      }
    }
    console.log(
      JSON.stringify(
        {
          ...provenanceHeader(process.env, evalModels),
          mode: 'evaluate',
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
    process.env.FAE_OPTIMIZER_STUDENT_MODEL || process.env.LAL_MODEL;
  if (!studentModel) {
    throw new Error('LAL_MODEL or FAE_OPTIMIZER_STUDENT_MODEL is required');
  }
  const teacherModel = process.env.FAE_OPTIMIZER_TEACHER_MODEL || studentModel;
  const studentAI = makeAxAI(process.env, studentModel);
  const teacherAI = makeAxAI(process.env, teacherModel);
  let trialCount = 0;
  const program = new FaePromptProgram(async input => {
    trialCount += 1;
    const result = await runnerModule.runTrial(input);
    if (result.trace) {
      return result;
    }
    if (typeof result.workerLog === 'string') {
      return {
        ...result,
        trace: parseWorkerLogTrace(result.workerLog),
      };
    }
    throw new Error('runner must return either trace or workerLog');
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
        ...provenanceHeader(process.env, evalModels),
        optimizer: optimizerKind,
        rounds,
        examples: {
          train: trainBase.map(example => example.id),
          validation: validationBase.map(example => example.id),
        },
        bestScore: result.bestScore,
        trialCount,
        optimizedAdoptionSection: result.optimizedProgram?.instruction,
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
