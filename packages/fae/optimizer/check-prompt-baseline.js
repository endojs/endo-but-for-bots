#!/usr/bin/env node
// @ts-check
/* global process */

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
const promptPath = path.join(packageRoot, 'src', 'system-prompt.js');
const repairMessagesPath = path.join(packageRoot, 'src', 'repair-messages.js');
const examplesPath = path.join(dirname, 'examples.json');
const baselineRepoPath = path.relative(repoRoot, baselinePath);

/** @param {string | Buffer} value */
export const sha256 = value =>
  crypto.createHash('sha256').update(value).digest('hex');
harden(sha256);

/**
 * @typedef {{
 *   systemPromptSha256: string,
 *   repairMessagesSha256: string,
 *   examplesSha256: string,
 *   trainingScore: number,
 *   modelScores?: Record<string, number>,
 * }} PromptBaseline
 */

/**
 * @param {{
 *   baseline: PromptBaseline,
 *   previousBaseline?: PromptBaseline,
 *   systemPromptSha256: string,
 *   repairMessagesSha256: string,
 *   examplesSha256: string,
 * }} input
 */
export const findBaselineIssues = ({
  baseline,
  previousBaseline,
  systemPromptSha256,
  repairMessagesSha256,
  examplesSha256,
}) => {
  /** @type {string[]} */
  const issues = [];

  if (baseline.systemPromptSha256 !== systemPromptSha256) {
    issues.push(
      'system-prompt.js changed since the recorded optimizer baseline',
    );
  }
  if (baseline.repairMessagesSha256 !== repairMessagesSha256) {
    issues.push(
      'repair-messages.js changed since the recorded optimizer baseline',
    );
  }
  if (baseline.examplesSha256 !== examplesSha256) {
    issues.push('optimizer/examples.json changed since the recorded baseline');
  }
  if (
    previousBaseline &&
    baseline.trainingScore < previousBaseline.trainingScore
  ) {
    issues.push(
      `training score regressed from ${previousBaseline.trainingScore} to ${baseline.trainingScore}`,
    );
  }
  for (const [model, previousScore] of Object.entries(
    previousBaseline?.modelScores || {},
  )) {
    const currentScore = baseline.modelScores?.[model];
    if (currentScore === undefined) {
      issues.push(`model score for ${model} is missing from the baseline`);
    } else if (currentScore < previousScore) {
      issues.push(
        `model score for ${model} regressed from ${previousScore} to ${currentScore}`,
      );
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
  const [baseline, promptSource, repairMessagesSource, examplesSource] =
    await Promise.all([
      fs.readFile(baselinePath, 'utf8').then(JSON.parse),
      fs.readFile(promptPath),
      fs.readFile(repairMessagesPath),
      fs.readFile(examplesPath),
    ]);
  const issues = findBaselineIssues({
    baseline,
    previousBaseline: loadPreviousBaseline(),
    systemPromptSha256: sha256(promptSource),
    repairMessagesSha256: sha256(repairMessagesSource),
    examplesSha256: sha256(examplesSource),
  });

  if (issues.length > 0) {
    console.error('Prompt optimizer baseline is stale or regressed:');
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    console.error(
      'Re-run yarn optimize:prompt, review the result, and update optimizer/prompt-baseline.json before committing.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Prompt optimizer baseline is current at score ${baseline.trainingScore}.`,
  );
};

if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
