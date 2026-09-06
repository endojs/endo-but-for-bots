// @ts-check
/* eslint-disable no-await-in-loop */

// Floot consumes this provider-neutral stream contract; Codex-specific JSON-RPC
// names and item schemas stay behind @endo/codex-sandbox's capability boundary.

import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

// Stands in for a result the backend never reported. Persisted as the tool
// message's content, so the transcript says what happened instead of carrying
// an empty result that reads as a tool still running.
export const UNREPORTED_TOOL_RESULT =
  'The backend completed the turn without reporting a result for this tool call.';
harden(UNREPORTED_TOOL_RESULT);

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
    return harden({ finalContent: '', usage: undefined, toolCalls: [] });
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
        const failure = new AggregateError(
          [error],
          `Hosted turn cancellation failed: ${details}`,
        );
        failure.name = 'HostedTurnCancellationError';
        throw failure;
      }
    })();
    cancellationP.then(resolveAbort, rejectAbort);
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
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
      return harden({ finalContent: '', usage: undefined, toolCalls: [] });
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
          throw Error(`${event.reason || 'hosted turn aborted'}`);
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
          if (signal?.aborted && cancellationP) await cancellationP;
          return harden({
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
  }
  if (!signal?.aborted)
    throw Error('hosted turn ended without a terminal event');
  if (cancellationP) await cancellationP;
  return harden({
    finalContent,
    usage,
    toolCalls: toolCalls.map(call => harden({ ...call })),
    ...(checkpoint ? { checkpoint } : {}),
  });
};
harden(runHostedTurn);
