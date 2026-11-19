// @ts-check
/**
 * The `ShellPort`: a session's shell on the turn path for one adapter
 * incarnation (`designs/m6-interfaces.md` D-M6-4, 3.6, 4.2 step 4, 5.5).
 * The session's `runCommand` and `inspectShell` tools send the model's
 * argument JSON here (inline, or staged and read through the request's
 * `Content`); the port parses it (`command-args.js`), runs the command
 * through the runner, bounds the result (`command-output.js`) and answers
 * a `ToolOutcome` whose text is the A.3 JSON, inline up to `inlineBytes`,
 * else staged through the request's `BlobWriters` (`blob-access.js`).
 *
 * Refusals are `failed` outcomes, never rejections (a rejection from an
 * adapter object is how the session sees a break, D-M6-5): bad arguments
 * (nothing runs), a key withdrawn by an emergency stop (D-M6-9; asked
 * before the command and again after it), a timeout (the partial output is
 * dropped, as exo-shell does), a runtime failure (a bounded reason, the
 * state directory never in it: `redact`).
 *
 * Node only (adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentInterfaces,
  environmentLimits,
  environmentTexts,
  environmentTextOf,
} from '../../../guest/lib/guards/environments.js';
import { textOf } from '../../../guest/lib/interfaces.js';
import {
  boundToolOutput,
  cutText,
  messageOf,
  previewText,
  utf8Bytes,
} from '../../../guest/lib/bounded.js';
import { limits } from '../../../guest/lib/limits.js';
import { isStaged } from '../../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import { parseCommandArgs, parseInspectArgs } from './command-args.js';
import { boundCommandResult } from './command-output.js';
import { readStaged, stageText } from './blob-access.js';

/** @import { RawResult } from './command-output.js' */

const { makeExo } = /** @type {any} */ (globalThis);

const L = environmentLimits;

/**
 * The most bytes of staged argument JSON the port reads: the arguments'
 * own bound, doubled for the JSON's keys, quotes and escapes. Over it the
 * call is refused unread.
 */
export const argsReadBytes = 2 * L.commandArgsBytes;

/** Units of a runtime failure's reason in `runtimeFailed`. */
const reasonUnits = 1024;

/** Runner rejections whose message is already a fixed environments text. */
const fixedTexts = new Set(Object.values(environmentTexts));

/**
 * @typedef {object} PortRunner the runner as the port uses it (`runner.js`)
 * @property {(key: string, argv: string[], options: { timeoutMs: number }) => Promise<RawResult>} exec
 * @property {() => Promise<any> | any} inspect a `ShellInfo`
 *
 * @typedef {object} PortBlobs
 * @property {typeof stageText} stageText
 * @property {typeof readStaged} readStaged
 */

/**
 * @param {object} options
 * @param {string} options.key the environment's key (never leaves the adapter)
 * @param {PortRunner} options.runner
 * @param {{ allowedCommands: readonly string[], defaultTimeoutMs?: number }} options.settings
 * @param {PortBlobs} [options.blobs] reads and writes of agent-host blobs
 * @param {(key: string) => boolean} [options.isWithdrawn] the adapter's
 *   withdrawn set (emergency stop, D-M6-9)
 * @param {(text: string) => string} [options.redact] removes host paths
 *   from a runtime failure's message (D-M6-14)
 * @param {(event: string, fields: Record<string, unknown>) => void} [options.log]
 */
