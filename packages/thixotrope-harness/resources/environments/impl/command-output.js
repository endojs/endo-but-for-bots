// @ts-check
/**
 * A command's output as the environments adapter answers it
 * (`designs/m6-interfaces.md` D-M6-6 and 5.5): the runtime's `RawResult`
 * (each stream already kept to `streamBytes`) becomes
 *
 * - on the tool path (`ShellPort.runCommand`), the A.3 JSON text
 *   `{ stdout, stderr, exitCode, signal, truncated }`, always valid JSON
 *   and at most `toolOutputUnits` UTF-16 units: each field too long is cut
 *   by its *escaped* length, at a code point boundary, with the R4-46
 *   marker inside the field (G-19: the cut never breaks the JSON);
 * - on the exec path (`Shell.runCommand` through the manager), a
 *   `CommandResult` record whose streams are cut to
 *   `shellAnswerStreamUnits` each, so the record fits `answerBytes`.
 *
 * Decoding is UTF-8 with replacement: an invalid byte becomes U+FFFD; a
 * stream the runtime cut loses the partial character at its end.
 *
 * Node only (adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { environmentLimits } from '../../../guest/lib/guards/environments.js';
import { textOf } from '../../../guest/lib/guards/base.js';
import { boundToolOutput, previewText } from '../../../guest/lib/bounded.js';
import { limits } from '../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/**
 * @typedef {object} RawResult the runtime's answer (contract 5.3)
 * @property {Uint8Array} stdout
 * @property {Uint8Array} stderr
 * @property {boolean} stdoutCut
 * @property {boolean} stderrCut
 * @property {number | null} exitCode
 * @property {string | null} signal
 * @property {boolean} timedOut
 * @property {number} ms
 */

/**
 * Stderr's least share of the room when both streams are cut (5.5 step 3).
 */
export const stderrShareUnits = 2048;

/** Units a signal name may have in a `CommandResult` (its shape). */
const signalUnits = 16;

/**
 * A stream's bytes as text. A stream the runtime cut may end inside a
 * character: a streaming decode holds that partial sequence back, so it is
 * dropped instead of becoming U+FFFD.
 *
 * @param {Uint8Array} bytes
 * @param {boolean} cut
 */
export const decodeStream = (bytes, cut) =>
  new TextDecoder('utf-8', { fatal: false }).decode(bytes, { stream: cut });
harden(decodeStream);

/**
 * The units a string takes inside JSON, without its quotes.
 * @param {string} text
 */
const escapedUnits = text => JSON.stringify(text).length - 2;

/**
 * The longest prefix of `text` whose escaped length is at most `units`,
 * never ending inside a surrogate pair. JSON escapes character by
 * character, so a prefix's escaped length grows with it: binary search.
 *
 * @param {string} text
 * @param {number} units
 */
const prefixByEscaped = (text, units) => {
  if (units <= 0) return '';
  if (escapedUnits(text) <= units) return text;
  // Escaping never shortens a character: the answer is at most `units` long.
  let lo = 0;
  let hi = Math.min(text.length, units) + 1;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (escapedUnits(previewText(text, mid)) <= units) lo = mid;
    else hi = mid;
  }
  return previewText(text, lo);
};

/**
 * @param {string | null} signal
 */
const signalOf = signal =>
  signal === null ? null : previewText(String(signal), signalUnits);

/**
 * The tool-path text of a command's result (5.5 steps 1-3): valid JSON of
 * at most `maxUnits` units.
 *
 * @param {RawResult} raw
 * @param {{ maxUnits?: number }} [options]
 * @returns {string}
 */
export const boundCommandResult = (
  raw,
  { maxUnits = limits.toolOutputUnits } = {},
) => {
  const stdout = decodeStream(raw.stdout, raw.stdoutCut);
  const stderr = decodeStream(raw.stderr, raw.stderrCut);
  const exitCode = raw.exitCode;
  const signal = signalOf(raw.signal);
  const whole = JSON.stringify({
    stdout,
    stderr,
    exitCode,
    signal,
    truncated: raw.stdoutCut || raw.stderrCut,
  });
  if (whole.length <= maxUnits) return whole;

  const base = JSON.stringify({
    stdout: '',
    stderr: '',
    exitCode,
    signal,
    truncated: true,
  }).length;
  const outMarker = textOf.truncationMarker(stdout.length);
  const errMarker = textOf.truncationMarker(stderr.length);
  const outEscaped = escapedUnits(stdout);
  const errEscaped = escapedUnits(stderr);
  // Room for the two fields with both markers reserved.
  const room = Math.max(
    0,
    maxUnits - base - escapedUnits(outMarker) - escapedUnits(errMarker),
  );
  let errShare = Math.min(
    errEscaped,
    Math.max(stderrShareUnits, Math.floor(room / 4)),
  );
  errShare = Math.min(errShare, room);
  const outShare = Math.min(outEscaped, room - errShare);
  errShare = Math.min(errEscaped, room - outShare);

  /**
   * @param {string} field
   * @param {number} escaped
   * @param {number} share
   * @param {string} marker
   */
  const cutField = (field, escaped, share, marker) =>
    escaped <= share
      ? field
      : `${prefixByEscaped(field, share)}${marker}`;
  const text = JSON.stringify({
    stdout: cutField(stdout, outEscaped, outShare, outMarker),
    stderr: cutField(stderr, errEscaped, errShare, errMarker),
    exitCode,
    signal,
    truncated: true,
  });
  if (text.length <= maxUnits) return text;
  // Only a `maxUnits` too small for the markers reaches here: answer the
  // fields empty rather than an invalid or oversized text.
  return JSON.stringify({ stdout: '', stderr: '', exitCode, signal, truncated: true });
};
harden(boundCommandResult);

/**
 * The exec-path answer: a `CommandResult` whose streams are each at most
 * `streamUnits` units (the R4-46 marker inside a cut stream).
 *
 * @param {RawResult} raw
 * @param {{ streamUnits?: number }} [options]
 */
export const boundCommandRecord = (
  raw,
  { streamUnits = environmentLimits.shellAnswerStreamUnits } = {},
) => {
  const stdout = decodeStream(raw.stdout, raw.stdoutCut);
  const stderr = decodeStream(raw.stderr, raw.stderrCut);
  const keptOut = boundToolOutput(stdout, streamUnits);
  const keptErr = boundToolOutput(stderr, streamUnits);
  return harden({
    stdout: keptOut,
    stderr: keptErr,
    exitCode: raw.exitCode,
    signal: signalOf(raw.signal),
    truncated:
      raw.stdoutCut || raw.stderrCut || keptOut !== stdout || keptErr !== stderr,
  });
};
harden(boundCommandRecord);
