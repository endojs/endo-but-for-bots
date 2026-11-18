// @ts-check
/**
 * The Anthropic API provider, streamed (M2 W2.1b; R4-12, R4-31, R4-41,
 * R4-42, R4-77, R4-78, R4-79, R4-82, R4-92, R4-93; G-04; open decisions 12
 * and 13; designs/m2-interfaces.md 8.1, 8.2).
 *
 * Messages API with `stream: true` (`POST <baseUrl>/v1/messages`,
 * `x-api-key`, `anthropic-version: 2023-06-01`), written against the public
 * event shapes the Endo reference modules encode (lal `providers/
 * anthropic.js`: message and tool translation, the 401 text, usage; Fae
 * `providers/anthropic-streaming.js` is the spec's source for streaming and
 * the stop-reason rule). The answer is read as server-sent events
 * (`sse.js`, linear):
 *
 * - `message_start`: the served model and the input token counts;
 * - `content_block_start` / `_delta` / `_stop` per block index: `text`
 *   (`text_delta` published as deltas, one per network read as OpenRouter's,
 *   J-0413), `tool_use` (`input_json_delta` fragments joined; the arguments
 *   stay text, never parsed, rule 12.10), `thinking` (`thinking_delta`,
 *   `signature_delta`) and `redacted_thinking` (kept whole as opaque native
 *   context, R4-31: never published, never shown);
 * - `message_delta`: the stop reason and the output token count;
 * - `message_stop`: the answer is whole; `ping` is ignored; `error`: the
 *   stream's API error (`overloaded_error`, ...).
 *
 * What the answer means:
 *
 * - `end_turn` / `stop_sequence` with no tool call, or `tool_use` with at
 *   least one: delivered (an empty `end_turn` is a legitimate empty reply on
 *   the Anthropic API, unlike OpenRouter's R4-78 empty answer); a stop
 *   reason that disagrees with the tool calls fails with
 *   `textOf.anthropicStopMismatch` (R4-42);
 * - `max_tokens` (the request's `max_tokens`, R4-92: the session's
 *   `maxOutputTokens`, else 4,096) with text and no tool call: the text plus
 *   `\n\n` and `texts.outputLimitNote`, published as one more delta (R4-78,
 *   as OpenRouter's `length`); without text or inside a tool call, `refusal`
 *   and any other stop reason: `textOf.anthropicStopped(reason)`;
 * - an `error` event: `textOf.anthropicApiError(' (type <t>)')`, retried
 *   while nothing was delivered when `t` is `overloaded_error`, `api_error`
 *   or `rate_limit_error` (open decision 12: overload is retried like a 529);
 * - a stream that ends before `message_stop`: `texts.anthropicUnreachable`;
 * - 401: `texts.anthropicAuthFailed` (R4-77); another non-2xx:
 *   `textOf.anthropicHttp(status)` (the body is never read, R4-79); no
 *   response: `texts.anthropicUnreachable`; the request timeout
 *   (`spec.timeoutMs`, default 1 h, G-04: the spec's slot has none; 0 turns
 *   it off): `textOf.anthropicTimeout(s)`.
 *
 * Retries (`retry.js`, m2-interfaces.md 8.2): 408, 409, 429, 5xx (529
 * overloaded included), an overload or API error event, network failures
 * and unreadable answers, at most 3 attempts per round and one timeout
 * retry, waiting `min(8 s, max(Retry-After, 500 ms x 2^(n-1)))`, only while
 * nothing was delivered. Usage is reported with the attempt's outcome, not
 * at `message_start`: a failure before any text leaves no tokens behind
 * (the API reports the input count before it fails), so it can be retried;
 * a failure after text reports the usage seen with the round's failure.
 *
 * Usage (R4-33): `usageFromAnthropic` of `message_start` merged with
 * `message_delta`; the window is 0 here: a configured window comes from the
 * session's `contextLength` (open decision 13; seam 3 of m2-interfaces.md
 * 2.4), since the API reports none.
 *
 * Native context (R4-31): the round's thinking blocks as JSON text
 * `{ v: 1, model, textDigest, blocks }`, staged by the round driver into
 * `RoundResult.nativeContext`; a projection replays the blocks before the
 * round's text only when `model` is the request's model and `textDigest` is
 * the digest of the assistant text it is replayed with ("after checking it
 * matches the model and text"); otherwise the blocks are left out.
 *
 * The key is read at every round (R4-82). Tool-call ids are op ids
 * (`t1/r0/c0`) that the API refuses (`^[a-zA-Z0-9_-]+$`), so each request
 * maps them injectively (`anthropicToolId`). Failure texts carry statuses,
 * stop reasons and error types only, each when it has an identifier's
 * shape: no provider body ever reaches a failure, a log line or a record.
 *
 * Node only (adapter).
 */
