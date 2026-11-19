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
 * M1b W1b.2 (m1b-interfaces.md 6.5, 9): each round first calls the
 * endpoint's `prepare` (the context cache) and stands for a provider that
 * sends the projection: round 0 chooses its script turn from the
 * projection's full input text, a page that breaks abandons the round
 * (nothing sent), a blob that cannot be loaded fails it with
 * `textOf.stagingFailed`. With `logContext` (default: when there is a log
 * file) a `context` line records what the provider would have received:
 * `{ records, bytes, digest, turnDigests }` (sha-256 prefixes of the
 * transcript records' JSON, the whole and per turn, a turn starting at each
 * user message), so a test can compare contexts across a restart; while a
 * file `<logPath>.nodigest` exists the line has no digests (M2 W2.9).
 *
 * M2 W2.6: a script round with `times` stands for that many rounds in a row
 * (`scriptRoundAt`; the round-limit probe), and the `context` line also
 * carries `{ systemBytes, systemDigest }` of the request's system prompt
 * (seam 1 of m2-interfaces.md 2.4), read in full when staged.
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

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
import { makeEventLog } from './event-log.js';
import {
  isProviderFailure,
  stageResult,
  systemTextOf,
  tailText,
} from './round.js';
import { compactBeforeRound } from './compaction-round.js';
import { scriptedSummary } from './compaction.js';
import { makeProviderShell } from './shell.js';

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
 * `{"<prefix><from>":<from>,...}` with `count` distinct keys, built as
 * text in the adapter. A script names a flood of fresh keys this way
 * (`chunk.keys`, `call.argsFreshKeys`) instead of carrying the text:
 * the script crosses the agent host's manager vat whole, where a message of
 * a few hundred KB halts it (C-5; J-9381).
 * @param {{ prefix: string, from: number, count: number }} spec
 */
export const generatedKeys = ({ prefix, from, count }) => {
  /** @type {string[]} */
  const parts = [];
  for (let i = from; i < from + count; i += 1)
    parts.push(`"${prefix}${i}":${i}`);
  return `{${parts.join(',')}}`;
};
harden(generatedKeys);

/** @param {string} text */
const sha = text => createHash('sha256').update(text).digest('hex');

/**
 * What the `context` log line records of a projection (W1b.2): the record
 * count, the JSON bytes, a digest of the whole transcript and one 16-hex
 * digest per turn (a turn starts at each user message), space-separated.
 * @param {readonly any[]} transcript
 */
export const contextDigests = transcript => {
  /** @type {string[]} */
  const turns = [];
  /** @type {string[]} */
  let current = [];
  let bytes = 0;
  /** @type {string[]} */
  const all = [];
  for (const record of transcript) {
    const json = JSON.stringify(record);
    bytes += Buffer.byteLength(json);
    all.push(json);
    if (record.kind === 'message' && record.role === 'user' && current.length) {
      turns.push(sha(current.join('\n')).slice(0, 16));
      current = [];
    }
    current.push(json);
  }
  if (current.length) turns.push(sha(current.join('\n')).slice(0, 16));
  return harden({
    records: transcript.length,
    bytes,
    digest: sha(all.join('\n')).slice(0, 32),
    turnDigests: turns.join(' '),
  });
};
harden(contextDigests);

/**
 * The script round that stands for `round` of a script turn: rounds in
 * order, each `times` times (M2 W2.6, default once), or undefined past the
 * end.
 * @param {any} scriptTurn
 * @param {number} round
 */
export const scriptRoundAt = (scriptTurn, round) => {
  if (scriptTurn === undefined) return undefined;
  let left = round;
  for (const scripted of scriptTurn.rounds) {
    const times = /** @type {number} */ (scripted.times ?? 1);
    if (left < times) return scripted;
    left -= times;
  }
  return undefined;
};
harden(scriptRoundAt);

/**
 * What the `context` line records of a request's system prompt (M2 W2.6):
 * its UTF-8 bytes and a 16-hex digest of its text, or nothing without one.
 * A staged prompt is read through the blob store first.
 * @param {string | undefined} system
 */
export const systemDigest = system =>
  system === undefined
    ? {}
    : {
        systemBytes: Buffer.byteLength(system),
        systemDigest: sha(system).slice(0, 16),
      };
harden(systemDigest);

/** @param {unknown} error */
const messageOf = error =>
  /** @type {Error} */ (error)?.message ?? String(error);

