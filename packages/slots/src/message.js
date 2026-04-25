// @ts-check

import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';

import { makeCList } from './clist.js';
import { makeSlotCodec } from './codec.js';
import { makeSlotClient } from './client.js';
import { bootstrap as sessionBootstrap } from './bootstrap.js';

/** @import { Descriptor } from './descriptor.js' */

/**
 * @typedef {object} SlotEnvelope
 * @property {string} verb
 * @property {Uint8Array} payload
 */

/**
 * @template TBootstrap
 * @typedef {object} MessageSlotsResult
 * @property {() => unknown} getBootstrap
 *   Returns the remote peer's root presence.
 * @property {Promise<void>} closed
 * @property {(reason?: Error) => Promise<void>} close
 */

/**
 * Drop-in analogue of [`makeMessageCapTP`] from
 * `packages/daemon/src/connection.js`, but speaks slot-machine on
 * the wire.  Constructs a c-list + codec + client over the supplied
 * message streams, exchanges bootstrap roots via the position-1
 * convention, and returns `{ getBootstrap, closed, close }`.
 *
 * The `writer` and `reader` streams carry [`SlotEnvelope`] objects
 * — wrap a byte-level pipe with `mapWriter` /  `mapReader` +
 * `encodeEnvelope` / `decodeEnvelope` (from
 * `packages/daemon/src/envelope.js`) if you need to cross a pipe
 * boundary.
 *
 * @template TBootstrap
 * @param {string} name
 * @param {{ next: (env: SlotEnvelope) => unknown, return?: (v?: unknown) => unknown }} writer
 * @param {AsyncIterable<SlotEnvelope>} reader
 * @param {Promise<void>} cancelled
 * @param {TBootstrap} bootstrap
 * @returns {MessageSlotsResult<TBootstrap>}
 */
export const makeMessageSlots = (
  name,
  writer,
  reader,
  cancelled,
  bootstrap,
) => {
  const clist = makeCList({ label: name });

  /** @type {import('./client.js').makeSlotClient | null} */
  let clientRef = null;
  /**
   * @param {Descriptor} desc
   * @returns {unknown}
   */
  const makePresence = desc => {
    // Forward to the client so secondary slot references decode
    // into real HandledPromise presences rather than inert stubs.
    if (clientRef) {
      return /** @type {any} */ (clientRef).makePresence(desc);
    }
    // Before the client exists we cannot wire a presence; this
    // branch is unreachable because decoding only happens under
    // the inbound reader loop which starts after client is built.
    throw new Error(`makePresence called before client initialised: ${name}`);
  };
  const codec = makeSlotCodec({
    clist,
    makePresence,
    marshalName: name,
  });

  /**
   * @param {string} verb
   * @param {Uint8Array} payload
   */
  const sendEnvelope = (verb, payload) => {
    try {
      void writer.next(harden({ verb, payload }));
    } catch (err) {
      // Writer closed; drop is best-effort.  Real errors surface
      // through the reader's end-of-stream path which triggers
      // `close` below.
    }
  };

  const client = makeSlotClient({ clist, codec, sendEnvelope });
  clientRef = /** @type {any} */ (client);

  const { remoteRoot } = sessionBootstrap({ clist, client, root: bootstrap });

  const { promise: closedPromise, resolve: resolveClosed } = makePromiseKit();
  let isClosed = false;

  /** @type {(reason?: Error) => Promise<void>} */
  const close = async reason => {
    if (isClosed) return closedPromise;
    isClosed = true;
    try {
      if (writer.return) await writer.return(undefined);
    } catch (_err) {
      // writer may already be closed
    }
    resolveClosed(undefined);
    return closedPromise;
  };

  const drained = (async () => {
    try {
      for await (const env of reader) {
        client.onEnvelope(env.verb, env.payload);
      }
    } finally {
      close();
    }
  })();

  cancelled.catch(err => close(err));

  const closedRace = Promise.race([closedPromise, drained]).then(() => {});

  return harden({
    getBootstrap: () => remoteRoot,
    closed: closedRace,
    close,
  });
};
harden(makeMessageSlots);
