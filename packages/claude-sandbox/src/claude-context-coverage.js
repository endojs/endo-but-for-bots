// @ts-check
import { Fail } from '@endo/errors';

const LIMIT = 16 * 1024 * 1024;
const isUuid = value =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Conservative coverage proof for the pinned CLI's mainline partial stream.
 * This does not establish signature validity, effect settlement, or producer
 * shutdown. Call only after an independently confirmed stopped producer and
 * pass a transcript already validated by the sandbox capture helper.
 * Unsupported framing is an availability failure, never a partial proof.
 */
export const makeClaudeContextCoverage = () => {
  let refused = false;
  let bytes = 0;
  let session;
  let initialized = false;
  let terminal = false;
  /** @type {any} */
  let message;
  /** @type {any} */
  let block;
  let nextIndex = 0;
  /** @type {Array<{uuid: string, role: string, content: any, messageId?: string, model?: string, messageType?: string}>} */
  const frames = [];
  const frameIds = new Set();
  const requireValue = condition => {
    if (!condition) {
      refused = true;
      throw Fail`Claude native context coverage unavailable`;
    }
  };
  const guarded = operation => {
    requireValue(!refused);
    try {
      return operation();
    } catch (error) {
      refused = true;
      throw error;
    }
  };
  const charge = value => {
    bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    requireValue(bytes <= LIMIT);
  };
  const validateUserContent = content => {
    requireValue(
      typeof content === 'string' ||
        (Array.isArray(content) &&
          content.every(item =>
            item.type === 'text'
              ? typeof item.text === 'string'
              : item.type === 'tool_result' &&
                typeof item.tool_use_id === 'string' &&
                (typeof item.content === 'string' ||
                  (Array.isArray(item.content) &&
                    item.content.every(
                      part =>
                        part.type === 'text' && typeof part.text === 'string',
                    ))),
          )),
    );
  };
  const completedBlock = () => {
    if (block.value.type !== 'tool_use') return block.value;
    requireValue(block.json !== '');
    const input = JSON.parse(block.json);
    requireValue(input && typeof input === 'object' && !Array.isArray(input));
    return { ...block.value, input };
  };
  /** @param {any} event */
  const observe = event =>
    guarded(() => {
      charge(event);
      requireValue(event && typeof event === 'object');
      // Subagent events are not mainline dialogue. They cannot certify coverage.
      if (event.parent_tool_use_id) return;
      requireValue(!terminal && isUuid(event.session_id));
      if (session === undefined) session = event.session_id;
      requireValue(event.session_id === session);
      if (event.type === 'system') {
        if (event.subtype === 'init') {
          requireValue(!initialized && frames.length === 0 && !message);
          initialized = true;
        } else {
          requireValue(
            initialized &&
              ['status', 'thinking_tokens'].includes(event.subtype),
          );
        }
        return;
      }
      requireValue(initialized);
      if (event.type === 'result') {
        // A result's text can be separately displayed by the translator when
        // nothing streamed. Do not certify an unrepresented synthetic answer.
        requireValue(!message && !block && frames.length > 0);
        if (typeof event.result === 'string' && event.result !== '') {
          requireValue(
            frames.some(
              frame =>
                frame.role === 'assistant' &&
                Array.isArray(frame.content) &&
                frame.content.some(
                  item => item.type === 'text' && item.text === event.result,
                ),
            ),
          );
        }
        terminal = true;
        return;
      }
      if (event.type === 'assistant' || event.type === 'user') {
        requireValue(isUuid(event.uuid) && !frameIds.has(event.uuid));
        requireValue(event.message?.role === event.type);
        const content = event.message.content;
        if (event.type === 'assistant') {
          requireValue(
            message &&
              block &&
              !block.matched &&
              event.message.id === message.id &&
              event.message.type === 'message' &&
              event.message.model === message.model,
          );
          requireValue(Array.isArray(content) && content.length === 1);
          requireValue(same(content[0], completedBlock()));
          block.matched = true;
        } else {
          requireValue(!message && !block);
          validateUserContent(content);
        }
        frameIds.add(event.uuid);
        // Copy so a caller cannot mutate an observation after acceptance.
        frames.push(
          JSON.parse(
            JSON.stringify({
              uuid: event.uuid,
              role: event.type,
              content,
              ...(event.type === 'assistant'
                ? {
                    messageId: event.message.id,
                    messageType: event.message.type,
                    model: event.message.model,
                  }
                : {}),
            }),
          ),
        );
        return;
      }
      requireValue(event.type === 'stream_event');
      const stream = event.event;
      requireValue(stream && typeof stream === 'object');
      if (stream.type === 'message_start') {
        requireValue(
          !message &&
            !block &&
            stream.message?.role === 'assistant' &&
            typeof stream.message.id === 'string' &&
            stream.message.id !== '' &&
            stream.message.type === 'message' &&
            typeof stream.message.model === 'string' &&
            stream.message.model !== '' &&
            Array.isArray(stream.message.content) &&
            stream.message.content.length === 0,
        );
        message = { id: stream.message.id, model: stream.message.model };
        nextIndex = 0;
        return;
      }
      requireValue(message);
      if (stream.type === 'content_block_start') {
        requireValue(!block && stream.index === nextIndex);
        const value = stream.content_block;
        requireValue(value && typeof value === 'object');
        requireValue(
          (value.type === 'text' && typeof value.text === 'string') ||
            (value.type === 'thinking' && typeof value.thinking === 'string') ||
            (value.type === 'redacted_thinking' &&
              typeof value.data === 'string' &&
              value.data !== '') ||
            (value.type === 'tool_use' &&
              typeof value.id === 'string' &&
              typeof value.name === 'string' &&
              same(value.input, {})),
        );
        block = {
          value: JSON.parse(JSON.stringify(value)),
          json: '',
          matched: false,
        };
        if (value.type === 'thinking')
          block.value.signature = value.signature ?? '';
        return;
      }
      if (stream.type === 'content_block_delta') {
        requireValue(block && !block.matched && stream.index === nextIndex);
        const delta = stream.delta;
        if (block.value.type === 'text') {
          requireValue(
            delta?.type === 'text_delta' && typeof delta.text === 'string',
          );
          block.value.text += delta.text;
        } else if (block.value.type === 'thinking') {
          requireValue(
            ['thinking_delta', 'signature_delta'].includes(delta?.type),
          );
          const key =
            delta.type === 'thinking_delta' ? 'thinking' : 'signature';
          requireValue(typeof delta[key] === 'string');
          block.value[key] += delta[key];
        } else {
          requireValue(block.value.type === 'tool_use');
          requireValue(
            delta?.type === 'input_json_delta' &&
              typeof delta.partial_json === 'string',
          );
          block.json += delta.partial_json;
        }
        return;
      }
      if (stream.type === 'content_block_stop') {
        requireValue(block?.matched && stream.index === nextIndex);
        block = undefined;
        nextIndex += 1;
        return;
      }
      requireValue(!block && nextIndex > 0);
      if (stream.type === 'message_stop') message = undefined;
      else
        requireValue(
          stream.type === 'message_delta' &&
            Object.keys(stream.delta ?? {}).every(key =>
              ['stop_reason', 'stop_sequence'].includes(key),
            ),
        );
    });

  /**
   * @param {string} nativeTranscript Helper-validated native JSONL.
   * @param {{sessionId: string, beforeUuid: string|null, prompt: string}} cut
   */
  const assertCaptured = (
    nativeTranscript,
    { sessionId, beforeUuid, prompt },
  ) =>
    guarded(() => {
      requireValue(initialized && frames.length > 0 && !message && !block);
      requireValue(
        isUuid(sessionId) &&
          sessionId === session &&
          (beforeUuid === null || isUuid(beforeUuid)) &&
          typeof prompt === 'string',
      );
      requireValue(
        typeof nativeTranscript === 'string' &&
          nativeTranscript.endsWith('\n') &&
          new TextEncoder().encode(nativeTranscript).byteLength <= LIMIT,
      );
      const rows = nativeTranscript
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line));
      requireValue(
        rows.every(row => row.sessionId === sessionId && !row.isSidechain),
      );
      const before =
        beforeUuid === null
          ? -1
          : rows.findLastIndex(row => row.uuid === beforeUuid);
      requireValue(beforeUuid === null || before >= 0);
      const active = rows.slice(before + 1);
      const admitted = active.shift();
      requireValue(
        admitted?.type === 'user' &&
          admitted.message?.role === 'user' &&
          admitted.parentUuid === beforeUuid &&
          isUuid(admitted.uuid),
      );
      requireValue(
        admitted.message.content === prompt ||
          same(admitted.message.content, [{ type: 'text', text: prompt }]),
      );
      let parent = admitted.uuid;
      let position = 0;
      const ids = new Set([parent]);
      for (const row of active) {
        requireValue(
          isUuid(row.uuid) && !ids.has(row.uuid) && row.parentUuid === parent,
        );
        ids.add(row.uuid);
        parent = row.uuid;
        if (row.type === 'attachment') {
          const attachment = row.attachment;
          requireValue(
            attachment?.type === 'total_tokens_reminder' ||
              (attachment?.type === 'max_turns_reached' &&
                [attachment.maxTurns, attachment.turnCount].every(
                  value =>
                    typeof value === 'number' &&
                    Number.isInteger(value) &&
                    value > 0,
                )),
          );
        } else {
          const frame = frames[position];
          requireValue(
            frame &&
              row.uuid === frame.uuid &&
              row.type === frame.role &&
              row.message?.role === frame.role &&
              (frame.role !== 'assistant' ||
                (row.message.id === frame.messageId &&
                  row.message.type === frame.messageType &&
                  row.message.model === frame.model)) &&
              same(row.message.content, frame.content),
          );
          position += 1;
        }
      }
      requireValue(position === frames.length);
    });
  return harden({ observe, assertCaptured });
};
harden(makeClaudeContextCoverage);
