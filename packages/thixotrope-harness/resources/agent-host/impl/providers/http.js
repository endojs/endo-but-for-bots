// @ts-check
/**
 * The provider HTTP base (M2 W2.1a; designs/m2-interfaces.md 8.1, 12):
 * Node's `fetch` (Node 22, undici) with the caller's cancel and a request
 * timeout combined, redirects refused, and no response body in any error.
 *
 * - `postJson` / `getJson` resolve to the `Response` (any status); the
 *   caller reads a 2xx body as a stream and never reads another one
 *   (`discardBody`), so a provider body can never reach a failure text, a
 *   log line or a record (R4-79).
 * - A request that fails before a response rejects with an `HttpFailure`
 *   whose `kind` is `aborted` (the caller's signal), `timeout` (the request
 *   timeout, R4-93) or `network` (anything else: refused, reset, DNS,
 *   TLS); its message is fixed. The same classification applies to a body
 *   read that fails later (`failureKind`), because the timeout covers the
 *   whole request, body included, as lal's does.
 *
 * Node only (adapter).
 */

/**
 * The fixed text of a refused provider base URL (the key is never sent to
 * it; J-9486).
 */
export const BASE_URL_REFUSED =
  'provider base URL refused: https, or http to a loopback host, with no user info, query or fragment';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A spec's base URL (else `fallback`), without trailing slashes, when the
 * key may go there: `https:`, or `http:` to a loopback host (the fake
 * servers), with no user info, query or fragment. Anything else throws
 * `BASE_URL_REFUSED`, so a ReadGrant cannot carry its key to a server its
 * holder picks over clear text, or smuggle one in a URL.
 * @param {unknown} baseUrl
 * @param {string} fallback
 */
export const providerBaseUrl = (baseUrl, fallback) => {
  const text = String(baseUrl ?? fallback);
  /** @type {URL} */
  let url;
  try {
    url = new URL(text);
  } catch {
    throw Error(BASE_URL_REFUSED);
  }
  const allowed =
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    !text.includes('?') &&
    !text.includes('#');
  if (!allowed) throw Error(BASE_URL_REFUSED);
  return text.replace(/\/+$/, '');
};
harden(providerBaseUrl);

/**
 * `chunks`, failing with `over()` once more than `maxBytes` have arrived
 * (a round's whole stream: J-9486). Leaving the loop cancels the body.
 * @param {AsyncIterable<Uint8Array> | Iterable<Uint8Array>} chunks
 * @param {number} maxBytes
 * @param {() => Error} over
 * @returns {AsyncGenerator<Uint8Array, void, undefined>}
 */
export async function* boundedChunks(chunks, maxBytes, over) {
  let bytes = 0;
  for await (const chunk of chunks) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw over();
    yield chunk;
  }
}
harden(boundedChunks);

/** Node's longest timer (a longer delay fires at once). */
const MAX_TIMER_MS = 2_147_483_647;

/** @typedef {'aborted' | 'timeout' | 'network'} HttpFailureKind */

/** A request that got no response; `message` is fixed (no body, no URL). */
export class HttpFailure extends Error {
  /** @param {HttpFailureKind} kind */
  constructor(kind) {
    super(`provider request failed: ${kind}`);
    /** @type {HttpFailureKind} */
    this.kind = kind;
  }
}
harden(HttpFailure);

/**
 * Why a request or its body read failed.
 * @param {unknown} error
 * @param {AbortSignal | undefined} callerSignal the caller's own cancel
 * @param {AbortSignal | undefined} requestSignal the combined signal
 * @returns {HttpFailureKind}
 */
export const failureKind = (error, callerSignal, requestSignal) => {
  if (error instanceof HttpFailure) return error.kind;
  if (callerSignal?.aborted) return 'aborted';
  const name = /** @type {any} */ (error)?.name;
  if (
    name === 'TimeoutError' ||
    /** @type {any} */ (requestSignal?.reason)?.name === 'TimeoutError'
  )
    return 'timeout';
  return 'network';
};
harden(failureKind);

/**
 * The caller's signal and the request timeout as one signal.
 * @param {AbortSignal | undefined} signal
 * @param {number | undefined} timeoutMs
 */
export const requestSignalOf = (signal, timeoutMs) => {
  /** @type {AbortSignal[]} */
  const signals = [];
  if (signal !== undefined) signals.push(signal);
  if (timeoutMs !== undefined && timeoutMs > 0)
    signals.push(AbortSignal.timeout(Math.min(timeoutMs, MAX_TIMER_MS)));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
};
harden(requestSignalOf);

/**
 * @typedef {object} RequestOptions
 * @property {string} url
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body] sent as JSON (POST)
 * @property {AbortSignal} [signal] the caller's cancel
 * @property {number} [timeoutMs] the whole request, body included
 * @property {typeof globalThis.fetch} [fetch]
 */

/**
 * @param {'GET' | 'POST'} method
 * @param {RequestOptions} options
 * @returns {Promise<Response & { requestSignal?: AbortSignal }>}
 */
const request = async (
  method,
  { url, headers = {}, body, signal, timeoutMs, fetch = globalThis.fetch },
) => {
  const requestSignal = requestSignalOf(signal, timeoutMs);
  if (signal?.aborted) throw new HttpFailure('aborted');
  /** @type {Response} */
  let response;
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      signal: requestSignal,
      headers:
        method === 'POST'
          ? { 'content-type': 'application/json', ...headers }
          : headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch (error) {
    throw new HttpFailure(failureKind(error, signal, requestSignal));
  }
  // The combined signal rides along so a body read can be classified.
  return Object.assign(response, { requestSignal });
};

/** @param {RequestOptions} options */
export const postJson = options => request('POST', options);
harden(postJson);

/** @param {RequestOptions} options */
export const getJson = options => request('GET', options);
harden(getJson);

/**
 * Drop a body unread (a non-2xx answer: its text is never looked at).
 * @param {Response} response
 */
export const discardBody = response => {
  response.body?.cancel().catch(() => {});
};
harden(discardBody);

/**
 * `Retry-After` in ms (seconds or an HTTP date), or undefined.
 * @param {Response} response
 * @param {() => number} [now]
 */
export const retryAfterMs = (response, now = () => Date.now()) => {
  const value = response.headers.get('retry-after');
  if (value === null || value.trim() === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(value.trim())) {
    const ms = Number(value.trim()) * 1000;
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  const ms = at - now();
  return ms > 0 ? ms : undefined;
};
harden(retryAfterMs);

/**
 * The 2xx body as bytes, chunk by chunk (for `parseSse`).
 * @param {Response} response
 * @returns {AsyncIterable<Uint8Array> | Iterable<Uint8Array>}
 */
export const bodyChunks = response => {
  const { body } = response;
  if (body === null) return [];
  return /** @type {AsyncIterable<Uint8Array>} */ (
    /** @type {unknown} */ (body)
  );
};
harden(bodyChunks);
