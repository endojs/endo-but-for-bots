// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { EndoHost } from '@endo/daemon' */
/** @import { Evaluate, EvaluateInput } from './types.js' */

import { E } from '@endo/eventual-send';

/**
 * Wrap a lone pet name as a one-segment path; never split on a delimiter.
 *
 * @param {string | string[]} nameOrPath
 * @returns {string[]}
 */
const toPetNamePath = nameOrPath =>
  harden(typeof nameOrPath === 'string' ? [nameOrPath] : nameOrPath);

/**
 * Build a daemon-hosted evaluate function.
 * The host is supplied as a live powers reference and is expected to expose
 * the daemon's `evaluate(workerNamePath, source, codeNames, petNamePaths,
 * resultNamePath)` method.
 *
 * @param {ERef<Pick<EndoHost, 'evaluate'>>} powers
 * @returns {Evaluate}
 */
export const makeDaemonEvaluate = powers => {
  /** @param {EvaluateInput} input */
  const evaluate = async ({ source, resultName, globals }) => {
    const codeNames = harden(globals.map(({ name }) => name));
    const petNames = harden(
      globals.map(global => toPetNamePath(global.petName ?? global.name)),
    );
    return E(powers).evaluate(
      undefined,
      source,
      codeNames,
      petNames,
      resultName === undefined ? undefined : toPetNamePath(resultName),
    );
  };
  Object.defineProperty(evaluate, 'hasStoreValue', { value: true });
  return harden(evaluate);
};
harden(makeDaemonEvaluate);
