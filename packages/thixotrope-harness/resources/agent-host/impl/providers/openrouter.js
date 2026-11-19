// @ts-check
/**
 * The OpenRouter provider, streamed (M2 W2.1a; R4-12, R4-13, R4-41, R4-74,
 * R4-78, R4-79, R4-108; G-03; designs/m2-interfaces.md 8.1).
 *
 * Chat completions with `stream: true` (the Endo provider asked with
 * `stream: false`, so its UI saw each reply whole: G-03, not copied), and
 * `tools` with `tool_choice: 'auto'` when the round offers tools. The answer
 * is read as server-sent events (`sse.js`, linear): `delta.content` is
 * published to the session's channel as it arrives (acceptance 1), one
 * delta per network read (the events that arrived together are joined:
 * publishing costs about 25 us per delta, J-0413),
 * `delta.tool_calls` fragments are joined per `index` into whole calls whose
 * arguments stay text, the `finish_reason` and the trailing usage chunk are
 * kept, `[DONE]` ends it. What the answer means is lal
 * `providers/openrouter.js`'s (1315bef86), adapted to a stream:
 *
 * - `content_filter`: `textOf.openRouterStopped('content_filter', served)`;
 * - `length` with text and no tool call: the text plus `\n\n` and
 *   `texts.outputLimitNote` (published as one more delta, so the transcript
 *   and the live view agree); `length` without text, or with a tool call cut
 *   mid-argument: `textOf.openRouterStopped('length', served)`;
 * - neither text (after trimming) nor a tool call:
 *   `textOf.openRouterEmpty(details)` (retryable while nothing was
 *   delivered, R4-74: W2.1b);
 * - an `error` object in a chunk: `textOf.openRouterApiError(details)`; a
 *   finish reason `error`, or a stream that ends before any finish reason
 *   (a mid-stream disconnect): `textOf.openRouterNoMessage(details)` or
 *   `texts.openRouterUnreachable`;
 * - a non-2xx status: `textOf.openRouterHttp(status)` (the body is never
 *   read); no response: `texts.openRouterUnreachable`; the request timeout
 *   (`spec.timeoutMs`, default 1 h, R4-93): `textOf.openRouterTimeout(s)`.
 *
 * `served` and `details` are lal's parenthesised facts, each value shown
 * only when it has the shape of the identifier it should be (`shown`, lal's
 * SHAPES/KEY_PREFIX/looksRandom rules, ported word for word): no provider
 * body, and nothing shaped like a key, reaches a failure text (R4-79). The
 * served-by model and provider of a successful round go into its
 * `servedBy` (R4-108).
 *
 * The key is read through the backend's grant at every round (`readKey()`,
 * R4-82; W2.3's read path, wired by W2.2): a read failure fails the round
 * with `textOf.secretFailed(code)`. The model id must be `org/model`
 * (`texts.openRouterModelPrefix`). No output limit is sent unless the round
 * asks for one (`options.maxOutputTokens`, R4-92: OpenRouter none).
 *
 * Retry (R4-74, R4-105; W2.1b, `retry.js`): by default every round runs
 * its attempts through `makeRetry({ delayMs: openRouterDelay })`: 408, 429,
 * 5xx, network failures, unreadable and empty answers are asked again, at
 * most 3 attempts, one timeout retry, waiting `min(30 s, max(Retry-After,
 * 1 s x 3^(n-1)))`, only while nothing was delivered (no text published, no
 * tokens reported); each retry is logged `retry` (attempt, wait, status;
 * never a body). `makeOpenRouterProvider({ retry })` replaces the wrapper
 * (`({ attempt, signal }) => AsyncIterable<RoundEvent>`). An attempt's
 * failure is a `ProviderFailure` with `retryable`, `retryAfterMs`,
 * `timedOut` and `delivered` (it published text or reported tokens) set.
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { texts, textOf } from '../../../../guest/lib/interfaces.js';
import { limits } from '../../../../guest/lib/limits.js';
import { usageFromOpenRouter } from '../../../../guest/lib/token-usage.js';
/* eslint-enable import/no-relative-packages */
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
import { ProviderFailure } from './round.js';
import { isDelivery, openRouterDelay } from './retry.js';
import { makeApiProvider } from './api.js';
import { chatImageMessages, toolResultImages } from './images.js';
import {
  CATALOG_BODY_BYTES,
  CATALOG_MAX_MODELS,
  CATALOG_READ_TIMEOUT_MS,
  catalogFail,
  catalogModel,
  readJson,
  tokenCount,
} from './catalog-core.js';

