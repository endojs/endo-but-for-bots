// @ts-check
/**
 * Texts the exec vat makes from model code and its results (M1b W1b.3;
 * `designs/m1b-interfaces.md` 8.1), ported from Fae `src/tool-makers.js` at
 * `1315bef86` (`stripCodeFence` :1484, `describeParseFailure` :1499,
 * `renderToolResult` :96, `bigintsAsDecimalStrings` :81).
 *
 * Two changes from Fae, both forced by the vat: the hint texts that name the
 * sequences SES refuses to evaluate (a dynamic import and the HTML comment
 * markers) are assembled from pieces, because SES refuses a source that
 * contains them anywhere, including inside a string, and this module is part
 * of a bundle a vat evaluates; and the result of a remote capability's
 * method-name query is bounded before it is rendered.
 *
 * M5 W5.4 adds what `run` and `inspect` share (the failed and exhausted
 * outcomes, `argumentText`, `finish`). The M5 `ExecScope` guard, its shapes
 * and the exec program's texts are in `../lib/guards/base.js` since the
 * fold (F2, HR-SYN-1), which replaced this module's copy of them.
 */

import { textOf } from '../lib/guards/base.js';
import { limits } from '../lib/limits.js';
import { boundToolOutput, chunkText, utf8Bytes } from '../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

// SES refuses these sequences anywhere in an evaluated source (Fae writes
// them literally; a vat bundle cannot).
const IMPORT_CALL = ['imp', 'ort('].join('');
const HTML_OPEN = ['<!', '--'].join('');
const HTML_CLOSE = ['--', '>'].join('');

/**
 * The code inside one wrapping markdown fence (```js ... ```), or the code
 * unchanged. A common model output; multiline code is not refused for its
 * wrapping backticks.
 *
 * @param {string} code
 * @returns {string}
 */
export const stripCodeFence = code => {
  const trimmed = code.trim();
  const fenced = /^```[^\n`]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1] : code;
};
harden(stripCodeFence);

/**
 * What to tell a model whose code did not parse. The advice has to fit the
 * cause: told "no markdown fences" about code that had none, a model resends
 * the same thing with something else changed.
 *
 * @param {string} code
 * @param {string} message the engine's message; it carries no position
 * @returns {string}
 */
