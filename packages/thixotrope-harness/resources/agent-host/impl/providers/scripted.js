// @ts-check
/**
 * The scripted fake provider (M1a W1a.2; `designs/m1a-interfaces.md`
 * section 10). A backend of kind `'scripted'` answers each round from its
 * script: text chunks with delays (published as deltas in-process, never
 * through a vat), tool calls, usage, a scripted error, or a stall until
 * `cancelRound`. It speaks to the session vat only through the turn's
 * `TurnSink`: `dispatching(0)` (answered, awaited before the "request"),
 * then one `roundFinal` or `roundFailed` (sendOnly).
 *
 * Every message it sends to a vat is measured first (exact UTF-8, rule
 * 12.5): a RoundResult over `frameBytes` is never sent; the round fails
 * with `texts.frameLimit` instead (no staging until M1b).
 *
 * Tool-call arguments stay text (rule 12.10): `argsKeys` generates a JSON
 * object with that many keys as a string, which the vat records without
 * parsing.
 *
 * M1b (W1b.1; m1b-interfaces.md 3.2, 5.2, 5.4, 6.4): text over
 * `inlineBytes` is staged as a blob before it is sent: the reply text and
 * a failure's partial (1,024-unit preview), each tool call's `args` over
 * `inlineBytes` and then, while the RoundResult is over `roundResultBytes`,
 * the largest remaining inline `args` (256-unit preview), and a scripted
 * `nativeContext` always (no preview). After staging, a RoundResult still
 * over `roundResultBytes`, or with more than `maxCallsPerMessage` calls,
 * fails the round with `texts.frameLimit`; a staging failure fails it with
 * `textOf.stagingFailed`. While a round streams, every `progressEveryBytes`
 * new bytes (or `progressEveryMs` with new text) the whole text so far is
 * staged and sent as `TurnSink.progress` (sendOnly, one at a time); the
 * reply reuses the last checkpoint's blob when no text came after it.
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { pid } from 'node:process';

import { texts, textOf } from '../../../../guest/lib/interfaces.js';
import {
  cutText,
  messageBytes,
  utf8Bytes,
} from '../../../../guest/lib/bounded.js';
import { limits } from '../../../../guest/lib/limits.js';
import { isStaged } from '../../../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */

/**
 * One JSON line per provider or tool event (section 10):
 * `{ kind, label, pid, at, turnId?, round?, opId?, args?, units? }`.
 * @typedef {(kind: string, fields?: Record<string, unknown>) => void} EventLog
 */

/**
 * The event log of one backend: appended and fsynced line by line, or a
 * no-op without `logPath`.
 *
 * @param {object} options
 * @param {string} options.label the backend's label
 * @param {string} [options.logPath] absolute path of the JSON-lines file
 * @param {() => number} [options.now]
 * @returns {EventLog}
 */