/** OpenRouter's API base (a spec's `baseUrl` replaces it: the fake server). */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** R4-93: one request may take an hour. */
export const OPENROUTER_TIMEOUT_MS = 3_600_000;

// ---- What of a response may be shown (lal providers/openrouter.js:72-157)

const SHAPES = harden({
  // 429, or a symbolic code such as `rate_limited`.
  code: /^(?:\d{1,5}|[a-z]{1,16}(?:_[a-z]{1,16}){0,3})$/,
  // `stop`, `error`, `length`, ...
  reason: /^[a-z]{1,16}(?:_[a-z]{1,16}){0,2}$/,
  // `vendor/model-7b:free`: always qualified by its organization.
  model: /^[a-z0-9][a-z0-9.-]{0,31}\/[A-Za-z0-9][A-Za-z0-9.:+-]{0,63}$/,
  // `Google AI Studio`: at most three short words.
  provider: /^[A-Za-z0-9][A-Za-z0-9.+-]{0,15}(?: [A-Za-z0-9.+-]{1,16}){0,2}$/,
});
const LONGEST_WORD = 16;
const KEY_PREFIX =
  /(?:^|[^A-Za-z0-9])(?:sk|pk|rk|gsk|hf|ghp|gho|ghs|ghu|glpat|xox[a-z]?|bearer)(?:[^A-Za-z]|$)/i;
const GLUED_KEY_PREFIX = /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA|AIza|eyJ)[A-Za-z0-9]/;

/** @param {string} text */
const looksRandom = text => {
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (
    words.some(
      word => word.length >= 12 && /^[0-9a-f]+$/i.test(word) && /\d/.test(word),
    )
  ) {
    return true;
  }
  const mixed = words.filter(
    word =>
      word.length >= 8 &&
      /[A-Za-z]/.test(word) &&
      (word.match(/\d/g) || []).length >= 3,
  );
  return mixed.length >= 2;
};

/**
 * The value when it has the shape of `shape`'s identifier, else undefined.
 * @param {keyof typeof SHAPES} shape
 * @param {unknown} value
 * @returns {string | undefined}
 */
export const shown = (shape, value) => {
  const text =
    typeof value === 'number' && Number.isFinite(value) ? `${value}` : value;
  if (typeof text !== 'string' || !SHAPES[shape].test(text)) return undefined;
  if (text.split(/[^A-Za-z0-9_]+/).some(word => word.length > LONGEST_WORD)) {
    return undefined;
  }
  if (KEY_PREFIX.test(text) || GLUED_KEY_PREFIX.test(text)) return undefined;
  if (looksRandom(text)) return undefined;
  return text;
};
harden(shown);

/**
 * lal's `describe`: ` (label value, ...)` of the facts that may be shown.
 * @param {Array<[string, keyof typeof SHAPES, unknown]>} facts
 */
export const describeFacts = facts => {
  /** @type {[string, string][]} */
  const parts = [];
  for (const [label, shape, value] of facts) {
    const text = shown(shape, value);
    if (text !== undefined) parts.push([label, text]);
  }
  return textOf.servedBy(parts);
};
harden(describeFacts);

/** @param {unknown} status */
const retryableStatus = status =>
  status === 408 ||
  status === 429 ||
  (typeof status === 'number' && status >= 500 && status <= 599);

// ---- The request

/**
 * The OpenAI-compatible messages of a projection (transcript records,
 * projection.js): an assistant message and the tool calls that follow it
 * become one message with `tool_calls` (lal openai-compatible-messages.js);
 * a tool result becomes a `tool` message (a `viewImage` result: its
 * receipt, and the image in one user message after the round's tool
 * messages, `images.js`).
 * @param {readonly any[]} transcript
 * @param {string | undefined} system
 */
