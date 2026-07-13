#!/usr/bin/env node
// @ts-check
/* global process */
/**
 * lal-side CLI wrapper for the agentry prompt optimizer.
 *
 * Wires lal's package-specific paths (examples, baseline, system
 * prompt), trial runner, and Ax provider factory into agentry's
 * generic `runOptimizerCli`. The CLI surface (`--help`,
 * `--score-log=...`, `--trial=...`, `--evaluate`, default GEPA) is
 * defined in agentry; this file only supplies the lal-specific config
 * object.
 */

import '@endo/agentry/optimizer/init';

import path from 'node:path';
import url from 'node:url';

import { runOptimizerCli } from '@endo/agentry/optimizer/optimize-prompt';

// IMPORTANT: lal's `prompts/system.js` and `./trial-runner.js` both
// transitively reach lal's `agent.js`, which loads `@endo/marshal` ->
// `@endo/errors` and throws unless SES is installed. agentry's
// `runOptimizerCli` lazy-imports the trial runner and system prompt for
// LLM-touching modes (after it has loaded `@endo/init`), so we pass
// thunks instead of resolved values.

const dirname = path.dirname(url.fileURLToPath(import.meta.url));

/**
 * lal's provider mapping: pick the Ax provider name from the LAL_HOST
 * URL substring or the `<provider>/<model>` model prefix, and read the
 * matching per-provider API key (falling back to lal's legacy
 * `LAL_AUTH_TOKEN`). Mirrors the prior in-file `makeAxAI`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} model
 * @param {(args: any) => any} ai
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
  await runOptimizerCli({
    examplesPath: path.join(dirname, 'examples.json'),
    envPath: path.join(dirname, '..', '.env'),
    loadSystemPrompt: async () => {
      const { systemPrompt } = await import('../prompts/system.js');
      return systemPrompt;
    },
    loadRunTrial: async () => {
      const { runTrial } = await import('./trial-runner.js');
      return { runTrial };
    },
    makeAxAI,
    studentModelEnvVar: 'LAL_OPTIMIZER_STUDENT_MODEL',
    teacherModelEnvVar: 'LAL_OPTIMIZER_TEACHER_MODEL',
    evalModelsEnvVar: 'LAL_OPTIMIZER_EVAL_MODELS',
    legacyModelEnvVar: 'LAL_MODEL',
    legacyHostEnvVar: 'LAL_HOST',
    scriptName: 'optimize:prompt',
  });
};

if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
