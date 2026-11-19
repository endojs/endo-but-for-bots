// @ts-check
/**
 * The `splitArgs` inspector operation (`designs/m9-interfaces.md` D-M9-14,
 * seam X1). A mail body or a subagent task over `inlineBytes` makes the
 * model's tool-call arguments a staged text, which the session vat cannot
 * parse (rule 12.10). The session sends it here; this vat reads it through
 * `Content` pages, parses it (model data, parsed in the exec vat on
 * purpose), stages every long string value again through the call's
 * `BlobWriters` (owned by the session) and answers the residual JSON text
 * with each staged string replaced by a placeholder string, plus the
 * StagedTexts in placeholder order: `{ status: 'split', split: { json,
 * staged } }` (`guards/base.js` `SplitArgs`).
 *
 * Rules:
 * - The residual is the model's own text with string-value literals cut
 *   out and nothing else changed: numbers, `raw` spans and white space keep
 *   their exact source (no parse-and-stringify round trip, which would
 *   change `1.0` or an unsafe integer). Object keys are never replaced.
 * - A placeholder is the JSON string `"\u0000s<k>"`, `k` its index in
 *   `staged`. A string value is staged when it is longer than
 *   `splitStringUnits`, or when it begins with the placeholder prefix (so
 *   in the residual every string that begins with it is a placeholder).
 * - When the residual is still over `inlineBytes`, more string values are
 *   staged, longest first, until it fits; past `splitStagedStrings` staged
 *   strings, or a string over `mailBodyUnits`, the call fails before
 *   anything is staged.
 * - A key flood or an exhausted name table answers `exhausted`, as every
 *   exec operation (the inspector's catch).
 *
 * Nothing here calls the request's `target`; the guard requires one, so the
 * session may pass any remotable it minted.
 */
import { textOf } from '../lib/guards/base.js';
import { limits } from '../lib/limits.js';
import { mailLimits } from '../lib/mail-limits.js';
import { chunkText, messageOf, utf8Bytes } from '../lib/bounded.js';
import { failed, isKeysExhausted } from './render.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/** What every placeholder string begins with (U+0000 and `s`). */
export const SPLIT_PLACEHOLDER_PREFIX = '\u0000s';

/**
 * The placeholder string of staged string `index`.
 * @param {number} index
 */
export const splitPlaceholder = index => `${SPLIT_PLACEHOLDER_PREFIX}${index}`;
harden(splitPlaceholder);

/**
 * How a literal whose value may begin with the prefix begins: NUL is always
 * escaped in JSON, and the `s` may be escaped too, so the literal is decoded.
 */
const PREFIX_LITERAL = '"\\u0000';

/**
 * The largest staged argument text split: a body of `mailBodyUnits` units
 * written entirely as six-byte `\uXXXX` escapes, plus room for the other
 * arguments. A model's arguments past it are refused unread.
 */
export const SPLIT_SOURCE_BYTES =
  6 * mailLimits.mailBodyUnits + 8 * limits.inlineBytes;

/** Page reads one split may make (a page may stop short of `maxBytes`). */
const MAX_PAGES = 2 * Math.ceil(SPLIT_SOURCE_BYTES / limits.blobPageBytes) + 2;

// Harness texts (journaled with this unit).
/** No arguments came with the request. */
export const SPLIT_NO_ARGS_TEXT = 'splitArgs needs the tool arguments';
/** A staged argument text whose pages did not reach its end. */
export const SPLIT_PAGES_TEXT =
  'the tool arguments could not be read: their pages did not reach the end of the text';
/**
 * @param {number} given
 * @param {number} limit
 */
export const splitTooManyText = (given, limit) =>
  `The tool arguments hold ${given} long strings; at most ${limit} can be staged`;
harden(splitTooManyText);
/**
 * @param {number} units
 * @param {number} limit
 */
export const splitStringTooLongText = (units, limit) =>
  `A string argument is ${units} characters; the limit is ${limit}`;
harden(splitStringTooLongText);
/** @param {number} limit */
export const splitResidualText = limit =>
  `The tool arguments do not fit in ${limit} bytes even with ${mailLimits.splitStagedStrings} strings staged`;
harden(splitResidualText);

/**
 * @typedef {{ blob: object, preview: string, bytes: number }} StagedText
 * @typedef {{ start: number, end: number, value?: string }} Literal
 *   a string-value literal's span in the argument text, `end` exclusive
 */

/**
 * The argument text, read in pages when staged. A read that meets an
 * exhausted name table throws (the inspector answers `exhausted`).
 * @param {string | StagedText} args
 * @param {any} content
 * @returns {Promise<{ text: string } | { refusal: string }>}
 */
const sourceOf = async (args, content) => {
  await null;
  if (typeof args === 'string') return { text: args };
  const tooLarge = (/** @type {number} */ bytes) => ({
    refusal: textOf.execSourceTooLarge(bytes, SPLIT_SOURCE_BYTES),
  });
  if (args.bytes > SPLIT_SOURCE_BYTES) return tooLarge(args.bytes);
  if (content === undefined) return { refusal: SPLIT_NO_ARGS_TEXT };
  /** @type {string[]} */
  const pages = [];
  let offset = 0;
  for (let read = 0; read < MAX_PAGES; read += 1) {
    /** @type {{ text: string, next: number, done: boolean }} */
    let page;
    try {
      // eslint-disable-next-line no-await-in-loop -- one answered page per crank
      page = await E(content).read(
        args.blob,
        harden({ offset, maxBytes: limits.blobPageBytes }),
      );
    } catch (error) {
      if (isKeysExhausted(error)) throw error;
      return { refusal: messageOf(error) };
    }
    if (page.next > SPLIT_SOURCE_BYTES) return tooLarge(page.next);
    pages.push(page.text);
    if (page.done) return { text: pages.join('') };
    if (page.next <= offset) break;
    offset = page.next;
  }
  return { refusal: SPLIT_PAGES_TEXT };
};

