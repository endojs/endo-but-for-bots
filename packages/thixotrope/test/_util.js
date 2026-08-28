// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { Client } from '@endo/ocapn/client/types' */

import harden from '@endo/harden';
import { makeOcapn } from '@endo/ocapn';

/**
 * The worker and hub fixtures expose several capabilities with different
 * method sets.
 * `fetch`, `evaluate`, and `getGift` are the capability-producing methods
 * shared by the worker and hub fixtures.
 *
 * @template [MethodResult=any]
 * @typedef {object} ThixotropeRemote
 * @property {(swissnum: Uint8Array) => ERef<ThixotropeRemote>} fetch
 * @property {(source: string, endowments?: Record<string, unknown>) => ERef<MethodResult>} evaluate
 * @property {() => ERef<{ gift: Promise<unknown> }>} getGift
 *
 * @typedef {object} ThixotropeBootstrap
 * @property {(swissnum: Uint8Array) => ERef<ThixotropeRemote>} fetch
 */

/**
 * Construct a test OCapN client with the bootstrap interface shared by the
 * worker and hub fixtures.
 *
 * @param {Parameters<typeof makeOcapn>[0]} options
 * @returns {Promise<Client<ThixotropeBootstrap>>}
 */
export const makeTestOcapn = options =>
  makeOcapn(options).then(
    client =>
      /** @type {Client<ThixotropeBootstrap>} */ (
        /** @type {unknown} */ (client)
      ),
  );
harden(makeTestOcapn);
