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
