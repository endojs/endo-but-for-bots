// @ts-check
/**
 * The `echo` adapter tool (M1a W1a.2; `designs/m1a-interfaces.md` section
 * 10): the test tool scripted backends offer in `TurnPorts.tools`.
 *
 * Its arguments arrive as the model's JSON text and are parsed here, in
 * the callee, never in a vat (rule 12.10): a 2,000-key object reaches it
 * intact and is logged as received. Argument errors are answered as a
 * `failed` outcome carrying the R4-43 / R4-45 text, never as a rejection:
 * those texts quote words the model chose, and a rejection from an adapter
 * tool is how the session sees a hub break (M1a QC finding 1, J-0290). Only
 * a real CapTP break (or a defect in this file) rejects. The output is cut in the callee to `toolOutputUnits` with
 * the R4-46 marker; an answer still over `frameBytes` (exact UTF-8) is not
 * sent: the outcome is `frame-limit` and the session fails the turn.
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  echoArgumentNames,
  interfaces,
  texts,
  textOf,
} from '../../../../guest/lib/interfaces.js';
import {
  boundToolOutput,
  cutText,
  fitsFrame,
  previewText,
} from '../../../../guest/lib/bounded.js';
import { limits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

const { makeExo } = /** @type {any} */ (globalThis);

/**
 * @param {unknown} value
 * @param {number} max
 */
const inRange = (value, max) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max;

/**
 * Check echo's arguments. Returns the parsed record, or the R4-43 / R4-45
 * error text (which may quote text the model chose).
 *
 * @param {string} args
 * @returns {string | Record<string, unknown>}
 */
const checkArgs = args => {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(args);
  } catch (error) {
    return textOf.argumentsNotJson(
      /** @type {Error} */ (error)?.message ?? String(error),
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return textOf.invalidArgument('args', 'echo', 'a JSON object');
  const record = /** @type {Record<string, unknown>} */ (parsed);
  const unexpected = Object.keys(record).find(
    key => !echoArgumentNames.includes(key),
  );
  if (unexpected !== undefined)
    return textOf.unexpectedArgument(unexpected, 'echo', echoArgumentNames);
  const { text, delayMs = 0, bytes } = record;
  if (text !== undefined && typeof text !== 'string')
    return textOf.invalidArgument('text', 'echo', 'a string');
  if (!inRange(delayMs, limits.maxDelayMs))
    return textOf.invalidArgument(
      'delayMs',
      'echo',
      `a number from 0 to ${limits.maxDelayMs}`,
    );
  if (bytes !== undefined && !inRange(bytes, limits.echoMaxUnits))
    return textOf.invalidArgument(
      'bytes',
      'echo',
      `a number from 0 to ${limits.echoMaxUnits}`,
    );
  return record;
};

/**
 * A `failed` outcome whose text fits `toolOutputUnits` and the frame. The
 * session writes it as `Error: <text>` (R4-45).
 *
 * @param {string} message
 */
const failedOutcome = message => {
  let text = boundToolOutput(message);
  if (!fitsFrame(harden({ status: 'failed', text })))
    text = cutText(text, limits.frameBytes - 1024);
  return harden({ status: 'failed', text });
};

/**
 * @param {object} options
 * @param {import('../timers.js').Timers} options.timers
 * @param {import('../providers/scripted.js').EventLog} [options.log] the
 *   backend's event log (`echo-start`, `echo-end`, `echo-frame-limit`)
 */
export const makeEchoTool = ({ timers, log = () => {} }) =>
  makeExo('AdapterTool', interfaces.AdapterTool, {
    /** @param {{ opId: string, args: string }} request */
    execute: async ({ opId, args }) => {
      log('echo-start', { opId, args });
      const checked = checkArgs(args);
      if (typeof checked === 'string') {
        log('echo-failed', { opId, units: checked.length });
        return failedOutcome(checked);
      }
      const { text, delayMs = 0, bytes } = checked;
      // R4-49: a cancel does not interrupt a running tool.
      if (/** @type {number} */ (delayMs) > 0)
        await timers.delay(/** @type {number} */ (delayMs));
      let output = /** @type {string} */ (text ?? '');
      if (bytes !== undefined) {
        const units = Math.floor(/** @type {number} */ (bytes));
        const unit = output || 'x';
        output = previewText(
          unit.repeat(Math.ceil(units / unit.length)),
          units,
        );
      }
      output = boundToolOutput(output);
      const outcome = harden({ status: 'ok', text: output });
      if (!fitsFrame(outcome)) {
        log('echo-frame-limit', { opId, units: output.length });
        return harden({ status: 'frame-limit', text: texts.frameLimit });
      }
      log('echo-end', { opId, units: output.length });
      return outcome;
    },
  });
harden(makeEchoTool);