export const openRouterMessages = (transcript, system) => {
  /** @type {any[]} */
  const messages = [];
  if (system !== undefined && system !== '')
    messages.push({ role: 'system', content: system });
  // M8: viewImage results as one user message after the round's tool
  // messages (images.js, seam S-19).
  const images = toolResultImages(transcript);
  /** @type {{ id: string, image: any }[]} */
  let pending = [];
  /** @type {any} */
  let assistant;
  for (const record of transcript) {
    if (record.kind !== 'tool-result' && pending.length > 0) {
      messages.push(...chatImageMessages(pending));
      pending = [];
    }
    if (record.kind === 'message' && record.role === 'assistant') {
      assistant = { role: 'assistant', content: record.content ?? '' };
      messages.push(assistant);
    } else if (record.kind === 'tool-call') {
      if (assistant === undefined) {
        assistant = { role: 'assistant', content: null };
        messages.push(assistant);
      }
      if (assistant.tool_calls === undefined) {
        assistant.tool_calls = [];
        if (assistant.content === '') assistant.content = null;
      }
      assistant.tool_calls.push({
        id: record.id,
        type: 'function',
        function: { name: record.name, arguments: record.args },
      });
    } else if (record.kind === 'tool-result') {
      const { text, image } = images(record);
      if (image !== undefined) pending.push({ id: record.id, image });
      messages.push({ role: 'tool', tool_call_id: record.id, content: text });
    } else if (record.kind === 'message') {
      assistant = undefined;
      messages.push({ role: record.role, content: record.content ?? '' });
    }
  }
  messages.push(...chatImageMessages(pending));
  return messages;
};
harden(openRouterMessages);

/**
 * A round's tools as OpenAI-style function tools. `parameters` is JSON
 * Schema as text (the contract's `ToolDescription`); one that does not
 * parse is offered as an empty object schema.
 * @param {readonly any[]} tools
 */
export const openRouterTools = tools =>
  tools.map(tool => {
    let parameters;
    try {
      parameters = JSON.parse(tool.parameters);
    } catch {
      parameters = { type: 'object', properties: {} };
    }
    return {
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters },
    };
  });
harden(openRouterTools);

/**
 * The request body (exported for tests).
 * @param {object} request
 * @param {string} request.model
 * @param {any[]} request.messages
 * @param {readonly any[]} request.tools
 * @param {number} [request.maxOutputTokens]
 * @param {string} [request.reasoningEffort]
 */
export const openRouterBody = ({
  model,
  messages,
  tools,
  maxOutputTokens,
  reasoningEffort,
}) => ({
  model,
  messages,
  ...(tools.length
    ? { tools: openRouterTools(tools), tool_choice: 'auto' }
    : {}),
  stream: true,
  // OpenRouter reports usage in the last chunk of a stream when asked
  // (usage accounting). [real-provider]: confirm the field against the API.
  usage: { include: true },
  ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
  ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
});
harden(openRouterBody);

/**
 * One streamed attempt: the events of `runProviderRound`, or a thrown
 * `ProviderFailure`.
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.key
 * @param {any} options.body
 * @param {AbortSignal} options.signal
 * @param {number} options.timeoutMs
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @returns {AsyncGenerator<import('./round.js').RoundEvent, void, undefined>}
 */
