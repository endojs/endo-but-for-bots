// @ts-check
/**
 * The Codex subscription wire client (`codex-pool`; M4 W4.3;
 * `designs/m4-interfaces.md` 5.3; R4-23, R4-30, R4-31, R4-75, R4-93,
 * R4-105).
 *
 * OpenAI Responses over SSE with the member's OAuth access token, ported
 * from lal `providers/subscription-responses.js` (1315bef86) onto M2's
 * round events and `sse.js`:
 *
 * - request (R4-30): the round's system text as `instructions` (resolved
 *   once per round by the pool provider with M2's `systemTextOf`, plain
 *   text here), the projection as `input` items, `store: false`,
 *   `stream: true`, `include: ['reasoning.encrypted_content']`, the effort
 *   as `reasoning.effort` with `ultra` sent as `max` (R4-23, hosted-agent
 *   `codex-reasoning.js`), tools as function tools; headers: the bearer,
 *   `chatgpt-account-id` when the credential names an account, and the
 *   `originator` the reference's profile sends;
 * - answer: `response.output_text.delta` texts are published as deltas (one
 *   per network read, as M2's clients); completed output items
 *   (`response.output_item.done`) are kept by index; `response.completed`
 *   ends the answer (its `output` is used when not empty, else the streamed
 *   items, as subscription streams acknowledge with an empty output);
 *   function calls become tool calls, reasoning items (encrypted reasoning)
 *   the round's native context, replayed before the round's text only for
 *   the same model and text (R4-31, as `anthropic.js` checks its thinking);
 * - failures: `error`, `response.failed`, `response.incomplete` fail with
 *   `subscriptionTextOf.responsesFailed(type, facts, explanation)`, facts symbolic
 *   only (codes, types, params, reasons; never prose, a request id or a
 *   body); a non-200 answer with `subscriptionTextOf.subscriptionHttp(status)` (a 429
 *   whose headers say the subscription is used up carries `exhausted`, a
 *   401 `rejected`); an answer with no text and no call with
 *   `subscriptionTexts.emptyResponsesOutput`; a stream cut before completion, an
 *   unreadable event, no answer and a timeout with `responsesFailed` of the
 *   pseudo event types `stream.incomplete`, `stream.unreadable`,
 *   `stream.unreachable` and `stream.timeout` (no fixed text exists for
 *   them; the reference's `diagnosticEventType` admits `stream.*`);
 * - retry (R4-75): only `server_is_overloaded` (in an `error` or
 *   `response.failed` event) before anything was fenced: visible text,
 *   usage, response output, an incomplete response or an event this build
 *   does not know (the reference's fence); such a failure is `retryable`
 *   and `overloaded`, and the pool provider runs `withOverloadRetry` with
 *   `codexOverloadDelaysMs` (5, 10, 20, 40, 60 s).
 *
 * Every answer's rate-limit headers go to `onReading` (`wire.js`); no header
 * value, body or token reaches a failure, a log or a record.
 *
 * Node only (adapter).
 */
import { createHash } from 'node:crypto';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { texts } from '../../../../guest/lib/interfaces.js';
import { limits } from '../../../../guest/lib/limits.js';
import {
  codexExplanations,
  subscriptionTextOf,
  subscriptionTexts,
} from '../../../../guest/lib/subscription-texts.js';
import { usageFromOpenRouter } from '../../../../guest/lib/token-usage.js';
/* eslint-enable import/no-relative-packages */
import { subscriptionDefaults } from '../../../../config/subscription-defaults.js';
import { anthropicToolId, textDigest } from '../providers/anthropic.js';
import {
  bodyChunks,
  boundedChunks,
  discardBody,
  failureKind,
  postJson,
  providerBaseUrl,
  retryAfterMs,
} from '../providers/http.js';
import { ProviderFailure } from '../providers/round.js';
import { parseSseBatches } from '../providers/sse.js';
import { NATIVE_CONTEXT_FORMAT } from '../projection.js';
import { responsesToolOutput, toolResultImages } from '../providers/images.js';
import { observingFetch, wireFailure } from './wire.js';

/** The ChatGPT origin (a pool spec's `baseUrl` replaces it). */
export const CODEX_BASE_URL = 'https://chatgpt.com';
/** The Responses route of the subscription backend (reference profile). */
export const CODEX_RESPONSES_PATH = '/backend-api/codex/responses';
/** The `originator` header of the reference's Codex profile. */
export const CODEX_ORIGINATOR = 'codex_cli_rs';

