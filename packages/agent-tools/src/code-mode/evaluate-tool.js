// @ts-check
/// <reference types="ses"/>

/** @import { ToolRecord } from '@endo/agent-tools' */
/** @import { CodeModeGlobal, Evaluate, EvaluateInput, EvaluateWithStoreValue, StoreValue } from './types.js' */

import { makeTool } from '../tool.js';

import { normalizeGlobals } from './declarations.js';

const RESULT_NAME_SCHEMA = harden({
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  description:
    'Optional pet name or pet-name path where the completion value is stored.',
});

/**
 * @param {boolean} hasStoreValue
 * @returns {object}
 */
const makeEvaluateParameters = hasStoreValue =>
  harden({
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description:
          'JavaScript source to evaluate in the code-mode compartment.',
      },
      ...(hasStoreValue && { resultName: RESULT_NAME_SCHEMA }),
    },
    required: ['source'],
    additionalProperties: false,
  });

const EVALUATE_PARAMETERS_WITHOUT_STORE = makeEvaluateParameters(false);

/** The JSON Schema for an `evaluate` tool with storage authority. */
export const EVALUATE_PARAMETERS = makeEvaluateParameters(true);
harden(EVALUATE_PARAMETERS);

/**
 * @param {unknown} value
 * @returns {value is string | string[]}
 */
const isResultName = value =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every(part => typeof part === 'string'));

/**
 * Build the model-facing `evaluate` tool.
 * The result-name parameter is advertised only when storage authority is
 * supplied by the caller or by the host evaluate function.
 *
 * @param {Evaluate} evaluate
 * @param {CodeModeGlobal[]} globals
 * @param {StoreValue | boolean} [storeValue] Storage authority, or `true` for
 *   a host that stores through another mechanism.
 * @returns {ToolRecord}
 */
export const makeEvaluateTool = (evaluate, globals, storeValue) => {
  const normalized = normalizeGlobals(globals);
  const evaluateWithStore = /** @type {EvaluateWithStoreValue} */ (evaluate);
  const hasStoreValue =
    storeValue !== undefined || evaluateWithStore.hasStoreValue === true;
  const parameters = hasStoreValue
    ? EVALUATE_PARAMETERS
    : EVALUATE_PARAMETERS_WITHOUT_STORE;
  return makeTool({
    name: 'evaluate',
    description:
      'Evaluate JavaScript source with the code-mode powers in lexical scope.',
    parameters,
    execute: async args => {
      const { source, resultName } = args;
      if (typeof source !== 'string') {
        throw new Error('evaluate.source must be a string');
      }
      if (!hasStoreValue && Object.hasOwn(args, 'resultName')) {
        throw new Error(
          'unexpected evaluate argument "resultName" without storeValue',
        );
      }
      if (resultName !== undefined && !isResultName(resultName)) {
        throw new Error('evaluate.resultName must be a string or string[]');
      }
      return evaluate({
        source,
        resultName,
        globals: normalized,
      });
    },
  });
};
harden(makeEvaluateTool);
