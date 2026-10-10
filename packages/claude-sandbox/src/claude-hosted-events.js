// @ts-check
// Translate the raw `claude -p --output-format stream-json` events a
// ClaudeClient reply reader yields into the provider-neutral hosted turn events
// Floot's hosted-turn consumer understands:
//
//   { type: 'phase', phase }                  coarse status for the UI
//   { type: 'text-delta', text }              next chunk of assistant text
//   { type: 'tool-call', id, name, args }     a tool the CLI is invoking
//   { type: 'tool-result', id, name, result } that tool's output
//   { type: 'usage', inputTokens, outputTokens }
//   { type: 'end' } | { type: 'abort', reason }
//
// Nothing Claude-specific crosses the hosted seam: Floot persists the tool
// activity and the final text from these events exactly as it does for any
// other hosted backend, and the CLI's own event vocabulary stays behind this
// package's capability boundary.

import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

/**
 * @typedef {(
 *   | { type: 'phase', phase: string }
 *   | { type: 'text-delta', text: string }
 *   | { type: 'tool-call', id: string, name: string, args: string }
 *   | { type: 'tool-result', id: string, name: string, result: string }
 *   | { type: 'usage', inputTokens: number, outputTokens: number }
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
          streamedCurrentAssistant = false;
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
          out.push({
            type: 'usage',
            inputTokens: Number(event.usage.input_tokens) || 0,
            outputTokens: Number(event.usage.output_tokens) || 0,
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
  const { push, reader, setOnClose } = makeBufferedReader();
  const rawIterator = iterateReader(/** @type {any} */ (rawReader), {
    buffer: 8,
  });
  setOnClose(() => {
    rawIterator.return().catch(() => {});
  });
  (async () => {
    try {
      for await (const raw of rawIterator) {
        const event = /** @type {any} */ (raw);
        if (event?.type === 'end') {
          for (const translated of translator.finish()) push(translated);
          return;
        }
        if (event?.type === 'abort') {
          push({
            type: 'abort',
            reason: `${event.reason || 'claude turn aborted'}`,
          });
          return;
        }
        for (const translated of translator.handle(event)) push(translated);
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
