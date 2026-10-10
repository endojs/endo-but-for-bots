// @ts-check

import harden from '@endo/harden';

// A tiny, dependency-free JavaScript tokenizer for the transcript's action
// entries. The Floot space has no Monaco colorizer wired through it (unlike the
// inbox's code fences, which take a host-supplied `colorize`), and the snippets
// shown here are short `exec` bodies, so a local scanner keeps the view pure and
// self-contained.
//
// This is a *display* tokenizer, not a parser: it never evaluates the source and
// its worst failure mode is a mis-coloured span.

const KEYWORDS = harden(
  new Set([
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'export',
    'extends',
    'finally',
    'for',
    'from',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'let',
    'new',
    'of',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
  ]),
);

const LITERALS = harden(new Set(['true', 'false', 'null', 'undefined', 'NaN']));

const PUNCTUATION = '{}()[];,.:?=+-*/%<>!&|^~';

const WHITESPACE_RE = harden(/\s/);
const IDENTIFIER_START_RE = harden(/[A-Za-z_$]/);
const IDENTIFIER_PART_RE = harden(/[A-Za-z0-9_$]/);
const DIGIT_RE = harden(/[0-9]/);
// Everything a numeric literal can be spelled with: decimal digits, the hex
// digits and radix prefixes, the bigint suffix, separators, and an exponent's
// sign (accepted only after `e`/`E`, see `scanNumber`).
const NUMBER_PART_RE = harden(/[0-9a-fA-FxXoObBnE_.+-]/);
const EXPONENT_RE = harden(/[eE]/);
const REGEXP_FLAG_RE = harden(/[a-z]/);

/**
 * @typedef {'plain' | 'comment' | 'string' | 'template' | 'regexp' | 'number' |
 *   'keyword' | 'literal' | 'punctuation' | 'identifier'} JsTokenType
 */

/**
 * @typedef {{ type: JsTokenType, text: string }} JsToken
 */

/**
 * A regex literal is only possible where a value is expected. Tracking the
 * previous significant token is enough to tell `a / b` from `/re/` for the
 * shapes that actually appear in an `exec` body.
 *
 * @param {JsToken | undefined} prev
 * @returns {boolean}
 */
const regexAllowed = prev => {
  if (!prev) return true;
  if (prev.type === 'keyword') return true;
  if (prev.type === 'punctuation') return !')]}'.includes(prev.text);
  return false;
};

/**
 * The end of a run of whitespace starting at `start`. Whitespace stays plain so
 * indentation survives untouched.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
const scanWhitespace = (text, start) => {
  let j = start;
  while (j < text.length && WHITESPACE_RE.test(text[j])) j += 1;
  return j;
};

/**
 * The end of a quoted string or template starting at `start`. An unterminated
 * quote (other than a backtick) ends at its newline rather than swallowing the
 * rest of the snippet.
 *
 * @param {string} text
 * @param {number} start index of the opening quote
 * @param {string} quote the opening quote character
 * @returns {number}
 */
const scanQuoted = (text, start, quote) => {
  let j = start + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      j += 2;
    } else if (ch === quote) {
      return j + 1;
    } else if (quote !== '`' && ch === '\n') {
      return j;
    } else {
      j += 1;
    }
  }
  return j;
};

/**
 * The end of a regular-expression literal starting at `start`, including its
 * flags, or -1 when it never closes — in which case the `/` was division after
 * all.
 *
 * @param {string} text
 * @param {number} start index of the opening slash
 * @returns {number} the end index, or -1
 */
const scanRegExp = (text, start) => {
  let j = start + 1;
  let inClass = false;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      j += 2;
    } else if (ch === '\n') {
      return -1;
    } else if (ch === '[') {
      inClass = true;
      j += 1;
    } else if (ch === ']') {
      inClass = false;
      j += 1;
    } else if (ch === '/' && !inClass) {
      j += 1;
      while (j < text.length && REGEXP_FLAG_RE.test(text[j])) j += 1;
      return j;
    } else {
      j += 1;
    }
  }
  return -1;
};

