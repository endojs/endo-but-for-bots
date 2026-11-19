// @ts-check
/**
 * The text pipeline of one playback (`designs/m11-interfaces.md` section 7,
 * R5-35..R5-37; the `SpeechText` of `engine-types.js`): reply text in,
 * spoken sentences out.
 *
 * 1. Fenced code is removed incrementally (`code-filter.js`).
 * 2. The filtered text is split at boundaries: a newline, or `.`, `!`, `?`
 *    followed by whitespace, except a `.` after one of `ABBREVIATIONS` or
 *    after a numbered-list marker (a line that is only digits so far). A
 *    sentence is released only when the whitespace after its mark arrives.
 * 3. Each sentence loses its markdown (`stripMarkdown`: remaining fences
 *    become a space, inline code its content, images go, links become their
 *    text, bold, italic, heading, blockquote and bullet markers go) and is
 *    trimmed; an empty one is dropped; one under `MIN_SENTENCE_UNITS` units
 *    merges with the next.
 * 4. A run of `sentenceUnits` units with no boundary is cut at its last
 *    whitespace (or at `sentenceUnits` when it has none), so the text held
 *    back stays bounded whatever the reply (D-M11-11).
 * 5. `finish()` releases the rest.
 *
 * Ported from the chunker of Endo `packages/floot/voice/tts-server-caplet.js`
 * at `1315bef86` (`makeChunker`, `stripMarkdown`, `isBoundary`). Changes:
 * - the split is incremental: each push scans only the units it added (the
 *   source rescanned its whole buffer per push and looked back with a regex
 *   over everything before a period: quadratic for a long reply with few
 *   boundaries); the abbreviation and list-marker checks look back a
 *   bounded number of units;
 * - the forced cut of step 4 (the source had none);
 * - `lineBreak()`: a tool call between rounds ends the current message, so
 *   no sentence spans it (a chunk under `MIN_SENTENCE_UNITS` is released
 *   alone rather than merged across it), and starts a fresh code filter (a
 *   fence left open by one message does not silence the next);
 * - `pendingUnits()` for the caller's backlog bound.
 *
 * Node module of the agent-host adapter (no vat runs it: D-M11-6).
 */
import { audioLimits } from './audio-protocol.js';
import { makeCodeFilter } from './code-filter.js';

/** @import { SpeechText } from './engine-types.js' */

/** A sentence shorter than this merges with the next (R5-37). */
export const MIN_SENTENCE_UNITS = 10;

