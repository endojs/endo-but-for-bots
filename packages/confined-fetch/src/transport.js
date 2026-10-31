// @ts-check

/**
 * Adapt an endowed `@endo/fetch` `Fetch` capability, possibly in another vat,
 * into the local `FetchLike` transport `makeHttpClientAndControl` consumes.
 * This is the confined plugin's only route to the network.
 *
 * `AbortSignal` cannot cross a vat boundary, so the adapter forwards it as the
 * base's `cancelled` token and also races it locally, so a timeout or a
 * revocation does not wait on the remote request. The token is cancelled when
 * the body ends too, so the base can release its abort signal.
 */

import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import { fromAbortSignal } from '@endo/cancel/from-abort';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { thawedBytes } from '@endo/immutable-arraybuffer';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { FetchLike, FetchLikeRequestOptions, FetchLikeResponse } from '@endo/exo-http-client' */
/** @import { Fetch } from '@endo/fetch/src/types.js' */

/**
 * @param {ERef<Fetch>} base
 * @returns {FetchLike}
 */
export const makeTransportFromBase = base => {
  /**
   * @param {string} url
   * @param {FetchLikeRequestOptions} [options]
   * @returns {Promise<FetchLikeResponse>}
   */
  const transport = async (url, options) => {
    const {
      signal,
      body: requestBody,
      ...requestOptions
    } = options || {
      redirect: 'manual',
    };
    const parent = signal === undefined ? undefined : fromAbortSignal(signal);
    const { cancelled, cancel } = makeCancelKit(
      parent?.cancelled,
      parent?.isCancelled,
    );
    const release = () => cancel(Error('request settled'));

    const { body, ...summary } = await Promise.race([
      E(base).fetch(
        url,
        harden({
          ...requestOptions,
          ...(requestBody === undefined
            ? {}
            : { body: /** @type {string} */ (requestBody) }),
          cancelled,
        }),
      ),
      cancelled,
    ]);

    if (body === null) {
      release();
      return { ...summary, body: null };
    }
    // `iterateReader` consumes the byte stream a `bytesReaderFromIterator` serves.
    const iterator = iterateReader(/** @type {any} */ (body));
    return {
      ...summary,
      body: {
        getReader: () => ({
          read: async () => {
            await null;
            try {
              const result = await iterator.next();
              if (result.done) {
                release();
                return result;
              }
              // A passable byte array may sit over an emulated immutable
              // buffer that typed-array reads cannot see through.
              return {
                done: false,
                value: thawedBytes(/** @type {Uint8Array} */ (result.value)),
              };
            } catch (error) {
              release();
              throw error;
            }
          },
          cancel: async () => {
            release();
            await iterator.return(undefined);
          },
        }),
      },
    };
  };
  return transport;
};
harden(makeTransportFromBase);