export async function* openRouterAttempt({
  url,
  key,
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
        ? textOf.openRouterTimeout(seconds)
        : texts.openRouterUnreachable,
      { retryable: true, timedOut: kind === 'timeout', delivered },
    );
  };
  /** @type {Response & { requestSignal?: AbortSignal }} */
  let response;
  try {
    response = await postJson({
      url,
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'text/event-stream',
      },
      body,
      signal,
      timeoutMs,
      ...(fetch === undefined ? {} : { fetch }),
    });
  } catch (error) {
    throw transport(error, undefined);
  }
  if (!response.ok) {
    const after = retryAfterMs(response, now);
    discardBody(response);
    throw new ProviderFailure(textOf.openRouterHttp(response.status), {
      retryable: retryableStatus(response.status),
      status: response.status,
      ...(after === undefined ? {} : { retryAfterMs: after }),
    });
  }
  if (
    !/^text\/event-stream(?:;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  ) {
    discardBody(response);
    throw new ProviderFailure(texts.openRouterUnreachable, { retryable: true });
  }

  /** @type {unknown} */
  let model;
  /** @type {unknown} */
  let provider;
  /** @type {string | undefined} */
  let finishReason;
  /** @type {any} */
  let usage;
  /** @type {any} */
  let apiError;
  let done = false;
  let nonBlank = false;
  let textLength = 0;
  /** index -> the call being joined */
  /** @type {Map<number, { id?: string, name: string, args: string[] }>} */
  const calls = new Map();
  const served = () =>
    describeFacts([
      ['served by', 'model', model],
      ['via', 'provider', provider],
    ]);
  try {
    // One delta per network read (J-0413): the content of every event that
    // arrived in one body chunk is published together.
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
        if (data === '[DONE]') {
          done = true;
          break;
        }
        /** @type {any} */
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          unreadable = true;
          break;
        }
        if (chunk === null || typeof chunk !== 'object') chunk = {};
        if (model === undefined && chunk.model !== undefined)
          model = chunk.model;
        if (provider === undefined && chunk.provider !== undefined)
          provider = chunk.provider;
        if (chunk.error !== undefined && chunk.error !== null) {
          apiError = chunk.error;
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          usage = usageFromOpenRouter(chunk.usage);
        }
        const choice = Array.isArray(chunk.choices)
          ? chunk.choices[0]
          : undefined;
        if (choice !== undefined && choice !== null) {
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content !== '') {
            if (!nonBlank && delta.content.trim() !== '') nonBlank = true;
            textLength += delta.content.length;
            pieces.push(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const fragment of delta.tool_calls) {
              const index = Number.isInteger(fragment?.index)
                ? fragment.index
                : calls.size;
              let call = calls.get(index);
              if (call === undefined) {
                if (calls.size >= 4096) {
                  throw new ProviderFailure(texts.frameLimit, { delivered });
                }
                call = { name: '', args: [] };
                calls.set(index, call);
              }
              if (typeof fragment?.id === 'string' && fragment.id !== '')
                call.id = fragment.id;
              const fn = fragment?.function;
              if (typeof fn?.name === 'string' && fn.name !== '')
                call.name = fn.name;
              if (typeof fn?.arguments === 'string')
                call.args.push(fn.arguments);
            }
          }
          if (typeof choice.finish_reason === 'string')
            finishReason = choice.finish_reason;
        }
      }
      if (pieces.length > 0) {
        delivered = true;
        yield { delta: pieces.length === 1 ? pieces[0] : pieces.join('') };
      }
      if (unreadable) {
        throw new ProviderFailure(texts.openRouterUnreachable, {
          retryable: !delivered,
          delivered,
        });
      }
      if (done) break;
    }
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw transport(error, response.requestSignal);
  }
  if (usage !== undefined) {
    // Tokens consumed are a delivery (R4-74: lal's `consumed`, usage with
    // a positive count); a zero reading is not.
    if (isDelivery({ usage })) delivered = true;
    yield { usage };
  }
  if (apiError !== undefined) {
    throw new ProviderFailure(
      textOf.openRouterApiError(
        describeFacts([
          ['code', 'code', apiError?.code],
          ['served by', 'model', model],
          ['via', 'provider', provider],
        ]),
      ),
      {
        retryable:
          !delivered &&
          retryableStatus(
            typeof apiError?.code === 'string' && /^\d{3}$/.test(apiError.code)
              ? Number(apiError.code)
              : apiError?.code,
          ),
        delivered,
      },
    );
  }
  if (finishReason === undefined) {
    // Cut before the model said why it stopped: not a whole answer.
    throw new ProviderFailure(
      done
        ? textOf.openRouterNoMessage(
            describeFacts([
              ['finish_reason', 'reason', 'none'],
              ['served by', 'model', model],
              ['via', 'provider', provider],
            ]),
          )
        : texts.openRouterUnreachable,
      { retryable: !delivered, delivered },
    );
  }
  if (finishReason === 'error') {
    throw new ProviderFailure(
      textOf.openRouterNoMessage(
        describeFacts([
          ['finish_reason', 'reason', finishReason],
          ['served by', 'model', model],
          ['via', 'provider', provider],
        ]),
      ),
      { retryable: !delivered, delivered },
    );
  }
  if (finishReason === 'content_filter') {
    throw new ProviderFailure(
      textOf.openRouterStopped('content_filter', served()),
      { delivered },
    );
  }
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]);
  if (finishReason === 'length' && (textLength === 0 || toolCalls.length > 0)) {
    throw new ProviderFailure(textOf.openRouterStopped('length', served()), {
      delivered,
    });
  }
  if (toolCalls.length === 0 && !nonBlank) {
    // Only whitespace, or nothing: lal's empty answer.
    throw new ProviderFailure(
      textOf.openRouterEmpty(
        `${describeFacts([['finish_reason', 'reason', finishReason]])}${served()}`,
      ),
      { retryable: !delivered, delivered },
    );
  }
  if (finishReason === 'length') {
    yield { delta: `\n\n${texts.outputLimitNote}` };
  }
  for (const [, call] of toolCalls) {
    yield {
      toolCall: {
        ...(call.id === undefined ? {} : { callId: call.id }),
        name: call.name,
        args: call.args.join(''),
      },
    };
  }
  /** @type {{ modelId?: string, provider?: string }} */
  const servedBy = {};
  const shownModel = shown('model', model);
  const shownProvider = shown('provider', provider);
  if (shownModel !== undefined) servedBy.modelId = shownModel;
  if (shownProvider !== undefined) servedBy.provider = shownProvider;
  yield { servedBy };
  yield { stop: finishReason };
}
harden(openRouterAttempt);

