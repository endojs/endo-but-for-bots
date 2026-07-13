// @ts-check

/**
 * OCapN wiring for portrait heaps (design doc §3.7), attaching purely
 * at the seams `makeOcapn` already exposes — no wire changes:
 *
 * - `makeOcapnSpecials()` — a specials codec that portrays sturdyrefs
 *   held in persistent state as durable `(location, secret)` data and
 *   re-mints live sturdyrefs on restore. Late-bound to the client
 *   because a heap can restore before (or without) a client existing.
 * - `makeHeapLocator(heap, fallback?)` — the `locator` to pass to
 *   `makeOcapn`, resolving inbound `fetch(swissnum)` through the
 *   heap's durable bindings (accepts a promise for the heap so the
 *   client can be constructed first).
 * - `provideSturdyRefBinding(...)` — mints a binding and, per
 *   invariant P2, awaits durability before returning the sturdyref,
 *   so a ref that has been handed out always revives.
 */

import harden from '@endo/harden';
import { makeTagged, getTag, passStyleOf } from '@endo/pass-style';
import { encodeHex, decodeHex } from '@endo/hex';
import { Fail } from '@endo/errors';
import { isSturdyRef, getSturdyRefDetails } from '@endo/ocapn';

/**
 * @import { PersistentHeap, SpecialsCodec } from './types.js'
 * @import { CopyTagged } from '@endo/pass-style'
 */

const STURDYREF_TAG = 'portrait:sturdyref';

/**
 * @returns {{
 *   specials: SpecialsCodec,
 *   connect: (client: {
 *     makeSturdyRef: (location: any, secret: string | Uint8Array) => any,
 *   }) => void,
 * }}
 */
export const makeOcapnSpecials = () => {
  /** @type {((location: any, secret: string | Uint8Array) => any) | undefined} */
  let mintSturdyRef;

  /** @type {SpecialsCodec} */
  const specials = harden({
    /** @param {CopyTagged} tagged */
    encodeTagged: tagged => {
      if (!isSturdyRef(tagged)) {
        return undefined;
      }
      const details = getSturdyRefDetails(/** @type {any} */ (tagged));
      const { location, secret } = /** @type {NonNullable<typeof details>} */ (
        details
      );
      /** @type {Record<string, unknown>} */
      const locationData = {
        type: location.type,
        designator: location.designator,
        transport: location.transport,
        hints: location.hints ? harden({ ...location.hints }) : false,
      };
      if (location.network !== undefined) {
        locationData.network = location.network;
      }
      return makeTagged(
        STURDYREF_TAG,
        /** @type {any} */ (
          harden({
            location: harden(locationData),
            secret:
              typeof secret === 'string'
                ? harden({ text: secret })
                : harden({ hex: encodeHex(secret) }),
          })
        ),
      );
    },
    /** @param {CopyTagged} tagged */
    decodeTagged: tagged => {
      if (passStyleOf(tagged) !== 'tagged' || getTag(tagged) !== STURDYREF_TAG) {
        return undefined;
      }
      mintSturdyRef !== undefined ||
        Fail`portrait ocapn specials must be connected to a client before sturdyrefs can restore`;
      const { location, secret } = /** @type {any} */ (tagged).payload;
      const secretValue =
        'text' in secret ? secret.text : decodeHex(secret.hex);
      return /** @type {NonNullable<typeof mintSturdyRef>} */ (mintSturdyRef)(
        location,
        secretValue,
      );
    },
  });

  return harden({
    specials,
    connect: client => {
      mintSturdyRef = (location, secret) =>
        client.makeSturdyRef(location, secret);
    },
  });
};
harden(makeOcapnSpecials);

/**
 * An ocapn `locator` backed by a heap's durable sturdyref bindings.
 * `get` may return a promise (the locator contract allows it), so the
 * heap may still be booting when the client is constructed.
 *
 * @param {PersistentHeap | Promise<PersistentHeap>} heapP
 * @param {{ get: (secret: string | Uint8Array) => unknown } } [fallback]
 */
export const makeHeapLocator = (heapP, fallback = undefined) =>
  harden({
    /** @param {string | Uint8Array} secret */
    get: async secret => {
      const heap = await heapP;
      const value = heap.lookupBinding(secret);
      if (value !== undefined) {
        return value;
      }
      return fallback === undefined ? undefined : fallback.get(secret);
    },
  });
harden(makeHeapLocator);

/**
 * Mint a durable sturdyref for a persistent instance. Awaits the
 * heap flush before returning (invariant P2): once the caller holds
 * the ref, the binding — and the object graph behind it — is durably
 * stored, so the ref revives across restarts.
 *
 * @param {PersistentHeap} heap
 * @param {{ makeSturdyRef: (location: any, secret: string | Uint8Array) => any }} client
 * @param {any} location The heap process's own ocapn location.
 * @param {unknown} obj A persistent exo instance (or kit facet).
 * @param {{ secret?: string | Uint8Array }} [options]
 */
export const provideSturdyRefBinding = async (
  heap,
  client,
  location,
  obj,
  options = undefined,
) => {
  const secret = heap.provideBinding(obj, options);
  await heap.flush();
  return client.makeSturdyRef(location, secret);
};
harden(provideSturdyRefBinding);
