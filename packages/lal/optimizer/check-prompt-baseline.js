#!/usr/bin/env node
// @ts-check
/* global process */
/**
 * Lint: confirm `packages/lal/prompts/system.js` and the optimizer's
 * examples have not drifted from the recorded prompt baseline.
 *
 * Two checks:
 *   1. SHA256 hashes of `prompts/system.js` and `optimizer/examples.json`
 *      must match the recorded baseline. Drift => fail. This is active
 *      from day one.
 *   2. If `prompt-baseline.json` records `trainingScore`, the previous
 *      recorded score in `git show HEAD:...` must not regress. This is
 *      active only after baseline-scoring has been run at least once;
 *      until then `trainingScore` is absent and the check is skipped.
 */

import './init.js';

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const dirname = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.join(dirname, '..');
const repoRoot = path.join(packageRoot, '..', '..');
const baselinePath = path.join(dirname, 'prompt-baseline.json');
const promptPath = path.join(packageRoot, 'prompts', 'system.js');
const examplesPath = path.join(dirname, 'examples.json');
const baselineRepoPath = path.relative(repoRoot, baselinePath);

/** @param {string | Buffer} value */
export const sha256 = value =>
  crypto.createHash('sha256').update(value).digest('hex');
harden(sha256);

/**
 * @typedef {{
 *   systemPromptSha256: string,
 *   examplesSha256: string,
 *   scores?: Record<string, number>,
 *   trainingScore?: number,
 * }} PromptBaseline
 */

/**
 * @param {{
 *   baseline: PromptBaseline,
 *   previousBaseline?: PromptBaseline,
 *   systemPromptSha256: string,
 *   examplesSha256: string,
 * }} input
 * @returns {readonly string[]}
 */
export const findBaselineIssues = ({
  baseline,
  previousBaseline,
  systemPromptSha256,
  examplesSha256,
}) => {
  /** @type {string[]} */
  const issues = [];
  if (baseline.systemPromptSha256 !== systemPromptSha256) {
    issues.push(
      'prompts/system.js changed since the recorded optimizer baseline',
    );
  }
  if (baseline.examplesSha256 !== examplesSha256) {
    issues.push('optimizer/examples.json changed since the recorded baseline');
  }
  // Score-presence and -regression checks are gated on `trainingScore`
  // being present in BOTH the current baseline and the previous (HEAD)
  // baseline. On a fresh checkout the file ships without scores; we
  // intentionally skip the regression check until baseline-scoring has
  // been run at least once.
  if (
    previousBaseline &&
    typeof baseline.trainingScore === 'number' &&
    typeof previousBaseline.trainingScore === 'number' &&
    baseline.trainingScore < previousBaseline.trainingScore
  ) {
    issues.push(
      `training score regressed from ${previousBaseline.trainingScore} to ${baseline.trainingScore}`,
    );
  }
  if (previousBaseline?.scores) {
    for (const [model, previousScore] of Object.entries(
      previousBaseline.scores,
    )) {
      const currentScore = baseline.scores?.[model];
      if (currentScore === undefined) {
        issues.push(`score for ${model} is missing from the baseline`);
      } else if (currentScore < previousScore) {
        issues.push(
          `score for ${model} regressed from ${previousScore} to ${currentScore}`,
        );
      }
    }
  }
  return harden(issues);
};
harden(findBaselineIssues);

const loadPreviousBaseline = () => {
  try {
    const previous = execFileSync('git', ['show', `HEAD:${baselineRepoPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /** @type {PromptBaseline} */ (JSON.parse(previous));
  } catch {
    return undefined;
  }
};

const main = async () => {
  const [baseline, promptSource, examplesSource] = await Promise.all([
    fs.readFile(baselinePath, 'utf8').then(JSON.parse),
    fs.readFile(promptPath),
    fs.readFile(examplesPath),
  ]);
  const issues = findBaselineIssues({
    baseline,
    previousBaseline: loadPreviousBaseline(),
    systemPromptSha256: sha256(promptSource),
    examplesSha256: sha256(examplesSource),
  });
  if (issues.length > 0) {
    console.error('Prompt optimizer baseline is stale or regressed:');
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    console.error(
      'Re-run yarn optimize:prompt --evaluate, review the result, and update optimizer/prompt-baseline.json before committing.',
    );
    process.exitCode = 1;
    return;
  }
  const scoreNote =
    typeof baseline.trainingScore === 'number'
      ? `score ${baseline.trainingScore}`
      : 'no recorded score (baseline-scoring deferred)';
  console.log(`Prompt optimizer baseline is current (${scoreNote}).`);
};

if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
