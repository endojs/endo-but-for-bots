// @ts-check
/**
 * The shared provider round (M2 W2.1a; designs/m2-interfaces.md 8.1): one
 * implementation of what every API provider does around its request, so
 * OpenRouter (W2.1a), the Anthropic API (W2.1b) and later providers differ
 * only in the request they make and how they read its answer.
 *
 * `runProviderRound({ req, channel, prepare, blobs, log, stream, ... })`:
 *
 * 1. `prepare()` first (the context cache's projection, M1b 9): a page that
 *    breaks abandons the round (nothing sent), another failure fails it with
 *    `textOf.stagingFailed`.
 * 2. Round 0 sends nothing to the provider before `E(req.sink).dispatching(0)`
 *    answered `true` (contract 6); a refusal or a break abandons the round.
 * 3. `stream({ projection, signal })` is called and its events consumed:
 *    `{ delta }` is published in process on the session's channel (zero vat
 *    deliveries per delta; split at the `DeltaEvent` bound) and appended to
 *    the reply; `{ toolCall }` is kept (`callId`, `name`, `args` as text,
 *    never parsed, rule 12.10; cut to the `ToolCall` guard's bounds); the
 *    latest `{ usage }`, `{ servedBy }` and `{ nativeContext }` (opaque
 *    provider text, W2.1b: staged with no preview into the result's
 *    `nativeContext`, R4-31) are kept; `{ stop }` is
 *    informative. While text streams, progress checkpoints stage the whole
 *    text so far every `progressEveryBytes` new bytes or `progressEveryMs`
 *    (answered, one in flight, linear bytes written; M1b 3.2, J-0393), as
 *    the scripted provider does.
 * 4. The result: one `roundFinal` (text and call arguments over their
 *    bounds staged per M1b 5.2; more than `maxCallsPerMessage` calls or a
 *    result still over `roundResultBytes` fails with `texts.frameLimit`), or
 *    one `roundFailed` with the failure's fixed text, the text so far as
 *    `partial` (staged when long) and the usage seen, if any.
 *
 * Cancel and release (`control.stop`) abort `signal`, so the provider's
 * request is torn down (R4-7; the server sees the connection close), and the
 * round sends nothing more to the vat: a staged file of a result never sent
 * is dropped (J-9361).
 *
 * Failure text (R4-79): a thrown `ProviderFailure` carries one of the
 * contract's fixed texts (`reason`); anything else thrown by the stream is
 * reported with `options.unreachable` (the provider's "could not be reached
 * or sent an unreadable response" text). No error message of a lower layer
 * and no provider body ever reaches `roundFailed` or the event log.
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';
import { Buffer } from 'node:buffer';

import { texts, textOf } from '../../../../guest/lib/interfaces.js';
import {
  cutText,
  messageBytes,
  utf8Bytes,
} from '../../../../guest/lib/bounded.js';
import { limits } from '../../../../guest/lib/limits.js';
import { isStaged } from '../../../../guest/session/staging.js';
import { emptyUsage } from '../../../../guest/lib/token-usage.js';
/* eslint-enable import/no-relative-packages */
import { isAbandoned } from '../context-cache.js';
import { tailText } from './scripted.js';

/**
 * A provider failure with a fixed text. `retryable`, `retryAfterMs` and
 * `timedOut` are for the retry wrapper (W2.1b); `delivered` says the
 * attempt already published text or reported usage (never retried, R4-74).
 */
export class ProviderFailure extends Error {
  /**
   * @param {string} reason one of the contract's fixed texts
   * @param {{ retryable?: boolean, retryAfterMs?: number, timedOut?: boolean, status?: number, delivered?: boolean }} [details]
   */
  constructor(reason, details = {}) {
    super(reason);
    this.reason = reason;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs;
    this.timedOut = details.timedOut ?? false;
    this.status = details.status;
    this.delivered = details.delivered ?? false;
  }
}
harden(ProviderFailure);

/** @param {unknown} error */
export const isProviderFailure = error => error instanceof ProviderFailure;
harden(isProviderFailure);