export const makeShellPort = ({
  key,
  runner,
  settings,
  blobs = harden({ stageText, readStaged }),
  isWithdrawn = () => false,
  redact = text => text,
  log = () => {},
}) => {
  const defaultTimeoutMs =
    settings.defaultTimeoutMs ?? L.defaultCommandTimeoutMs;

  /**
   * An outcome for a model-facing text: inline when it fits `inlineBytes`,
   * else staged. A failure's staged text is the whole `Error: ...` result
   * (as the session would write it inline).
   *
   * @param {'ok' | 'failed'} status
   * @param {string} text
   * @param {any} writers
   */
  const answer = async (status, text, writers) => {
    await null;
    const bounded = boundToolOutput(text);
    if (utf8Bytes(bounded) <= limits.inlineBytes) {
      return harden({ status, text: bounded });
    }
    const modelText =
      status === 'ok' ? bounded : boundToolOutput(textOf.errorResult(text));
    try {
      return harden({
        status,
        text: await blobs.stageText(modelText, writers),
      });
    } catch (error) {
      const failure = textOf.stagingFailed(messageOf(error));
      return harden({
        status: 'failed',
        text: cutText(boundToolOutput(failure), limits.inlineBytes),
      });
    }
  };

  /**
   * The model's argument text, or a refusal.
   * @param {any} args
   * @param {any} content
   * @returns {Promise<{ text: string } | { refusal: string }>}
   */
  const argumentText = async (args, content) => {
    await null;
    if (!isStaged(args)) return { text: args };
    const bytes = /** @type {number} */ (args.bytes);
    if (bytes > argsReadBytes) {
      return {
        refusal: environmentTextOf.argsTooLarge(bytes, L.commandArgsBytes),
      };
    }
    if (content === undefined) {
      return {
        refusal: textOf.stagingFailed(
          'the arguments were staged but no content reader was passed',
        ),
      };
    }
    try {
      return { text: await blobs.readStaged(args, content, argsReadBytes) };
    } catch (error) {
      return { refusal: textOf.stagingFailed(messageOf(error)) };
    }
  };

  /** @param {unknown} error */
  const runtimeFailure = error => {
    const message = messageOf(error);
    if (fixedTexts.has(message)) return message;
    return environmentTextOf.runtimeFailed(
      previewText(redact(message), reasonUnits),
    );
  };

  return makeExo('ShellPort', environmentInterfaces.ShellPort, {
    /**
     * @param {{ opId: string, args: any, writers: any, content?: any }} request
     */
    async runCommand({ opId, args, writers, content }) {
      if (isWithdrawn(key)) {
        return answer('failed', environmentTexts.stopped, writers);
      }
      const argument = await argumentText(args, content);
      if ('refusal' in argument) {
        return answer('failed', argument.refusal, writers);
      }
      const parsed = parseCommandArgs(argument.text, settings.allowedCommands);
      if (!parsed.ok) return answer('failed', parsed.text, writers);
      if (isWithdrawn(key)) {
        return answer('failed', environmentTexts.stopped, writers);
      }
      const timeoutMs = parsed.timeoutMs ?? defaultTimeoutMs;
      log('shell-run-start', { opId, command: parsed.command });
      /** @type {RawResult} */
      let raw;
      try {
        raw = await runner.exec(key, [parsed.command, ...parsed.args], {
          timeoutMs,
        });
      } catch (error) {
        log('shell-run-failed', { opId });
        return answer('failed', runtimeFailure(error), writers);
      }
      if (isWithdrawn(key)) {
        return answer('failed', environmentTexts.stopped, writers);
      }
      if (raw.timedOut) {
        log('shell-run-timeout', { opId, ms: raw.ms });
        return answer('failed', environmentTextOf.timedOut(timeoutMs), writers);
      }
      const text = boundCommandResult(raw);
      log('shell-run-end', {
        opId,
        exitCode: raw.exitCode,
        ms: raw.ms,
        units: text.length,
      });
      return answer('ok', text, writers);
    },
    /**
     * @param {{ opId: string, args: any, writers: any, content?: any }} request
     */
    async inspect({ args, writers, content }) {
      if (isWithdrawn(key)) {
        return answer('failed', environmentTexts.stopped, writers);
      }
      const argument = await argumentText(args, content);
      if ('refusal' in argument) {
        return answer('failed', argument.refusal, writers);
      }
      const parsed = parseInspectArgs(argument.text);
      if (!parsed.ok) return answer('failed', parsed.text, writers);
      try {
        const info = await runner.inspect();
        return answer('ok', JSON.stringify(info), writers);
      } catch (error) {
        return answer('failed', runtimeFailure(error), writers);
      }
    },
  });
};
harden(makeShellPort);
