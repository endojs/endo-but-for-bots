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
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { pid } from 'node:process';

import { texts, textOf } from '../../../../guest/lib/interfaces.js';
import {
  cutText,
  fitsFrame,
  messageBytes,
  utf8Bytes,
} from '../../../../guest/lib/bounded.js';
import { limits } from '../../../../guest/lib/limits.js';
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
 * @param {() => number} [options.now]
 */
export const makeScriptedProvider = ({
  label,
  script,
  logPath,
  timers,
  log = makeEventLog({ label, logPath }),
  now = () => Date.now(),
}) => {
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
    const base = { round, reason, at: now() };
    if (partial === '') return harden(base);
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
    const cancelled = () => {
      if (control.stopped() === 'cancel') log('cancelled', where);
    };
    let scriptTurn;
    if (round === 0) {
      const first = req.append[0];
      scriptTurn = chooseTurn(
        first?.kind === 'turn-started' ? first.input : undefined,
      );
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
    for (const chunk of scripted.chunks ?? []) {
      // eslint-disable-next-line no-await-in-loop
      if (await control.sleep(chunk.delayMs ?? scripted.chunkDelayMs ?? 0)) {
        cancelled();
        return;
      }
      const text = chunk.text.repeat(chunk.repeat ?? 1);
      parts.push(text);
      const publishedAt = now();
      channel.publishDelta(harden({ type: 'delta', turnId, round, text }));
      // Logged after this turn of the event loop, so the fsync does not
      // delay the subscribers' answers (perf turn.delta reads `at`). A
      // late write that fails (the log removed meanwhile) is dropped: it
      // must not take the adapter process down.
      timers.after(0, () => {
        try {
          log('delta', { ...where, units: text.length, at: publishedAt });
        } catch {
          // Dropped.
        }
      });
    }
    const text = parts.join('');
    if (scripted.stall === 'untilCancel') await control.whenStopped;
    if (control.stopped() !== undefined) {
      cancelled();
      return;
    }
    if (scripted.error !== undefined) {
      log('round-failed', where);
      E.sendOnly(sink).roundFailed(failure(round, scripted.error, text));
      return;
    }
    const toolCalls = (scripted.toolCalls ?? []).map(
      (/** @type {any} */ call) =>
        harden({
          callId: call.callId ?? '',
          name: call.name,
          args:
            call.args ?? (call.argsKeys ? generatedArgs(call.argsKeys) : '{}'),
        }),
    );
    const result = harden({
      round,
      text,
      toolCalls,
      usage: scripted.usage ?? ZERO_USAGE,
      at: now(),
      servedBy: { label, modelId: req.options.modelId },
    });
    if (!fitsFrame(result)) {
      log('frame-limit', { ...where, units: text.length });
      E.sendOnly(sink).roundFailed(failure(round, texts.frameLimit));
      return;
    }
    log('round-final', where);
    E.sendOnly(sink).roundFinal(result);
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