/**
 * The control of one running round: `stop('cancel' | 'release')` aborts
 * `signal` (the request goes down with it) and wakes `whenStopped`.
 * @param {import('../timers.js').Timers} timers
 */
export const makeRoundControl = timers => {
  const controller = new AbortController();
  /** @type {'cancel' | 'release' | undefined} */
  let stopped;
  /** @type {() => void} */
  let wake = () => {};
  /** @type {Promise<void>} */
  const whenStopped = new Promise(resolve => {
    wake = () => resolve(undefined);
  });
  // Not hardened: `harden` would freeze the AbortSignal, and `fetch` (and
  // `AbortSignal.any`) cannot use a frozen signal.
  return Object.freeze({
    signal: controller.signal,
    stopped: () => stopped,
    whenStopped,
    /** @param {'cancel' | 'release'} how */
    stop: how => {
      if (stopped !== undefined) return;
      stopped = how;
      controller.abort();
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
  });
};
harden(makeRoundControl);

/** @typedef {ReturnType<typeof makeRoundControl>} RoundControl */

/**
 * The key, through the backend's grant (R4-82): a read failure is
 * `textOf.secretFailed(code)` with the store's code, else `READ_FAILED`.
 * @param {(() => Promise<string>) | undefined} readKey
 */
export const readProviderKey = async readKey => {
  if (readKey === undefined)
    throw new ProviderFailure(textOf.secretFailed('READ_FAILED'));
  try {
    const key = await readKey();
    if (typeof key !== 'string' || key.trim() === '') throw Error('no key');
    if (Buffer.byteLength(key) > limits.providerTokenBytes) {
      // R7-25, contract 9.2: never sent as a header (J-9486).
      throw Error('Secret operation failed: "INVALID_SECRET_BYTES"');
    }
    return key;
  } catch (error) {
    const message = /** @type {Error} */ (error)?.message ?? '';
    const code = /^Secret operation failed: "([A-Z_]+)"$/.exec(message)?.[1];
    throw new ProviderFailure(textOf.secretFailed(code ?? 'READ_FAILED'));
  }
};
harden(readProviderKey);

/**
 * The round's system prompt as text (inline, or staged: read in process),
 * or undefined; a read that fails is `textOf.stagingFailed`. M5 (W5.3, S2,
 * H-8): `system` may be a list of parts (the stored prompt and the turn's
 * R4-29 line), each inline or staged; they are read in order and joined
 * with a blank line.
 * @param {any} system
 * @param {import('../blobs.js').BlobStore | undefined} blobs
 * @param {any} owner
 * @returns {Promise<string | undefined>}
 */
export const systemTextOf = async (system, blobs, owner) => {
  if (system === undefined) return undefined;
  if (Array.isArray(system)) {
    /** @type {string[]} */
    const parts = [];
    for (const part of system) {
      // eslint-disable-next-line no-await-in-loop -- at most two parts, in order
      const text = await systemTextOf(part, blobs, owner);
      if (text !== undefined) parts.push(text);
    }
    return parts.join('\n\n');
  }
  if (!isStaged(system)) return system;
  try {
    if (blobs === undefined) throw Error('no blob store');
    return await blobs.read(system.blob, owner);
  } catch (error) {
    throw new ProviderFailure(
      textOf.stagingFailed(
        /** @type {Error} */ (error)?.message ?? String(error),
      ),
    );
  }
};
harden(systemTextOf);

/**
 * @typedef {{ delta: string }
 *   | { toolCall: { callId?: string, name: string, args: string } }
 *   | { usage: any }
 *   | { servedBy: { modelId?: string, provider?: string } }
 *   | { nativeContext: string }
 *   | { stop: string }} RoundEvent
 */

/**
 * Split a delta at the `DeltaEvent` text bound (never inside a pair).
 * @param {string} text
 */
const deltaPieces = text => {
  const max = limits.scriptRepeat;
  if (text.length <= max) return [text];
  /** @type {string[]} */
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + max);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
};

