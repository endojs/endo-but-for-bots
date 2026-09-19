// @ts-check
/* global fetch, setTimeout, clearTimeout */

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
 * was delivered, so a reply is not paid for twice.
 */
const MAX_ATTEMPTS = 3;
/** A request that outlives this is abandoned; it is repeated at most once. */
const REQUEST_TIMEOUT_MS = 300_000;
/** The longest a `Retry-After` is honoured for. */
const MAX_RETRY_AFTER_MS = 30_000;

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
 */
export const makeOpenRouterProvider = ({
  apiKey,
  model,
  fetchImpl = fetch,
  sleep = defaultSleep,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  log = line => console.error(line),
}) => {
  if (!apiKey || !apiKey.trim()) throw Error('OpenRouter API key is required');
  if (!model || !model.includes('/')) {
    throw Error('OpenRouter model must include its organization prefix');
  }

  /**
   * One request. Resolves to the accepted result, or to why there is none and
   * whether asking again could help.
   *
   * @param {any[]} messages
   * @param {any[]} tools
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ result: any } | { failure: string, retryable: boolean, timedOut?: boolean, retryAfterMs?: number }>}
   */
  const attempt = async (messages, tools, signal) => {
    let response;
    let result;
    try {
      response = await fetchImpl(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          redirect: 'error',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
            : AbortSignal.timeout(requestTimeoutMs),
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
      if (!response.ok) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        return {
          failure: `OpenRouter request failed (HTTP ${response.status})`,
          retryable: retryableStatus(response.status),
          ...(Number.isFinite(retryAfter) && retryAfter > 0
            ? { retryAfterMs: retryAfter * 1000 }
            : {}),
        };
      }
      result = await response.json();
    } catch (error) {
      // The caller's own cancellation is not a failure to report or repeat.
      if (signal?.aborted) throw error;
      // Only the request's own clock: an abort from anywhere else is an
      // ordinary failure, and says nothing about how long was waited.
      const timedOut = /** @type {any} */ (error)?.name === 'TimeoutError';
      return {
        failure: timedOut
          ? `OpenRouter did not answer within ${Math.round(requestTimeoutMs / 1000)} seconds`
          : 'OpenRouter could not be reached or sent an unreadable response',
        retryable: true,
        timedOut,
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
        failure: `OpenRouter returned an API error${describe([['code', 'code', code], ...servedBy])}`,
        // The code is an HTTP status, as a number or as its digits.
        retryable: retryableStatus(
          typeof code === 'string' && /^\d{3}$/.test(code)
            ? Number(code)
            : code,
        ),
      };
    }
    const choice = result?.choices?.[0];
    if (!choice?.message || choice.finish_reason === 'error') {
      return {
        failure: `OpenRouter returned no successful assistant message${describe(
          [
            ['finish_reason', 'reason', choice ? choice.finish_reason : 'none'],
            ['code', 'code', choice?.error?.code],
            ...servedBy,
          ],
        )}`,
        retryable: true,
      };
    }
    return { result };
  };

  /**
   * @param {any[]} messages
   * @param {any[]} tools
   * @param {AbortSignal} [signal]
   */
  const chat = async (messages, tools, signal) => {
    let result;
    let timeouts = 0;
    for (let tries = 1; ; tries += 1) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await attempt(messages, tools, signal);
      if ('result' in outcome) {
        result = outcome.result;
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
    if (
      result.usage &&
      ![result.usage.prompt_tokens, result.usage.completion_tokens].every(
        count =>
          typeof count === 'number' && Number.isFinite(count) && count >= 0,
      )
    ) {
      throw Error('OpenRouter returned invalid token usage');
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
      ...(result.usage
        ? {
            usage: {
              inputTokens: result.usage.prompt_tokens || 0,
              outputTokens: result.usage.completion_tokens || 0,
            },
          }
        : {}),
    });
  };
  return harden({
    chat,
    /**
     * @param {any[]} messages
     * @param {any[]} tools
     * @param {(text: string) => void} [onToken]
     * @param {AbortSignal} [signal]
     */
    async chatStream(messages, tools, onToken, signal) {
      const result = await chat(messages, tools, signal);
      if (result.message.content) onToken?.(result.message.content);
      return result;
    },
  });
};
harden(makeOpenRouterProvider);
