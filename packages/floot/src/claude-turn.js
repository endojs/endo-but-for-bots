// @ts-check
// One Floot turn against a ClaudeClient capability (@endo/claude-sandbox):
// send the user text with `E(client).send(prompt)`, consume the returned
// buffered reply reader with `iterateReader`, and translate the raw
// `claude -p --output-format stream-json` events into Floot's normalized
// ReplyEvent writer calls (src/stream.js).
//
// The CLI runs its own agentic loop inside the sandbox — tools execute there,
// and conversation continuity lives in the sandboxed workspace (`--continue`).
// So unlike the API provider path (agent.js's tool-round loop), a Claude-CLI
// turn is a single send: Floot's tool loop, tool discovery, and
// conversation-context assembly are all bypassed, and the events streamed back
// (text, tool_use, tool_result, result) are translated for display and durable
// observation. Observing a native tool is not authorization before execution.
//
// Abort: when the turn is cancelled (UI Stop / barge-in, via
// `FlootTurn.cancel`), `signal` aborts; we close the CLI reader in response,
// which requests termination of the in-flight `claude -p` process. The legacy
// interface does not confirm process exit, so cancellation remains unknown.

import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

const partialTurns = new WeakMap();

/** Recover observed text, usage and native tool records after a failed turn.
 * @param {unknown} error
 */
export const claudeTurnPartialOf = error =>
  error && typeof error === 'object' ? partialTurns.get(error) : undefined;
harden(claudeTurnPartialOf);

/**
 * Render a claude tool_result content payload as plain text. The CLI emits
 * either a string or an array of content blocks ({ type: 'text', text }).
 *
 * @param {unknown} content
 * @returns {string}
 */
const renderToolResultText = content => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block =>
        block && typeof block === 'object' && 'text' in block
          ? `${/** @type {{ text: unknown }} */ (block).text}`
          : '',
      )
      .join('');
  }
  return content === undefined ? '' : JSON.stringify(content);
};

/**
 * Stateful translator from raw `claude -p` stream-json events to Floot
 * ReplyEvent writer calls. Exported for unit testing; `runClaudeTurn` drives
 * it against a live reader.
 *
 * @param {object} writer - makeReplyChannel writer
 *   (setPhase/delta/toolCall/toolResult/usage/final/end/abort callers own
 *   final/usage/end — the translator only reports; see finish()).
 * @returns {{
 *   handle: (event: any) => void,
 *   finish: () => {
 *     finalText: string,
 *     usage: { inputTokens: number, outputTokens: number } | undefined,
 *     errorReason: string | undefined,
 *   },
 * }}
 */