/** The native context's format version (inside the opaque payload). */
const NATIVE_VERSION = 1;
/** Output items one answer may complete (a bound, not a quota). */
const MAX_ITEMS = 4096;

const MODEL = /^[a-z][a-z0-9]{0,15}(?:[.-][a-z0-9]{1,16}){0,8}$/;

/** The efforts the Responses API takes (hosted-agent `codex-reasoning.js`). */
const WIRE_EFFORTS = harden([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * The Responses spelling of an effort (R4-23): `ultra` is sent as `max`; an
 * effort the API does not take is undefined.
 * @param {string | null | undefined} effort
 * @returns {string | undefined}
 */
export const codexEffort = effort => {
  if (effort === 'ultra') return 'max';
  return typeof effort === 'string' && WIRE_EFFORTS.includes(effort)
    ? effort
    : undefined;
};
harden(codexEffort);

// Events that stay inside this client until the answer completes (the
// reference's `BUFFERED_PROGRESS_EVENTS`): they do not fence a retry.
const BUFFERED = new Set([
  'response.created',
  'response.in_progress',
  'response.metadata',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
]);
const FAILURE_EVENTS = new Set([
  'error',
  'response.failed',
  'response.incomplete',
]);
const TOKENISH =
  /(?:^|_)(?:sk|pk|rk|gsk|hf|ghp|gho|ghs|ghu|glpat|xox[a-z]?|bearer)(?:_|$)/i;

/**
 * A symbolic identifier (`snake_case`, no credential-shaped part), else
 * undefined.
 * @param {unknown} value
 */
const symbolic = value =>
  typeof value === 'string' &&
  /^[a-z]{1,16}(?:_[a-z]{1,16}){0,5}$/.test(value) &&
  !TOKENISH.test(value)
    ? value
    : undefined;

/**
 * A known event type as it may appear in a failure text, else
 * `unrecognized` (the reference's `diagnosticEventType`).
 * @param {unknown} type
 */
const eventTypeText = type =>
  typeof type === 'string' &&
  type.length <= 96 &&
  /^(?:response|stream)\.[a-z_]{1,24}(?:\.[a-z_]{1,24}){0,3}$/.test(type) &&
  !/(?:^|[._])(?:sk|pk|rk|gsk|hf|ghp|gho|ghs|ghu|glpat|xox[a-z]?|bearer)(?:[._]|$)/i.test(
    type,
  )
    ? type
    : 'unrecognized';

/**
 * The failure text of a failure event: its type and the symbolic facts it
 * names (the reference's `responseFailure`), never prose or a body.
 * @param {any} event
 */
export const responsesFailureText = event => {
  const error =
    event.type === 'error' ? (event.error ?? event) : event.response?.error;
  const code =
    typeof error?.code === 'number' &&
    Number.isInteger(error.code) &&
    Number(error.code) >= 0 &&
    Number(error.code) <= 99_999
      ? `${error.code}`
      : symbolic(error?.code);
  const type = error === event ? undefined : symbolic(error?.type);
  const reason = symbolic(event.response?.incomplete_details?.reason);
  const rawParam = error?.param;
  const param =
    typeof rawParam === 'string' &&
    rawParam.length <= 128 &&
    rawParam.split('.').length <= 6 &&
    rawParam.split('.').every(part => {
      const match = /^([a-z_]+)(?:\[[0-9]{1,5}\])?$/.exec(part);
      return match !== null && symbolic(match[1]) !== undefined;
    })
      ? rawParam
      : undefined;
  const facts = Object.entries({ code, type, param, reason })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`);
  const key = code ?? reason;
  const explanations = /** @type {Record<string, string>} */ (
    codexExplanations
  );
  const explanation =
    key !== undefined && Object.hasOwn(explanations, key)
      ? explanations[key]
      : undefined;
  return subscriptionTextOf.responsesFailed(
    event.type === 'error' ? 'error' : eventTypeText(event.type),
    facts,
    explanation,
  );
};
harden(responsesFailureText);

/**
 * The reasoning items of a native context, when it was made for `model`
 * and `text`; else undefined (R4-31).
 * @param {any} providerContext
 * @param {string} model
 * @param {string} text
 */
const replayedReasoning = (providerContext, model, text) => {
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
    native.kind !== 'responses' ||
    native.model !== model ||
    native.textDigest !== textDigest(text) ||
    !Array.isArray(native.items)
  )
    return undefined;
  for (const item of native.items) {
    if (
      item?.type !== 'reasoning' ||
      typeof item.encrypted_content !== 'string'
    )
      return undefined;
  }
  return native.items;
};

/**
 * The Responses `input` of a projection (transcript records): user and
 * assistant messages, the replayed reasoning items before an assistant's
 * text, `function_call` items and their `function_call_output`s (a
 * `viewImage` result as an `input_image` output, `images.js`). A call
 * whose result is missing gets `texts.toolOutcomeUnknown` (the API refuses
 * a call without its output, R4-32). Call ids are the op ids, mapped into
 * the tool id alphabet as the Claude client does.
 * @param {readonly any[]} transcript
 * @param {string} model
 */
export const codexInput = (transcript, model) => {
  /** @type {any[]} */
  const input = [];
  // M8: viewImage results as input_image outputs (images.js, seam S-19).
  const images = toolResultImages(transcript);
  /** @type {string[]} */
  let waiting = [];
  const answerWaiting = () => {
    for (const id of waiting) {
      input.push({
        type: 'function_call_output',
        call_id: id,
        output: texts.toolOutcomeUnknown,
      });
    }
    waiting = [];
  };
  for (const record of transcript) {
    if (record.kind === 'message' && record.role === 'assistant') {
      answerWaiting();
      const text = String(record.content ?? '');
      const reasoning = replayedReasoning(record.providerContext, model, text);
      if (reasoning !== undefined) input.push(...reasoning);
      if (text !== '') input.push({ role: 'assistant', content: text });
    } else if (record.kind === 'tool-call') {
      const id = anthropicToolId(String(record.id));
      input.push({
        type: 'function_call',
        call_id: id,
        name: String(record.name),
        arguments: String(record.args ?? '{}'),
      });
      waiting.push(id);
    } else if (record.kind === 'tool-result') {
      const id = anthropicToolId(String(record.id));
      const at = waiting.indexOf(id);
      if (at >= 0) {
        waiting.splice(at, 1);
        input.push({
          type: 'function_call_output',
          call_id: id,
          output: responsesToolOutput(images(record)),
        });
      }
    } else if (record.kind === 'message') {
      answerWaiting();
      const text = String(record.content ?? '');
      if (text !== '') input.push({ role: 'user', content: text });
    }
  }
  answerWaiting();
  return input;
};
harden(codexInput);

/**
 * A round's tools as Responses function tools (`parameters` is JSON Schema
 * text; one that does not parse as an object schema is an empty object).
 * @param {readonly any[]} tools
 */
export const codexTools = tools =>
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
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: schema,
    };
  });
harden(codexTools);

/**
 * The Responses request body of one member attempt (exported for tests).
 * @param {object} request
 * @param {string} request.modelId
 * @param {string} [request.reasoningEffort]
 * @param {string} [request.system] the round's system text, plain
 * @param {readonly any[]} request.tools
 * @param {readonly any[]} [request.transcript]
 */
export const codexBody = ({
  modelId,
  reasoningEffort,
  system,
  tools,
  transcript = [],
}) => {
  const effort = codexEffort(reasoningEffort);
  return {
    model: modelId,
    instructions: typeof system === 'string' ? system : '',
    input: codexInput(transcript, modelId),
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    ...(tools.length ? { tools: codexTools(tools) } : {}),
  };
};
harden(codexBody);

/** @param {string | undefined} name */
const missingTypeReason = name => {
  if (!name) return 'event-type-no-name';
  if (name === 'message') return 'event-type-message';
  if (
    BUFFERED.has(name) ||
    FAILURE_EVENTS.has(name) ||
    name === 'response.output_text.delta' ||
    name === 'response.completed'
  )
    return 'event-type-known-name';
  return 'event-type-other-name';
};

/**
 * Classify the MIME type without putting a provider-supplied header in errors.
 * @param {string | null} contentType
 */
const mimeClass = contentType => {
  if (!contentType) return 'missing';
  if (
    /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json\s*(?:;|$)/i.test(contentType)
  )
    return 'json';
  if (/^(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(contentType))
    return 'html';
  return 'other';
};

/**
 * The request headers of one attempt (the reference's Codex profile).
 * @param {import('./types.js').Credential} credential
 */
export const codexHeaders = credential =>
  harden({
    authorization: `Bearer ${credential.accessToken}`,
    ...(typeof credential.accountId === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(credential.accountId)
      ? { 'chatgpt-account-id': credential.accountId }
      : {}),
    originator: CODEX_ORIGINATOR,
    accept: 'text/event-stream',
  });
harden(codexHeaders);

/**
 * A completed output item, kept in the form it is replayed or read in.
 * @param {any} item
 */
const keptItem = item => {
  if (item?.type === 'reasoning') {
    return {
      type: 'reasoning',
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      summary: Array.isArray(item.summary) ? item.summary : [],
      encrypted_content:
        typeof item.encrypted_content === 'string'
          ? item.encrypted_content
          : '',
    };
  }
  return item;
};

/**
 * One streamed attempt on one member (`WireAttempt`, `types.js`). Options
 * beyond the type: `now`, `settings` (`subscriptionDefaults`).
 * The type's `member` is accepted and not read: the credential is the
 * member's.
 * @param {object} options
 * @param {import('./types.js').Credential} options.credential
 * @param {any} options.projection `{ transcript }` of the round (always
 *   given: a pool round needs its projection, `PREPARE_REQUIRED`)
 * @param {{ modelId: string, reasoningEffort?: string, maxOutputTokens?: number, system?: string, tools: readonly any[] }} options.request
 * @param {any} [options.spec] the `PoolSpec` (`baseUrl`, `timeoutMs`)
 * @param {AbortSignal} options.signal
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {(reading: import('./types.js').Reading) => void} [options.onReading]
 * @param {() => number} [options.now]
 * @param {{ requestTimeoutMs: number }} [options.settings]
 * @returns {AsyncGenerator<import('../providers/round.js').RoundEvent, void, undefined>}
 */
export async function* codexAttempt({
  credential,
  projection,
  request,
  spec = {},
  signal,
  fetch,
  onReading,
  now = () => Date.now(),
  settings = subscriptionDefaults,
}) {
  const modelId = String(request.modelId);
  if (
    request.reasoningEffort !== undefined &&
    codexEffort(request.reasoningEffort) === undefined
  ) {
    throw wireFailure(subscriptionTexts.unsupportedEffort);
  }
  const body = codexBody({
    modelId,
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort }),
    ...(request.system === undefined ? {} : { system: request.system }),
    tools: request.tools ?? [],
    transcript: projection.transcript,
  });
  // INT-M4: the M2 review's base URL rule (https, or http to loopback)
  // holds for pools too: a credential goes nowhere else.
  const baseUrl = providerBaseUrl(spec.baseUrl, CODEX_BASE_URL);
  const timeoutMs = spec.timeoutMs ?? settings.requestTimeoutMs;
  const observer = observingFetch({
    ...(fetch === undefined ? {} : { fetch }),
    ...(onReading === undefined ? {} : { onReading }),
    now,
  });
  let delivered = false;
  /** The reference's retry fence: something left this client. */
  let fenced = false;

  /**
   * @param {unknown} error
   * @param {AbortSignal | undefined} requestSignal
   */
  const transport = (error, requestSignal) => {
    const kind = failureKind(error, signal, requestSignal);
    if (kind === 'aborted') return error;
    return wireFailure(
      subscriptionTextOf.responsesFailed(
        kind === 'timeout' ? 'stream.timeout' : 'stream.unreachable',
        [],
      ),
      { delivered, timedOut: kind === 'timeout' },
    );
  };

  /** @type {Response & { requestSignal?: AbortSignal }} */
  let response;
  try {
    response = await postJson({
      url: `${baseUrl}${CODEX_RESPONSES_PATH}`,
      headers: codexHeaders(credential),
      body,
      signal,
      ...(Number(timeoutMs) > 0 ? { timeoutMs } : {}),
      fetch: observer.fetch,
    });
  } catch (error) {
    throw transport(error, undefined);
  }
  if (!response.ok) {
    const status = response.status;
    const after = retryAfterMs(response, now);
    const exhausted = status === 429 ? observer.exhausted() : undefined;
    discardBody(response);
    throw wireFailure(subscriptionTextOf.subscriptionHttp(status), {
      status,
      ...(exhausted === undefined ? {} : { exhausted }),
      ...(status === 401 ? { rejected: true } : {}),
      ...(after === undefined ? {} : { retryAfterMs: after }),
    });
  }
  const contentType = response.headers.get('content-type');
  if (
    contentType !== null &&
    !/^text\/event-stream[ \t]*(?:;|$)/i.test(contentType)
  ) {
    discardBody(response);
    throw wireFailure(
      subscriptionTextOf.responsesFailed('stream.unreadable', [
        `mime=${mimeClass(contentType)}`,
      ]),
    );
  }

  // Headerless successes still require a complete Responses SSE stream.
  let sawEvent = false;
  const framingFacts = () =>
    contentType === null
      ? [
          'mime=missing',
          `status=${response.status}`,
          `sse=${sawEvent ? 'seen' : 'none'}`,
        ]
      : [];

  /** @type {any} */
  let completed;
  /** @type {any} */
  let usageRaw;
  /** @type {unknown} */
  let model;
  /** @type {Map<number, any>} */
  const items = new Map();
  /** @type {any[]} */
  const unindexed = [];
  // The round's text, digested as it streams (the native context's check).
  const digest = createHash('sha256');
  let textLength = 0;

  try {
    // INT-M4: a round's whole stream is bounded as M2's providers bound it.
    for await (const batch of parseSseBatches(
      boundedChunks(bodyChunks(response), limits.roundStreamBytes, () =>
        wireFailure(texts.frameLimit, { delivered }),
      ),
    )) {
      /** @type {string[]} */
      const pieces = [];
      /** @type {any} */
      let failed;
      /** @type {string | undefined} */
      let unreadable;
      sawEvent = true;
      for (const { data, event: name } of batch) {
        // Nothing after completion counts (a `[DONE]` or `stream.done`
        // marker, trailing metadata).
        if (completed !== undefined || data === '[DONE]') break;
        /** @type {any} */
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          unreadable = 'json-parse';
          break;
        }
        if (
          event === null ||
          typeof event !== 'object' ||
          Array.isArray(event)
        ) {
          unreadable = 'non-object';
          break;
        }
        // A named SSE error may carry the error object without a JSON type.
        if (name === 'error' && event.type === undefined) event.type = 'error';
        const type = event.type;
        if (typeof type !== 'string') {
          unreadable = missingTypeReason(name);
          break;
        }
        const failureEvent = FAILURE_EVENTS.has(type);
        // The reference's fence: usage, response output, visible text, an
        // incomplete response or an unknown event block a retry.
        if (
          event.usage != null ||
          event.response?.usage != null ||
          (event.response?.output !== undefined &&
            (!Array.isArray(event.response.output) ||
              event.response.output.length !== 0)) ||
          type === 'response.incomplete' ||
          type === 'response.output_text.delta' ||
          (!failureEvent &&
            !BUFFERED.has(type) &&
            type !== 'response.completed')
        ) {
          fenced = true;
        }
        if (model === undefined && typeof event.response?.model === 'string')
          model = event.response.model;
        if (failureEvent) {
          failed = event;
          break;
        }
        if (type === 'response.output_text.delta') {
          if (typeof event.delta === 'string' && event.delta !== '') {
            textLength += event.delta.length;
            pieces.push(event.delta);
          }
        } else if (type === 'response.output_item.done') {
          const index = event.output_index;
          if (
            index !== undefined &&
            (!Number.isSafeInteger(index) || Number(index) < 0)
          ) {
            unreadable = 'output-index';
            break;
          }
          if (
            event.item === null ||
            typeof event.item !== 'object' ||
            Array.isArray(event.item)
          ) {
            unreadable = 'output-item';
            break;
          }
          if (typeof event.item.type !== 'string') {
            unreadable = 'output-item-type';
            break;
          }
          if (items.size + unindexed.length >= MAX_ITEMS && !items.has(index)) {
            throw wireFailure(texts.frameLimit, { delivered });
          }
          const item = keptItem(event.item);
          if (index === undefined) unindexed.push(item);
          else items.set(index, item);
        } else if (type === 'response.completed') {
          completed = event.response ?? {};
          usageRaw = completed.usage;
        }
      }
      if (pieces.length > 0) {
        delivered = true;
        const delta = pieces.length === 1 ? pieces[0] : pieces.join('');
        digest.update(delta, 'utf8');
        yield { delta };
      }
      if (failed !== undefined) {
        const error =
          failed.type === 'error'
            ? (failed.error ?? failed)
            : failed.response?.error;
        const overloaded =
          failed.type !== 'response.incomplete' &&
          error?.code === 'server_is_overloaded';
        throw wireFailure(responsesFailureText(failed), {
          delivered,
          retryable: overloaded && !fenced && !delivered,
          ...(overloaded ? { overloaded: true } : {}),
        });
      }
      if (unreadable) {
        throw wireFailure(
          subscriptionTextOf.responsesFailed('stream.unreadable', [
            `reason=${unreadable}`,
            ...framingFacts(),
          ]),
          {
            delivered,
          },
        );
      }
    }
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    const kind = failureKind(error, signal, response.requestSignal);
    if (kind === 'aborted') throw error;
    if (kind === 'timeout') throw transport(error, response.requestSignal);
    // A body that ended inside an event, bad UTF-8, a reset: not a whole
    // answer.
    throw wireFailure(
      subscriptionTextOf.responsesFailed('stream.incomplete', framingFacts()),
      {
        delivered,
      },
    );
  }
  if (completed === undefined) {
    throw wireFailure(
      subscriptionTextOf.responsesFailed('stream.incomplete', framingFacts()),
      {
        delivered,
      },
    );
  }
  // Wait for every explicit index before assigning remaining positions.
  let nextIndex = 0;
  for (const item of unindexed) {
    while (items.has(nextIndex)) nextIndex += 1;
    items.set(nextIndex, item);
    nextIndex += 1;
  }
  const output =
    Array.isArray(completed.output) && Number(completed.output.length) > 0
      ? completed.output.map(keptItem)
      : [...items.entries()].sort((a, b) => a[0] - b[0]).map(([, i]) => i);

  /** @type {{ callId?: string, name: string, args: string }[]} */
  const calls = [];
  /** @type {any[]} */
  const reasoning = [];
  let outputText = '';
  for (const item of output) {
    if (item?.type === 'function_call') {
      calls.push({
        ...(typeof item.call_id === 'string' ? { callId: item.call_id } : {}),
        name: typeof item.name === 'string' ? item.name : '',
        args:
          typeof item.arguments === 'string' && item.arguments !== ''
            ? item.arguments
            : '{}',
      });
    } else if (item?.type === 'reasoning') {
      if (item.encrypted_content !== '') reasoning.push(item);
    } else if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string')
          outputText += part.text;
        else if (part?.type === 'refusal' && typeof part.refusal === 'string')
          outputText += part.refusal;
      }
    }
  }
  // A message whose text arrived only in the completed items (no deltas).
  if (textLength === 0 && outputText !== '') {
    delivered = true;
    digest.update(outputText, 'utf8');
    textLength = outputText.length;
    yield { delta: outputText };
  }
  const usage =
    usageRaw !== null && typeof usageRaw === 'object'
      ? usageFromOpenRouter({
          prompt_tokens: usageRaw.input_tokens,
          completion_tokens: usageRaw.output_tokens,
          prompt_tokens_details: {
            cached_tokens: usageRaw.input_tokens_details?.cached_tokens,
          },
          completion_tokens_details: {
            reasoning_tokens: usageRaw.output_tokens_details?.reasoning_tokens,
          },
        })
      : undefined;
  if (textLength === 0 && calls.length === 0) {
    if (usage !== undefined) yield { usage };
    throw wireFailure(subscriptionTexts.emptyResponsesOutput, { delivered });
  }
  for (const call of calls) yield { toolCall: call };
  if (reasoning.length > 0) {
    yield {
      nativeContext: JSON.stringify({
        v: NATIVE_VERSION,
        kind: 'responses',
        model: modelId,
        textDigest: digest.digest('hex').slice(0, 32),
        items: reasoning,
      }),
    };
  }
  /** @type {{ modelId?: string }} */
  const servedBy = {};
  if (typeof model === 'string' && MODEL.test(model)) servedBy.modelId = model;
  yield { servedBy };
  if (usage !== undefined) yield { usage };
  yield { stop: calls.length > 0 ? 'tool_calls' : 'completed' };
}
harden(codexAttempt);
