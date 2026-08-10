// @ts-check
/// <reference types="ses"/>

/**
 * Adapter from the embedding Android application's nodejs-mobile channel to
 * the structural {@link BridgeChannel} the transport consumes.
 *
 * nodejs-mobile exposes a Node-side module (conventionally `rn-bridge`) whose
 * `channel` carries strings between the embedded Node runtime and the app's
 * JVM side.  Frames are JSON documents, per `PROTOCOL.md`.
 */

import { makeError, q, X } from '@endo/errors';

/** @import { BridgeChannel } from './types.js' */

/**
 * Adapt the embedding's bridge module.
 *
 * @param {string} specifier - the bridge module's specifier, e.g.
 *   `'rn-bridge'`.  Passed as a value, and imported dynamically, because the
 *   module exists only inside the Android application: a static import would
 *   fail to resolve everywhere else, including on the desktop where the mock
 *   bridge path is exercised.
 * @returns {Promise<BridgeChannel>}
 */
export const adaptNodejsMobileChannel = async specifier => {
  await null;
  let bridgeModule;
  try {
    bridgeModule = await import(specifier);
  } catch (err) {
    throw makeError(
      X`@endo/host-android-admin could not load the nodejs-mobile bridge module ${q(
        specifier,
      )}; this formula only runs inside the device-owner application: ${q(
        /** @type {Error} */ (err).message,
      )}`,
    );
  }
  const channel = bridgeModule?.channel || bridgeModule?.default?.channel;
  if (!channel || typeof channel.send !== 'function') {
    throw makeError(
      X`@endo/host-android-admin: module ${q(specifier)} exposes no usable channel`,
    );
  }

  return harden({
    /** @param {{ id: number, request: unknown }} frame */
    send: frame => {
      channel.send(JSON.stringify(frame));
    },
    /** @param {(frame: unknown) => void} handler */
    subscribe: handler => {
      /** @param {unknown} message */
      const listener = message => {
        // A frame that does not parse is dropped with a diagnostic rather
        // than thrown: this runs inside the channel's listener, where a throw
        // would escape into the embedding's event loop instead of reaching
        // any caller.
        try {
          handler(JSON.parse(String(message)));
        } catch (err) {
          console.error(
            '@endo/host-android-admin: unparseable frame from bridge:',
            /** @type {Error} */ (err).message,
          );
        }
      };
      channel.on('message', listener);
      return () => {
        channel.removeListener('message', listener);
      };
    },
  });
};
harden(adaptNodejsMobileChannel);