/**
 * OpenRouter's chat completions request and answer for the API provider
 * (`api.js`).
 * @type {import('./api.js').ApiWire}
 */
export const openRouterWire = harden({
  baseUrl: OPENROUTER_BASE_URL,
  timeoutMs: OPENROUTER_TIMEOUT_MS,
  path: '/chat/completions',
  unreachable: texts.openRouterUnreachable,
  model: req => {
    const model = req.options.modelId;
    if (typeof model !== 'string' || !model.includes('/'))
      throw new ProviderFailure(texts.openRouterModelPrefix);
    return model;
  },
  body: ({ model, transcript, system, req, spec }) =>
    openRouterBody({
      model,
      messages: openRouterMessages(transcript, system),
      tools: req.tools,
      maxOutputTokens: req.options.maxOutputTokens ?? spec.maxOutputTokens,
      reasoningEffort: req.options.reasoningEffort,
    }),
  delay: openRouterDelay,
  attempt: openRouterAttempt,
});

/**
 * An OpenRouter backend's provider (`api.js` `makeApiProvider`'s options
 * but `wire`).
 * @param {Omit<Parameters<typeof makeApiProvider>[0], 'wire'>} options
 */
export const makeOpenRouterProvider = options =>
  makeApiProvider({ ...options, wire: openRouterWire });
harden(makeOpenRouterProvider);

// ---- The model list (M2 W2.2, m2-interfaces.md 8.4; hosted-agent
// `openrouter-model-read.js`): validated and bounded, failing closed with a
// fixed text; a refused answer's body is never read, and no provider text
// other than model titles and descriptions (display data) is kept.

/** Printable ASCII, no space (hosted-agent's identifier rule). */
const IDENTIFIER = /^[\x21-\x7e]+$/;

/**
 * @param {unknown} value
 * @param {number} limit
 */
const textField = (value, limit) => {
  if (typeof value !== 'string' || value.length > limit)
    catalogFail('model text');
  return /** @type {string} */ (value);
};

/** @param {unknown} value */
const identifier = value => {
  const result = textField(value, 256);
  if (!IDENTIFIER.test(result)) catalogFail('model identifier');
  return result;
};