import { createHash } from 'node:crypto';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { texts, textOf } from '../../../../guest/lib/interfaces.js';
import { limits } from '../../../../guest/lib/limits.js';
import { usageFromAnthropic } from '../../../../guest/lib/token-usage.js';
/* eslint-enable import/no-relative-packages */
import { NATIVE_CONTEXT_FORMAT } from '../projection.js';
import {
  bodyChunks,
  boundedChunks,
  discardBody,
  failureKind,
  postJson,
  providerBaseUrl,
  retryAfterMs,
} from './http.js';
import { parseSseBatches } from './sse.js';
import {
  makeRoundControl,
  ProviderFailure,
  readProviderKey,
  runProviderRound,
  systemTextOf,
} from './round.js';
import { makeEventLog } from './scripted.js';
import { anthropicDelay, isDelivery, makeRetry } from './retry.js';

/** The API's base (a spec's `baseUrl` replaces it: the fake server). */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** The Messages API version header. */
export const ANTHROPIC_VERSION = '2023-06-01';
/** G-04: the spec's Anthropic slot has no timeout; the harness gives 1 h. */
export const ANTHROPIC_TIMEOUT_MS = 3_600_000;
/** R4-92: output tokens per request when the session sets none. */
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 4096;
/** The native context's format version (inside the opaque payload). */
const NATIVE_VERSION = 1;
/** Content blocks one answer may open (a bound, not a quota). */
const MAX_BLOCKS = 4096;

const IDENTIFIER = /^[a-z]{1,24}(?:_[a-z]{1,24}){0,3}$/;
const MODEL = /^[a-z][a-z0-9]{0,15}(?:[.-][a-z0-9]{1,16}){0,8}$/;

/**
 * An identifier-shaped value (a stop reason, an error type), else
 * `fallback`.
 * @param {unknown} value
 * @param {string} [fallback]
 */
const identifier = (value, fallback = 'unknown') =>
  typeof value === 'string' && IDENTIFIER.test(value) ? value : fallback;

/** @param {unknown} status */
const retryableStatus = status =>
  status === 408 ||
  status === 409 ||
  status === 429 ||
  (typeof status === 'number' && status >= 500 && status <= 599);

const RETRYABLE_ERRORS = new Set([
  'overloaded_error',
  'api_error',
  'rate_limit_error',
]);

/**
 * The first 32 hex digits of the SHA-256 of a text (native context check).
 * @param {string} text
 */
export const textDigest = text =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
harden(textDigest);

/**
 * An op id in the API's tool id alphabet, injectively: letters, digits and
 * `-` stay; any other unit `u` becomes `_` and its 2 hex digits (below 256)
 * or `_u` and 4 hex digits (`_` itself is `_5f`).
 * @param {string} id
 */
export const anthropicToolId = id => {
  if (/^[A-Za-z0-9-]+$/.test(id)) return id;
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < id.length; i += 1) {
    const ch = id[i];
    if (/[A-Za-z0-9-]/.test(ch)) out.push(ch);
    else {
      const code = id.charCodeAt(i);
      out.push(
        code < 256
          ? `_${code.toString(16).padStart(2, '0')}`
          : `_u${code.toString(16).padStart(4, '0')}`,
      );
    }
  }
  return out.length === 0 ? '_' : out.join('');
};
harden(anthropicToolId);

/**
 * The thinking blocks of a native context, when it was made for `model`
 * and `text`; else undefined (R4-31).
 * @param {any} providerContext
 * @param {string} model
 * @param {string} text
 */