export const describeParseFailure = (code, message) => {
  /** @type {string[]} */
  const hints = [];
  if (
    /SES_IMPORT_REJECTED|import expression|import statement|import\.meta/i.test(
      message,
    )
  ) {
    hints.push(
      [
        'exec has no import, ',
        IMPORT_CALL,
        ') or require: there is no module loader and no Node built-ins. Reach files and everything else outside through capabilities: E(powers).lookup(...). This evaluator refuses the characters "',
        IMPORT_CALL,
        '" anywhere in the source, even inside a string or a comment - so if you are writing a file that contains a dynamic import, build that text as "imp" + "ort(".',
      ].join(''),
    );
  } else if (/SES_HTML_COMMENT_REJECTED|html comment/i.test(message)) {
    hints.push(
      [
        'The source contains an HTML comment marker (',
        HTML_OPEN,
        ' or ',
        HTML_CLOSE,
        '), which this evaluator refuses even inside a string. Write it as "<!" + "--" and "--" + ">".',
      ].join(''),
    );
  } else {
    // A fence that was stripped before evaluating is not the problem; one
    // that is still there (prose around it, or only half of it) is.
    if (stripCodeFence(code) === code && code.includes('```')) {
      hints.push(
        'Send raw JavaScript in the "code" argument, without markdown fences or any prose around the code.',
      );
    }
    // The fences' own backticks are not template literals.
    if (code.replace(/```/g, '').includes('`')) {
      hints.push(
        'The code uses template literals. If one of them holds text that itself contains a backtick or ${ (a shader, a template, markdown), that inner backtick ends the literal and the rest is parsed as code - a common cause of "Unexpected identifier". Build such text from single-quoted strings joined together, or escape each inner backtick and ${.',
      );
    }
    if (/await is only valid|Unexpected reserved word/.test(message)) {
      hints.push(
        'await works at the top level of the code, but not inside a nested function unless that function is async.',
      );
    }
  }
  if (hints.length === 0) {
    hints.push('Check the code for syntax errors and send it again.');
  }
  return `Could not parse the code (${message}). ${hints.join(' ')}`;
};
harden(describeParseFailure);

/**
 * `JSON.stringify` replacer: a BigInt as its decimal digits (a tool result is
 * text a model reads).
 * @param {string} _key
 * @param {unknown} value
 */
export const bigintsAsDecimalStrings = (_key, value) =>
  typeof value === 'bigint' ? value.toString() : value;

/** Method names rendered for a remote capability, at most. */
const MAX_METHOD_NAMES = 256;

/**
 * Host file paths in text that leaves the exec vat (M1b follow-ups, J-9367):
 * stack strings and engine messages may name the files the vat's boot code
 * came from on the daemon's machine. An absolute path under a host root, or
 * a `file://` URL, keeps only its last segment (the file name, line and
 * column), behind `<host>/`. Paths under other roots (an API path the model
 * built, `/a/b`) are left alone.
 */
const HOST_PATH =
  /(?:file:\/\/)?\/(?:Users|home|private|tmp|var|opt|nix|root|usr|Volumes|run|srv|mnt|etc)\/(?:[^\s'"`()<>:/\\]+\/)*([^\s'"`()<>:/\\]+)/g;
const WINDOWS_PATH =
  /(?:file:\/\/\/)?[A-Za-z]:\\(?:[^\s'"`()<>:\\]+\\)*([^\s'"`()<>:\\]+)/g;

/**
 * `text` with host file paths cut to their file names (J-9367).
 * @param {string} text
 * @returns {string}
 */
export const redactHostPaths = text => {
  if (!text.includes('/') && !text.includes('\\')) return text;
  return text
    .replace(HOST_PATH, (_whole, last) => `<host>/${last}`)
    .replace(WINDOWS_PATH, (_whole, last) => `<host>/${last}`);
};
harden(redactHostPaths);

/**
 * A thrown value's message, never throwing itself.
 * @param {unknown} error
 * @returns {string}
 */
export const messageOf = error => {
  try {
    if (typeof error === 'object' && error !== null) {
      const { message } = /** @type {{ message?: unknown }} */ (error);
      if (typeof message === 'string') return message;
    }
    return String(error);
  } catch {
    return 'unprintable error';
  }
};
harden(messageOf);

/**
 * A result value as text for the model. JSON-serialisable values are
 * stringified (two-space indent, BigInts as decimal strings). A remote
 * capability has no enumerable own properties, so `JSON.stringify` makes it
 * `"{}"`; when it answers the method-name query it is described by its
 * method names instead, so the model knows what it can call.
 *
 * @param {unknown} result
 * @returns {Promise<string>}
 */
export const renderToolResult = async result => {
  await null;
  /** @type {string | undefined} */
  let json;
  try {
    json = JSON.stringify(result, bigintsAsDecimalStrings, 2);
  } catch {
    json = undefined;
  }
  if (json !== undefined && json !== '{}') {
    return json;
  }
  try {
    // `__getMethodNames__` is the introspection method every exo answers;
    // it is not on the typed `E` surface.
    // eslint-disable-next-line no-underscore-dangle
    const methods = await E(/** @type {any} */ (result)).__getMethodNames__();
    if (Array.isArray(methods)) {
      const names = methods
        .slice(0, MAX_METHOD_NAMES)
        .map(name => (typeof name === 'string' ? name : String(name)));
      return `[remote capability] callable methods: ${JSON.stringify(names)}`;
    }
  } catch {
    // Not an introspectable presence; fall through to the best-effort string.
  }
  if (json !== undefined) return json;
  try {
    return String(result);
  } catch {
    return 'unprintable result';
  }
};
harden(renderToolResult);

// ---------------------------------------------------------------- outcomes (run and inspect)

/**
 * @typedef {{ status: 'ok' | 'failed', text: string | object }} Outcome
 * @typedef {{ blob: object, preview: string, bytes: number }} StagedText
 */

/** A staged source whose pages do not reach its end within this many reads. */
export const MAX_SOURCE_PAGES =
  4 * Math.ceil(limits.execSourceBytes / limits.blobPageBytes);

/** `ExecRequest.args` is staged but no `Content` came with it. */
export const NO_CONTENT_TEXT =
  'exec arguments were staged but no content reader was passed';
/** A staged source's pages did not reach its end. */
export const SOURCE_PAGES_TEXT =
  'exec source could not be read: its pages did not reach the end of the text';

/**
 * @param {string} text
 * @returns {Outcome}
 */
export const failed = text => harden({ status: 'failed', text });
harden(failed);

/** The engine's text when a vat's name table is full (J-0333). */
const KEYS_EXHAUSTED = 'property key space exhausted';

/**
 * Whether `error` (or a message) says this vat's name table is full.
 * @param {unknown} error
 */
export const isKeysExhausted = error =>
  messageOf(error).includes(KEYS_EXHAUSTED);
harden(isKeysExhausted);

export const EXHAUSTED = harden({ status: 'exhausted' });

/**
 * The model's argument text: inline, or read from its blob in pages.
 * @param {{ args: string | StagedText, content?: any }} request
 * @returns {Promise<{ text: string } | { outcome: Outcome }>}
 */
export const argumentText = async ({ args, content }) => {
  await null;
  if (typeof args === 'string') return { text: args };
  if (args.bytes > limits.execSourceBytes)
    return {
      outcome: failed(
        textOf.execSourceTooLarge(args.bytes, limits.execSourceBytes),
      ),
    };
  if (content === undefined) return { outcome: failed(NO_CONTENT_TEXT) };
  /** @type {string[]} */
  const pages = [];
  let offset = 0;
  for (let read = 0; read < MAX_SOURCE_PAGES; read += 1) {
    /** @type {{ text: string, next: number, done: boolean }} */
    let page;
    try {
      // eslint-disable-next-line no-await-in-loop -- one answered page per crank
      page = await E(content).read(
        args.blob,
        harden({ offset, maxBytes: limits.blobPageBytes }),
      );
    } catch (error) {
      // The adapter restarted (its Content is gone) or the blob is unknown.
      return { outcome: failed(messageOf(error)) };
    }
    if (page.next > limits.execSourceBytes)
      return {
        outcome: failed(
          textOf.execSourceTooLarge(
            Math.max(page.next, args.bytes),
            limits.execSourceBytes,
          ),
        ),
      };
    pages.push(page.text);
    if (page.done) return { text: pages.join('') };
    if (page.next <= offset) break;
    offset = page.next;
  }
  return { outcome: failed(SOURCE_PAGES_TEXT) };
};
harden(argumentText);

/**
 * The outcome for a model-facing text: inline when it is at most
 * `inlineBytes`, else staged through `writers` in pieces of at most
 * `blobPieceBytes` (one answered piece per crank).
 *
 * `ok`: `text` is the rendered result. `failed`: `text` is the error
 * message; inline it stays the message (the session writes `Error: ...`),
 * staged it is the complete model-facing result (`m1b-interfaces.md` 5.3).
 *
 * @param {'ok' | 'failed'} status
 * @param {string} text
 * @param {any} writers
 * @returns {Promise<Outcome>}
 */
export const finish = async (status, text, writers) => {
  await null;
  const bounded = boundToolOutput(text);
  if (bounded === text && utf8Bytes(text) <= limits.inlineBytes)
    return harden({ status, text });
  const modelText =
    status === 'ok' ? bounded : boundToolOutput(textOf.errorResult(text));
  /** @type {any} */
  let writer;
  try {
    writer = await E(writers).open();
    for (const piece of chunkText(modelText, limits.blobPieceBytes)) {
      // eslint-disable-next-line no-await-in-loop -- one answered piece per crank
      await E(writer).append(piece);
    }
    const staged = await E(writer).close();
    return harden({ status, text: staged });
  } catch (error) {
    if (writer !== undefined) E.sendOnly(writer).abort();
    return failed(textOf.stagingFailed(messageOf(error)));
  }
};
harden(finish);
