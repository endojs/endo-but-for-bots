// @ts-check

/**
 * Adapt an endowed `@endo/fetch` `Fetch` capability, possibly in another vat,
 * into the local `FetchLike` transport `makeHttpClientAndControl` consumes.
 * This is the confined plugin's only route to the network.
 *
 * The promise-based cancellation token crosses the vat boundary unchanged.
 * The adapter also races it locally, so a timeout or revocation does not wait
 * on a remote request that has not yet observed cancellation.
 */

import { E } from '@endo/eventual-send';
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
      cancelled,
      body: requestBody,
      ...requestOptions
    } = options || {
      redirect: 'manual',
    };
    const response = E(base).fetch(
      url,
      harden({
        ...requestOptions,
        ...(requestBody === undefined
          ? {}
          : { body: /** @type {string} */ (requestBody) }),
        ...(cancelled === undefined ? {} : { cancelled }),
      }),
    );
    const { body, ...summary } = await (cancelled === undefined
      ? response
      : Promise.race([response, cancelled]));

    if (body === null) {
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
            const result = await iterator.next();
            if (result.done) return result;
            // A passable byte array may sit over an emulated immutable
            // buffer that typed-array reads cannot see through.
            return {
              done: false,
              value: thawedBytes(/** @type {Uint8Array} */ (result.value)),
            };
          },
          cancel: async () => {
            await iterator.return(undefined);
          },
        }),
      },
    };
  };
  return transport;
};
harden(makeTransportFromBase);
