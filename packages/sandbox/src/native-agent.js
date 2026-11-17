// @ts-check

import { Fail } from '@endo/errors';

import { makeOwnedNativeSandboxAgent } from './owned-agent.js';

const makeNative = makeOwnedNativeSandboxAgent();

/**
 * Host-only native service with slot-free constructor input. Resolve and retain
 * session paths in the native controller; this service imports no daemon host
 * or scratch-provider authority. It uses the same retained lifetime
 * implementation as the capability-based entrypoint.
 * @param {null | Promise<null>} powers
 * @param {Parameters<typeof makeNative>[1]} context
 * @param {Parameters<typeof makeNative>[2]} [options]
 */
export const make = (powers, context, options) => {
  const validated = Promise.resolve(powers).then(value => {
    value === null || Fail`Native sandbox service requires null powers`;
    return null;
  });
  // Configuration can fail before the owner begins waiting for powers.
  void validated.catch(() => {});
  return makeNative(validated, context, options);
};
harden(make);