export const makeClaudeEventTranslator = writer => {
  const w = /** @type {any} */ (writer);
  // claude's tool_result events carry only tool_use_id; remember each
  // tool_use's name so the paired result can be labeled for the UI.
  /** @type {Map<string, string>} */
  const toolNames = new Map();
  // Text streamed across assistant events. The `result` event's summary text
  // takes precedence when present (it is the CLI's own notion of the final
  // answer for the turn).
  let streamed = '';
  /** @type {string | undefined} */
  let resultText;
  /** @type {string | undefined} */
  let errorReason;
  /** @type {{ inputTokens: number, outputTokens: number } | undefined} */
  let usage;
  // With `--include-partial-messages`, text arrives first as Anthropic
  // content-block deltas and is repeated in the complete assistant event(s)
  // for the same message (the CLI emits one assistant record per content
  // block). Remember which messages streamed — by the id `message_start`
  // announces and assistant records carry — so the UI/TTS branches receive
  // each character exactly once whatever order the records interleave in (a
  // thinking-only record between a message's deltas and its text record, say).
  // The boolean is the fallback for a wire without message ids.
  /** @type {string | undefined} */
  let streamingMessageId;
  /** @type {Set<string>} */
  const streamedMessageIds = new Set();
  let streamedCurrentAssistant = false;

  const handle = event => {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'system': {
        // Lifecycle diagnostics (subtype 'init' etc.) — surface as a phase so
        // the UI shows sandbox startup instead of dead air.
        if (event.subtype === 'init') w.setPhase('claude session starting');
        break;
      }
      case 'stream_event': {
        const streamEvent = event.event;
        if (streamEvent?.type === 'message_start') {
          const id = streamEvent.message?.id;
          streamingMessageId = typeof id === 'string' ? id : undefined;
          streamedCurrentAssistant = false;
        } else if (
          streamEvent?.type === 'content_block_delta' &&
          streamEvent.delta?.type === 'text_delta' &&
          streamEvent.delta.text
        ) {
          const text = `${streamEvent.delta.text}`;
          streamed += text;
          if (streamingMessageId !== undefined) {
            streamedMessageIds.add(streamingMessageId);
          }
          streamedCurrentAssistant = true;
          w.delta(text);
        }
        break;
      }
      case 'assistant': {
        const blocks = event.message?.content;
        if (!Array.isArray(blocks)) break;
        const messageId = event.message?.id;
        const alreadyStreamed =
          typeof messageId === 'string'
            ? streamedMessageIds.has(messageId)
            : streamedCurrentAssistant;
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) {
            if (!alreadyStreamed) {
              streamed += `${block.text}`;
              w.delta(`${block.text}`);
            }
          } else if (block?.type === 'tool_use') {
            const id = `${block.id || ''}`;
            const name = `${block.name || 'tool'}`;
            toolNames.set(id, name);
            w.toolCall({ id, name, args: JSON.stringify(block.input ?? {}) });
          }
        }
        streamedCurrentAssistant = false;
        break;
      }
      case 'user': {
        // Tool results echo back as user-role events in the stream-json wire.
        const blocks = event.message?.content;
        if (!Array.isArray(blocks)) break;
        for (const block of blocks) {
          if (block?.type === 'tool_result') {
            const id = `${block.tool_use_id || ''}`;
            w.toolResult({
              id,
              name: toolNames.get(id) || 'tool',
              result: renderToolResultText(block.content),
            });
          }
        }
        break;
      }
      case 'result': {
        if (typeof event.result === 'string' && event.result !== '') {
          resultText = event.result;
        }
        if (event.usage && typeof event.usage === 'object') {
          usage = {
            inputTokens: Number(event.usage.input_tokens) || 0,
            outputTokens: Number(event.usage.output_tokens) || 0,
          };
        }
        if (event.is_error) {
          // A failed turn (subtype error_max_turns / error_during_execution,
          // or a claude-side error) must not read as success: `result` is
          // often absent on these, so the turn would otherwise finish with
          // whatever text happened to stream and be persisted as a normal
          // assistant reply. Record it; runClaudeTurn raises it.
          errorReason =
            resultText ||
            (typeof event.subtype === 'string' && event.subtype) ||
            'claude reported an error';
        }
        break;
      }
      default:
      // Unknown event types (future CLI versions) are ignored, not fatal.
    }
  };

  const finish = () =>
    harden({
      finalText: resultText !== undefined ? resultText : streamed,
      usage,
      errorReason,
    });

  return harden({ handle, finish });
};
harden(makeClaudeEventTranslator);

/**
 * Run one turn against a ClaudeClient: send the prompt, stream the reply
 * events through `writer`, and resolve with the final text and token usage
 * once the CLI turn completes.
 *
 * The reader's in-band terminals map to outcomes: `{ type: 'end' }` resolves
 * the turn; `{ type: 'abort', reason }` rejects it (the caller aborts the
 * writer). When `signal` fires first, the reader is closed — killing the
 * in-flight `claude -p` — and the turn resolves quietly with whatever text
 * had streamed (the caller checks `signal.aborted` to classify cancellation).
 *
 * @param {object} options
 * @param {any} options.client - ClaudeClient capability (may be remote).
 * @param {string} options.text - Assembled user message.
 * @param {object} options.writer - makeReplyChannel writer.
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.model] - Optional model override for this turn.
 * @param {(event: any) => Promise<void>} [options.recordToolEvent] Durable
 *   observation of native tools, awaited before the corresponding UI event.
 * @returns {Promise<{
 *   delivered: boolean,
 *   outcomeUnknown: boolean,
 *   finalContent: string,
 *   usage: { inputTokens: number, outputTokens: number } | undefined,
 *   toolCalls: Array<{ id: string, name: string, args: string, result: string | null }>,
 * }>}
 */
