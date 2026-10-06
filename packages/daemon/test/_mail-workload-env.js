// @ts-check
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * Read only the recorded construction value; no host or inference effects.
 * @param {unknown} powers
 * @param {unknown} context
 * @param {{env?: Record<string,string>}} [options]
 */
export const make = (powers, context, { env } = {}) =>
  makeExo(
    'RetainedFormulaText',
    M.interface('RetainedFormulaText', {
      read: M.call().returns(M.any()),
    }),
    {
      read: () => env?.FAE_SUBAGENT_PROMPT,
    },
  );
harden(make);
