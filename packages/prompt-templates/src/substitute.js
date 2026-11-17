// @ts-check

/** @import { ArgumentHintToken, PlaceholderAnalysis } from './types.js' */

import harden from '@endo/harden';

// One alternation covers Pi's whole grammar, so substitution is a single
// left-to-right pass: `${@:N:L}`, `${@:N}`, `${@:-default}`, `${n:-default}`,
// `$ARGUMENTS`, `$@`, and `$n` (n >= 1).
const PLACEHOLDER_PATTERN =
  /\$\{@:(\d+)(?::(\d+))?\}|\$\{@:-([^}]*)\}|\$\{([1-9]\d*):-([^}]*)\}|\$ARGUMENTS|\$@|\$([1-9]\d*)/g;

/**
 * Report the highest positional placeholder in a template body and whether
 * the body consumes the remaining arguments (`$@`, `$ARGUMENTS`, or a rest-slice form).
 *
 * @param {string} body
 * @returns {PlaceholderAnalysis}
 */
export const analyzePlaceholders = body => {
  let maxPosition = 0;
  let usesRest = false;
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const position = match[4] ?? match[6];
    if (position !== undefined) {
      maxPosition = Math.max(maxPosition, Number(position));
    } else {
      usesRest = true;
    }
  }
  return harden({ maxPosition, usesRest });
};
harden(analyzePlaceholders);

/**
 * Expand Pi placeholders with positional arguments in one pass, so a value
 * that contains `$1`, `${...}`, or `$&` stays literal. Text outside the
 * grammar (`$PATH`, `$0`, a lone `$`) is kept as written.
 *
 * @param {string} body
 * @param {readonly string[]} commandArguments
 * @returns {string}
 */
export const substituteArguments = (body, commandArguments) =>
  body.replace(
    PLACEHOLDER_PATTERN,
    (
      placeholder,
      sliceStart,
      sliceLength,
      restDefault,
      defaultPosition,
      positionalDefault,
      position,
    ) => {
      if (sliceStart !== undefined) {
        const start = Math.max(0, Number(sliceStart) - 1);
        const end =
          sliceLength === undefined ? undefined : start + Number(sliceLength);
        return commandArguments.slice(start, end).join(' ');
      }
      if (restDefault !== undefined) {
        return commandArguments.length > 0
          ? commandArguments.join(' ')
          : restDefault;
      }
      if (defaultPosition !== undefined) {
        const value = commandArguments[Number(defaultPosition) - 1];
        return value || positionalDefault;
      }
      if (position !== undefined) {
        return commandArguments[Number(position) - 1] ?? '';
      }
      // `$@` and `$ARGUMENTS`.
      return commandArguments.join(' ');
    },
  );
harden(substituteArguments);

/**
 * Parse an `argument-hint` such as `<focus> [scope]` into tokens. A token in
 * angle brackets is required; any other token, bracketed or bare, is optional.
 * The *n*th token labels `$n`.
 *
 * @param {string} hint
 * @returns {readonly ArgumentHintToken[]}
 */
export const parseArgumentHint = hint =>
  harden(
    Array.from(hint.matchAll(/<([^>]*)>|\[([^\]]*)\]|(\S+)/g), match =>
      match[1] !== undefined
        ? harden({ label: match[1].trim(), required: true })
        : harden({ label: (match[2] ?? match[3]).trim(), required: false }),
    ),
  );
harden(parseArgumentHint);

/**
 * Split a slash-command argument string by Pi's rules: whitespace separates
 * arguments; a `'` or `"` opens a quoted argument only at the start of an
 * argument, so an apostrophe inside a word is text; the matching quote closes
 * it and both quotes are removed (`""` is an empty argument); a quote with no
 * matching close stays as literal text; backslashes never escape. A quoted
 * argument ends at its closing quote, so `"a"b` is two arguments.
 *
 * @param {string} text
 * @returns {readonly string[]}
 */
export const parseCommandArguments = text => {
  /** @type {string[]} */
  const parsed = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }
    const character = text[index];
    if (character === '"' || character === "'") {
      const close = text.indexOf(character, index + 1);
      if (close !== -1) {
        parsed.push(text.slice(index + 1, close));
        index = close + 1;
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    let word = '';
    while (index < text.length && !/\s/.test(text[index])) {
      word += text[index];
      index += 1;
    }
    parsed.push(word);
  }
  return harden(parsed);
};
harden(parseCommandArguments);