/** A `.` after one of these words is not a boundary (R5-36). */
export const ABBREVIATIONS = harden(
  new Set(['St', 'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'vs', 'etc', 'Jr', 'Sr']),
);

/** The longest word of `ABBREVIATIONS`: a longer run of letters is no abbreviation. */
const ABBREVIATION_UNITS = Math.max(
  ...[...ABBREVIATIONS].map(word => word.length),
);

/**
 * Remove the markdown that would otherwise be read aloud as punctuation
 * (the source's `stripMarkdown`, unchanged).
 * @param {string} text
 */
export const stripMarkdown = text =>
  `${text}`
    .replace(/```[\s\S]*?```/g, ' ') // fenced code left over
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, ''); // bullet markers
harden(stripMarkdown);

/** @param {string | undefined} char */
const isSpace = char => char !== undefined && /\s/.test(char);

/** @param {number} code */
const isLetter = code =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

/** @param {number} code */
const isDigit = code => code >= 0x30 && code <= 0x39;

/**
 * Whether the `.` at `i` follows an abbreviation (the whole run of letters
 * before it is one of `ABBREVIATIONS`), looking back at most one unit more
 * than the longest abbreviation, and never before `from`.
 * @param {string} text
 * @param {number} i
 * @param {number} from
 */
const afterAbbreviation = (text, i, from) => {
  let j = i;
  while (
    j > from &&
    i - j <= ABBREVIATION_UNITS &&
    isLetter(text.charCodeAt(j - 1))
  ) {
    j -= 1;
  }
  if (j === i || i - j > ABBREVIATION_UNITS) return false;
  if (j > from && isLetter(text.charCodeAt(j - 1))) return false;
  return ABBREVIATIONS.has(text.slice(j, i));
};

/**
 * Whether the `.` at `i` ends a numbered-list marker: everything on its line
 * before it is digits (at least one). `lineStart` is where the line begins
 * (tracked by the scan; -1: the line holds earlier text), and the check
 * stops at the first unit that is not a digit.
 * @param {string} text
 * @param {number} i
 * @param {number} lineStart
 */
const afterListMarker = (text, i, lineStart) => {
  if (lineStart < 0 || i === lineStart) return false;
  for (let j = lineStart; j < i; j += 1) {
    if (!isDigit(text.charCodeAt(j))) return false;
  }
  return true;
};

/**
 * Where to cut a run with no boundary: after its last whitespace within
 * `units` of `start`, or at `start + units` (never between the halves of a
 * surrogate pair).
 * @param {string} text
 * @param {number} start
 * @param {number} units
 * @returns {{ cut: number, next: number }} `cut` ends the sentence, `next`
 *   starts the following text (later whitespace is trimmed with it)
 */
const forcedCut = (text, start, units) => {
  for (let j = start + units - 1; j > start; j -= 1) {
    if (isSpace(text[j])) return { cut: j, next: j + 1 };
  }
  let cut = start + units;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { cut, next: cut };
};

/**
 * One playback's text pipeline.
 * @param {object} [options]
 * @param {number} [options.sentenceUnits] the forced cut (default
 *   `audioLimits.sentenceUnits`)
 * @returns {SpeechText}
 */
export const makeSpeechText = ({
  sentenceUnits = audioLimits.sentenceUnits,
} = {}) => {
  let filter = makeCodeFilter();
  /** Filtered text not yet released; a sentence in progress starts at 0. */
  let buffer = '';
  /** Where the next push resumes the scan within `buffer`. */
  let scanFrom = 0;
  /**
   * Where the line holding `scanFrom` begins (list markers); -1 when it
   * began before `buffer` (text of a released sentence precedes the mark on
   * its line, so no list marker can end there).
   */
  let lineStart = 0;
  /** A released sentence under `MIN_SENTENCE_UNITS`, waiting for the next. */
  let pending = '';

  /**
   * Strip, trim and merge one raw part into `out`.
   * @param {string} part
   * @param {string[]} out
   */
  const release = (part, out) => {
    const trimmed = stripMarkdown(part).trim();
    if (!trimmed) return;
    const combined = pending ? `${pending} ${trimmed}` : trimmed;
    if (combined.length >= MIN_SENTENCE_UNITS) {
      out.push(combined);
      pending = '';
    } else {
      pending = combined;
    }
  };

  /** @returns {string[]} the sentences the scan completes */
  const scan = () => {
    /** @type {string[]} */
    const out = [];
    let start = 0;
    let i = scanFrom;
    while (i < buffer.length) {
      if (i - start >= sentenceUnits) {
        const { cut, next } = forcedCut(buffer, start, sentenceUnits);
        release(buffer.slice(start, cut), out);
        start = next;
        i = Math.max(i, start);
        // eslint-disable-next-line no-continue
        continue;
      }
      const char = buffer[i];
      let boundary = false;
      if (char === '\n') {
        boundary = true;
      } else if (char === '.' || char === '!' || char === '?') {
        const next = buffer[i + 1];
        const exempt =
          char === '.' &&
          (afterListMarker(buffer, i, lineStart) ||
            afterAbbreviation(buffer, i, start));
        if (!exempt && next === undefined) break; // wait for what follows
        boundary = !exempt && isSpace(next);
      }
      if (boundary) {
        let end = i + 1;
        while (end < buffer.length && isSpace(buffer[end])) end += 1;
        for (let j = i; j < end; j += 1) {
          if (buffer[j] === '\n') lineStart = j + 1;
        }
        release(buffer.slice(start, end), out);
        start = end;
        i = end;
      } else {
        i += 1;
      }
    }
    buffer = buffer.slice(start);
    scanFrom = i - start;
    lineStart = lineStart >= start ? lineStart - start : -1;
    return out;
  };

  return harden({
    /** @param {string} text */
    push: text => {
      buffer += filter.push(text);
      return scan();
    },
    lineBreak: () => {
      buffer += `${filter.finish()}\n`;
      filter = makeCodeFilter();
      const out = scan();
      // No sentence spans a tool call: a short chunk is released alone.
      if (pending) out.push(pending);
      pending = '';
      return out;
    },
    finish: () => {
      /** @type {string[]} */
      const out = [];
      const tail = `${buffer}${filter.finish()}`;
      buffer = '';
      scanFrom = 0;
      lineStart = 0;
      const trimmed = stripMarkdown(tail).trim();
      const last = [pending, trimmed].filter(Boolean).join(' ');
      pending = '';
      if (last) out.push(last);
      return out;
    },
    pendingUnits: () => buffer.length + pending.length + filter.held(),
  });
};
harden(makeSpeechText);
