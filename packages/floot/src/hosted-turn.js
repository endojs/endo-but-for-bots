// @ts-check
/* eslint-disable no-await-in-loop */

// Floot consumes this provider-neutral stream contract; Codex-specific JSON-RPC
// names and item schemas stay behind @endo/codex-sandbox's capability boundary.

import { makeError } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

// Stands in for a result the backend never reported. Persisted as the tool
// message's content, so the transcript says what happened instead of carrying
// an empty result that reads as a tool still running.
export const UNREPORTED_TOOL_RESULT =
  'The backend completed the turn without reporting a result for this tool call.';
harden(UNREPORTED_TOOL_RESULT);

// Stands in for the result of a tool the turn was stopped, or failed, before it
// reported on. Persisted when a transcript backend's partial turn is mirrored,
// so the record says why the result is missing.
export const UNSETTLED_TOOL_RESULT =
  'The turn ended before this tool call reported a result.';
harden(UNSETTLED_TOOL_RESULT);

/**
 * One interleaving-preserving slice of a hosted turn: assistant text, or a
 * round of tool calls with their results. The transcript is rebuilt from these
 * in order, so text that preceded a tool call stays before it instead of
 * being concatenated onto the final answer.
 *
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'tools', calls: Array<{ id: string, name: string, args: string, result: string | null }> }} HostedTurnSegment
 */

/**
 * @typedef {object} HostedTurnPartial
 * @property {boolean} delivered - whether the backend took the prompt at all:
 *   anything it emitted before a terminal means it did; a spawn refusal or a
 *   stop before dispatch arrives as a leading abort.
 * @property {boolean} [outcomeUnknown] - transport failure may hide external effects.
 * @property {string} finalContent - the reply text that streamed.
 * @property {{ inputTokens: number, outputTokens: number } | undefined} usage
 * @property {Array<{ id: string, name: string, args: string, result: string | null }>} toolCalls
 *   - the tool activity that streamed (`result` is null for a call the turn
 *   ended before settling).
 * @property {HostedTurnSegment[]} [segments] - `finalContent` and `toolCalls`
 *   in stream order, for callers that persist the transcript.
 */

/**
 * Fail a turn with what the backend already did with it. A backend whose
 * continuity is its own transcript keeps the delivered prompt and whatever
 * streamed before the failure, so the caller mirrors those instead of dropping
 * a turn the model still remembers.
 *
 * @param {string} reason
 * @param {HostedTurnPartial} partial
 * @param {Error} [error]
 * @returns {Error}
 */
const failTurn = (reason, partial, error = Error(reason)) => {
  Object.defineProperty(error, 'hostedTurn', {
    value: harden({
      delivered: partial.delivered,
      ...(partial.outcomeUnknown ? { outcomeUnknown: true } : {}),
      finalContent: partial.finalContent,
      usage: partial.usage,
      toolCalls: partial.toolCalls.map(call => harden({ ...call })),
      ...(partial.segments
        ? { segments: freezeSegments(partial.segments) }
        : {}),
    }),
    enumerable: false,
  });
  return error;
};

/**
 * Copy a mutable segment list into a hardened, self-contained value. Call
 * objects are shared with the caller's `toolCalls`, so copy before freezing.
 *
 * @param {HostedTurnSegment[]} segments
 * @returns {HostedTurnSegment[]}
 */
const freezeSegments = segments =>
  harden(
    segments.map(segment =>
      segment.type === 'text'
        ? harden({ type: 'text', text: segment.text })
        : harden({
            type: 'tools',
            calls: segment.calls.map(call => harden({ ...call })),
          }),
    ),
  );

/**
 * What a failed hosted turn had already done, when the error came from
 * `runHostedTurn`; `undefined` for any other error (the prompt never reached
 * the backend).
 *
 * @param {unknown} error
 * @returns {HostedTurnPartial | undefined}
 */
export const hostedTurnPartialOf = error =>
  error && typeof error === 'object' && 'hostedTurn' in error
    ? /** @type {any} */ (error).hostedTurn
    : undefined;
harden(hostedTurnPartialOf);

/**
 * @param {{ client: any, text: string, writer: any, signal?: AbortSignal, model?: string, reasoningEffort?: string, systemPrompt?: string, acknowledgedCheckpoint?: string, continuityContext?: string, continuityContextUnavailable?: string, recordToolEvent?: (event: any) => Promise<void> }} options
 */
