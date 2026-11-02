// @ts-check

/** @import { ArgumentBinding } from './types.js' */

import harden from '@endo/harden';

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g;

/**
 * List a template body's distinct variables in order of first appearance.
 *
 * @param {string} body
 * @returns {readonly string[]}
 */
export const extractVariables = body =>
  harden([
    ...new Set(Array.from(body.matchAll(VARIABLE_PATTERN), match => match[1])),
  ]);
harden(extractVariables);

/**
 * Replace each `{{name}}` that has a value. This makes a single pass over the
 * body, so a value containing `{{other}}` or `$&` stays literal. A placeholder
 * with no value also stays, so the user can see it in the editor.
 *
 * @param {string} body
 * @param {Readonly<Record<string, string>>} values
 * @returns {string}
 */
export const substituteVariables = (body, values) =>
  body.replace(VARIABLE_PATTERN, (placeholder, name) =>
    Object.hasOwn(values, name) ? values[name] : placeholder,
  );
harden(substituteVariables);

/**
 * Split a slash-command argument string the way a shell splits words: single
 * or double quotes group whitespace, the quotes are removed, and `""` yields an
 * empty argument. An unterminated quote runs to the end of the string.
 *
 * @param {string} text
 * @returns {readonly string[]}
 */
export const parseCommandArguments = text => {
  /** @type {string[]} */
  const parsed = [];
  let current = '';
  let hasToken = false;
  /** @type {string | undefined} */
  let quote;
  for (const character of text) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      hasToken = true;
    } else if (/\s/.test(character)) {
      if (hasToken) {
        parsed.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += character;
      hasToken = true;
    }
  }
  if (hasToken) {
    parsed.push(current);
  }
  return harden(parsed);
};
harden(parseCommandArguments);

/**
 * Assign positional arguments to variables in order of first appearance.
 *
 * @param {readonly string[]} variables
 * @param {readonly string[]} commandArguments
 * @returns {ArgumentBinding}
 */
export const bindArguments = (variables, commandArguments) =>
  harden({
    values: Object.fromEntries(
      variables
        .slice(0, commandArguments.length)
        .map((name, index) => [name, commandArguments[index]]),
    ),
    missing: variables.slice(commandArguments.length),
    excess: Math.max(0, commandArguments.length - variables.length),
  });
harden(bindArguments);
