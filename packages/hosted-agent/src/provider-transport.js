// @ts-check

import { Fail, makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { isCredentialRejection } from './provider-broker.js';

/** @import { UpstreamRequest } from './provider-broker.js' */

/**
 * Host-only failure metadata. Never includes request data, headers, response
 * bodies, URLs, or exception text. HTTP statuses are restricted to 100–599.
 * @typedef {object} ProviderTransportDiagnostic
 * @property {'request' | 'fetch' | 'response' | 'body' | 'timeout'} stage
 * @property {number} [status]
 */

/**
 * Per-lease fetch transport. Fetch is an explicit trusted power, never ambient
 * network authority. Responses support bounded, incremental pulls with a deadline that remains
 * active until EOF or cancellation. The compatibility request method buffers.
 * Abort and disposal settle callers even if an injected fetch ignores abort.
 * Such a fetch is still responsible for stopping its underlying network work.
 *
 * @param {object} options
 * @param {typeof globalThis.fetch} options.fetch
 * @param {number} options.timeoutMs - Host timers have a signed 32-bit delay range.
 * @param {bigint} options.maxRequestBytes
 * @param {bigint} options.maxResponseBytes
 * @param {(callback: () => void, delay: number) => unknown} [options.setTimer]
 * @param {(timer: unknown) => void} [options.clearTimer]
 * @param {(diagnostic: ProviderTransportDiagnostic) => void | Promise<void>} [options.onDiagnostic]
 */
export const makeProviderFetchTransport = ({
  fetch,
  timeoutMs,
  maxRequestBytes,
  maxResponseBytes,
  onDiagnostic = () => {},
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = timer =>
    globalThis.clearTimeout(
      /** @type {ReturnType<typeof globalThis.setTimeout>} */ (timer),
    ),
}) => {
  (typeof fetch === 'function' &&
    Number.isInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= 2_147_483_647) ||
    Fail`Invalid transport timeout`;
  (typeof maxRequestBytes === 'bigint' &&
    maxRequestBytes > 0n &&
    typeof maxResponseBytes === 'bigint' &&
    maxResponseBytes > 0n) ||
    Fail`Invalid transport byte limits`;
  let disposed = false;
  /** @type {Set<() => void>} */
  const pending = new Set();
  // Match the broker's bounded admission envelope, not M.string's implicit
  // 100,000-character default. The request's UTF-8 byte limit is still checked
  // before fetch; 8MiB is the private provider pipe's maximum frame size.
  const BodyShape = M.string({
    stringLengthLimit: Math.max(
      100_000,
      Number(maxRequestBytes < 8_388_608n ? maxRequestBytes : 8_388_608n),
    ),
  });
  const transport = makeExo(
    'ProviderFetchTransport',
    M.interface('ProviderFetchTransport', {
      request: M.call(
        M.splitRecord({
          url: M.string(),
          method: M.string(),
          headers: M.recordOf(M.string(), M.string()),
          body: BodyShape,
          redirect: /** @type {const} */ ('error'),
          maxResponseBytes: M.bigint(),
        }),
      ).returns(M.promise()),

      requestStream: M.call(
        M.splitRecord({
          url: M.string(),
          method: M.string(),
          headers: M.recordOf(M.string(), M.string()),
          body: BodyShape,
          redirect: /** @type {const} */ ('error'),
          maxResponseBytes: M.bigint(),
        }),
      ).returns(M.promise()),
    }),
    {
      /** @param {UpstreamRequest} request */
      async request(request) {
        !disposed || Fail`Provider transport disposed`;
        try {
          const response = await E(transport).requestStream(request);
          const parts = [];
          for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const chunk = await E(response.reader).next();
            if (chunk.done) break;
            parts.push(chunk.value);
          }
          return harden({ status: response.status, body: parts.join('') });
        } catch (error) {
          // The credential classification is the one detail worth preserving
          // across the buffering wrapper; everything else collapses.
          if (isCredentialRejection(error)) throw error;
          return Fail`Provider transport failed`;
        }
      },
      /** @param {UpstreamRequest} request */
      async requestStream(request) {
        !disposed || Fail`Provider transport disposed`;
        const controller = new AbortController();
        /** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */
        let reader;
        let finished = false;
        let credentialRejected = false;
        /** @type {ProviderTransportDiagnostic['stage']} */
        let stage = 'request';
        /** @type {number | undefined} */
        let status;
        let reported = false;
        const reportFailure = () => {
          if (reported) return;
          reported = true;
          try {
            const diagnostic = harden({
              stage,
              ...(status === undefined ? {} : { status }),
            });
            // A host observer must not change request settlement or leak its
            // own exception through the provider capability.
            void Promise.resolve(onDiagnostic(diagnostic)).catch(() => {});
          } catch (_error) {
            // Diagnostics are best effort and silent by default.
          }
        };
        const cancelBody = () => {
          if (reader) {
            // Cancellation is best effort and cannot extend the request deadline.
            void reader.cancel().catch(() => {});
          }
        };
        /** @type {(error: Error) => void} */
        let rejectStopped;
        /** @type {Promise<never>} */
        const stopped = new Promise((_, reject) => {
          rejectStopped = reject;
        });
        // A deadline may fire while the caller is not pulling.
        void stopped.catch(() => {});
        const finish = () => {
          finished = true;
          pending.delete(stop);
          clearTimer(timer);
          try {
            reader?.releaseLock();
          } catch (_error) {
            // A pending read releases when cancellation settles.
          }
        };
        const stop = () => {
          controller.abort();
          cancelBody();
          rejectStopped(makeError(X`Provider transport stopped`));
          finish();
        };
        pending.add(stop);
        const timer = setTimer(() => {
          stage = 'timeout';
          reportFailure();
          stop();
        }, timeoutMs);
        try {
          const url = new URL(request.url);
          (url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.hash &&
            request.method === 'POST' &&
            request.redirect === 'error' &&
            typeof request.body === 'string' &&
            BigInt(new TextEncoder().encode(request.body).length) <=
              maxRequestBytes &&
            typeof request.maxResponseBytes === 'bigint' &&
            request.maxResponseBytes > 0n) ||
            Fail`Invalid provider request`;
          const limit =
            request.maxResponseBytes < maxResponseBytes
              ? request.maxResponseBytes
              : maxResponseBytes;
          for (const [name, value] of Object.entries(request.headers)) {
            const subscriptionHeader =
              request.url ===
                'https://chatgpt.com/backend-api/codex/responses' &&
              ((name === 'chatgpt-account-id' &&
                /^[A-Za-z0-9_-]{1,256}$/.test(value)) ||
                (name === 'originator' && value === 'codex_cli_rs'));
            ((subscriptionHeader ||
              [
                'authorization',
                'x-api-key',
                'anthropic-version',
                'anthropic-beta',
                'content-type',
              ].includes(name)) &&
              typeof value === 'string' &&
              /^[\x20-\x7e]*$/.test(value)) ||
              Fail`Invalid provider header`;
          }
          stage = 'fetch';
          const fetching = Promise.resolve(
            fetch(url.href, {
              method: 'POST',
              headers: request.headers,
              body: request.body,
              redirect: 'error',
              credentials: 'omit',
              signal: controller.signal,
              cache: 'no-store',
              referrerPolicy: 'no-referrer',
            }),
          ).then(response => {
            if (finished || controller.signal.aborted) {
              void response.body?.cancel().catch(() => {});
              Fail`Provider transport stopped`;
            }
            return response;
          });
          const response = await Promise.race([fetching, stopped]);
          stage = 'response';
          if (
            Number.isInteger(response.status) &&
            response.status >= 100 &&
            response.status <= 599
          ) {
            status = response.status;
          }
          // Only successful inference bodies are exposed; never redirects,
          // authentication challenges, response headers, or error payloads.
          reader = response.body?.getReader();
          // The single bit a refreshing broker needs from a rejection: whether
          // the credential itself was refused. The status class carries it; the
          // challenge header, the error body, and the upstream's wording stay
          // on this side of the seam.
          //
          // 401 only. A 403 is the upstream refusing *this request* — an
          // unentitled model, a region, a content policy — and refreshing
          // cannot fix it. Treating it as a credential failure would let a
          // slice that can reproduce one turn every admitted request into a
          // second dispatch, a token exchange and a secret write, none of which
          // the request and cost quotas meter.
          if (response.status === 401) credentialRejected = true;
          (Number.isInteger(response.status) &&
            response.status >= 200 &&
            response.status < 300 &&
            !response.redirected &&
            response.body) ||
            Fail`Invalid provider response`;
          const bodyReader = reader;
          if (!bodyReader) throw Fail`Missing provider body`;
          const length = response.headers.get('content-length');
          length === null ||
            (/^\d+$/.test(length) && BigInt(length) <= limit) ||
            Fail`Provider response too large`;
          const decoder = new TextDecoder('utf-8', { fatal: true });
          stage = 'body';
          let bytes = 0n;
          let reading = false;
          const stream = makeExo(
            'ProviderResponseReader',
            M.interface('ProviderResponseReader', {
              next: M.call().returns(M.promise()),
              return: M.call().returns(M.undefined()),
            }),
            {
              async next() {
                !reading || Fail`Concurrent provider read`;
                !controller.signal.aborted || Fail`Provider transport stopped`;
                if (finished) return harden({ done: true, value: '' });
                reading = true;
                try {
                  const chunk = await Promise.race([
                    bodyReader.read(),
                    stopped,
                  ]);
                  !controller.signal.aborted ||
                    Fail`Provider transport stopped`;
                  if (chunk.done) {
                    const value = decoder.decode();
                    finish();
                    // The decoder can emit a final value; deliver it before EOF.
                    return harden({ done: value.length === 0, value });
                  }
                  chunk.value instanceof Uint8Array ||
                    Fail`Invalid provider bytes`;
                  bytes += BigInt(chunk.value.byteLength);
                  bytes <= limit || Fail`Provider response too large`;
                  return harden({
                    done: false,
                    value: decoder.decode(chunk.value, { stream: true }),
                  });
                } catch (_error) {
                  reportFailure();
                  stop();
                  return Fail`Provider transport failed`;
                } finally {
                  reading = false;
                  if (finished) finish();
                }
              },
              return: stop,
            },
          );
          return harden({ status: response.status, reader: stream });
        } catch (_error) {
          reportFailure();
          stop();
          // This exact wording is the contract `isCredentialRejection` reads.
          if (credentialRejected) return Fail`Provider credential rejected`;
          return Fail`Provider transport failed`;
        }
      },
    },
  );
  return harden({
    transport,
    dispose: () => {
      disposed = true;
      for (const stop of pending) stop();
    },
  });
};
harden(makeProviderFetchTransport);
