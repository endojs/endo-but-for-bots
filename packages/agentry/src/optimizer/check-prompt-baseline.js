// @ts-check
/* global process */
/**
 * Lint helper: confirm the system prompt and examples files have not
 * drifted from the recorded prompt baseline.
 *
 * Two checks:
 *   1. SHA256 hashes of the system-prompt file and examples file must
 *      match the recorded baseline. Drift => fail. This is active from
 *      day one.
 *   2. If the baseline records `trainingScore`, the previous recorded
 *      score in `git show HEAD:...` must not regress. This is active
 *      only after baseline-scoring has been run at least once; until
 *      then `trainingScore` is absent and the check is skipped.
 *
 * agentry owns the algorithm; the consumer owns the file paths. The
 * consumer wires the per-package paths into a thin `runBaselineCheck`
 * call (see `packages/lal/optimizer/check-prompt-baseline.js`).
 */

import './init.js';

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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
 *   systemPromptLabel?: string,
 *   examplesLabel?: string,
 * }} input
 * @returns {readonly string[]}
 */
export const findBaselineIssues = ({
  baseline,
  previousBaseline,
  systemPromptSha256,
  examplesSha256,
  systemPromptLabel = 'system prompt',
  examplesLabel = 'examples',
}) => {
  /** @type {string[]} */
  const issues = [];
  if (baseline.systemPromptSha256 !== systemPromptSha256) {
    issues.push(
      `${systemPromptLabel} changed since the recorded optimizer baseline`,
    );
  }
  if (baseline.examplesSha256 !== examplesSha256) {
    issues.push(`${examplesLabel} changed since the recorded baseline`);
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

/**
 * @param {{ baselinePath: string, repoRoot: string }} input
 * @returns {PromptBaseline | undefined}
 */
const loadPreviousBaseline = ({ baselinePath, repoRoot }) => {
  const baselineRepoPath = path.relative(repoRoot, baselinePath);
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

/**
 * @typedef {object} BaselineCheckConfig
 * @property {string} baselinePath        Absolute path to the baseline JSON.
 * @property {string} systemPromptPath    Absolute path to the system-prompt source file.
 * @property {string} examplesPath        Absolute path to the examples JSON.
 * @property {string} repoRoot            Absolute path to the repo root (for `git show HEAD:...`).
 * @property {string} [systemPromptLabel] Display label for the system-prompt file.
 * @property {string} [examplesLabel]     Display label for the examples file.
 * @property {string} [reEvaluateHint]    Per-package re-evaluation hint (defaults to lal's script name).
 */

/**
 * Run the baseline check against the consumer's paths. Sets
 * `process.exitCode = 1` on drift / regression. Returns the loaded
 * baseline on success so the caller can use any extra metadata.
 *
 * @param {BaselineCheckConfig} config
 * @returns {Promise<PromptBaseline>}
 */
export const runBaselineCheck = async config => {
  const {
    baselinePath,
    systemPromptPath,
    examplesPath,
    repoRoot,
    systemPromptLabel,
    examplesLabel,
    reEvaluateHint,
  } = config;
  const [baseline, promptSource, examplesSource] = await Promise.all([
    fs.readFile(baselinePath, 'utf8').then(JSON.parse),
    fs.readFile(systemPromptPath),
    fs.readFile(examplesPath),
  ]);
  const issues = findBaselineIssues({
    baseline,
    previousBaseline: loadPreviousBaseline({ baselinePath, repoRoot }),
    systemPromptSha256: sha256(promptSource),
    examplesSha256: sha256(examplesSource),
    systemPromptLabel,
    examplesLabel,
  });
  if (issues.length > 0) {
    console.error('Prompt optimizer baseline is stale or regressed:');
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    if (reEvaluateHint) {
      console.error(reEvaluateHint);
    }
    process.exitCode = 1;
    return baseline;
  }
  const scoreNote =
    typeof baseline.trainingScore === 'number'
      ? `score ${baseline.trainingScore}`
      : 'no recorded score (baseline-scoring deferred)';
  console.log(`Prompt optimizer baseline is current (${scoreNote}).`);
  return baseline;
};
harden(runBaselineCheck);
