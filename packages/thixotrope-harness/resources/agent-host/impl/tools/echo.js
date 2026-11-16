// @ts-check
/**
 * The `echo` adapter tool (M1a W1a.2; `designs/m1a-interfaces.md` section
 * 10): the test tool scripted backends offer in `TurnPorts.tools`.
 *
 * Its arguments arrive as the model's JSON text and are parsed here, in
 * the callee, never in a vat (rule 12.10): a 2,000-key object reaches it
 * intact and is logged as received. Argument errors reject with the R4-43 /
 * R4-45 texts. The output is cut in the callee to `toolOutputUnits` with
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
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(args);
      } catch (error) {
        throw Error(
          textOf.argumentsNotJson(
            /** @type {Error} */ (error)?.message ?? String(error),
          ),
          { cause: error },
        );
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw Error(textOf.invalidArgument('args', 'echo', 'a JSON object'));
      const record = /** @type {Record<string, unknown>} */ (parsed);
      const unexpected = Object.keys(record).find(
        key => !echoArgumentNames.includes(key),
      );
      if (unexpected !== undefined)
        throw Error(
          textOf.unexpectedArgument(unexpected, 'echo', echoArgumentNames),
        );
      const { text, delayMs = 0, bytes } = record;
      if (text !== undefined && typeof text !== 'string')
        throw Error(textOf.invalidArgument('text', 'echo', 'a string'));
      if (!inRange(delayMs, limits.maxDelayMs))
        throw Error(
          textOf.invalidArgument(
            'delayMs',
            'echo',
            `a number from 0 to ${limits.maxDelayMs}`,
          ),
        );
      if (bytes !== undefined && !inRange(bytes, limits.echoMaxUnits))
        throw Error(
          textOf.invalidArgument(
            'bytes',
            'echo',
            `a number from 0 to ${limits.echoMaxUnits}`,
          ),
        );
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
