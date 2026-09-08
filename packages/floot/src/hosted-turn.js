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
 * @typedef {object} HostedTurnPartial
 * @property {boolean} delivered - whether the backend took the prompt at all:
 *   anything it emitted before a terminal means it did; a spawn refusal or a
 *   stop before dispatch arrives as a leading abort.
 * @property {string} finalContent - the reply text that streamed.
 * @property {Array<{ id: string, name: string, args: string, result: string | null }>} toolCalls
 *   - the tool activity that streamed (`result` is null for a call the turn
 *   ended before settling).
 */

/**
 * Fail a turn with what the backend already did with it. A backend whose
 * continuity is its own transcript keeps the delivered prompt and whatever
 * streamed before the failure, so the caller mirrors those instead of dropping
 * a turn the model still remembers.
 *
 * @param {string} reason
 * @param {HostedTurnPartial} partial
 * @returns {Error}
 */
const failTurn = (reason, partial) => {
  const error = Error(reason);
  Object.defineProperty(error, 'hostedTurn', {
    value: harden({
      delivered: partial.delivered,
      finalContent: partial.finalContent,
      toolCalls: partial.toolCalls.map(call => harden({ ...call })),
    }),
    enumerable: false,
  });
  return error;
};

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
 * @param {{ client: any, text: string, writer: any, signal?: AbortSignal, model?: string, reasoningEffort?: string, systemPrompt?: string, acknowledgedCheckpoint?: string }} options
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
}) => {
  if (signal?.aborted) {
    return harden({
      delivered: false,
      finalContent: '',
      usage: undefined,
      toolCalls: [],
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
  let finalContent = '';
  let checkpoint;
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
          writer.delta(textDelta);
          break;
        }
        case 'commentary-delta':
          // Floot's delta channel is spoken and persisted as answer text. Keep
          // Codex progress out of that channel until Floot has a distinct,
          // non-TTS commentary event.
          break;
        case 'tool-call':
          writer.setPhase('using tools');
          {
            const call = {
              id: `${event.id || ''}`,
              name: `${event.name || 'tool'}`,
              args: `${event.args || ''}`,
              result: null,
            };
            toolCalls.push(call);
            callsById.set(call.id, call);
            writer.toolCall(call);
          }
          break;
        case 'tool-result': {
          const result = `${event.result || ''}`;
          const call = callsById.get(`${event.id || ''}`);
          if (call) call.result = result;
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
          throw failTurn(`${event.reason || 'hosted turn aborted'}`, {
            delivered,
            finalContent,
            toolCalls,
          });
        case 'end':
          checkpoint =
            typeof event.checkpoint === 'string' && event.checkpoint !== ''
              ? event.checkpoint
              : undefined;
          // A tool the backend started and never reported on would otherwise
          // sit in the transcript looking permanently in progress: the live
          // view keeps it pending and the persisted history records an empty
          // result. Settle it explicitly, on both.
          for (const call of toolCalls) {
            if (call.result === null) {
              call.result = UNREPORTED_TOOL_RESULT;
              writer.toolResult({
                id: call.id,
                name: call.name,
                result: call.result,
              });
            }
          }
          return harden({
            delivered,
            finalContent,
            usage,
            toolCalls: toolCalls.map(call => harden({ ...call })),
            ...(checkpoint ? { checkpoint } : {}),
          });
        default:
        // Forward compatibility: unknown normalized event kinds are ignored.
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    // Transport failures must not release the turn while interruption is pending.
    // A failed barrier takes precedence so the session can quarantine itself.
    if (cancellationP) await cancellationP;
  }
  if (!signal?.aborted) {
    throw failTurn('hosted turn ended without a terminal event', {
      delivered,
      finalContent,
      toolCalls,
    });
  }
  return harden({
    delivered,
    finalContent,
    usage,
    toolCalls: toolCalls.map(call => harden({ ...call })),
    ...(checkpoint ? { checkpoint } : {}),
  });
};
harden(runHostedTurn);