export const runHostedTurn = async ({
  client,
  text,
  writer,
  signal,
  model,
  reasoningEffort,
  systemPrompt,
  acknowledgedCheckpoint,
  continuityContext,
  continuityContextUnavailable,
  recordToolEvent,
}) => {
  const recordObservedTool = async event => {
    if (!recordToolEvent) return;
    await recordToolEvent(event);
  };
  if (signal?.aborted) {
    return harden({
      delivered: false,
      finalContent: '',
      usage: undefined,
      toolCalls: [],
      segments: harden([]),
    });
  }
  /** @type {ReturnType<typeof iterateReader> | undefined} */
  let iterator;
  /** @type {() => void} */
  let resolveAbort = () => {};
  /** @type {(reason?: any) => void} */
  let rejectAbort = () => {};
  /** @type {Promise<void> | undefined} */
  let cancellationP;
  const abortP = new Promise((resolve, reject) => {
    resolveAbort = () => resolve('aborted');
    rejectAbort = reject;
  });
  const onAbort = () => {
    cancellationP = (async () => {
      await null;
      // Reader close initiates cancellation, but its local return can settle
      // before a remote Codex turn reaches terminal confirmation. The explicit
      // barrier keeps Floot's serialized turn chain occupied until it is safe
      // to accept the next prompt. Start both concurrently: a stream adapter is
      // allowed to withhold its terminal acknowledgement until the producer's
      // interrupt has completed.
      const closeP = iterator ? iterator.return() : Promise.resolve();
      // Keep a wedged reader observed. If the authoritative backend barrier
      // rejects, the enclosing session is quarantined and its slice owner must
      // reap the process; waiting forever for an untrusted stream ack would
      // hide that failure behind a generic shutdown timeout.
      closeP.catch(() => undefined);
      try {
        await E(client).interrupt();
        await closeP;
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        throw makeError(
          `Hosted turn cancellation failed: ${details}`,
          AggregateError,
          { errors: [error instanceof Error ? error : makeError(details)] },
        );
      }
    })();
    cancellationP.then(resolveAbort, rejectAbort);
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let delivered = false;
  let terminal = false;
  let finalContent = '';
  let checkpoint;
  /** @type {HostedTurnSegment[]} */
  const segments = [];
  let pendingText = '';
  const flushText = () => {
    if (pendingText.length === 0) return;
    segments.push({ type: 'text', text: pendingText });
    pendingText = '';
  };
  // Live progress: opencode (and Codex) stream long model reasoning as
  // commentary, which is deliberately kept out of the answer channel and the
  // transcript. Surface a throttled, bounded tail as a phase instead, so a
  // multi-minute turn is not silent in the UI.
  let lastCommentaryAt = 0;
  let commentaryTail = '';
  /** @type {{ inputTokens: number, outputTokens: number } | undefined} */
  let usage;
  /** @type {Array<{ id: string, name: string, args: string, result: string | null }>} */
  const toolCalls = [];
  const callsById = new Map();
  await null;
  try {
    const readerP = E(client).send(
      text,
      harden({
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(acknowledgedCheckpoint ? { acknowledgedCheckpoint } : {}),
        ...(continuityContext === undefined ? {} : { continuityContext }),
        ...(continuityContextUnavailable
          ? { continuityContextUnavailable }
          : {}),
      }),
    );
    const outcome = signal
      ? await Promise.race([
          readerP.then(reader => ({ reader })),
          abortP.then(() => ({ aborted: true })),
        ])
      : { reader: await readerP };
    if ('aborted' in outcome) {
      return harden({
        delivered: false,
        finalContent: '',
        usage: undefined,
        toolCalls: [],
        segments: harden([]),
      });
    }
    iterator = iterateReader(/** @type {any} */ (outcome.reader));
    for (;;) {
      const nextP = iterator.next();
      const nextOutcome = signal
        ? await Promise.race([
            nextP.then(result => ({ result })),
            abortP.then(() => ({ aborted: true })),
          ])
        : { result: await nextP };
      if ('aborted' in nextOutcome) break;
      if (nextOutcome.result.done) break;
      const event = /** @type {any} */ (nextOutcome.result.value);
      // Anything the backend emits before a terminal means it took the prompt;
      // a spawn refusal or a stop before dispatch arrives as a leading abort.
      if (event?.type !== 'abort') delivered = true;
      switch (event?.type) {
        case 'phase':
          writer.setPhase(`${event.phase || 'thinking'}`);
          break;
        case 'text-delta': {
          const textDelta = `${event.text || ''}`;
          finalContent += textDelta;
          pendingText += textDelta;
          writer.delta(textDelta);
          break;
        }
        case 'commentary-delta': {
          // Floot's delta channel is spoken and persisted as answer text. Keep
          // Codex progress out of that channel until Floot has a distinct,
          // non-TTS commentary event; a bounded phase tail is live-only.
          commentaryTail = `${commentaryTail}${event.text || ''}`.slice(-160);
          const now = Date.now();
          if (now - lastCommentaryAt >= 1000) {
            lastCommentaryAt = now;
            const tail = commentaryTail.replace(/\s+/g, ' ').trim();
            if (tail) writer.setPhase(`thinking: ${tail}`);
          }
          break;
        }
        case 'tool-call':
          writer.setPhase('using tools');
          {
            flushText();
            const call = {
              id: `${event.id || ''}`,
              name: `${event.name || 'tool'}`,
              args: `${event.args || ''}`,
              result: null,
            };
            if (!call.id || callsById.has(call.id))
              throw Error('Hosted tool call requires a unique nonempty ID');
            toolCalls.push(call);
            callsById.set(call.id, call);
            const lastSegment = segments[segments.length - 1];
            if (lastSegment?.type === 'tools') {
              lastSegment.calls.push(call);
            } else {
              segments.push({ type: 'tools', calls: [call] });
            }
            await recordObservedTool({
              type: 'observed-tool-call',
              callId: call.id,
              name: call.name,
              args: call.args,
            });
            writer.toolCall(call);
          }
          break;
        case 'tool-result': {
          const result = `${event.result || ''}`;
          const call = callsById.get(`${event.id || ''}`);
          if (!call || call.result !== null)
            throw Error('Hosted tool result has no unsettled matching call');
          if (call) call.result = result;
          if (call)
            await recordObservedTool({
              type: 'observed-tool-result',
              callId: call.id,
              result,
            });
          writer.toolResult({
            id: `${event.id || ''}`,
            name: `${event.name || 'tool'}`,
            result,
          });
          break;
        }
        case 'usage':
          // App-server reports `tokenUsage.last` once per model call. An
          // agentic turn can make several model calls around tool use, so the
          // provider-neutral turn total is the sum of these updates.
          if (!usage) usage = { inputTokens: 0, outputTokens: 0 };
          usage.inputTokens += Number(event.inputTokens) || 0;
          usage.outputTokens += Number(event.outputTokens) || 0;
          break;
        case 'abort':
          terminal = true;
          flushText();
          throw failTurn(`${event.reason || 'hosted turn aborted'}`, {
            delivered,
            finalContent,
            usage,
            toolCalls,
            segments,
          });
        case 'end':
          checkpoint =
            typeof event.checkpoint === 'string' && event.checkpoint !== ''
              ? event.checkpoint
              : undefined;
          // Close the UI placeholder, but retain the missing result in the
          // partial record. A terminal with unresolved tools is not success.
          for (const call of toolCalls) {
            if (call.result === null) {
              writer.toolResult({
                id: call.id,
                name: call.name,
                result: UNREPORTED_TOOL_RESULT,
              });
            }
          }
          if (toolCalls.some(call => call.result === null)) {
            throw Error('hosted turn ended with unsettled tool calls');
          }
          terminal = true;
          flushText();
          return harden({
            delivered,
            finalContent,
            usage,
            toolCalls: toolCalls.map(call => harden({ ...call })),
            segments: freezeSegments(segments),
            ...(checkpoint ? { checkpoint } : {}),
          });
        default:
        // Forward compatibility: unknown normalized event kinds are ignored.
      }
    }
    if (!signal?.aborted) {
      throw Error('hosted turn ended without a terminal event');
    }
  } catch (error) {
    // EOF, broken readers, and failed durable recording are not producer stop
    // barriers. Keep the turn occupied until interruption is confirmed.
    if (!terminal && !cancellationP) {
      try {
        await E(client).interrupt();
      } catch {
        flushText();
        throw failTurn(
          'Hosted turn cancellation failed: producer stop was not confirmed',
          { delivered, finalContent, usage, toolCalls, segments },
        );
      }
    }
    flushText();
    throw failTurn(error instanceof Error ? error.message : String(error), {
      delivered,
      ...(!terminal ? { outcomeUnknown: true } : {}),
      finalContent,
      usage,
      toolCalls,
      segments,
    });
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    // Transport failures must not release the turn while interruption is pending.
    // A failed barrier takes precedence so the session can quarantine itself.
    if (cancellationP) {
      try {
        await cancellationP;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Unconfirmed producer stop deliberately overrides every turn outcome.
        flushText();
        // eslint-disable-next-line no-unsafe-finally
        throw failTurn(
          reason,
          { delivered, finalContent, usage, toolCalls, segments },
          new AggregateError([error], reason),
        );
      }
    }
  }
  // The signal-abort path breaks out of the loop without a terminal event;
  // flush any text that streamed after the last tool round so the mirrored
  // partial keeps it.
  flushText();
  return harden({
    delivered,
    finalContent,
    usage,
    toolCalls: toolCalls.map(call => harden({ ...call })),
    segments: freezeSegments(segments),
    ...(checkpoint ? { checkpoint } : {}),
  });
};
harden(runHostedTurn);
