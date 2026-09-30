// @ts-check
/** @import { Logger } from '../platform/logging.js' */
import harden from '@endo/harden';

/**
 * Whether a code unit can steer a terminal rather than merely appear on it:
 * the C0 controls (including ESC), DEL, the C1 controls (including CSI,
 * U+009B), and the Unicode line and paragraph separators, which some
 * terminals honour as line breaks. JSON quoting escapes only the C0 range,
 * so JSON text is not safe to print without this.
 * @param {number} code
 */
const isTerminalControl = code =>
  code < 32 ||
  (code >= 127 && code <= 159) ||
  code === 0x2028 ||
  code === 0x2029;

/**
 * Render untrusted text for a terminal by rewriting every control character
 * as its `\uXXXX` escape. The rewrite is also the JSON escape for the same
 * character, so JSON text stays valid JSON that parses back to the same value.
 * @param {string} text
 */
export const terminalText = text =>
  [...text]
    .map(character => {
      const code = character.charCodeAt(0);
      return isTerminalControl(code)
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : character;
    })
    .join('');
harden(terminalText);

/**
 * Print a value as indented JSON with every control character escaped, for
 * results that carry remote-controlled text such as messages and labels.
 * JSON quoting already escapes C0 controls inside strings, so the only raw
 * newlines in the text are the indentation's own; those are kept.
 * @param {Logger} logger
 * @param {unknown} value
 */
export const printJson = (logger, value) => {
  const json = JSON.stringify(value, null, 2) ?? 'undefined';
  logger.log(json.split('\n').map(terminalText).join('\n'));
};
harden(printJson);