const replayedThinking = (providerContext, model, text) => {
  if (providerContext?.format !== NATIVE_CONTEXT_FORMAT) return undefined;
  /** @type {any} */
  let native;
  try {
    native = JSON.parse(String(providerContext.payload));
  } catch {
    return undefined;
  }
  if (
    native === null ||
    typeof native !== 'object' ||
    native.v !== NATIVE_VERSION ||
    native.model !== model ||
    native.textDigest !== textDigest(text) ||
    !Array.isArray(native.blocks)
  ) {
    return undefined;
  }
  /** @type {any[]} */
  const blocks = [];
  for (const block of native.blocks) {
    if (
      block?.type === 'thinking' &&
      typeof block.thinking === 'string' &&
      typeof block.signature === 'string'
    ) {
      blocks.push({
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      });
    } else if (
      block?.type === 'redacted_thinking' &&
      typeof block.data === 'string'
    ) {
      blocks.push({ type: 'redacted_thinking', data: block.data });
    } else {
      return undefined;
    }
  }
  return blocks;
};

/**
 * The Messages API `messages` of a projection (transcript records,
 * projection.js), consecutive messages of one role joined: a user message,
 * an assistant message with its native context's thinking blocks (when they
 * match), its text and the round's `tool_use` blocks, then one user message
 * with the `tool_result` blocks (`is_error` when failed). A `tool_use`
 * whose result is missing gets `texts.toolOutcomeUnknown` as an error
 * result, since the API refuses a call without its result (R4-32).
 * @param {readonly any[]} transcript
 * @param {string} model the request's model (native context check)
 */
export const anthropicMessages = (transcript, model) => {
  /** @type {{ role: 'user' | 'assistant', content: any[] }[]} */
  const messages = [];
  /** @param {'user' | 'assistant'} role */
  const open = role => {
    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === role) return last;
    const next = { role, content: /** @type {any[]} */ ([]) };
    messages.push(next);
    return next;
  };
  /** Calls of the latest assistant message still waiting for a result. */
  /** @type {string[]} */
  let waiting = [];
  const answerWaiting = () => {
    if (waiting.length === 0) return;
    const user = open('user');
    for (const id of waiting) {
      user.content.push({
        type: 'tool_result',
        tool_use_id: id,
        content: texts.toolOutcomeUnknown,
        is_error: true,
      });
    }
    waiting = [];
  };
  for (const record of transcript) {
    if (record.kind === 'message' && record.role === 'assistant') {
      answerWaiting();
      const text = String(record.content ?? '');
      const assistant = open('assistant');
      const thinking = replayedThinking(record.providerContext, model, text);
      if (thinking !== undefined) assistant.content.push(...thinking);
      if (text !== '') assistant.content.push({ type: 'text', text });
    } else if (record.kind === 'tool-call') {
      const id = anthropicToolId(String(record.id));
      /** @type {any} */
      let input;
      try {
        input = JSON.parse(record.args);
      } catch {
        input = undefined;
      }
      if (input === null || typeof input !== 'object' || Array.isArray(input))
        input = {};
      if (messages[messages.length - 1]?.role !== 'assistant') answerWaiting();
      open('assistant').content.push({
        type: 'tool_use',
        id,
        name: String(record.name),
        input,
      });
      waiting.push(id);
    } else if (record.kind === 'tool-result') {
      const id = anthropicToolId(String(record.id));
      const at = waiting.indexOf(id);
      // A result without its call is dropped.
      if (at >= 0) {
        waiting.splice(at, 1);
        const content = String(record.content ?? '');
        open('user').content.push({
          type: 'tool_result',
          tool_use_id: id,
          ...(content === '' ? {} : { content }),
          ...(record.failed ? { is_error: true } : {}),
        });
      }
    } else if (record.kind === 'message') {
      answerWaiting();
      const text = String(record.content ?? '');
      if (text !== '') open('user').content.push({ type: 'text', text });
    }
  }
  answerWaiting();
  return messages.filter(message => message.content.length > 0);
};
harden(anthropicMessages);

/**
 * A round's tools as Messages API tools. `parameters` is JSON Schema as
 * text (the contract's `ToolDescription`); one that does not parse as an
 * object schema is offered as an empty object schema.
 * @param {readonly any[]} tools
 */
