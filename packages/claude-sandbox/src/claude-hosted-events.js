// @ts-check
// Translate the raw `claude -p --output-format stream-json` events a
// ClaudeClient reply reader yields into the provider-neutral hosted turn events
// Floot's hosted-turn consumer understands:
//
//   { type: 'phase', phase }                  coarse status for the UI
//   { type: 'text-delta', text }              next chunk of assistant text
//   { type: 'tool-call', id, name, args }     a tool the CLI is invoking
//   { type: 'tool-result', id, name, result } that tool's output
//   { type: 'usage', ...counts, context? }     see @endo/hosted-agent/token-usage.js
//   { type: 'end' } | { type: 'abort', reason }
//
// Nothing Claude-specific crosses the hosted seam: Floot persists the tool
// activity and the final text from these events exactly as it does for any
// other hosted backend, and the CLI's own event vocabulary stays behind this
// package's capability boundary.

import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeHostedTurnChannel } from '@endo/hosted-agent/turn-channel.js';
import { projectContext, tokenCount } from '@endo/hosted-agent/token-usage.js';

/**
 * @typedef {(
 *   | { type: 'phase', phase: string }
 *   | { type: 'text-delta', text: string }
 *   | { type: 'tool-call', id: string, name: string, args: string }
 *   | { type: 'tool-result', id: string, name: string, result: string }
 *   | ({ type: 'usage' } & Partial<import('@endo/hosted-agent/token-usage.js').TokenUsage>)
 *   | { type: 'end' }
 *   | { type: 'abort', reason: string }
 * )} HostedTurnEvent
 */

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
 * What one Anthropic `usage` object says a request put in the window: its
 * three input kinds, which are disjoint, plus its output.
 *
 * @param {any} usage
 */
const windowUse = usage =>
  tokenCount(usage?.input_tokens) +
  tokenCount(usage?.cache_read_input_tokens) +
  tokenCount(usage?.cache_creation_input_tokens) +
  tokenCount(usage?.output_tokens);

/**
 * A model id without a variant suffix such as `[1m]`.
 * @param name
 */
const baseModel = (/** @type {string} */ name) =>
  name.replace(/\[[^\]]*\]$/, '');

/**
 * The context window of the model that ran the main conversation, from the
 * `result` event's `modelUsage`, which is keyed by model and may also list a
 * small model the CLI used on the side, or a subagent's. The named model
 * wins, then the same model under a variant suffix (`[1m]`); failing both,
 * the largest window listed, since the side models are the small ones.
 *
 * @param {any} modelUsage
 * @param {string | undefined} model
 */
const contextWindowOf = (modelUsage, model) => {
  if (modelUsage === null || typeof modelUsage !== 'object') return 0;
  const entries = Object.entries(modelUsage).filter(
    ([, entry]) => entry !== null && typeof entry === 'object',
  );
  const windowOf = (/** @type {[string, unknown] | undefined} */ found) =>
    found ? tokenCount(/** @type {any} */ (found[1]).contextWindow) : 0;
  if (model !== undefined) {
    const named =
      entries.find(([name]) => name === model) ||
      entries.find(([name]) => baseModel(name) === baseModel(model));
    if (windowOf(named) > 0) return windowOf(named);
  }
  return Math.max(0, ...entries.map(entry => windowOf(entry)));
};

/**
 * Whether an API message's usage says anything. The CLI writes placeholder
 * messages of its own (model `<synthetic>`, all-zero usage) into the stream,
 * for instance around an API error; they are not requests.
 *
 * @param {any} message
 */
const isRealRequest = message =>
  message?.model !== '<synthetic>' &&
  message?.usage !== null &&
  typeof message?.usage === 'object' &&
  windowUse(message.usage) > 0;

/**
 * Stateful translator from raw `claude -p` stream-json events to hosted turn
 * events. `handle(event)` returns the hosted events one raw event maps to;
 * `finish()` returns the terminal event once the raw stream has ended cleanly.
 *
 * @returns {{
 *   handle: (event: any) => HostedTurnEvent[],
 *   finish: () => HostedTurnEvent[],
 * }}
 */
