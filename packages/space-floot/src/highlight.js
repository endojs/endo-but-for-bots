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

const KEYWORDS = new Set([
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
]);

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN']);

const PUNCTUATION = '{}()[];,.:?=+-*/%<>!&|^~';

const isIdentifierStart = ch => /[A-Za-z_$]/.test(ch);
const isIdentifierPart = ch => /[A-Za-z0-9_$]/.test(ch);
const isDigit = ch => ch >= '0' && ch <= '9';

/**
 * A regex literal is only possible where a value is expected. Tracking the
 * previous significant token is enough to tell `a / b` from `/re/` for the
 * shapes that actually appear in an `exec` body.
 *
 * @param {{ type: string, text: string } | undefined} prev
 * @returns {boolean}
 */
const regexAllowed = prev => {
  if (!prev) return true;
  if (prev.type === 'keyword') return true;
  if (prev.type === 'punctuation') return !')]}'.includes(prev.text);
  return false;
};

/**
 * @typedef {{ type: 'plain' | 'comment' | 'string' | 'template' | 'regexp' |
 *   'number' | 'keyword' | 'literal' | 'punctuation' | 'identifier',
 *   text: string }} JsToken
 */

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
  const push = (type, value) => {
    if (!value) return;
    const token = /** @type {JsToken} */ ({ type, text: value });
    tokens.push(token);
    if (type !== 'plain' && type !== 'comment') significant = token;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // Whitespace runs stay plain so indentation survives untouched.
    if (/\s/.test(ch)) {
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      push('plain', text.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      let j = text.indexOf('\n', i);
      if (j === -1) j = text.length;
      push('comment', text.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const j = end === -1 ? text.length : end + 2;
      push('comment', text.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          j += 1;
          break;
        }
        // An unterminated single-quoted string ends at the newline rather than
        // swallowing the rest of the snippet.
        if (ch !== '`' && text[j] === '\n') break;
        j += 1;
      }
      push(ch === '`' ? 'template' : 'string', text.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '/' && regexAllowed(significant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < text.length) {
        const c = text[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j < text.length && /[a-z]/.test(text[j])) j += 1;
        push('regexp', text.slice(i, j));
        i = j;
        continue;
      }
      // Not a regex after all — fall through and treat `/` as punctuation.
    }

    if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1]))) {
      let j = i;
      while (j < text.length && /[0-9a-fA-FxXoObBnE_.+-]/.test(text[j])) {
        // `+`/`-` only continue a number as an exponent sign.
        if (
          (text[j] === '+' || text[j] === '-') &&
          !/[eE]/.test(text[j - 1] || '')
        ) {
          break;
        }
        j += 1;
      }
      push('number', text.slice(i, j));
      i = j;
      continue;
    }

    if (isIdentifierStart(ch)) {
      let j = i;
      while (j < text.length && isIdentifierPart(text[j])) j += 1;
      const word = text.slice(i, j);
      if (KEYWORDS.has(word)) push('keyword', word);
      else if (LITERALS.has(word)) push('literal', word);
      else push('identifier', word);
      i = j;
      continue;
    }

    if (PUNCTUATION.includes(ch)) {
      push('punctuation', ch);
      i += 1;
      continue;
    }

    push('plain', ch);
    i += 1;
  }

  return tokens;
};
harden(tokenizeJs);