export const runClaudeTurn = async ({
  client,
  text,
  writer,
  signal,
  model,
  recordToolEvent,
}) => {
  const w = /** @type {any} */ (writer);
  const actions = [];
  const translator = makeClaudeEventTranslator({
    setPhase: value => actions.push({ method: 'setPhase', value }),
    delta: value => actions.push({ method: 'delta', value }),
    toolCall: value => actions.push({ method: 'toolCall', value }),
    toolResult: value => actions.push({ method: 'toolResult', value }),
  });
  const toolCalls = [];
  const callsById = new Map();
  let delivered = false;
  let outcomeUnknown = false;
  const partial = () => {
    const { finalText, usage } = translator.finish();
    return harden({
      delivered,
      outcomeUnknown,
      finalContent: finalText,
      usage,
      toolCalls: toolCalls.map(call => ({ ...call })),
    });
  };
  if (signal?.aborted) return partial();
  /** @type {ReturnType<typeof iterateReader> | undefined} */
  let iterator;
  let terminal = false;
  let stopping;
  const stopProducer = () => {
    if (!stopping) {
      // Legacy interrupt and reader return request termination, but neither
      // proves process exit. Preserve uncertainty even if both acknowledge.
      outcomeUnknown = true;
      stopping = (async () => {
        const close = iterator ? iterator.return() : Promise.resolve();
        const interrupt = E(client)
          .interrupt()
          .catch(error => {
            if (!(
              error instanceof Error &&
              /no in-flight prompt to interrupt/.test(error.message)
            ))
              throw error;
          });
        try {
          await Promise.all([close, interrupt]);
        } catch {
          throw Error(
            'Hosted turn cancellation failed: legacy Claude producer stop was not confirmed',
          );
        }
      })();
    }
    return stopping;
  };
  let resolveAbort = () => {};
  let rejectAbort = reason => {};
  const aborted = new Promise((resolve, reject) => {
    resolveAbort = () => resolve(undefined);
    rejectAbort = reject;
  });
  // The loop observes this rejection; keep it handled while persisting an
  // observation or awaiting a producer response.
  aborted.catch(() => {});
  const onAbort = () => {
    stopProducer().then(resolveAbort, rejectAbort);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    // A rejected remote send can mean that its response was lost after the
    // producer started. Keep both startup and its cancellation inside the
    // uncertain-outcome/stop lifecycle, not outside the protected block.
    const readerP = E(client)
      .send(text, model ? { model } : {})
      .then(reader => {
        const received = iterateReader(/** @type {any} */ (reader));
        if (stopping) {
          // Cancellation can win before send returns. Close a late reader too;
          // the already-recorded unknown outcome remains fenced even if this
          // eventual cleanup fails and cannot change the returned result.
          received.return().catch(() => {});
        }
        return received;
      });
    const startup = await Promise.race([
      readerP.then(received => ({ received })),
      aborted.then(() => ({ aborted: true })),
    ]);
    if ('aborted' in startup) return partial();
    const activeIterator = startup.received;
    iterator = activeIterator;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const next = await Promise.race([
        activeIterator.next(),
        aborted.then(() => ({ done: true, value: undefined })),
      ]);
      if (next.done) break;
      // stream-json events are opaque records on the wire; the translator is
      // the only place that knows their shape.
      const event = /** @type {any} */ (next.value);
      if (event?.type === 'end') {
        terminal = true;
        break;
      }
      if (event?.type === 'abort') {
        terminal = true;
        throw Error(`${event.reason || 'claude turn aborted'}`);
      }
      delivered = true;
      translator.handle(event);
      for (const { method, value } of actions.splice(0)) {
        if (method === 'toolCall') {
          if (!value.id || callsById.has(value.id)) {
            throw Error(
              'Claude native tool call has missing or duplicate identity',
            );
          }
          const call = { ...value, result: null };
          toolCalls.push(call);
          callsById.set(call.id, call);
          // Observation is not admission: Claude has already started this
          // native tool. A recording failure closes the reader/producer.
          // eslint-disable-next-line no-await-in-loop
          await recordToolEvent?.({
            type: 'observed-tool-call',
            callId: call.id,
            name: call.name,
            args: call.args,
          });
        } else if (method === 'toolResult') {
          const call = callsById.get(value.id);
          if (!call || call.result !== null) {
            throw Error(
              'Claude native tool result has unknown or settled identity',
            );
          }
          call.result = value.result;
          // eslint-disable-next-line no-await-in-loop
          await recordToolEvent?.({
            type: 'observed-tool-result',
            callId: call.id,
            result: call.result,
          });
        }
        w[method](value);
      }
    }
    if (stopping) await stopping;
    if (!terminal && !signal?.aborted) {
      throw Error(
        'Claude reader ended without a terminal event; outcome unknown',
      );
    }
    const { errorReason } = translator.finish();
    if (errorReason !== undefined && !signal?.aborted) {
      throw Error(`claude turn failed: ${errorReason}`);
    }
    if (!signal?.aborted && toolCalls.some(call => call.result === null)) {
      throw Error(
        'Claude turn ended with unsettled native tool calls; effects unknown',
      );
    }
    return partial();
  } catch (error) {
    let failure = error;
    if (!terminal || stopping) {
      try {
        await stopProducer();
      } catch (stopError) {
        failure = stopError;
      }
    }
    if (failure && typeof failure === 'object')
      partialTurns.set(failure, partial());
    throw failure;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
};
harden(runClaudeTurn);