export const makeClaudeHostedTranslator = () => {
  // claude's tool_result events carry only tool_use_id; remember each
  // tool_use's name so the paired result can be labeled for the UI.
  /** @type {Map<string, string>} */
  const toolNames = new Map();
  // Whether any assistant text has been emitted. The `result` event repeats the
  // final answer; it is only surfaced when nothing streamed ahead of it, so a
  // consumer never sees the same text twice.
  let streamedAny = false;
  /** @type {string | undefined} */
  let errorReason;
  // With `--include-partial-messages`, text arrives first as Anthropic
  // content-block deltas and is repeated by the complete assistant event(s)
  // that follow — possibly one per content block. Remember which messages
  // streamed, by id when the wire names one (`message_start`) and otherwise as
  // "the message currently streaming", so the consumer receives each
  // character exactly once.
  /** @type {Set<string>} */
  const streamedMessageIds = new Set();
  /** @type {string | undefined} */
  let currentMessageId;
  let streamedCurrentAssistant = false;
  // `system/init` is only a startup phase. Clear it as soon as Claude emits a
  // substantive event so the UI does not keep saying "session starting" while
  // the model is already responding or using a tool.
  let starting = false;
  // What the main conversation's latest API request put in the window, and
  // the model that served it. `result.usage` covers the whole turn, so it
  // cannot say this; each request's own usage can. With partial messages the
  // input kinds arrive on `message_start` and the final output on
  // `message_delta`; without them the complete `assistant` event carries both.
  /** @type {{ input: number, output: number } | undefined} */
  let lastRequest;
  /** @type {string | undefined} */
  let lastModel;
  // The message whose usage `lastRequest` holds, so the complete `assistant`
  // events that repeat it (one per content block) do not report it again.
  /** @type {string | undefined} */
  let readMessageId;
  // Whether the request now streaming gave its usage on `message_start`, so
  // a `message_delta` completes that reading and not an earlier request's.
  let streamingRequest = false;
  const contextEvent = () =>
    lastRequest === undefined || lastRequest.input + lastRequest.output === 0
      ? []
      : [
          /** @type {HostedTurnEvent} */ ({
            type: 'usage',
            context: {
              usedTokens: lastRequest.input + lastRequest.output,
              windowTokens: 0,
            },
          }),
        ];

  /** @param {any} event */
  const handle = event => {
    /** @type {HostedTurnEvent[]} */
    const out = [];
    /** @param {string} phase */
    const leaveStarting = phase => {
      if (!starting) return;
      starting = false;
      out.push({ type: 'phase', phase });
    };
    if (!event || typeof event !== 'object') return out;
    // Subagent traffic (the CLI's Task/Agent tools) carries the parent's
    // tool_use id. Its text and tool activity belong to that subagent, not to
    // the reply the main session is composing, so it never reaches the hosted
    // stream — a consumer would otherwise persist it as the assistant's answer.
    if (event.parent_tool_use_id) return out;
    switch (event.type) {
      case 'system': {
        // Lifecycle diagnostics (subtype 'init' etc.) — surface as a phase so
        // the UI shows sandbox startup instead of dead air.
        if (event.subtype === 'init') {
          starting = true;
          out.push({ type: 'phase', phase: 'claude session starting' });
        }
        break;
      }
      case 'stream_event': {
        const streamEvent = event.event;
        if (streamEvent?.type === 'message_start') {
          // A new API message starts streaming: nothing of it is emitted yet.
          currentMessageId =
            typeof streamEvent.message?.id === 'string'
              ? streamEvent.message.id
              : undefined;
          // A new request: whatever the last one read no longer describes
          // the one streaming, whether or not this one says its usage.
          streamingRequest = false;
          if (isRealRequest(streamEvent.message)) {
            const started = streamEvent.message.usage;
            lastRequest = {
              input: windowUse({ ...started, output_tokens: 0 }),
              output: tokenCount(started.output_tokens),
            };
            streamingRequest = true;
            readMessageId = currentMessageId;
            if (typeof streamEvent.message.model === 'string') {
              lastModel = streamEvent.message.model;
            }
          }
          streamedCurrentAssistant = false;
        }
        if (
          streamEvent?.type === 'message_delta' &&
          streamEvent.usage &&
          streamingRequest &&
          lastRequest !== undefined
        ) {
          // The request is complete: its output count is final.
          lastRequest = {
            input: lastRequest.input,
            output: tokenCount(streamEvent.usage.output_tokens),
          };
          out.push(...contextEvent());
        }
        if (
          streamEvent?.type === 'content_block_delta' &&
          streamEvent.delta?.type === 'text_delta' &&
          streamEvent.delta.text
        ) {
          const text = `${streamEvent.delta.text}`;
          leaveStarting('responding');
          streamedAny = true;
          streamedCurrentAssistant = true;
          if (currentMessageId !== undefined) {
            streamedMessageIds.add(currentMessageId);
          }
          out.push({ type: 'text-delta', text });
        }
        break;
      }
      case 'assistant': {
        const blocks = event.message?.content;
        if (!Array.isArray(blocks)) break;
        const messageId = event.message?.id;
        const streamed =
          typeof messageId === 'string' && streamedMessageIds.size > 0
            ? streamedMessageIds.has(messageId)
            : streamedCurrentAssistant;
        // Without partial messages this event is the only per-request usage.
        // With them, `message_start` already read this message; either way a
        // message is read once, though it arrives once per content block.
        if (
          isRealRequest(event.message) &&
          !(typeof messageId === 'string' && messageId === readMessageId)
        ) {
          if (typeof event.message.model === 'string') {
            lastModel = event.message.model;
          }
          lastRequest = {
            input: windowUse({ ...event.message.usage, output_tokens: 0 }),
            output: tokenCount(event.message.usage.output_tokens),
          };
          readMessageId = typeof messageId === 'string' ? messageId : undefined;
          out.push(...contextEvent());
        }
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) {
            leaveStarting('responding');
            if (!streamed) {
              streamedAny = true;
              out.push({ type: 'text-delta', text: `${block.text}` });
            }
          } else if (block?.type === 'tool_use') {
            leaveStarting('using tools');
            const id = `${block.id || ''}`;
            const name = `${block.name || 'tool'}`;
            toolNames.set(id, name);
            out.push({
              type: 'tool-call',
              id,
              name,
              args: JSON.stringify(block.input ?? {}),
            });
          }
        }
        break;
      }
      case 'user': {
        // Tool results echo back as user-role events in the stream-json wire.
        const blocks = event.message?.content;
        if (!Array.isArray(blocks)) break;
        for (const block of blocks) {
          if (block?.type === 'tool_result') {
            leaveStarting('thinking');
            const id = `${block.tool_use_id || ''}`;
            out.push({
              type: 'tool-result',
              id,
              name: toolNames.get(id) || 'tool',
              result: renderToolResultText(block.content),
            });
          }
        }
        break;
      }
      case 'result': {
        const resultText =
          typeof event.result === 'string' && event.result !== ''
            ? event.result
            : undefined;
        if (event.is_error) {
          // A failed turn (subtype error_max_turns / error_during_execution,
          // or a claude-side error) must not read as success: `result` is
          // often absent on these, so the turn would otherwise finish with
          // whatever text happened to stream and be persisted as a normal
          // assistant reply. Record it; finish() raises it.
          errorReason =
            resultText ||
            (typeof event.subtype === 'string' && event.subtype) ||
            'claude reported an error';
        } else if (resultText !== undefined && !streamedAny) {
          // The CLI's own notion of the final answer, surfaced only when no
          // assistant text streamed ahead of it (a turn that produced its
          // answer without a visible assistant message).
          streamedAny = true;
          out.push({ type: 'text-delta', text: resultText });
        }
        if (event.usage && typeof event.usage === 'object') {
          // The whole turn, every request of it. Anthropic's input kinds are
          // already disjoint, and it does not count thinking apart from
          // output. Reading `input_tokens` alone dropped the cache reads and
          // writes, which are most of a long session.
          const context = projectContext({
            usedTokens:
              lastRequest === undefined
                ? 0
                : lastRequest.input + lastRequest.output,
            windowTokens: contextWindowOf(event.modelUsage, lastModel),
          });
          out.push({
            type: 'usage',
            inputTokens: tokenCount(event.usage.input_tokens),
            outputTokens: tokenCount(event.usage.output_tokens),
            cachedInputTokens: tokenCount(event.usage.cache_read_input_tokens),
            cacheWriteInputTokens: tokenCount(
              event.usage.cache_creation_input_tokens,
            ),
            reasoningOutputTokens: 0,
            ...(context === undefined ? {} : { context }),
          });
        }
        break;
      }
      default:
      // Unknown event types (future CLI versions) are ignored, not fatal.
    }
    return out;
  };

  const finish = () =>
    errorReason === undefined
      ? [/** @type {HostedTurnEvent} */ ({ type: 'end' })]
      : [
          /** @type {HostedTurnEvent} */ ({
            type: 'abort',
            reason: `claude turn failed: ${errorReason}`,
          }),
        ];

  return harden({ handle, finish });
};
harden(makeClaudeHostedTranslator);

