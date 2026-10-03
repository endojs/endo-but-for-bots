// @ts-check
/**
 * Code-evaluation tools: `evaluate` runs a snippet directly with endowments
 * the guest names, while `define` proposes a reusable program with named
 * slots for the host to fill.
 *
 * @import { Pattern } from '@endo/patterns'
 */

import { M } from '@endo/patterns';
import { NamePathArgumentShape } from '@endo/daemon/type-guards.js';

/** @import { LalToolDef } from './index.js' */

/** @type {LalToolDef[]} */
export const codeToolDefs = harden([
  // --- Code evaluation ---
  {
    name: 'evaluate',
    summary:
      'Evaluate JavaScript code directly. Arguments: ' +
      'workerNamePath (string[] path components, or undefined), source (string), ' +
      'codeNames (string[]), edgeNames (string[], one pet name per endowment), ' +
      'resultNamePath (string[], path components).',
    // workerNamePath + codeNames + edgeNames are optional in the dispatcher
    // (codeNames/edgeNames default to [] and workerNamePath accepts the
    // "#undefined" SmallCaps sentinel). Allow either undefined or the
    // expected shape. workerNamePath, like resultNamePath, is a pet-name path; the
    // argument shape admits a bare string only so the daemon can refuse it
    // with a retry-as-array error.
    params: M.splitRecord(
      { source: M.string(), resultNamePath: NamePathArgumentShape },
      {
        workerNamePath: M.or(NamePathArgumentShape, M.undefined()),
        codeNames: M.arrayOf(M.string()),
        edgeNames: M.arrayOf(M.string()),
      },
    ),
  },

  // --- Define (code with slots for host to fill) ---
  {
    name: 'define',
    summary:
      'Propose a reusable program with named capability slots for the host to fill. ' +
      'Unlike evaluate(), you do NOT provide the capabilities yourself. ' +
      'Arguments: source (string), slots (object mapping slot name to { label }).',
    params: M.splitRecord({
      source: M.string(),
      slots: M.recordOf(M.string(), M.splitRecord({ label: M.string() })),
    }),
  },
]);
