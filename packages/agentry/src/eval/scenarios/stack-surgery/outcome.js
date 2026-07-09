// @ts-check
/// <reference types="ses"/>

/** @import { OutcomeReport, ReadText } from '../../types.js' */
/** @import { StackSurgeryTarget } from './scenario.js' */

import { E } from '@endo/eventual-send';

import { check, readTrackedFileAt } from '../../outcome-kit.js';

const MIXED_STACK_SURGERY_SUMMARY = 'feat: update alpha and beta stack';

/**
 * @typedef {object} GitOutcomeReader
 * @property {(options?: unknown) => Promise<Array<{ oid: string, summary: string }>>} log
 * @property {() => Promise<Array<{ path: string, index: string, worktree: string }>>} status
 */

/**
 * @param {object} args
 * @param {unknown} args.git
 * @param {ReadText} args.readText
 * @param {StackSurgeryTarget} args.expected
 * @returns {Promise<OutcomeReport>}
 */
export const assertStackSurgeryOutcome = async ({
  git,
  readText,
  expected,
}) => {
  const gitRef = /** @type {GitOutcomeReader} */ (git);
  /** @type {Array<{ name: string, ok: boolean, detail: string }>} */
  const checks = [];

  const mainLog = /** @type {Array<{ oid: string, summary: string }>} */ (
    await E(gitRef).log({ ref: 'main', maxCount: 1 })
  );
  const main = mainLog[0];
  const headLog = /** @type {Array<{ oid: string, summary: string }>} */ (
    await E(gitRef).log({})
  );
  const mainIndex =
    main === undefined
      ? -1
      : headLog.findIndex(entry => entry.oid === main.oid);
  checks.push(
    check(
      'linear-on-main',
      mainIndex >= 0,
      mainIndex >= 0
        ? `main ${main?.oid} is ancestor ${mainIndex} commits behind HEAD`
        : `main ${main?.oid ?? '<missing>'} is not in the HEAD history`,
    ),
  );

  const stack = mainIndex >= 0 ? headLog.slice(0, mainIndex) : headLog;
  const actualSummariesNewestFirst = stack.map(entry => entry.summary);
  const expectedNewestFirst = [...expected.summaries].reverse();
  checks.push(
    check(
      'final-stack-summaries',
      actualSummariesNewestFirst.length === expectedNewestFirst.length &&
        actualSummariesNewestFirst.every(
          (summary, index) => summary === expectedNewestFirst[index],
        ),
      `summaries newest-first ${JSON.stringify(
        actualSummariesNewestFirst,
      )} (expected ${JSON.stringify(expectedNewestFirst)})`,
    ),
  );

  const hasFixup = actualSummariesNewestFirst.some(summary =>
    summary.startsWith('fixup!'),
  );
  checks.push(
    check(
      'no-fixup-commits',
      !hasFixup,
      hasFixup
        ? `stack still contains fixup summaries: ${actualSummariesNewestFirst
            .filter(summary => summary.startsWith('fixup!'))
            .join(', ')}`
        : 'stack contains no fixup! commits',
    ),
  );

  checks.push(
    check(
      'mixed-commit-split',
      !actualSummariesNewestFirst.includes(MIXED_STACK_SURGERY_SUMMARY),
      actualSummariesNewestFirst.includes(MIXED_STACK_SURGERY_SUMMARY)
        ? `mixed summary ${JSON.stringify(MIXED_STACK_SURGERY_SUMMARY)} remains`
        : 'mixed alpha/beta summary is absent',
    ),
  );

  const betaTestText = await readTrackedFileAt({
    git,
    readText,
    ref: 'HEAD',
    path: 'beta/stack.test.js',
  });
  const expectedBetaTest = expected.files.find(
    entry => entry.path === 'beta/stack.test.js',
  );
  checks.push(
    check(
      'beta-test-reworded',
      actualSummariesNewestFirst.includes('test(beta): cover stack surgery') &&
        betaTestText === expectedBetaTest?.content,
      `beta test summary present=${actualSummariesNewestFirst.includes(
        'test(beta): cover stack surgery',
      )}; content matches=${betaTestText === expectedBetaTest?.content}`,
    ),
  );

  const fileChecks = await Promise.all(
    expected.files.map(async file => {
      const committedText = await readTrackedFileAt({
        git,
        readText,
        ref: 'HEAD',
        path: file.path,
      });
      const tracked = committedText !== undefined;
      return [
        check(
          `${file.path}-tracked-at-head`,
          tracked,
          tracked
            ? `${file.path} is present in the HEAD tree`
            : `${file.path} is not tracked at HEAD`,
        ),
        check(
          `${file.path}-content`,
          committedText === file.content,
          `committed content for ${file.path} ${JSON.stringify(
            committedText,
          )} (expected ${JSON.stringify(file.content)})`,
        ),
      ];
    }),
  );
  for (const entry of fileChecks.flat()) {
    checks.push(entry);
  }

  const rows =
    /** @type {Array<{ path: string, index: string, worktree: string }>} */ (
      await E(gitRef).status()
    );
  checks.push(
    check(
      'worktree-clean',
      rows.length === 0,
      rows.length === 0
        ? 'working tree has no pending status rows'
        : `working tree still has pending rows: ${rows
            .map(row => row.path)
            .join(', ')}`,
    ),
  );

  return harden({ pass: checks.every(entry => entry.ok), checks });
};
harden(assertStackSurgeryOutcome);
