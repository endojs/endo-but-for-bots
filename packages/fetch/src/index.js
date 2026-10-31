// @ts-check
// spell-out-exempt: `ok` is the platform Response field this record mirrors.

/**
 * `@endo/fetch` - the unconfined base plugin for outbound HTTP.
 *
 * Its `make()` adapts the unconfined worker's ambient `fetch` into the
 * passable, unfettered `Fetch` capability. `Fetch` makes no allowlist, rate,
 * size, policy, persistence, or revival decision, so granting it grants the
 * transport's whole network reach. The integration that provisions it
 * retains it and endows it, with a private state directory, to
 * `@endo/confined-fetch`; a guest never receives it.
 *
 * ```
 * E(host).makeUnconfined(workerName, '@endo/fetch', { powersName, resultName })
 * ```
 *
 * Requests and responses are passable so the capability can cross a vat
 * boundary: a request carries a string body and an optional `cancelled`
 * token, and a response is a record whose body is a
 * `CloseablePassableBytesReader`.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { toAbortSignal } from '@endo/cancel/to-abort';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';

/** @import { Cancelled } from '@endo/cancel' */
/** @import { FetchRequestOptions, FetchResponse, Transport, TransportBody } from './types.js' */

export const FetchRequestOptionsShape = M.splitRecord(
  {},
  {
    method: M.string(),
    headers: M.recordOf(M.string(), M.string()),
    body: M.string(),
    redirect: M.or('manual', 'follow', 'error'),
    cancelled: M.promise(),
  },
);

export const FetchResponseShape = M.splitRecord({
  status: M.number(),
  statusText: M.string(),
  ok: M.boolean(),
  headers: M.recordOf(M.string(), M.string()),
  url: M.string(),
  body: M.or(M.null(), M.remotable('CloseablePassableBytesReader')),
});

export const FetchInterface = M.interface('Fetch', {
  fetch: M.callWhen(M.string())
    .optional(FetchRequestOptionsShape)
    .returns(FetchResponseShape),
  help: M.call().returns(M.string()),
});

const fetchHelp = `\
Fetch - unfettered outbound HTTP. Not for guests.

  fetch(url, { method?, headers?, body?, redirect?, cancelled? })
    -> { status, statusText, ok, headers, url, body }

body is a CloseablePassableBytesReader, or null for a null-body response.
Rejecting the cancelled token aborts the request and its body.
Endow this to @endo/confined-fetch; grant guests only its HttpClient.`;

/**
 * Copy transport headers into a plain record with lowercased names. Native
 * `Headers` must not be hardened (Undici caches its sorted map lazily), so it
 * is read once and never escapes.
 *
 * @param {unknown} headers
 * @returns {Record<string, string>}
 */
const snapshotHeaders = headers => {
  /** @type {Iterable<[string, string]>} */
  const entries =
    headers &&
    typeof (/** @type {any} */ (headers)[Symbol.iterator]) === 'function'
      ? /** @type {Iterable<[string, string]>} */ (headers)
      : Object.entries(/** @type {Record<string, string>} */ (headers || {}));
  return Object.fromEntries(
    [...entries].map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
};

/**
 * Drain a transport body as an async iterator of byte chunks, cancelling the
 * transport reader if the consumer closes early.
 *
 * @param {TransportBody} body
 */
async function* readTransportBody(body) {
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value instanceof Uint8Array ? value : encodeUtf8(String(value));
    }
  } finally {
    if (!finished && typeof reader.cancel === 'function') {
      await Promise.resolve(reader.cancel()).catch(() => {});
    }
    if (typeof reader.releaseLock === 'function') {
      reader.releaseLock();
    }
  }
}

/**
 * @param {object} [options]
 * @param {Transport} [options.fetch] - the transport; defaults to the
 *   platform's ambient `fetch`. Tests inject a fake.
 */
export const makeFetch = ({
  fetch = /** @type {Transport} */ (globalThis.fetch),
} = {}) => {
  if (typeof fetch !== 'function') {
    throw TypeError('@endo/fetch: a fetch transport is required');
  }
  return makeExo('Fetch', FetchInterface, {
    /**
     * @param {string} url
     * @param {FetchRequestOptions} [options]
     * @returns {Promise<FetchResponse>}
     */
    async fetch(url, options = {}) {
      const { cancelled, ...requestOptions } = options;
      const response = await fetch(url, {
        ...requestOptions,
        ...(cancelled === undefined
          ? {}
          : { signal: toAbortSignal(/** @type {Cancelled} */ (cancelled)) }),
      });
      const body =
        response.body === null || response.body === undefined
          ? null
          : bytesReaderFromIterator(readTransportBody(response.body));
      const status = Number(response.status);
      return harden({
        status,
        statusText: String(response.statusText ?? ''),
        ok: response.ok ?? (status >= 200 && status < 300),
        headers: snapshotHeaders(response.headers),
        url: String(response.url ?? url),
        body,
      });
    },
    help() {
      return fetchHelp;
    },
  });
};
harden(makeFetch);

/**
 * Unconfined-caplet entry point. `powers`, `context`, and `env` supply no
 * policy or storage; the authority exposed is the worker's own `fetch`.
 *
 * @param {unknown} _powers
 * @param {unknown} [_context]
 * @param {{ env?: Record<string, string>, fetch?: Transport }} [options] -
 *   `fetch` is a test seam the `makeUnconfined` pathway never passes.
 */
export const make = (_powers, _context, { fetch } = {}) =>
  makeFetch(fetch === undefined ? {} : { fetch });
harden(make);