/**
 * The scripted kind's fixed reason for a round whose provider threw
 * (R4-79, HR-SYN-12): never the error's message.
 */
export const scriptedUnexpectedFailure = 'scripted provider failed';

/**
 * @param {object} options
 * @param {string} options.label the backend's label (`servedBy.label`)
 * @param {any} options.script a `shapes.Script`
 * @param {string} [options.logPath]
 * @param {import('../timers.js').Timers} options.timers
 * @param {import('./event-log.js').EventLog} [options.log] shared with the
 *   backend's tools
 * @param {import('../blobs.js').BlobStore} [options.blobs] M1b staging
 *   (without one, text over inlineBytes fails the round)
 * @param {() => number} [options.now]
 * @param {boolean} [options.logContext] W1b.2: log a `context` line per
 *   round (default: when `logPath` is given)
 */
export const makeScriptedProvider = ({
  label,
  script,
  logPath,
  timers,
  log = makeEventLog({ label, logPath }),
  blobs,
  now = () => Date.now(),
  logContext = logPath !== undefined,
}) => {
  /**
   * Stage a round's text without letting its handle out: the file stays
   * `<key>.part` until `commit` right before the message that carries it is
   * sent, so a crash or a cancel in between leaves nothing on disk (J-9361).
   * @param {string} text
   * @param {number} previewUnits
   * @param {any} owner the Session presence (its disk quota)
   */
  const stage = (text, previewUnits, owner) => {
    if (blobs === undefined) return Promise.reject(Error('no blob store'));
    return blobs.stagePending(text, { previewUnits, owner });
  };
  /**
   * Name the pending files among `staged` before sending them.
   * @param {ReadonlyArray<any>} staged
   */
  const commit = staged => blobs?.commit(staged) ?? Promise.resolve();
  /**
   * Delete the files among `staged` that were never committed.
   * @param {ReadonlyArray<any>} staged
   */
  const drop = staged => {
    void blobs?.drop(staged).catch(() => 0);
  };
  /**
   * Log after this turn of the event loop, with the `at` of the moment it
   * happened, so the fsync delays nothing on the turn's path (the `delta`
   * and `round-start` lines that perf reads). A late write that fails (the
   * log removed meanwhile) is dropped: it must not take the adapter down.
   * @param {import('./event-log.js').EventLog} write
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
   * W1b.2's `context` line: what the provider would have received this
   * round (M8: a compacted round's, after the compaction).
   * @param {any} req a RoundRequest
   * @param {any} owner
   * @param {any} projection
   * @param {number} ms the prepare's time
   */
  const logContextOf = async (req, owner, projection, ms) => {
    const where = { turnId: req.turnId, round: req.round };
    const { transcript, timing } = projection;
    // M2 W2.6: the system prompt the request carries (seam 1), in full.
    // M5 (W5.3, S2, H-9): a two-part system (the prompt and the turn's
    // R4-29 line) is read part by part and digested joined with a blank
    // line, as round.js `systemTextOf` joins it (not imported: round.js
    // imports this module).
    /** @type {string | undefined} */
    let system;
    if (req.system !== undefined) {
      /** @type {(string | undefined)[]} */
      const parts = [];
      for (const part of [req.system].flat()) {
        parts.push(
          isStaged(part)
            ? // eslint-disable-next-line no-await-in-loop -- at most two parts
              await blobs?.read(part.blob, owner).catch(() => undefined)
            : part,
        );
      }
      if (parts.every(part => typeof part === 'string')) {
        system = parts.join('\n\n');
      }
    }
    // M2 W2.9 (acceptance 15, m2-interfaces.md 4.13): a perf run that
    // measures per-turn cost at length creates `<logPath>.nodigest`; the
    // line then carries the timing only, so digesting the whole
    // transcript every round (which grows with the session) is not in
    // the measurement. Default (no such file): unchanged.
    const digests = logPath === undefined || !existsSync(`${logPath}.nodigest`);
    // Digested off the round's path, as `later` does for its lines.
    timers.after(0, () => {
      try {
        log('context', {
          ...where,
          ms,
          ...(digests ? contextDigests(transcript) : {}),
          ...systemDigest(system),
          ...(timing === undefined
            ? {}
            : {
                timing: Object.fromEntries(
                  Object.entries(timing).map(([k, v]) => [
                    k,
                    Math.round(v * 10) / 10,
                  ]),
                ),
              }),
        });
      } catch {
        // Dropped.
      }
    });
  };

  /**
   * @param {any} req a RoundRequest
   * @param {any} channel
   * @param {import('./round.js').RoundControl} control
   * @param {((next?: any) => Promise<any>) | undefined} prepare (M8:
   *   called again after a compaction)
   * @param {any} owner the Session presence served (its disk quota)
   */
  const runRound = async (req, channel, control, prepare, owner) => {
    const { turn, sink, turnId, round } = req;
    const where = { turnId, round };
    later(log, 'round-start', { ...where, at: now() });
    const cancelled = () => {
      if (control.stopped() === 'cancel') log('cancelled', where);
    };
    /** @type {any} */
    let projection;
    let ms = 0;
    if (prepare !== undefined) {
      const t0 = now();
      try {
        projection = await prepare();
      } catch (error) {
        if (isAbandoned(error)) {
          log('context-abandoned', { ...where, error: messageOf(error) });
          return;
        }
        log('context-failed', { ...where, error: messageOf(error) });
        if (control.stopped() !== undefined) {
          cancelled();
          return;
        }
        E.sendOnly(sink).roundFailed(
          failure(round, textOf.stagingFailed(messageOf(error))),
        );
        return;
      }
      ms = now() - t0;
      // M8 (S-16): a round that compacts logs the context it streams.
      if (logContext && req.compaction === undefined) {
        await logContextOf(req, owner, projection, ms);
      }
      if (control.stopped() !== undefined) {
        cancelled();
        return;
      }
    }
    let scriptTurn;
    if (round === 0) {
      const first = req.append.findLast(
        (/** @type {any} */ r) =>
          r.kind === 'turn-started' && r.turnId === turnId,
      );
      let input = projection?.input ?? first?.input;
      if (isStaged(input)) {
        // The script matches on the full text, read in process.
        input = await blobs?.read(input.blob, owner).catch(() => undefined);
      }
      scriptTurn = chooseTurn(input);
      if (scriptTurn !== undefined) chosen.set(turn, scriptTurn);
    } else {
      scriptTurn = chosen.get(turn);
    }
    const scripted = scriptRoundAt(scriptTurn, round);
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
    // M8 (m8-interfaces.md 5.1, S-16, D-M8-13): a compaction ask is
    // answered with the scripted summary and no usage, consuming no
    // script round.
    if (req.compaction !== undefined) {
      /** @param {unknown} error */
      const failureOf = error =>
        isProviderFailure(error)
          ? /** @type {any} */ (error).reason
          : scriptedUnexpectedFailure;
      const step = await systemTextOf(req.system, blobs, owner).then(
        system =>
          compactBeforeRound({
            req,
            projection,
            stream: async function* scriptedSummaryStream() {
              yield { delta: scriptedSummary };
            },
            control,
            prepare,
            blobs,
            owner,
            log,
            now,
            system,
            failureOf,
          }),
        error => harden({ failed: failureOf(error) }),
      );
      if ('abandon' in step) {
        cancelled();
        return;
      }
      if ('failed' in step) {
        log('round-failed', where);
        E.sendOnly(sink).roundFailed(failure(round, step.failed));
        return;
      }
      projection = step.projection;
      if (logContext && projection !== undefined) {
        await logContextOf(req, owner, projection, ms);
      }
    }
    log('request', where);
    /** @type {string[]} */
    const parts = [];
    let textBytes = 0;
    // Progress checkpoints (contract 3.2): one staging in flight at a time.
    let checkpointBytes = 0;
    let checkpointAt = now();
    /** bytes staged by this round's checkpoints (M1b QC, J-0393) */
    let checkpointWritten = 0;
    /** @type {{ bytes: number, staged: any } | undefined} */
    let lastCheckpoint;
    /** @type {Promise<void> | undefined} */
    let checkpointing;
    /** the checkpoint the session holds (it said so), if any */
    /** @type {any} */
    let heldCheckpoint;
    const checkpoint = () => {
      const whole = parts.join('');
      const bytes = textBytes;
      checkpointBytes = bytes;
      checkpointAt = now();
      checkpointWritten += bytes;
      checkpointing = stage(whole, limits.messagePreviewUnits, owner).then(
        async partial => {
          if (control.stopped() !== undefined) {
            checkpointing = undefined;
            drop([partial]);
            return undefined;
          }
          try {
            await commit([partial]);
          } catch (error) {
            checkpointing = undefined;
            drop([partial]);
            log('progress-failed', { ...where, error: messageOf(error) });
            return undefined;
          }
          checkpointing = undefined;
          lastCheckpoint = { bytes, staged: partial };
          log('progress', { ...where, units: whole.length });
          // Answered (J-0393): once the session kept this checkpoint it no
          // longer holds the previous one, whose file is deleted. A refusal
          // or a break keeps every file (the session may still hold it).
          // The next checkpoint waits for this answer (one in flight).
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
      const text =
        chunk.keys !== undefined
          ? generatedKeys(chunk.keys)
          : chunk.text.repeat(chunk.repeat ?? 1);
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
          publishedAt - checkpointAt >= limits.progressEveryMs) &&
        // Linear bytes written (J-0393): skip while earlier checkpoints of
        // this round already staged (factor - 1) x the text so far.
        checkpointWritten <= (limits.progressWriteFactor - 1) * textBytes
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
    if (
      heldCheckpoint !== undefined &&
      lastCheckpoint !== undefined &&
      lastCheckpoint.bytes !== textBytes &&
      control.stopped() === undefined
    ) {
      // The session holds an older checkpoint: make the whole text the last
      // one, so the reply reuses it and the older file is deleted when the
      // session keeps it (no checkpoint is left on disk unreferenced after
      // the round; J-0393). One more session crank, only for streamed
      // rounds that checkpointed.
      checkpoint();
      await checkpointing;
    }
    /** @param {number} previewUnits */
    const stageText = previewUnits =>
      lastCheckpoint !== undefined && lastCheckpoint.bytes === textBytes
        ? Promise.resolve(lastCheckpoint.staged)
        : stage(text, previewUnits, owner);
    if (scripted.error !== undefined) {
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
      E.sendOnly(sink).roundFailed(failure(round, scripted.error, partial));
      return;
    }
    /** @type {Array<{ callId: string, name: string, args: any }>} */
    // `times` repeats a scripted call (W1b.6: the 300-call too-big probe).
    const scriptedCalls = (scripted.toolCalls ?? []).flatMap(
      (/** @type {any} */ call) => Array(call.times ?? 1).fill(call),
    );
    const calls = scriptedCalls.map((/** @type {any} */ call) => ({
      callId: call.callId ?? '',
      name: call.name,
      /** @type {any} */
      args:
        call.args ??
        (call.code !== undefined
          ? JSON.stringify({
              code: call.code.text.repeat(call.code.repeat ?? 1),
            })
          : call.argsFreshKeys !== undefined
            ? JSON.stringify({ text: generatedKeys(call.argsFreshKeys) })
            : call.argsKeys
              ? generatedArgs(call.argsKeys)
              : '{}'),
    }));
    /** @type {any} */
    let result;
    /** What this round staged for its result (pending until sent). */
    /** @type {any[]} */
    const roundStaged = [];
    try {
      if (calls.length > limits.maxCallsPerMessage) {
        throw Error(texts.frameLimit);
      }
      result = await stageResult({
        round,
        text,
        textBytes,
        calls,
        stageText,
        stage: (whole, previewUnits) => stage(whole, previewUnits, owner),
        nativeContext: scripted.nativeContext,
        usage: scripted.usage ?? emptyUsage(),
        servedBy: { label, modelId: req.options.modelId },
        now,
        staged: roundStaged,
      });
      if (control.stopped() === undefined) await commit(roundStaged);
    } catch (error) {
      // Nothing of this round was sent: its pending files go (J-9361).
      drop(roundStaged);
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
      drop(roundStaged);
      cancelled();
      return;
    }
    log('round-final', where);
    E.sendOnly(sink).roundFinal(result);
  };

  // `prepare` is the context cache (W1b.2; optional here: M1a's tests run
  // rounds without one); `owner` the Session presence the round serves
  // (blob quota and provenance, J-9361).
  return makeProviderShell({ timers, runRound });
};
harden(makeScriptedProvider);

/** The `backendKinds` entry (`kinds.js`): M1a's test double; offers echo. */
export const scriptedKind = harden({
  kind: 'scripted',
  makeProvider: makeScriptedProvider,
  tools: ['echo'],
  unexpectedFailure: scriptedUnexpectedFailure,
  /** @type {import('./kinds.js').BackendKind['catalog']} */
  catalog: ({ models }) => models,
});