export const anthropicTools = tools =>
  tools.map(tool => {
    /** @type {any} */
    let schema;
    try {
      schema = JSON.parse(tool.parameters);
    } catch {
      schema = undefined;
    }
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema))
      schema = { type: 'object', properties: {} };
    if (schema.type === undefined) schema = { ...schema, type: 'object' };
    return {
      name: tool.name,
      description: tool.description,
      input_schema: schema,
    };
  });
harden(anthropicTools);

/**
 * The request body (exported for tests).
 * @param {object} request
 * @param {string} request.model
 * @param {any[]} request.messages
 * @param {readonly any[]} request.tools
 * @param {string} [request.system]
 * @param {number} [request.maxOutputTokens]
 * @param {Record<string, unknown>} [request.extras] (M4 H-14) fields laid
 *   over the body last: the Claude pool's billing `system` blocks and its
 *   adaptive thinking (`AH/subscriptions/messages.js`)
 */
export const anthropicBody = ({
  model,
  messages,
  tools,
  system,
  maxOutputTokens,
  extras,
}) => ({
  model,
  max_tokens:
    maxOutputTokens !== undefined && maxOutputTokens > 0
      ? maxOutputTokens
      : ANTHROPIC_MAX_OUTPUT_TOKENS,
  ...(system !== undefined && system !== '' ? { system } : {}),
  messages,
  ...(tools.length ? { tools: anthropicTools(tools) } : {}),
  stream: true,
  ...extras,
});
harden(anthropicBody);

/**
 * `Retry-After` in ms: the API's `retry-after-ms`, else `retry-after`.
 * @param {Response} response
 * @param {() => number} [now]
 */
const anthropicRetryAfter = (response, now) => {
  const ms = response.headers.get('retry-after-ms');
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) {
    const value = Number(ms.trim());
    if (Number.isFinite(value) && value > 0) return value;
  }
  return retryAfterMs(response, now);
};

/**
 * One streamed attempt: the events of `runProviderRound`, or a thrown
 * `ProviderFailure`.
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.key] the API key (`x-api-key`); not sent when
 *   `headers` is given
 * @param {Record<string, string>} [options.headers] (M4 H-14) the
 *   authorization headers in place of `x-api-key`: the Claude pool's OAuth
 *   bearer and its R4-30 headers (`anthropic-version` and `accept` are
 *   still sent)
 * @param {any} options.body
 * @param {AbortSignal} options.signal
 * @param {number} options.timeoutMs 0: no timeout
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @returns {AsyncGenerator<import('./round.js').RoundEvent, void, undefined>}
 */