/**
 * The end of a numeric literal starting at `start`.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
const scanNumber = (text, start) => {
  let j = start;
  while (j < text.length && NUMBER_PART_RE.test(text[j])) {
    // `+`/`-` only continue a number as an exponent sign; otherwise they are
    // the operator that follows it.
    const signed = text[j] === '+' || text[j] === '-';
    if (signed && !EXPONENT_RE.test(text[j - 1] || '')) break;
    j += 1;
  }
  return j;
};

/**
 * The end of an identifier, keyword or literal starting at `start`.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
const scanWord = (text, start) => {
  let j = start;
  while (j < text.length && IDENTIFIER_PART_RE.test(text[j])) j += 1;
  return j;
};

/**
 * The end of the line `start` sits on.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
const endOfLine = (text, start) => {
  const nl = text.indexOf('\n', start);
  return nl === -1 ? text.length : nl;
};

/**
 * Scan exactly one token starting at `start`, classifying it.
 *
 * @param {string} text
 * @param {number} start
 * @param {JsToken | undefined} significant the previous non-plain, non-comment
 *   token, which is what distinguishes a regex literal from division.
 * @param {boolean} tryRegex whether a `/` here may still open a regex literal.
 *   False while the caller knows the rest of the line cannot close one.
 * @returns {{ type: JsTokenType, end: number, noRegexBefore?: number }}
 *   `noRegexBefore` reports the offset up to which a regex scan is hopeless.
 */
const scanToken = (text, start, significant, tryRegex) => {
  const ch = text[start];

  if (WHITESPACE_RE.test(ch)) {
    return { type: 'plain', end: scanWhitespace(text, start) };
  }

  if (ch === '/' && text[start + 1] === '/') {
    const nl = text.indexOf('\n', start);
    return { type: 'comment', end: nl === -1 ? text.length : nl };
  }

  if (ch === '/' && text[start + 1] === '*') {
    const close = text.indexOf('*/', start + 2);
    return { type: 'comment', end: close === -1 ? text.length : close + 2 };
  }

  if (ch === '"' || ch === "'" || ch === '`') {
    return {
      type: ch === '`' ? 'template' : 'string',
      end: scanQuoted(text, start, ch),
    };
  }

  if (ch === '/' && tryRegex && regexAllowed(significant)) {
    const end = scanRegExp(text, start);
    // A slash that never closes was division; fall through to punctuation.
    if (end !== -1) return { type: 'regexp', end };
    // A scan that ran to the end of the line without closing tells us more than
    // "not here": no later slash on this line can close one either. Say so, or
    // every subsequent slash rescans the same tail and a line of unclosed
    // literals — `=/[` repeated, say — costs quadratic time in a view that has
    // no way to yield. Mis-colouring a slash is within this scanner's contract;
    // freezing on model output is not.
    return {
      type: 'punctuation',
      end: start + 1,
      noRegexBefore: endOfLine(text, start),
    };
  }

  if (
    DIGIT_RE.test(ch) ||
    (ch === '.' && DIGIT_RE.test(text[start + 1] || ''))
  ) {
    return { type: 'number', end: scanNumber(text, start) };
  }

  if (IDENTIFIER_START_RE.test(ch)) {
    const end = scanWord(text, start);
    const word = text.slice(start, end);
    if (KEYWORDS.has(word)) return { type: 'keyword', end };
    if (LITERALS.has(word)) return { type: 'literal', end };
    return { type: 'identifier', end };
  }

  if (PUNCTUATION.includes(ch)) return { type: 'punctuation', end: start + 1 };

  return { type: 'plain', end: start + 1 };
};

/**
 * Split JavaScript source into display tokens. Concatenating every token's
 * `text` reproduces the input exactly, so nothing is ever dropped from view.
 *
 * @param {string} source
 * @returns {JsToken[]}
 */
export const tokenizeJs = source => {
  const text = `${source || ''}`;
  /** @type {JsToken[]} */
  const tokens = [];
  /** @type {JsToken | undefined} */
  let significant;

  // Offset below which a `/` cannot open a regex literal, because a scan from
  // earlier on this line already ran past it without closing one.
  let noRegexBefore = 0;
  let i = 0;
  while (i < text.length) {
    const {
      type,
      end,
      noRegexBefore: hopeless,
    } = scanToken(text, i, significant, i >= noRegexBefore);
    if (hopeless !== undefined) noRegexBefore = hopeless;
    // `scanToken` never returns an end at or before its start, so the loop
    // always advances.
    const token = { type, text: text.slice(i, end) };
    tokens.push(token);
    if (type !== 'plain' && type !== 'comment') significant = token;
    i = end;
  }

  return tokens;
};
harden(tokenizeJs);
