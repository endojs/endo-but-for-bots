// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { Evaluate, EvaluateInput } from './types.js' */

import { E } from '@endo/eventual-send';

/**
 * The daemon accepts only pet-name paths, so split a slash-delimited pet
 * name string into its path components.
 *
 * @param {string | string[]} nameOrPath
 * @returns {string[]}
 */
const toPetNamePath = nameOrPath =>
  typeof nameOrPath === 'string' ? nameOrPath.split('/') : nameOrPath;

/**
 * Build a daemon-hosted evaluate function.
 * The host is supplied as a live powers reference and is expected to expose
 * the daemon's existing `evaluate(workerName, source, codeNames, petNames,
 * resultName)` method.
 *
 * @param {ERef<{ evaluate: (workerName: undefined, source: string, codeNames: string[], petNames: string[][], resultName?: string[]) => Promise<unknown> }>} powers
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