/**
 * The string-value literals of valid JSON text, in order (keys skipped).
 * @param {string} text already parsed, so every `"` outside a string opens one
 * @returns {Literal[]}
 */
const valueLiterals = text => {
  const special = /["\\]/g;
  const keyAfter = /\s*:/y;
  /** @type {Literal[]} */
  const found = [];
  let start = text.indexOf('"');
  while (start !== -1) {
    special.lastIndex = start + 1;
    let end = 0;
    while (end === 0) {
      const match = /** @type {RegExpExecArray} */ (special.exec(text));
      if (match[0] === '"') end = match.index + 1;
      else special.lastIndex = match.index + 2;
    }
    keyAfter.lastIndex = end;
    if (!keyAfter.test(text)) found.push({ start, end });
    start = text.indexOf('"', end);
  }
  return found;
};

/**
 * Which literals to stage, or the refusal. Decodes only literals that may
 * be long or carry the prefix.
 * @param {string} text
 * @param {Literal[]} literals
 * @returns {{ chosen: Literal[] } | { refusal: string }}
 */
const chooseLiterals = (text, literals) => {
  const decode = (/** @type {Literal} */ literal) => {
    if (literal.value === undefined)
      literal.value = JSON.parse(text.slice(literal.start, literal.end));
    return /** @type {string} */ (literal.value);
  };
  /** @type {Literal[]} */
  const chosen = [];
  /** @type {Literal[]} */
  const optional = [];
  for (const literal of literals) {
    const span = literal.end - literal.start;
    const mayBeLong = span - 2 > mailLimits.splitStringUnits;
    const value =
      mayBeLong || text.startsWith(PREFIX_LITERAL, literal.start)
        ? decode(literal)
        : '';
    if (value.length > mailLimits.mailBodyUnits)
      return {
        refusal: splitStringTooLongText(value.length, mailLimits.mailBodyUnits),
      };
    const must =
      value.length > mailLimits.splitStringUnits ||
      value.startsWith(SPLIT_PLACEHOLDER_PREFIX);
    (must ? chosen : optional).push(literal);
  }
  if (chosen.length > mailLimits.splitStagedStrings)
    return {
      refusal: splitTooManyText(chosen.length, mailLimits.splitStagedStrings),
    };
  // The largest placeholder literal: `"\u0000s15"`.
  const placeholderBytes = JSON.stringify(
    splitPlaceholder(mailLimits.splitStagedStrings - 1),
  ).length;
  const saved = (/** @type {Literal} */ literal) =>
    utf8Bytes(text.slice(literal.start, literal.end)) - placeholderBytes;
  let bytes = utf8Bytes(text);
  for (const literal of chosen) bytes -= saved(literal);
  optional.sort((a, b) => b.end - b.start - (a.end - a.start));
  for (const literal of optional) {
    if (bytes <= limits.inlineBytes) break;
    if (chosen.length === mailLimits.splitStagedStrings) break;
    const less = saved(literal);
    if (less > 0) {
      decode(literal);
      chosen.push(literal);
      bytes -= less;
    }
  }
  if (bytes > limits.inlineBytes)
    return { refusal: splitResidualText(limits.inlineBytes) };
  chosen.sort((a, b) => a.start - b.start);
  return { chosen };
};

/**
 * One string staged through the session's writers.
 * @param {string} value
 * @param {any} writers
 * @returns {Promise<StagedText>}
 */
const stageString = async (value, writers) => {
  const writer = await E(writers).open();
  try {
    for (const piece of chunkText(value, limits.blobPieceBytes)) {
      // eslint-disable-next-line no-await-in-loop -- one answered piece per crank
      await E(writer).append(piece);
    }
    return await E(writer).close();
  } catch (error) {
    E.sendOnly(writer).abort();
    throw error;
  }
};

/**
 * The `splitArgs` operation.
 * @param {{ args?: string | StagedText }} request
 * @param {{ writers: any, content?: any }} call the request's adapter objects
 * @returns {Promise<object>}
 */
export const splitArgs = async ({ args }, { writers, content }) => {
  if (args === undefined) return failed(SPLIT_NO_ARGS_TEXT);
  const source = await sourceOf(args, content);
  if ('refusal' in source) return failed(source.refusal);
  const { text } = source;
  try {
    // Model data, parsed in the exec vat on purpose (rule 12.10): checks the
    // syntax the literal scan relies on; a key flood throws here.
    JSON.parse(text);
  } catch (error) {
    if (isKeysExhausted(error)) throw error;
    return failed(textOf.argumentsNotJson(messageOf(error)));
  }
  const choice = chooseLiterals(text, valueLiterals(text));
  if ('refusal' in choice) return failed(choice.refusal);
  /** @type {string[]} */
  const parts = [];
  /** @type {StagedText[]} */
  const staged = [];
  let at = 0;
  for (const [index, literal] of choice.chosen.entries()) {
    parts.push(text.slice(at, literal.start));
    parts.push(JSON.stringify(splitPlaceholder(index)));
    at = literal.end;
    try {
      const value = /** @type {string} */ (literal.value);
      // eslint-disable-next-line no-await-in-loop -- one staged string at a time
      staged.push(await stageString(value, writers));
    } catch (error) {
      if (isKeysExhausted(error)) throw error;
      return failed(textOf.stagingFailed(messageOf(error)));
    }
  }
  parts.push(text.slice(at));
  return harden({
    status: 'split',
    split: harden({ json: parts.join(''), staged: harden(staged) }),
  });
};
harden(splitArgs);
