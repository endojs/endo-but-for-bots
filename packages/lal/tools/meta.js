// @ts-check
/**
 * Meta / self-documentation tools: `help` surfaces guest documentation, and
 * `inspect` resolves a capability and reports its help() text plus method
 * names. A guest has no `locate`: it designates values only by pet name.
 *
 * @import { Pattern } from '@endo/patterns'
 */

import { M } from '@endo/patterns';
import { NameOrPathShape } from '@endo/daemon/type-guards.js';

/** @import { LalToolDef } from './index.js' */

/** @type {LalToolDef[]} */
export const metaToolDefs = harden([
  // --- Self-documentation ---
  {
    name: 'help',
    summary:
      'Get documentation for guest capabilities or a specific method. ' +
      'Call with no arguments for an overview, or with a method name for specific documentation.',
    params: M.splitRecord({}, { methodName: M.string() }),
  },

  // --- Capability operations ---
  {
    name: 'inspect',
    summary:
      'Look up a capability by pet name and call its help() method to learn how to use it. ' +
      'Argument: petNameOrPath.',
    params: M.splitRecord({ petNameOrPath: NameOrPathShape }),
  },
]);