/** @param {unknown} value */
const identifiers = value => {
  if (!Array.isArray(value) || value.length > 64)
    catalogFail('model capabilities');
  const result = /** @type {unknown[]} */ (value).map(identifier);
  if (new Set(result).size !== result.length) catalogFail('model capabilities');
  return result;
};

/**
 * One OpenRouter model, validated (hosted-agent `normalizeModel`), or
 * undefined when it cannot serve the harness (no text in and out, or no
 * tool use: `modelsFromOpenRouterCatalog`).
 * @param {any} model
 * @returns {import('./catalog-core.js').CatalogModel | undefined}
 */
export const openRouterModel = model => {
  if (!model || typeof model !== 'object' || Array.isArray(model))
    catalogFail('model entry');
  const id = identifier(model.id);
  const title = textField(model.name, 1024);
  const description = textField(model.description ?? '', 16_384);
  const contextLength = tokenCount(model.context_length);
  if (
    model.top_provider != null &&
    (typeof model.top_provider !== 'object' ||
      Array.isArray(model.top_provider))
  )
    catalogFail('model provider metadata');
  const maxOutputTokens = tokenCount(model.top_provider?.max_completion_tokens);
  const inputs = identifiers(model.architecture?.input_modalities);
  const outputs = identifiers(model.architecture?.output_modalities);
  const parameters = identifiers(model.supported_parameters);
  if (
    !inputs.includes('text') ||
    !outputs.includes('text') ||
    !parameters.includes('tools')
  )
    return undefined;
  return catalogModel(id, title, description, contextLength, maxOutputTokens);
};
harden(openRouterModel);

/**
 * An OpenRouter catalogue (`GET <baseUrl>/models`).
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.key
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<import('./catalog-core.js').CatalogModel[]>}
 */
export const readOpenRouterModels = async ({
  baseUrl,
  key,
  fetch,
  timeoutMs = CATALOG_READ_TIMEOUT_MS,
}) => {
  const payload = await readJson({
    url: `${baseUrl}/models`,
    headers: { authorization: `Bearer ${key}` },
    fetch,
    timeoutMs,
    maxBytes: CATALOG_BODY_BYTES,
  });
  if (
    !Array.isArray(payload?.data) ||
    Number(payload.data.length) > CATALOG_MAX_MODELS ||
    payload.links?.next != null ||
    (payload.total_count !== undefined &&
      payload.total_count !== Number(payload.data.length))
  )
    catalogFail('catalogue shape');
  /** @type {import('./catalog-core.js').CatalogModel[]} */
  const models = [];
  const seen = new Set();
  for (const entry of payload.data) {
    const model = openRouterModel(entry);
    if (model !== undefined) {
      if (seen.has(model.id)) catalogFail('duplicate model');
      seen.add(model.id);
      models.push(model);
    }
  }
  return harden(models);
};
harden(readOpenRouterModels);

/**
 * R4-21: a creation's OpenRouter model names its organisation
 * (`org/model`, both parts present).
 * @param {string} modelId
 */
export const isOpenRouterModelId = modelId => /^[^/\s]+\/\S+$/.test(modelId);
harden(isOpenRouterModelId);

/** The `backendKinds` entry (`kinds.js`). */
export const openRouterKind = harden({
  kind: 'openrouter',
  makeProvider: makeOpenRouterProvider,
  /** The endpoint's text for a round that threw (R4-79: fixed). */
  unexpectedFailure: texts.openRouterUnreachable,
  // M4 W4.6 (H-14, D-M4-9): account status on API backends too.
  tools: harden(['accountStatus']),
  /** @type {import('./kinds.js').BackendKind['catalog']} */
  catalog: ({ models }) => models,
  /** @type {import('./kinds.js').BackendKind['readModels']} */
  readModels: ({ spec, fetch }) => {
    const baseUrl = providerBaseUrl(spec.baseUrl, OPENROUTER_BASE_URL);
    return key => readOpenRouterModels({ baseUrl, key, fetch });
  },
  acceptsModelId: isOpenRouterModelId,
});