export async function* anthropicAttempt({
  url,
  key,
  headers,
  body,
  signal,
  timeoutMs,
  fetch,
  now,
}) {
  let delivered = false;
  const seconds = Math.round(timeoutMs / 1000);
  /**
   * @param {unknown} error
   * @param {AbortSignal | undefined} requestSignal
   */
  const transport = (error, requestSignal) => {
    const kind = failureKind(error, signal, requestSignal);
    if (kind === 'aborted') return error;
    return new ProviderFailure(
      kind === 'timeout'
        ? textOf.anthropicTimeout(seconds)
        : texts.anthropicUnreachable,
      { retryable: true, timedOut: kind === 'timeout', delivered },
    );
  };
  /** @type {Response & { requestSignal?: AbortSignal }} */
  let response;
  try {
    response = await postJson({
      url,
      headers: {
        ...(headers ?? { 'x-api-key': String(key) }),
        'anthropic-version': ANTHROPIC_VERSION,
        accept: 'text/event-stream',
      },
      body,
      signal,
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
      ...(fetch === undefined ? {} : { fetch }),
    });
  } catch (error) {
    throw transport(error, undefined);
  }
  if (!response.ok) {
    const after = anthropicRetryAfter(response, now);
    discardBody(response);
    throw new ProviderFailure(
      response.status === 401
        ? texts.anthropicAuthFailed
        : textOf.anthropicHttp(response.status),
      {
        retryable: retryableStatus(response.status),
        status: response.status,
        ...(after === undefined ? {} : { retryAfterMs: after }),
      },
    );
  }
  if (
    !/^text\/event-stream(?:;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  ) {
    discardBody(response);
    throw new ProviderFailure(texts.anthropicUnreachable, { retryable: true });
  }

  /** @type {unknown} */
  let model;
  /** @type {any} */
  let startUsage;
  /** @type {any} */
  let endUsage;
  /** @type {unknown} */
  let stopReason;
  /** @type {any} */
  let apiError;
  let done = false;
  let textLength = 0;
  // The round's text, digested as it streams (the native context's check;
  // linear, nothing kept).
  const digest = createHash('sha256');
  /**
   * index -> the block being read (`text` blocks only count their text).
   * @type {Map<number, { type: string, id?: string, name?: string, parts: string[], signature?: string, data?: string, closed: boolean }>}
   */
  const blocks = new Map();
  const usage = () =>
    usageFromAnthropic({
      ...(startUsage ?? {}),
      ...(endUsage ?? {}),
    });
  /**
   * The failure, after the usage seen when it will not be retried (tokens
   * consumed are reported with the round's failure; R4-33).
   * @param {string} reason
   * @param {boolean} retryable
   * @param {string} [errorType] an `error` event's type (symbolic)
   */
  async function* fail(reason, retryable, errorType) {
    const again = retryable && !delivered;
    if (!again && (startUsage !== undefined || endUsage !== undefined)) {
      const seen = usage();
      if (isDelivery({ usage: seen })) delivered = true;
      yield { usage: seen };
    }
    throw new ProviderFailure(reason, {
      retryable: again,
      delivered,
      ...(errorType === undefined ? {} : { errorType }),
    });
  }

  try {
    for await (const batch of parseSseBatches(
      boundedChunks(
        bodyChunks(response),
        limits.roundStreamBytes,
        () => new ProviderFailure(texts.frameLimit, { delivered }),
      ),
    )) {
      /** @type {string[]} */
      const pieces = [];
      let unreadable = false;
      for (const { data } of batch) {
        /** @type {any} */
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          unreadable = true;
          break;
        }
        if (event === null || typeof event !== 'object') event = {};
        const index = Number.isInteger(event.index) ? event.index : -1;
        switch (event.type) {
          case 'message_start': {
            const message = event.message ?? {};
            if (model === undefined) model = message.model;
            if (message.usage !== null && typeof message.usage === 'object')
              startUsage = message.usage;
            break;
          }
          case 'content_block_start': {
            const block = event.content_block ?? {};
            if (blocks.size >= MAX_BLOCKS && !blocks.has(index)) {
              throw new ProviderFailure(texts.frameLimit, { delivered });
            }
            /** @type {{ type: string, id?: string, name?: string, parts: string[], signature?: string, data?: string, closed: boolean }} */
            const entry = {
              type: String(block.type ?? ''),
              parts: [],
              closed: false,
            };
            if (entry.type === 'tool_use') {
              if (typeof block.id === 'string') entry.id = block.id;
              entry.name = typeof block.name === 'string' ? block.name : '';
            } else if (entry.type === 'thinking') {
              if (typeof block.thinking === 'string' && block.thinking !== '')
                entry.parts.push(block.thinking);
              if (typeof block.signature === 'string')
                entry.signature = block.signature;
            } else if (entry.type === 'redacted_thinking') {
              if (typeof block.data === 'string') entry.data = block.data;
            } else if (entry.type === 'text') {
              if (typeof block.text === 'string' && block.text !== '') {
                textLength += block.text.length;
                pieces.push(block.text);
              }
            }
            blocks.set(index, entry);
            break;
          }
          case 'content_block_delta': {
            const entry = blocks.get(index);
            const delta = event.delta ?? {};
            if (entry === undefined) break;
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              if (delta.text !== '') {
                textLength += delta.text.length;
                pieces.push(delta.text);
              }
            } else if (
              delta.type === 'input_json_delta' &&
              typeof delta.partial_json === 'string'
            ) {
              entry.parts.push(delta.partial_json);
            } else if (
              delta.type === 'thinking_delta' &&
              typeof delta.thinking === 'string'
            ) {
              entry.parts.push(delta.thinking);
            } else if (
              delta.type === 'signature_delta' &&
              typeof delta.signature === 'string'
            ) {
              entry.signature = delta.signature;
            }
            break;
          }
          case 'content_block_stop': {
            const entry = blocks.get(index);
            if (entry !== undefined) entry.closed = true;
            break;
          }
          case 'message_delta': {
            if (event.delta?.stop_reason !== undefined)
              stopReason = event.delta.stop_reason;
            if (event.usage !== null && typeof event.usage === 'object')
              endUsage = event.usage;
            break;
          }
          case 'message_stop':
            done = true;
            break;
          case 'error':
            apiError = event.error ?? {};
            break;
          default:
            // `ping` and event types this build does not know.
            break;
        }
        if (done || apiError !== undefined) break;
      }
      if (pieces.length > 0) {
        delivered = true;
        const delta = pieces.length === 1 ? pieces[0] : pieces.join('');
        digest.update(delta, 'utf8');
        yield { delta };
      }
      if (unreadable) {
        yield* fail(texts.anthropicUnreachable, true);
      }
      if (done || apiError !== undefined) break;
    }
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw transport(error, response.requestSignal);
  }
  if (apiError !== undefined) {
    const type = identifier(apiError?.type, '');
    yield* fail(
      textOf.anthropicApiError(
        type === '' ? '' : textOf.servedBy([['type', type]]),
      ),
      RETRYABLE_ERRORS.has(type),
      type,
    );
  }
  if (!done) {
    // Cut before `message_stop`: not a whole answer.
    yield* fail(texts.anthropicUnreachable, true);
  }
  const calls = [...blocks.entries()]
    .filter(([, block]) => block.type === 'tool_use')
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => block);
  const reason = identifier(stopReason);
  if (reason === 'max_tokens') {
    if (textLength === 0 || calls.length > 0) {
      yield* fail(textOf.anthropicStopped(reason), false);
    }
    const note = `\n\n${texts.outputLimitNote}`;
    digest.update(note, 'utf8');
    yield { delta: note };
  } else if (reason === 'tool_use') {
    if (calls.length === 0)
      yield* fail(textOf.anthropicStopMismatch(reason, 0), false);
  } else if (reason === 'end_turn' || reason === 'stop_sequence') {
    if (calls.length > 0)
      yield* fail(textOf.anthropicStopMismatch(reason, calls.length), false);
  } else {
    yield* fail(textOf.anthropicStopped(reason), false);
  }
  if (calls.some(call => !call.closed)) {
    yield* fail(texts.anthropicUnreachable, false);
  }
  for (const call of calls) {
    const args = call.parts.join('');
    yield {
      toolCall: {
        ...(call.id === undefined ? {} : { callId: call.id }),
        name: call.name ?? '',
        args: args === '' ? '{}' : args,
      },
    };
  }
  const thinking = [...blocks.entries()]
    .filter(
      ([, block]) =>
        block.type === 'thinking' || block.type === 'redacted_thinking',
    )
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) =>
      block.type === 'thinking'
        ? {
            type: 'thinking',
            thinking: block.parts.join(''),
            signature: block.signature ?? '',
          }
        : { type: 'redacted_thinking', data: block.data ?? '' },
    );
  const requested = String(body?.model ?? '');
  if (thinking.length > 0) {
    // Checked against the text the projection replays it with: the round's
    // whole text, the note included (R4-31).
    yield {
      nativeContext: JSON.stringify({
        v: NATIVE_VERSION,
        model: requested,
        textDigest: digest.digest('hex').slice(0, 32),
        blocks: thinking,
      }),
    };
  }
  /** @type {{ modelId?: string }} */
  const servedBy = {};
  if (typeof model === 'string' && MODEL.test(model)) servedBy.modelId = model;
  yield { servedBy };
  yield { usage: usage() };
  yield { stop: reason };
}
harden(anthropicAttempt);