/**
 * @param {object} options
 * @param {any} options.req the RoundRequest
 * @param {any} options.channel the session's channel (`publishDelta`)
 * @param {(() => Promise<any>) | undefined} options.prepare the projection
 * @param {import('../blobs.js').BlobStore | undefined} options.blobs
 * @param {import('./scripted.js').EventLog} options.log
 * @param {(args: { projection: any, signal: AbortSignal }) => AsyncIterable<RoundEvent>} options.stream
 * @param {any} [options.owner] the Session presence (blob quota)
 * @param {RoundControl} options.control
 * @param {import('../timers.js').Timers} options.timers
 * @param {() => number} [options.now]
 * @param {string} options.label the backend's label (`servedBy.label`)
 * @param {string} options.unreachable the text for an unexpected failure
 */
export const runProviderRound = async ({
  req,
  channel,
  prepare,
  blobs,
  log,
  stream,
  owner,
  control,
  timers,
  now = () => Date.now(),
  label,
  unreachable,
}) => {
  const { sink, turnId, round } = req;
  const where = { turnId, round };
  /**
   * Log after this turn of the event loop (the fsync delays nothing on the
   * round's path); a late write that fails is dropped.
   * @param {string} kind
   * @param {Record<string, unknown>} fields
   */
  const later = (kind, fields) =>
    timers.after(0, () => {
      try {
        log(kind, fields);
      } catch {
        // Dropped.
      }
    });
  later('round-start', { ...where, at: now() });
  const cancelled = () => {
    if (control.stopped() === 'cancel') log('cancelled', where);
  };
  /**
   * @param {string} text
   * @param {number} previewUnits
   */
  const stage = (text, previewUnits) =>
    blobs === undefined
      ? Promise.reject(Error('no blob store'))
      : blobs.stagePending(text, { previewUnits, owner });
  /** @param {ReadonlyArray<any>} staged */
  const commit = staged => blobs?.commit(staged) ?? Promise.resolve();
  /** @param {ReadonlyArray<any>} staged */
  const drop = staged => {
    void blobs?.drop(staged).catch(() => 0);
  };
  /**
   * A roundFailed whose `partial` is cut so the message fits frameBytes.
   * @param {string} reason
   * @param {any} [partial]
   * @param {any} [usage]
   */
  const failure = (reason, partial = '', usage = undefined) => {
    /** @type {Record<string, any>} */
    const base = {
      round,
      reason: cutText(reason, limits.reasonUnits),
      at: now(),
    };
    if (usage !== undefined) base.usage = usage;
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

  // 1. The projection.
  /** @type {any} */
  let projection;
  if (prepare !== undefined) {
    try {
      projection = await prepare();
    } catch (error) {
      if (isAbandoned(error)) {
        log('context-abandoned', where);
        return;
      }
      if (control.stopped() !== undefined) {
        cancelled();
        return;
      }
      log('context-failed', where);
      E.sendOnly(sink).roundFailed(
        failure(
          textOf.stagingFailed(
            /** @type {Error} */ (error)?.message ?? String(error),
          ),
        ),
      );
      return;
    }
    if (control.stopped() !== undefined) {
      cancelled();
      return;
    }
  }

  // 2. Dispatch (round 0).
  if (round === 0) {
    let proceed = false;
    try {
      proceed = (await E(sink).dispatching(0)) === true;
    } catch {
      // The session vat is lost (or the turn is gone): send nothing.
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

  // 3. The stream.
  log('request', where);
  /** @type {string[]} */
  const parts = [];
  let textBytes = 0;
  /** @type {Array<{ callId: string, name: string, args: any }>} */
  const calls = [];
  /** @type {any} */
  let usage;
  /** @type {{ modelId?: string, provider?: string }} */
  let served = {};
  /** @type {string | undefined} */
  let nativeContext;
  let checkpointBytes = 0;
  let checkpointAt = now();
  let checkpointWritten = 0;
  /** @type {{ bytes: number, staged: any } | undefined} */
  let lastCheckpoint;
  /** @type {Promise<void> | undefined} */
  let checkpointing;
  /** @type {any} */
  let heldCheckpoint;
  const checkpoint = () => {
    const whole = parts.join('');
    const bytes = textBytes;
    checkpointBytes = bytes;
    checkpointAt = now();
    checkpointWritten += bytes;
    checkpointing = stage(whole, limits.messagePreviewUnits).then(
      async partial => {
        if (control.stopped() !== undefined) {
          checkpointing = undefined;
          drop([partial]);
          return undefined;
        }
        try {
          await commit([partial]);
        } catch {
          checkpointing = undefined;
          drop([partial]);
          log('progress-failed', where);
          return undefined;
        }
        checkpointing = undefined;
        lastCheckpoint = { bytes, staged: partial };
        log('progress', { ...where, units: whole.length });
        return E(sink)
          .progress(
            harden({
              round,
              partial,
              tail: tailText(whole, limits.messagePreviewUnits),
              at: now(),
            }),
          )
          .then(
            kept => {
              if (kept !== true) return;
              const previous = heldCheckpoint;
              heldCheckpoint = partial;
              if (previous !== undefined && previous.blob !== partial.blob)
                void blobs?.discard(previous.blob);
            },
            () => {},
          );
      },
      () => {
        checkpointing = undefined;
        log('progress-failed', where);
      },
    );
  };

  /** @type {string | undefined} */
  let failed;
  try {
    for await (const event of stream({ projection, signal: control.signal })) {
      if (control.stopped() !== undefined) break;
      if ('delta' in event) {
        const text = event.delta;
        if (typeof text === 'string' && text !== '') {
          parts.push(text);
          textBytes += utf8Bytes(text);
          const publishedAt = now();
          for (const piece of deltaPieces(text)) {
            channel.publishDelta(
              harden({ type: 'delta', turnId, round, text: piece }),
            );
          }
          later('delta', { ...where, units: text.length, at: publishedAt });
          const fresh = textBytes - checkpointBytes;
          if (
            blobs !== undefined &&
            checkpointing === undefined &&
            fresh > 0 &&
            (fresh >= limits.progressEveryBytes ||
              publishedAt - checkpointAt >= limits.progressEveryMs) &&
            checkpointWritten <= (limits.progressWriteFactor - 1) * textBytes
          ) {
            checkpoint();
          }
        }
      } else if ('toolCall' in event) {
        if (calls.length >= limits.maxCallsPerMessage) {
          throw new ProviderFailure(texts.frameLimit);
        }
        const call = event.toolCall;
        calls.push({
          callId: cutText(String(call.callId ?? ''), limits.callIdUnits),
          name: cutText(String(call.name ?? ''), limits.toolNameUnits),
          args: typeof call.args === 'string' ? call.args : '',
        });
      } else if ('usage' in event) {
        usage = event.usage;
      } else if ('servedBy' in event) {
        served = { ...served, ...event.servedBy };
      } else if ('nativeContext' in event) {
        if (typeof event.nativeContext === 'string' && event.nativeContext)
          nativeContext = event.nativeContext;
      }
    }
  } catch (error) {
    if (control.stopped() === undefined) {
      failed = isProviderFailure(error)
        ? /** @type {ProviderFailure} */ (error).reason
        : unreachable;
      // The error's class only: a message may quote what a server sent.
      if (!isProviderFailure(error))
        log('stream-failed', {
          ...where,
          error: /** @type {any} */ (error)?.name ?? typeof error,
        });
    }
  }
  if (control.stopped() !== undefined) {
    await checkpointing;
    cancelled();
    return;
  }

  const text = parts.join('');
  await checkpointing;
  /** @param {number} previewUnits */
  const stageText = previewUnits =>
    lastCheckpoint !== undefined && lastCheckpoint.bytes === textBytes
      ? Promise.resolve(lastCheckpoint.staged)
      : stage(text, previewUnits);

  if (failed !== undefined) {
    /** @type {any} */
    let partial = text;
    if (textBytes > limits.inlineBytes) {
      partial = await stageText(limits.messagePreviewUnits).catch(() => text);
    }
    if (control.stopped() !== undefined) {
      drop([partial]);
      cancelled();
      return;
    }
    try {
      await commit([partial]);
    } catch {
      drop([partial]);
      partial = text;
    }
    log('round-failed', where);
    E.sendOnly(sink).roundFailed(failure(failed, partial, usage));
    return;
  }

  if (
    heldCheckpoint !== undefined &&
    lastCheckpoint !== undefined &&
    lastCheckpoint.bytes !== textBytes
  ) {
    // Make the whole text the last checkpoint so the reply reuses it and
    // no superseded checkpoint file is left (J-0393), as scripted.js does.
    checkpoint();
    await checkpointing;
  }

  /** @type {any[]} */
  const roundStaged = [];
  /** @type {any} */
  let result;
  try {
    result = await stageResult({
      round,
      text,
      textBytes,
      calls,
      stageText,
      stage,
      usage: usage ?? emptyUsage(),
      servedBy: harden({
        label,
        modelId: cutText(
          served.modelId ?? req.options.modelId,
          limits.modelIdUnits,
        ),
        ...(served.provider === undefined
          ? {}
          : { provider: cutText(served.provider, limits.labelUnits) }),
      }),
      now,
      staged: roundStaged,
      nativeContext,
    });
    if (control.stopped() === undefined) await commit(roundStaged);
  } catch (error) {
    drop(roundStaged);
    if (control.stopped() !== undefined) {
      cancelled();
      return;
    }
    const message = /** @type {Error} */ (error)?.message ?? String(error);
    const reason =
      message === texts.frameLimit
        ? texts.frameLimit
        : textOf.stagingFailed(message);
    log(reason === texts.frameLimit ? 'frame-limit' : 'staging-failed', {
      ...where,
      units: text.length,
    });
    E.sendOnly(sink).roundFailed(failure(reason, '', usage));
    return;
  }
  if (control.stopped() !== undefined) {
    drop(roundStaged);
    cancelled();
    return;
  }
  log('round-final', { ...where, calls: calls.length, units: text.length });
  E.sendOnly(sink).roundFinal(result);
};
harden(runProviderRound);

/**
 * The RoundResult with every field over its bound staged (M1b 5.2), or a
 * rejection with `texts.frameLimit` when it still does not fit (5.4).
 * @param {object} round
 * @param {number} round.round
 * @param {string} round.text
 * @param {number} round.textBytes
 * @param {Array<{ callId: string, name: string, args: any }>} round.calls
 * @param {(previewUnits: number) => Promise<any>} round.stageText
 * @param {(text: string, previewUnits: number) => Promise<any>} round.stage
 * @param {any} round.usage
 * @param {any} round.servedBy
 * @param {() => number} round.now
 * @param {any[]} round.staged collects every StagedText of the result
 * @param {string} [round.nativeContext] staged with no preview (R4-31)
 */
const stageResult = async ({
  round,
  text,
  textBytes,
  calls,
  stageText,
  stage,
  usage,
  servedBy,
  now,
  staged,
  nativeContext,
}) => {
  /** @param {Promise<any>} staging */
  const kept = async staging => {
    const value = await staging;
    staged.push(value);
    return value;
  };
  /** @type {any} */
  let replyText = text;
  if (textBytes > limits.inlineBytes) {
    replyText = await kept(stageText(limits.messagePreviewUnits));
  }
  await Promise.all(
    calls.map(async call => {
      if (utf8Bytes(call.args) > limits.inlineBytes) {
        call.args = await kept(stage(call.args, limits.toolPreviewUnits));
      }
    }),
  );
  /** @type {Record<string, any>} */
  const fields = { round, text: replyText, usage, at: now(), servedBy };
  if (nativeContext !== undefined) {
    fields.nativeContext = await kept(stage(nativeContext, 0));
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
    if (largest < 0 || largestBytes < 1024) throw Error(texts.frameLimit);
    // eslint-disable-next-line no-await-in-loop
    calls[largest].args = await kept(
      stage(calls[largest].args, limits.toolPreviewUnits),
    );
    result = build();
  }
  return result;
};
