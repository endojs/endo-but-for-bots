// @ts-check
/* global fetch, setTimeout, clearTimeout */

import { boundedJson } from '@endo/hosted-agent/bounded-json.js';

import { toOpenAICompatibleMessages } from './openai-compatible-messages.js';

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * How many requests one `chat` may make. A request is repeated only when
 * nothing usable came back — the API refused it (429, 408, 5xx), the network
 * failed, or the answer held no assistant message — and never once a message
 * was delivered or positive token usage was reported. Missing usage is not
 * proof that an unsuccessful request was free.
 */
const MAX_ATTEMPTS = 3;
/** A request that outlives this is abandoned; it is repeated at most once. */
const REQUEST_TIMEOUT_MS = 300_000;
/** The longest a `Retry-After` is honoured for. */
const MAX_RETRY_AFTER_MS = 30_000;
/**
 * How long a reply waits for the model catalog, which is only read to say how
 * large the serving model's context window is. The catalog keeps loading
 * after that; a later reply has it.
 */
const CATALOG_WAIT_MS = 2000;
const CATALOG_TIMEOUT_MS = 20_000;
// Local metadata transport bound, matching the account-scoped catalog reader.
// This is not a context-window or generated-reply limit.
const MAX_CATALOG_BODY_BYTES = 16 * 1024 * 1024;
/** How long after a failed catalog read the next one waits. */
const CATALOG_RETRY_MS = 300_000;
/** Error diagnostics are small; never buffer an arbitrary error body. */
const MAX_ERROR_BODY_BYTES = 65_536;

/** @param {unknown} value */
const tokens = value =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;

/**
 * OpenRouter's usage in disjoint counts. It follows the OpenAI convention:
 * `prompt_tokens` includes the cached ones and `completion_tokens` the
 * reasoning ones. What the request put in the window is both totals.
 *
 * @param {any} usage
 * @param {number} windowTokens 0 when the serving model's size is not known
 */
export const usageFromOpenRouter = (usage, windowTokens) => {
  const prompt = tokens(usage.prompt_tokens);
  const completion = tokens(usage.completion_tokens);
  const cached = Math.min(
    prompt,
    tokens(usage.prompt_tokens_details?.cached_tokens),
  );
  const reasoning = Math.min(
    completion,
    tokens(usage.completion_tokens_details?.reasoning_tokens),
  );
  return {
    inputTokens: prompt - cached,
    outputTokens: completion - reasoning,
    cachedInputTokens: cached,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: reasoning,
    context: { usedTokens: prompt + completion, windowTokens },
  };
};

/**
 * What of a provider response may be shown. A body can carry credentials or
 * the user's input, so nothing from it reaches a log line, an error message or
 * a turn record unless it has the shape of the identifier it is supposed to
 * be. A credential echoed back is one long unbroken token, so beyond its shape
 * no value may contain a word (a run of letters, digits and underscores)
 * longer than real identifiers have, nor start the way keys do. This keeps
 * accidents out; an upstream that set out to write prose here already writes
 * the model's replies.
 */
const SHAPES = harden({
  // 429, or a symbolic code such as `rate_limited`.
  code: /^(?:\d{1,5}|[a-z]{1,16}(?:_[a-z]{1,16}){0,3})$/,
  // `stop`, `error`, `length`, …
  reason: /^[a-z]{1,16}(?:_[a-z]{1,16}){0,2}$/,
  // `vendor/model-7b:free` — always qualified by its organization.
  model: /^[a-z0-9][a-z0-9.-]{0,31}\/[A-Za-z0-9][A-Za-z0-9.:+-]{0,63}$/,
  // `Google AI Studio`: at most three short words.
  provider: /^[A-Za-z0-9][A-Za-z0-9.+-]{0,15}(?: [A-Za-z0-9.+-]{1,16}){0,2}$/,
});
const LONGEST_WORD = 16;
/** How credentials begin: separated from what follows, or glued to it. */
const KEY_PREFIX =
  /(?:^|[^A-Za-z0-9])(?:sk|pk|rk|gsk|hf|ghp|gho|ghs|ghu|glpat|xox[a-z]?|bearer)(?:[^A-Za-z]|$)/i;
const GLUED_KEY_PREFIX = /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA|AIza|eyJ)[A-Za-z0-9]/;

