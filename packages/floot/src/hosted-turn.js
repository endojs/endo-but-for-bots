// @ts-check

// Floot consumes this provider-neutral stream contract; Codex-specific JSON-RPC
// names and item schemas stay behind @endo/codex-sandbox's capability boundary.

import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

/**
 * @param {{ client: any, text: string, writer: any, signal?: AbortSignal, model?: string, reasoningEffort?: string, systemPrompt?: string }} options
 */
export const runHostedTurn = async ({
  client,
  text,
  writer,
  signal,
  model,
  reasoningEffort,
  systemPrompt,
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
      let closeFailure;
      if (iterator) {
        try {
          await iterator.return();
        } catch (error) {
          closeFailure = error;
        }
      }
      // Reader close initiates cancellation, but its local return can settle
      // before a remote Codex turn reaches terminal confirmation. The explicit
      // barrier keeps Floot's serialized turn chain occupied until it is safe
      // to accept the next prompt.
      await E(client).interrupt();
      if (closeFailure) throw closeFailure;
    })();
    cancellationP.then(resolveAbort, rejectAbort);
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let finalContent = '';
  /** @type {{ inputTokens: number, outputTokens: number } | undefined} */
  let usage;
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
    for await (const rawEvent of iterator) {
      const event = /** @type {any} */ (rawEvent);
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
          if (signal?.aborted && cancellationP) await cancellationP;
          return harden({
            finalContent,
            usage,
            toolCalls: toolCalls.map(call => harden({ ...call })),
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
  });
};
harden(runHostedTurn);