export const makeEventLog = ({ label, logPath, now = () => Date.now() }) => {
  if (logPath === undefined) return () => {};
  return (kind, fields = {}) => {
    const line = `${JSON.stringify({ kind, label, pid, at: now(), ...fields })}\n`;
    const fd = openSync(logPath, 'a', 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
};
harden(makeEventLog);

const ZERO_USAGE = harden({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * `JSON.stringify({ data: { k0: 0, k1: 0, ... } })` with `count` keys,
 * built as text (2,000 keys is about 19 KB).
 * @param {number} count
 */
export const generatedArgs = count => {
  /** @type {string[]} */
  const parts = [];
  for (let i = 0; i < count; i += 1) parts.push(`"k${i}":0`);
  return `{"data":{${parts.join(',')}}}`;
};
harden(generatedArgs);

/**
 * The last `units` UTF-16 units of `text`, never starting inside a pair.
 * @param {string} text
 * @param {number} units
 */
export const tailText = (text, units) => {
  if (text.length <= units) return text;
  let start = text.length - units;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
};
harden(tailText);

/** @param {unknown} error */
const messageOf = error =>
  /** @type {Error} */ (error)?.message ?? String(error);

/**
 * The control of one running round: cancel (logged) or release (silent)
 * stops it; sleeps end early when it stops.
 * @param {import('../timers.js').Timers} timers
 */
const makeRoundControl = timers => {
  /** @type {'cancel' | 'release' | undefined} */
  let stopped;
  /** @type {() => void} */
  let wake = () => {};
  /** @type {Promise<void>} */
  const whenStopped = new Promise(resolve => {
    wake = () => resolve(undefined);
  });
  return {
    stopped: () => stopped,
    whenStopped,
    /** @param {'cancel' | 'release'} how */
    stop: how => {
      if (stopped !== undefined) return;
      stopped = how;
      wake();
    },
    /**
     * Wait `ms`; true when the round was stopped meanwhile.
     * @param {number} ms
     */
    sleep: async ms => {
      if (stopped !== undefined) return true;
      if (ms > 0) {
        /** @type {() => void} */
        let cancel = () => {};
        await Promise.race([
          new Promise(resolve => {
            cancel = timers.after(ms, () => resolve(undefined));
          }),
          whenStopped,
        ]);
        cancel();
      }
      return stopped !== undefined;
    },
  };
};

/**
 * @param {object} options
 * @param {string} options.label the backend's label (`servedBy.label`)
 * @param {any} options.script a `shapes.Script`
 * @param {string} [options.logPath]
 * @param {import('../timers.js').Timers} options.timers
 * @param {EventLog} [options.log] shared with the backend's tools
 * @param {import('../blobs.js').BlobStore} [options.blobs] M1b staging
 *   (without one, text over inlineBytes fails the round)
 * @param {() => number} [options.now]
 */
export const makeScriptedProvider = ({
  label,
  script,
  logPath,
  timers,
  log = makeEventLog({ label, logPath }),
  blobs,
  now = () => Date.now(),
}) => {
  /**
   * @param {string} text
   * @param {number} previewUnits
   */
  const stage = (text, previewUnits) => {
    if (blobs === undefined) return Promise.reject(Error('no blob store'));
    return blobs.stage(text, { previewUnits });
  };
  /**
   * Log after this turn of the event loop, with the `at` of the moment it
   * happened, so the fsync delays nothing on the turn's path (the `delta`
   * and `round-start` lines that perf reads). A late write that fails (the
   * log removed meanwhile) is dropped: it must not take the adapter down.
   * @param {EventLog} write
   * @param {string} kind
   * @param {Record<string, unknown>} fields
   */
  const later = (write, kind, fields) =>
    timers.after(0, () => {
      try {
        write(kind, fields);
      } catch {
        // Dropped.
      }
    });
  /** turn -> the script turn chosen at its round 0 (this incarnation). */
  const chosen = new WeakMap();
  /** turn -> the control of its running round. */
  /** @type {Map<any, ReturnType<typeof makeRoundControl>>} */
  const running = new Map();

  /** @param {string | undefined} input */
  const chooseTurn = input =>
    script.turns.find(
      (/** @type {any} */ turn) => input !== undefined && turn.input === input,
    ) ??
    script.turns.find((/** @type {any} */ turn) => turn.input === undefined);

  /**
   * A roundFailed whose `partial` (the text so far) is cut so the message
   * fits `frameBytes`.
   * @param {number} round
   * @param {string} reason
   * @param {string} [partial]
   */
  const failure = (round, reason, partial = '') => {
    const base = {
      round,
      reason: cutText(reason, limits.reasonUnits),
      at: now(),
    };
    if (partial === '') return harden(base);
    if (isStaged(partial)) return harden({ ...base, partial });
    const room =
      limits.frameBytes -
      messageBytes(harden(base)) -
      utf8Bytes('partial') -
      utf8Bytes('roundFailed');
    const cut = cutText(partial, Math.max(0, room));
    return harden(cut === '' ? base : { ...base, partial: cut });
  };

  /**
   * @param {any} req a RoundRequest
   * @param {any} channel
   * @param {ReturnType<typeof makeRoundControl>} control
   */
  const runRound = async (req, channel, control) => {
    const { turn, sink, turnId, round } = req;
    const where = { turnId, round };
    later(log, 'round-start', { ...where, at: now() });
    const cancelled = () => {
      if (control.stopped() === 'cancel') log('cancelled', where);
    };
    let scriptTurn;
    if (round === 0) {
      const first = req.append[0];
      let input = first?.kind === 'turn-started' ? first.input : undefined;
      if (isStaged(input)) {
        // The script matches on the full text, read in process.
        input = await blobs?.read(input.blob).catch(() => undefined);
      }
      scriptTurn = chooseTurn(input);
      if (scriptTurn !== undefined) chosen.set(turn, scriptTurn);
    } else {
      scriptTurn = chosen.get(turn);
    }
    const scripted = scriptTurn?.rounds[round];
    if (scripted === undefined) {
      log('round-failed', where);
      E.sendOnly(sink).roundFailed(
        failure(round, textOf.scriptExhausted(round)),
      );
      return;
    }
    if (round === 0) {
      if (await control.sleep(scripted.dispatchDelayMs ?? 0)) {
        cancelled();
        return;
      }
      let proceed = false;
      try {
        proceed = (await E(sink).dispatching(0)) === true;
      } catch (_error) {
        // The session vat is lost (or the turn is gone): abandon the round
        // and send nothing to the provider.
        proceed = false;
      }
      if (!proceed) {
        log('dispatch-refused', where);
        return;
      }
      if (control.stopped() !== undefined) {
        cancelled();
        return;
      }
    }
    log('request', where);
    /** @type {string[]} */
    const parts = [];
    let textBytes = 0;
    // Progress checkpoints (contract 3.2): one staging in flight at a time.
    let checkpointBytes = 0;
    let checkpointAt = now();
    /** @type {{ bytes: number, staged: any } | undefined} */
    let lastCheckpoint;
    /** @type {Promise<void> | undefined} */
    let checkpointing;
    const checkpoint = () => {
      const whole = parts.join('');
      const bytes = textBytes;
      checkpointBytes = bytes;
      checkpointAt = now();
      checkpointing = stage(whole, limits.messagePreviewUnits).then(
        partial => {
          checkpointing = undefined;
          if (control.stopped() !== undefined) return;
          lastCheckpoint = { bytes, staged: partial };
          log('progress', { ...where, units: whole.length });
          E.sendOnly(sink).progress(
            harden({
              round,
              partial,
              tail: tailText(whole, limits.messagePreviewUnits),
              at: now(),
            }),
          );
        },
        error => {
          checkpointing = undefined;
          log('progress-failed', { ...where, error: messageOf(error) });
        },
      );
    };
    for (const chunk of scripted.chunks ?? []) {
      // eslint-disable-next-line no-await-in-loop
      if (await control.sleep(chunk.delayMs ?? scripted.chunkDelayMs ?? 0)) {
        cancelled();
        return;
      }
      const text = chunk.text.repeat(chunk.repeat ?? 1);
      parts.push(text);
      textBytes += utf8Bytes(text);
      const publishedAt = now();
      channel.publishDelta(harden({ type: 'delta', turnId, round, text }));
      later(log, 'delta', { ...where, units: text.length, at: publishedAt });
      const fresh = textBytes - checkpointBytes;
      if (
        blobs !== undefined &&
        checkpointing === undefined &&
        fresh > 0 &&
        (fresh >= limits.progressEveryBytes ||
          publishedAt - checkpointAt >= limits.progressEveryMs)
      ) {
        checkpoint();
      }
    }
    const text = parts.join('');
    if (scripted.stall === 'untilCancel') await control.whenStopped;
    if (control.stopped() !== undefined) {
      cancelled();
      return;
    }
    // The reply reuses the last checkpoint when no text came after it.
    await checkpointing;
    /** @param {number} previewUnits */
    const stageText = previewUnits =>
      lastCheckpoint !== undefined && lastCheckpoint.bytes === textBytes
        ? Promise.resolve(lastCheckpoint.staged)
        : stage(text, previewUnits);
    if (scripted.error !== undefined) {
      /** @type {any} */
      let partial = text;
      if (textBytes > limits.inlineBytes) {
        partial = await stageText(limits.messagePreviewUnits).catch(() => text);
      }
      if (control.stopped() !== undefined) {
        cancelled();
        return;
      }
      log('round-failed', where);
      E.sendOnly(sink).roundFailed(failure(round, scripted.error, partial));
      return;
    }
    /** @type {Array<{ callId: string, name: string, args: any }>} */
    const calls = (scripted.toolCalls ?? []).map((/** @type {any} */ call) => ({
      callId: call.callId ?? '',
      name: call.name,
      /** @type {any} */
      args:
        call.args ??
        (call.code !== undefined
          ? JSON.stringify({
              code: call.code.text.repeat(call.code.repeat ?? 1),
            })
          : call.argsKeys
            ? generatedArgs(call.argsKeys)
            : '{}'),
    }));
    /** @type {any} */
    let result;
    try {
      if (calls.length > limits.maxCallsPerMessage) {
        throw Error(texts.frameLimit);
      }
      result = await stageRound({
        round,
        text,
        textBytes,
        calls,
        stageText,
        nativeContext: scripted.nativeContext,
        usage: scripted.usage ?? ZERO_USAGE,
        servedBy: { label, modelId: req.options.modelId },
      });
    } catch (error) {
      const reason =
        messageOf(error) === texts.frameLimit
          ? texts.frameLimit
          : textOf.stagingFailed(messageOf(error));
      if (control.stopped() !== undefined) {
        cancelled();
        return;
      }
      log(reason === texts.frameLimit ? 'frame-limit' : 'staging-failed', {
        ...where,
        units: text.length,
      });
      E.sendOnly(sink).roundFailed(failure(round, reason));
      return;
    }
    if (control.stopped() !== undefined) {
      cancelled();
      return;
    }
    log('round-final', where);
    E.sendOnly(sink).roundFinal(result);
  };

  /**
   * The RoundResult with every field over its bound staged (5.2), or a
   * rejection with `texts.frameLimit` when it still does not fit (5.4).
   * @param {object} round
   * @param {number} round.round
   * @param {string} round.text
   * @param {number} round.textBytes
   * @param {Array<{ callId: string, name: string, args: any }>} round.calls
   * @param {(previewUnits: number) => Promise<any>} round.stageText
   * @param {string | undefined} round.nativeContext
   * @param {any} round.usage
   * @param {any} round.servedBy
   */
  const stageRound = async ({
    round,
    text,
    textBytes,
    calls,
    stageText,
    nativeContext,
    usage,
    servedBy,
  }) => {
    /** @type {any} */
    let replyText = text;
    if (textBytes > limits.inlineBytes) {
      replyText = await stageText(limits.messagePreviewUnits);
    }
    await Promise.all(
      calls.map(async call => {
        if (utf8Bytes(call.args) > limits.inlineBytes) {
          call.args = await stage(call.args, limits.toolPreviewUnits);
        }
      }),
    );
    /** @type {Record<string, any>} */
    const fields = { round, text: replyText, usage, at: now(), servedBy };
    if (nativeContext !== undefined) {
      fields.nativeContext = await stage(nativeContext, 0);
    }
    const build = () =>
      harden({ ...fields, toolCalls: calls.map(call => harden({ ...call })) });
    let result = build();
    while (messageBytes(result) > limits.roundResultBytes) {
      let largest = -1;
      let largestBytes = 0;
      calls.forEach((call, index) => {
        if (typeof call.args === 'string') {
          const bytes = /** @type {number} */ (utf8Bytes(call.args));
          if (bytes > largestBytes) {
            largest = index;
            largestBytes = bytes;
          }
        }
      });
      // Nothing inline worth staging is left (a staged field is ~0.8 KB).
      if (largest < 0 || largestBytes < 1024) {
        throw Error(texts.frameLimit);
      }
      // eslint-disable-next-line no-await-in-loop
      calls[largest].args = await stage(
        calls[largest].args,
        limits.toolPreviewUnits,
      );
      result = build();
    }
    return result;
  };

  return harden({
    /**
     * @param {any} req
     * @param {any} channel
     */
    startRound: async (req, channel) => {
      running.get(req.turn)?.stop('release');
      const control = makeRoundControl(timers);
      running.set(req.turn, control);
      try {
        await runRound(req, channel, control);
      } finally {
        if (running.get(req.turn) === control) running.delete(req.turn);
      }
    },
    /** @param {any} turn stops its running round; logged `cancelled` */
    cancelRound: turn => running.get(turn)?.stop('cancel'),
    /** @param {any} turn stops its running round silently (lease released) */
    releaseTurn: turn => running.get(turn)?.stop('release'),
  });
};
harden(makeScriptedProvider);