/**
 * Whether a value looks like key material cut into identifier-sized pieces:
 * a long all-hex word, or several words that each mix letters with digits the
 * way random tokens do and names do not.
 *
 * @param {string} text
 */
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
 * @param {keyof typeof SHAPES} shape
 * @param {unknown} value
 * @returns {string | undefined}
 */
const shown = (shape, value) => {
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

/** @param {unknown} status */
const retryableStatus = status =>
  status === 408 ||
  status === 429 ||
  (typeof status === 'number' && status >= 500 && status <= 599);

/**
 * @param {Array<[string, keyof typeof SHAPES, unknown]>} facts
 * @returns {string} ` (finish_reason error, code 502)`, or nothing.
 */
const describe = facts => {
  const parts = [];
  for (const [label, shape, value] of facts) {
    const text = shown(shape, value);
    if (text !== undefined) parts.push(`${label} ${text}`);
  }
  return parts.length ? ` (${parts.join(', ')})` : '';
};

/**
 * OpenRouter's buffered chat API, shared by Fae and Floot.
 *
 * No output limit is sent: a reply is as long as the model makes it. A reply
 * the model itself cut short is delivered with a note rather than thrown away.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @param {number} [options.requestTimeoutMs]
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now] the clock that spaces catalog reads
 */
export const makeOpenRouterProvider = ({
  apiKey,
  model,
  fetchImpl = fetch,
  sleep = defaultSleep,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  log = line => console.error(line),
  now = Date.now,
}) => {
  if (!apiKey || !apiKey.trim()) throw Error('OpenRouter API key is required');
  if (!model || !model.includes('/')) {
    throw Error('OpenRouter model must include its organization prefix');
  }

  // Model id to context length, from the public catalog: no credential is
  // sent to it. It is read on the first `chat`, beside that request and never
  // before it. A read that fails is tried again after a while rather than on
  // every reply, and until one succeeds the window is reported as 0.
  /** @type {Promise<Map<string, number> | undefined> | undefined} */
  let catalog;
  let catalogRetryAt = 0;
  const loadCatalog = () => {
    if (catalog === undefined && now() >= catalogRetryAt) {
      const reading = (async () => {
        try {
          const response = await fetchImpl(
            'https://openrouter.ai/api/v1/models',
            {
              redirect: 'error',
              signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
            },
          );
          if (!response.ok) throw Error(`HTTP ${response.status}`);
          const listing = await boundedJson(
            response,
            MAX_CATALOG_BODY_BYTES,
            'OpenRouter model catalog',
          );
          const windows = new Map();
          for (const entry of Array.isArray(listing?.data)
            ? listing.data
            : []) {
            const size = tokens(entry?.context_length);
            if (size > 0) {
              // A reply names the model that served it by its dated slug as
              // often as by its id.
              for (const name of [entry?.id, entry?.canonical_slug]) {
                if (typeof name === 'string' && name) windows.set(name, size);
              }
            }
          }
          return windows;
        } catch (error) {
          catalog = undefined;
          catalogRetryAt = now() + CATALOG_RETRY_MS;
          log(
            `[openrouter] no model catalog, so no context window sizes: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      })();
      catalog = reading;
    }
    return catalog ?? Promise.resolve(undefined);
  };
  /**
   * @param {unknown} servedModel the model a routing id resolved to
   */
  const contextWindowOf = async servedModel => {
    // A timer of its own, not `sleep`: that one paces retries, and a caller
    // who replaces it to skip the waits must not skip the catalog too.
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const waited = new Promise(resolve => {
      timer = setTimeout(() => resolve(undefined), CATALOG_WAIT_MS);
    });
    const windows = await Promise.race([loadCatalog(), waited]);
    clearTimeout(timer);
    if (windows === undefined) return 0;
    const served =
      typeof servedModel === 'string' ? windows.get(servedModel) : undefined;
    if (served !== undefined) return served;
    // A routing id (`openrouter/auto`, `openrouter/free`) lists a nominal
    // size of its own, which is not the size of whatever it routed to.
    return model.startsWith('openrouter/') ? 0 : (windows.get(model) ?? 0);
  };

  /**
   * One request. Resolves to the accepted result, or to why there is none and
   * whether asking again could help.
   *
   * @param {any[]} messages
   * @param {any[]} tools
   * @param {AbortSignal} [signal]
   * @returns {Promise<({ result: any } | { failure: string, retryable: boolean, timedOut?: boolean, retryAfterMs?: number }) & { usage?: ReturnType<typeof usageFromOpenRouter> }>}
   */
  const attempt = async (messages, tools, signal) => {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
      : AbortSignal.timeout(requestTimeoutMs);
    let response;
    let result;
    let bodyTimedOut = false;
    try {
      response = await fetchImpl(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          redirect: 'error',
          signal: requestSignal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-OpenRouter-Title': 'Endo Floot/Fae',
          },
          body: JSON.stringify({
            model,
            messages: toOpenAICompatibleMessages(messages),
            ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
            stream: false,
          }),
        },
      );
      // Never echo a provider response body: it can contain credentials or
      // input. What is kept of a failure is its status and identifiers.
      try {
        result = response.ok
          ? await response.json()
          : await boundedJson(
              response,
              MAX_ERROR_BODY_BYTES,
              'OpenRouter error',
            );
      } catch (error) {
        // An HTML/empty HTTP error must retain its status-based diagnosis.
        // No usage can be recovered from an unreadable body.
        if (response.ok || signal?.aborted) throw error;
        bodyTimedOut =
          requestSignal.reason?.name === 'TimeoutError' ||
          /** @type {any} */ (error)?.name === 'TimeoutError';
      }
    } catch (error) {
      // The caller's own cancellation is not a failure to report or repeat.
      if (signal?.aborted) throw error;
      // Only the request's own clock: an abort from anywhere else is an
      // ordinary failure, and says nothing about how long was waited.
      const timedOut =
        requestSignal.reason?.name === 'TimeoutError' ||
        /** @type {any} */ (error)?.name === 'TimeoutError';
      return {
        failure: timedOut
          ? `OpenRouter did not answer within ${Math.round(requestTimeoutMs / 1000)} seconds`
          : 'OpenRouter could not be reached or sent an unreadable response',
        retryable: true,
        timedOut,
      };
    }
    if (
      result?.usage &&
      ![result.usage.prompt_tokens, result.usage.completion_tokens].every(
        count =>
          typeof count === 'number' && Number.isInteger(count) && count >= 0,
      )
    ) {
      throw Error('OpenRouter returned invalid token usage');
    }
    const usage = result?.usage
      ? usageFromOpenRouter(result.usage, await contextWindowOf(result.model))
      : undefined;
    const observation = usage ? { usage } : {};
    // A failed response can still represent consumed tokens. Preserve its usage
    // and let the caller decide whether to try again, rather than replaying it.
    const consumed = !!usage && usage.context.usedTokens > 0;
    if (!response.ok) {
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      return {
        ...observation,
        failure: `OpenRouter request failed (HTTP ${response.status})`,
        retryable: !consumed && retryableStatus(response.status),
        ...(bodyTimedOut ? { timedOut: true } : {}),
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retryAfterMs: retryAfter * 1000 }
          : {}),
      };
    }
    /** @type {Array<[string, keyof typeof SHAPES, unknown]>} */
    const servedBy = [
      ['served by', 'model', result?.model],
      ['via', 'provider', result?.provider],
    ];
    if (result?.error) {
      const code = result.error.code;
      return {
        ...observation,
        failure: `OpenRouter returned an API error${describe([['code', 'code', code], ...servedBy])}`,
        // The code is an HTTP status, as a number or as its digits.
        retryable:
          !consumed &&
          retryableStatus(
            typeof code === 'string' && /^\d{3}$/.test(code)
              ? Number(code)
              : code,
          ),
      };
    }
    const choice = result?.choices?.[0];
    if (!choice?.message || choice.finish_reason === 'error') {
      return {
        ...observation,
        failure: `OpenRouter returned no successful assistant message${describe(
          [
            ['finish_reason', 'reason', choice ? choice.finish_reason : 'none'],
            ['code', 'code', choice?.error?.code],
            ...servedBy,
          ],
        )}`,
        retryable: !consumed,
      };
    }
    return { result, ...observation };
  };

  /**
   * @param {any[]} messages
   * @param {any[]} tools
   * @param {AbortSignal} [signal]
   * @param {(usage: ReturnType<typeof usageFromOpenRouter>) => void} [onUsage]
   */
  const chat = async (messages, tools, signal, onUsage) => {
    // Beside the request, not after it, so the first reply does not wait on
    // a second round trip. Its failures are its own and already handled.
    void loadCatalog();
    let result;
    let usage;
    let timeouts = 0;
    for (let tries = 1; ; tries += 1) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await attempt(messages, tools, signal);
      // Outside the request/retry catch: an observer failure must not replay
      // inference. Each callback reports only this attempt's usage.
      if (outcome.usage) onUsage?.(harden(outcome.usage));
      if ('result' in outcome) {
        result = outcome.result;
        usage = outcome.usage;
        break;
      }
      if (outcome.timedOut) timeouts += 1;
      const again = outcome.retryable && tries < MAX_ATTEMPTS && timeouts <= 1;
      log(
        `[openrouter] ${model} attempt ${tries} of ${MAX_ATTEMPTS}: ${outcome.failure}${again ? '; asking again' : ''}`,
      );
      if (!again) {
        throw Error(
          tries > 1
            ? `${outcome.failure}, after ${tries} attempts`
            : outcome.failure,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(
        Math.min(
          MAX_RETRY_AFTER_MS,
          Math.max(outcome.retryAfterMs || 0, 1000 * 3 ** (tries - 1)),
        ),
        signal,
      );
    }
    const choice = result.choices[0];
    const served = describe([
      ['served by', 'model', result.model],
      ['via', 'provider', result.provider],
    ]);
    if (choice.finish_reason === 'content_filter') {
      throw Error(`OpenRouter completion stopped: content_filter${served}`);
    }
    // No limit was asked for, so `length` is the model's own. Text it had
    // written is worth more delivered, and marked, than discarded; a tool call
    // cut off mid-argument is not a call anybody can run.
    const cutShort = choice.finish_reason === 'length';
    if (
      cutShort &&
      (!choice.message.content ||
        typeof choice.message.content !== 'string' ||
        (Array.isArray(choice.message.tool_calls) &&
          choice.message.tool_calls.length !== 0))
    ) {
      throw Error(`OpenRouter completion stopped: length${served}`);
    }
    const message = choice.message;
    if (
      message.role !== 'assistant' ||
      (message.content != null && typeof message.content !== 'string') ||
      (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))
    ) {
      throw Error('OpenRouter returned an invalid assistant message');
    }
    for (const call of message.tool_calls || []) {
      if (
        call.type !== 'function' ||
        typeof call.id !== 'string' ||
        !call.id ||
        typeof call.function?.name !== 'string' ||
        !call.function.name ||
        typeof call.function.arguments !== 'string'
      ) {
        throw Error('OpenRouter returned an invalid tool call');
      }
    }
    // A syntactically valid assistant message can still contain no answer.
    // Reasoning alone is not user-facing output. Do not silently complete or
    // repeat a request that may already have consumed provider usage.
    if (!message.content?.trim() && !message.tool_calls?.length) {
      throw Error(
        `OpenRouter returned an empty assistant response${describe([
          ['finish_reason', 'reason', choice.finish_reason],
        ])}${served}`,
      );
    }
    const servedBy = {
      ...(shown('model', result.model)
        ? { model: shown('model', result.model) }
        : {}),
      ...(shown('provider', result.provider)
        ? { provider: shown('provider', result.provider) }
        : {}),
    };
    return harden({
      message: {
        ...message,
        content: cutShort
          ? `${message.content}\n\n[The model stopped here: it reached its own output limit.]`
          : message.content || '',
      },
      ...(Object.keys(servedBy).length ? { servedBy } : {}),
      ...(usage ? { usage } : {}),
    });
  };
  return harden({
    chat,
    /**
     * @param {any[]} messages
     * @param {any[]} tools
     * @param {(text: string) => void} [onToken]
     * @param {AbortSignal} [signal]
     * @param {(usage: ReturnType<typeof usageFromOpenRouter>) => void} [onUsage]
     */
    async chatStream(messages, tools, onToken, signal, onUsage) {
      const result = await chat(messages, tools, signal, onUsage);
      if (result.message.content) onToken?.(result.message.content);
      return result;
    },
  });
};
harden(makeOpenRouterProvider);
