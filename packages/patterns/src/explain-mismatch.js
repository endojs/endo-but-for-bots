// @ts-check

import harden from '@endo/harden';

import { matches } from './patterns/patternMatchers.js';
import { traceWalk } from './explain-mismatch/trace.js';
import { renderTrace } from './explain-mismatch/render.js';

/**
 * @import {Passable} from '@endo/pass-style';
 * @import {Pattern} from './types.js';
 */

/**
 * @typedef {object} ExplainMismatchInput
 * @property {unknown} specimen The value being checked.
 * @property {unknown} pattern The pattern the value is checked against.
 * @property {string} [context] Optional caller-supplied prefix (e.g. an exo
 *   method name and argument index) prepended to the rendered report.
 */

/**
 * @typedef {object} ExplainMismatchOptions
 * @property {'compact' | 'expanded'} [format] Default `'compact'`.
 *   `'compact'` is one mismatch per line with ` | ` column separators,
 *   sized for AI-agent token economy. `'expanded'` is indented, Rust-
 *   compiler-style line-art, sized for a human reading at a REPL.
 */

/**
 * Non-throwing matcher that explains a pattern mismatch. Returns `undefined`
 * when the specimen matches the pattern, mirroring the verdict shape of
 * `matches(specimen, pattern): boolean`. Returns a rendered diagnostic
 * string when the specimen does not match.
 *
 * The submodule is opt-in: the production matcher path (`mustMatch`,
 * `assertMatches`, `matches`) is unchanged and pays no additional cost.
 * Callers that never `import` this module never load any of it.
 *
 * @param {ExplainMismatchInput} input
 * @param {ExplainMismatchOptions} [options]
 * @returns {string | undefined}
 */
export const explainMismatch = (input, options = {}) => {
  const { specimen, pattern, context } = input;
  if (
    matches(
      /** @type {Passable} */ (specimen),
      /** @type {Pattern} */ (pattern),
    )
  ) {
    return undefined;
  }
  const trace = traceWalk(
    /** @type {Passable} */ (specimen),
    /** @type {Pattern} */ (pattern),
  );
  return renderTrace(trace, { format: options.format, context });
};
harden(explainMismatch);