/**
 * Wrap one ClaudeClient reply reader as a hosted-event reader. The returned
 * reader yields the translated events and exactly one terminal (`end`, or
 * `abort` with the CLI's reason). Closing it closes the raw reader, which
 * kills the in-flight `claude -p` process — the same close-to-kill contract
 * the ClaudeClient reader itself offers.
 *
 * @param {any} rawReader - the reader `ClaudeClient.send()` returned.
 * @returns {object} a buffered hosted-event reader
 */
export const translateClaudeTurn = rawReader => {
  const translator = makeClaudeHostedTranslator();
  const rawIterator = iterateReader(/** @type {any} */ (rawReader), {
    buffer: 8,
  });
  const { push, write, reader } = makeHostedTurnChannel({
    name: 'claude-translated',
    onConsumerClosed: () => {
      rawIterator.return().catch(() => {});
    },
  });
  (async () => {
    try {
      for await (const raw of rawIterator) {
        const event = /** @type {any} */ (raw);
        if (event?.type === 'end') {
          for (const translated of translator.finish()) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await write(translated))) return;
          }
          return;
        }
        if (event?.type === 'abort') {
          push({
            type: 'abort',
            reason: `${event.reason || 'claude turn aborted'}`,
          });
          return;
        }
        for (const translated of translator.handle(event)) {
          // eslint-disable-next-line no-await-in-loop
          if (!(await write(translated))) return;
        }
      }
      // The raw reader ended without an in-band terminal: its producer closed
      // it (the client's interrupt() or terminate() killed the process), so
      // whatever streamed is a truncated reply and must not read as complete.
      push({
        type: 'abort',
        reason: 'claude turn ended without a terminal event',
      });
    } catch (error) {
      push({
        type: 'abort',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return reader;
};
harden(translateClaudeTurn);
