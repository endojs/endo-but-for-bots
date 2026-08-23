// @ts-check

/**
 * The runtime half of helpdown: turn a parsed help record into the `help`
 * method that capabilities conventionally expose.
 *
 * This module holds the single definition of the fallback wording every
 * capability shows for an undocumented interface or method, so the text a
 * caller sees does not drift between packages.
 */

import harden from '@endo/harden';

/** @import { HelpText } from './types.js' */

/**
 * Create a help function that looks up documentation.
 *
 * @param {HelpText} helpText - The help text object
 * @param {HelpText[]} [fallbacks] - Additional help texts to search
 * @returns {(methodName?: string) => string}
 */
export const makeHelp = (helpText, fallbacks = []) => {
  /**
   * @param {string} [methodName]
   * @returns {string}
   */
  const help = (methodName = '') => {
    if (methodName in helpText) {
      return helpText[methodName];
    }
    for (const fallback of fallbacks) {
      if (methodName in fallback) {
        return fallback[methodName];
      }
    }
    if (methodName === '') {
      return 'No documentation available for this interface.';
    }
    return `No documentation available for method "${methodName}".`;
  };
  return help;
};
harden(makeHelp);
