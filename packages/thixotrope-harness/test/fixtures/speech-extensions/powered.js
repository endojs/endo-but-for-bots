// @ts-check
/**
 * A probe gateway extension of `gateway-speech-extension.test.js`
 * (designs/m11-interfaces.md D-M11-22): its service records the context
 * the gateway gave it. The test imports this file too, so the object it
 * lists in `extensionPowers` is the one the loader required (A-5).
 * Imports nothing; reads the guest prelude off `globalThis`.
 */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

/** Every context a service or large-call target of this file received. */
export const contexts = [];

export const gatewayExtension = harden({
  name: 'probe-powered',
  services: [
    {
      label: 'probe-powered',
      make: (/** @type {any} */ context) => {
        contexts.push(context);
        return Far('Probe', { ping: () => 'pong' });
      },
    },
  ],
  largeCalls: [
    {
      target: async (/** @type {any} */ context) => {
        contexts.push(context);
        return Far('ProbeTarget', {});
      },
      methods: ['ping'],
    },
  ],
});