/**
 * @param {object} options
 * @param {string} options.label the backend's label
 * @param {any} [options.spec] the BackendSpec (`modelId`, `baseUrl`,
 *   `timeoutMs` (0: none), `maxOutputTokens`, `logPath`)
 * @param {() => Promise<string>} [options.readKey] the key, read through the
 *   backend's grant at every round (R4-82)
 * @param {import('../timers.js').Timers} options.timers
 * @param {import('./scripted.js').EventLog} [options.log]
 * @param {import('../blobs.js').BlobStore} [options.blobs]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {(args: { attempt: (signal: AbortSignal) => AsyncIterable<import('./round.js').RoundEvent>, signal: AbortSignal }) => AsyncIterable<import('./round.js').RoundEvent>} [options.retry]
 *   the retry wrapper (default: `makeRetry` with `anthropicDelay`, one per
 *   round, logging each retry)
 * @param {string} [options.logPath] (as the scripted kind's options)
 */
export const makeAnthropicProvider = ({
  label,
  spec = {},
  readKey,
  timers,
  logPath = spec.logPath,
  log = makeEventLog({ label, logPath }),
  blobs,
  fetch,
  now = () => Date.now(),
  retry,
}) => {
  const baseUrl = providerBaseUrl(spec.baseUrl, ANTHROPIC_BASE_URL);
  const timeoutMs = spec.timeoutMs ?? ANTHROPIC_TIMEOUT_MS;
  /** turn -> the control of its running round. */
  /** @type {Map<any, import('./round.js').RoundControl>} */
  const running = new Map();

  return harden({
    /**
     * @param {any} req
     * @param {any} channel
     * @param {() => Promise<any>} [prepare]
     * @param {any} [owner]
     */
    startRound: async (req, channel, prepare, owner) => {
      running.get(req.turn)?.stop('release');
      const control = makeRoundControl(timers);
      running.set(req.turn, control);
      try {
        await runProviderRound({
          req,
          channel,
          prepare,
          blobs,
          log,
          owner,
          control,
          timers,
          now,
          label,
          unreachable: texts.anthropicUnreachable,
          stream: async function* anthropicStream({ projection, signal }) {
            const model = String(req.options.modelId);
            const key = await readProviderKey(readKey);
            const system = await systemTextOf(req.system, blobs, owner);
            const transcript =
              projection?.transcript ??
              req.append
                .filter(
                  (/** @type {any} */ r) =>
                    r.kind === 'turn-started' && typeof r.input === 'string',
                )
                .map((/** @type {any} */ r) => ({
                  kind: 'message',
                  role: 'user',
                  content: r.input,
                }));
            const body = anthropicBody({
              model,
              messages: anthropicMessages(transcript, model),
              tools: req.tools,
              system,
              maxOutputTokens:
                req.options.maxOutputTokens ?? spec.maxOutputTokens,
            });
            const retryRound =
              retry ??
              makeRetry({
                timers,
                delayMs: anthropicDelay,
                onRetry: ({ attempt, failure, waitMs }) =>
                  log('retry', {
                    turnId: req.turnId,
                    round: req.round,
                    attempt,
                    waitMs,
                    ...(failure.status === undefined
                      ? {}
                      : { status: failure.status }),
                    timedOut: failure.timedOut,
                  }),
              });
            yield* retryRound({
              signal,
              attempt: attemptSignal =>
                anthropicAttempt({
                  url: `${baseUrl}/v1/messages`,
                  key,
                  body,
                  signal: attemptSignal,
                  timeoutMs,
                  ...(fetch === undefined ? {} : { fetch }),
                  now,
                }),
            });
          },
        });
      } finally {
        if (running.get(req.turn) === control) running.delete(req.turn);
      }
    },
    /** The endpoint's text for a round that threw (R4-79: fixed). */
    unexpectedFailure: texts.anthropicUnreachable,
    /** @param {any} turn aborts its request (R4-7); logged `cancelled` */
    cancelRound: turn => running.get(turn)?.stop('cancel'),
    /** @param {any} turn aborts its request silently (lease released) */
    releaseTurn: turn => running.get(turn)?.stop('release'),
  });
};
harden(makeAnthropicProvider);

/** The `backendKinds` entry (AH/index.js hook table). */
export const anthropicKind = harden({
  kind: 'anthropic',
  makeProvider: makeAnthropicProvider,
  // M4 W4.6 (H-14, D-M4-9): account status on API backends too.
  tools: harden(['accountStatus']),
});
