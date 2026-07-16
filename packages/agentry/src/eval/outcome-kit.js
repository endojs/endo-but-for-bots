// @ts-check
/// <reference types="ses"/>

/** @import { OutcomeCheck, OutcomeMeasurementPoint, OutcomeReport, ReadText } from './types.js' */

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';

/**
 * One outcome check: a named pass/fail with a human-readable detail string.
 * Shared by every eval's outcome assertion.
 *
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 * @returns {OutcomeCheck}
 */
export const check = (name, ok, detail) => harden({ name, ok, detail });
harden(check);

/**
 * Record one task-specific progress marker separately from the gate checks.
 *
 * @param {string} name
 * @param {boolean} hit
 * @param {string} detail
 * @returns {OutcomeMeasurementPoint}
 */
export const measurementPoint = (name, hit, detail) =>
  harden({ name, hit, detail });
harden(measurementPoint);

/**
 * Build the report shared by scenario outcome assertions.
 * `pass` remains the existing all-checks gate.
 * `score` is a normalized fraction of the separately declared measurement
 * points that were hit.
 *
 * @param {OutcomeCheck[]} checks
 * @param {OutcomeMeasurementPoint[]} measurementPoints
 * @returns {OutcomeReport}
 */
export const makeOutcomeReport = (checks, measurementPoints) => {
  const hitCount = measurementPoints.filter(point => point.hit).length;
  const score =
    measurementPoints.length === 0 ? 1 : hitCount / measurementPoints.length;
  const pass = checks.every(entry => entry.ok);
  const divergence =
    pass && score < 1
      ? 'pass-with-incomplete-score'
      : !pass && score === 1
        ? 'fail-with-complete-score'
        : null;
  return harden({
    pass,
    score,
    divergence,
    checks: harden(checks),
    measurementPoints: harden(measurementPoints),
  });
};
harden(makeOutcomeReport);

/**
 * Read the UTF-8 content of a tracked file at a git ref, or `undefined` when the
 * path is not tracked at that ref. Reads out of the committed tree
 * (`filesystemAt(ref)`), never the working tree, so a file written-but-not-
 * committed does not pass a content check.
 *
 * The endo fs `lookup` raises an `ENOENT`-tagged error when the path is absent
 * from the tree; that genuine "path not tracked" case returns `undefined`. Any
 * other failure (a backend fault, a broken capability, an unexpected error
 * shape) is infrastructure, not a model miss, and is rethrown so it surfaces
 * loudly rather than masquerading as a clean "file not committed".
 *
 * The byte reader is injected as `readText` so this kit carries no stream
 * dependency.
 *
 * @param {object} args
 * @param {unknown} args.git A live `@endo/exo-git` Git capability.
 * @param {ReadText} args.readText Read a File capability's content as UTF-8.
 * @param {string} args.ref The ref whose tree to read (a branch name, `HEAD`).
 * @param {string} args.path Repository-relative path to read.
 * @returns {Promise<string | undefined>}
 */
export const readTrackedFileAt = async ({ git, readText, ref, path }) => {
  const gitRef = /** @type {any} */ (git);
  const parts = Reflect.apply(String.prototype.split, path, ['/']);
  parts.every(part => part !== '' && part !== '..') ||
    Fail`path must be a non-empty relative path without "..": ${path}`;
  try {
    const committedFs = await E(gitRef).filesystemAt(ref);
    const committedRoot = await E(committedFs).root();
    const file = await parts.reduce(
      (nodeP, part) => E(nodeP).lookup(part),
      committedRoot,
    );
    return await readText(file);
  } catch (err) {
    const message = /** @type {Error} */ (err)?.message ?? '';
    if (!/ENOENT/.test(message)) {
      throw err;
    }
    return undefined;
  }
};
harden(readTrackedFileAt);

/**
 * Resolve a branch's commit list, newest-first, through the live `git`
 * capability. `log({ ref })` returns the branch's commits with the tip first.
 *
 * @param {object} args
 * @param {unknown} args.git A live `@endo/exo-git` Git capability.
 * @param {string} args.ref The branch (or ref) whose log to read.
 * @returns {Promise<Array<{ oid: string, summary: string }>>}
 */
export const branchLog = async ({ git, ref }) => {
  const gitRef = /** @type {any} */ (git);
  return E(gitRef).log({ ref });
};
harden(branchLog);
