#!/usr/bin/env node
// @ts-check
/* global process */
/**
 * lal-side wrapper for agentry's baseline lint.
 *
 * Pins the lal-specific paths (system prompt, examples, baseline JSON,
 * repo root) and the re-evaluation hint into agentry's
 * `runBaselineCheck`.
 */

import '@endo/agentry/optimizer/init';

import path from 'node:path';
import url from 'node:url';

import { runBaselineCheck } from '@endo/agentry/optimizer/check-prompt-baseline';

const dirname = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.join(dirname, '..');
const repoRoot = path.join(packageRoot, '..', '..');

const main = async () => {
  await runBaselineCheck({
    baselinePath: path.join(dirname, 'prompt-baseline.json'),
    systemPromptPath: path.join(packageRoot, 'prompts', 'system.js'),
    examplesPath: path.join(dirname, 'examples.json'),
    repoRoot,
    systemPromptLabel: 'prompts/system.js',
    examplesLabel: 'optimizer/examples.json',
    reEvaluateHint:
      'Re-run yarn optimize:prompt --evaluate, review the result, and update optimizer/prompt-baseline.json before committing.',
  });
};

if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
