// @ts-check
/**
 * The code filter of spoken text (`designs/m11-interfaces.md` section 7,
 * R5-35): fenced code is removed before the sentence split, also when a
 * fence is split across text deltas. Plain prose passes through at once;
 * only a possible fence at the start of a line is held back. Code is
 * discarded as it arrives, so a long code block costs no retained text.
 *
 * Ported from Endo `packages/floot/src/speech-code-filter.js` at
 * `1315bef86`. Changes: `harden` is the prelude global; the inspected
 * prefix bound is `INSPECTED_LINE_UNITS`; `held()` answers the units held
 * back (the `SpeechText` backlog counts them). The rules, as the source
 * states them:
 *
 * - an opening fence is 3 or more backticks or tildes at a line start; the
 *   rest of its line (the info string) is never speech;
 * - a closing fence is a line of at least as many of the same marker
 *   (surrounding blanks allowed), so a shorter inner fence does not end an
 *   outer example;
 * - only a line's first `INSPECTED_LINE_UNITS` units are inspected for a
 *   closing fence (a longer line is code, never a close);
 * - `finish()` answers the held prefix outside a fence and nothing inside
 *   one (an unclosed block stays silent).
 *
 * Node module of the agent-host adapter (no vat runs it: D-M11-6).
 */

/** Units of one line inspected for a closing fence (contract section 7). */
export const INSPECTED_LINE_UNITS = 128;

const OPENING_FENCE = /^(`{3,}|~{3,})/;
const POSSIBLE_FENCE = /^`{1,2}$|^~{1,2}$/;

/**
 * @typedef {object} CodeFilter
 * @property {(text: string) => string} push the prose of `text` now known
 *   not to be code
 * @property {() => string} finish the held prefix outside a fence
 * @property {() => number} held units held back (at most
 *   `INSPECTED_LINE_UNITS`)
 */

/** @returns {CodeFilter} */
export const makeCodeFilter = () => {
  let start = true;
  let prefix = '';
  let fence = '';
  let lineTooLong = false;
  let openingRun = false;
  /** @param {string} text */
  const push = text => {
    let out = '';
    for (const char of text) {
      if (fence) {
        if (openingRun && char === fence[0]) {
          fence += char;
          // eslint-disable-next-line no-continue
          continue;
        }
        openingRun = false;
        if (char === '\n') {
          const line = prefix.trim();
          if (
            !lineTooLong &&
            line.length >= fence.length &&
            [...line].every(c => c === fence[0])
          ) {
            fence = '';
            out += '\n';
          }
          prefix = '';
          lineTooLong = false;
        } else if (prefix.length < INSPECTED_LINE_UNITS) {
          prefix += char;
        } else {
          lineTooLong = true;
        }
      } else if (start) {
        prefix += char;
        const run = OPENING_FENCE.exec(prefix);
        if (run) {
          // The info string after an opening fence is never speech; starting
          // suppression at the third marker keeps long code cheap.
          fence = run[1];
          openingRun = true;
          prefix = '';
          lineTooLong = true; // the rest of the opening line is not a close
        } else if (!POSSIBLE_FENCE.test(prefix)) {
          out += prefix;
          start = char === '\n';
          prefix = '';
        }
      } else {
        out += char;
        if (char === '\n') start = true;
      }
    }
    return out;
  };
  return harden({
    push,
    finish() {
      const tail = fence ? '' : prefix;
      prefix = '';
      return tail;
    },
    held: () => (fence ? 0 : prefix.length),
  });
};
harden(makeCodeFilter);
