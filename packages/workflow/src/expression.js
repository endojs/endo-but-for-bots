// @ts-check

/**
 * Powerless-compartment evaluation of definition guard and reducer
 * expressions.
 *
 * Guards and reducers are small pure expressions carried as strings in a
 * workflow definition and evaluated in a fresh SES `Compartment` with no
 * endowments: no authority, deterministic by construction, hardened
 * inputs.
 *
 * SES on Node cannot meter evaluation, so a hostile expression could
 * still spin the engine turn; the primary control is the trust model
 * (definitions come only from the host) and this module's define-time
 * syntactic budget is defense in depth: a length cap and a keyword
 * denylist that excludes loops, function declarations, and the dynamic
 * evaluators. See `designs/endo-workflow.md` § "The reducer problem".
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

const MAX_EXPRESSION_LENGTH = 1024;

// Word-boundary denylist enforcing the expression subset: no loops, no
// function/class declarations, no dynamic evaluation, no ambient escape
// hatches. Arrow functions remain, which is exactly the intended shape:
// `({ context, event }) => <expression>`.
const FORBIDDEN_WORDS = harden([
  'while',
  'for',
  'do',
  'function',
  'class',
  'new',
  'this',
  'yield',
  'async',
  'await',
  'import',
  'export',
  'eval',
  'Function',
  'Compartment',
  'globalThis',
]);

const forbiddenPattern = new RegExp(
  `\\b(?:${FORBIDDEN_WORDS.join('|')})\\b`,
  'u',
);

/**
 * Check an expression source against the syntactic budget without
 * evaluating it. Returns a human-readable problem or `undefined`.
 *
 * @param {unknown} source
 * @returns {string | undefined}
 */
export const expressionBudgetProblem = source => {
  if (typeof source !== 'string') {
    return `expression must be a string, not ${typeof source}`;
  }
  if (source.length > MAX_EXPRESSION_LENGTH) {
    return `expression exceeds the ${MAX_EXPRESSION_LENGTH}-character budget`;
  }
  const match = forbiddenPattern.exec(source);
  if (match !== null) {
    return `expression uses forbidden word ${q(match[0])}`;
  }
  return undefined;
};
harden(expressionBudgetProblem);

/**
 * Compile an expression in a powerless compartment, enforcing the
 * syntactic budget first. The result must evaluate to a function; it is
 * hardened before return.
 *
 * A fresh `Compartment` per compilation keeps expressions from
 * communicating through shared compartment state.
 *
 * @param {string} source
 * @returns {(input: unknown) => unknown}
 */
export const compileExpression = source => {
  const problem = expressionBudgetProblem(source);
  if (problem !== undefined) {
    throw makeError(X`Rejected expression: ${q(problem)}`);
  }
  const compartment = new Compartment();
  let fn;
  try {
    fn = compartment.evaluate(`(${source})`);
  } catch (cause) {
    throw makeError(
      X`Expression failed to parse: ${q(source)}: ${q(
        /** @type {Error} */ (cause).message,
      )}`,
    );
  }
  if (typeof fn !== 'function') {
    throw makeError(X`Expression must be a function: ${q(source)}`);
  }
  return harden(fn);
};
harden(compileExpression);

/**
 * Evaluate a compiled expression over hardened input, hardening the
 * result so expression output cannot serve as a communication channel.
 *
 * @param {(input: unknown) => unknown} fn
 * @param {unknown} input
 * @returns {unknown}
 */
export const evaluateExpression = (fn, input) => {
  return harden(fn(harden(input)));
};
harden(evaluateExpression);

// Template placeholders are `${context.<dotted-path>}`.
const templatePattern = /\$\{context\.([\w.]+)\}/gu;

/**
 * Substitute `${context.path}` placeholders in a definition string.
 *
 * Substituted values render as their JSON encoding — quoted, delimited
 * data — never spliced raw into the surrounding text. Descriptions reach
 * humans and LLM agents; the trust model requires participant-supplied
 * content to be visibly data, not instruction.
 *
 * @param {string} template
 * @param {Record<string, unknown>} context
 * @returns {string}
 */
export const substituteTemplate = (template, context) => {
  return template.replaceAll(templatePattern, (_all, path) => {
    /** @type {unknown} */
    let value = context;
    for (const segment of /** @type {string} */ (path).split('.')) {
      if (typeof value !== 'object' || value === null) {
        value = undefined;
        break;
      }
      value = /** @type {Record<string, unknown>} */ (value)[segment];
    }
    // eslint-disable-next-line no-template-curly-in-string -- literal marker text, not a template
    return value === undefined ? '${undefined}' : JSON.stringify(value);
  });
};
harden(substituteTemplate);
