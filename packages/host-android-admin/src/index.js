// @ts-check
/// <reference types="ses"/>

/**
 * Unconfined Endo formula that mints an `AndroidAdmin` capability over the
 * privileged Android side of the device-owner application's bridge.
 *
 * This is the device-side backend of the Android administration capability,
 * mirroring how `@endo/host-spawner` backs `@endo/exo-shell`.  It is
 * *unconfined* because reaching the embedding's channel means reaching the
 * host module loader; everything the guest can touch is the portable exo from
 * `@endo/exo-android-admin`, which holds no host authority of its own.
 *
 * The formula returns a kit rather than a bare client: a formula has exactly
 * one result, and returning only the client would leave the control facet —
 * the sole means of re-scoping or revoking — unreachable.  The device-side
 * host holds the kit and vends `client()` onward; `control()` never leaves
 * the device.
 */

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeAndroidAdminAndControl } from '@endo/exo-android-admin';

import { makeChannelTransport } from './channel-transport.js';
import { makeMockDeviceBridge } from './mock-bridge.js';
import { adaptNodejsMobileChannel } from './nodejs-mobile-channel.js';

export { makeChannelTransport } from './channel-transport.js';
export { makeMockDeviceBridge } from './mock-bridge.js';
export { adaptNodejsMobileChannel } from './nodejs-mobile-channel.js';

/** @import { AdminPolicy } from '@endo/exo-android-admin' */

/**
 * The kit interface.  `client` and `control` are separate methods rather than
 * a returned record so that naming one in the daemon's pet store does not
 * drag the other along with it.
 */
export const AndroidAdminKitInterface = M.interface('AndroidAdminKit', {
  client: M.call().returns(M.remotable('AndroidAdmin')),
  control: M.call().returns(M.remotable('AndroidAdminControl')),
  help: M.call().returns(M.string()),
});

const androidAdminKitHelp = `\
AndroidAdminKit - The device-side pair for an AndroidAdmin capability.

client() returns the vendable, policy-bounded facet; control() returns the
host-retained facet that can re-scope policy and revoke. Vend client() to a
remote peer; keep control() on the device.`;

/**
 * Parse the formula env's JSON policy.
 *
 * A policy is required and has no default: defaulting would mean guessing how
 * much authority over a physical device the operator meant to grant.
 *
 * @param {string | undefined} text
 * @returns {AdminPolicy}
 */
export const parsePolicy = text => {
  if (typeof text !== 'string' || text.length === 0) {
    throw makeError(
      X`@endo/host-android-admin requires a JSON "policy" in the formula env`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw makeError(
      X`@endo/host-android-admin could not parse the "policy" env as JSON: ${q(
        /** @type {Error} */ (err).message,
      )}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw makeError(
      X`@endo/host-android-admin "policy" env must be a JSON object, got ${q(parsed)}`,
    );
  }
  return harden(parsed);
};
harden(parsePolicy);

/**
 * Parse an optional positive-integer env value.
 *
 * @param {string | undefined} text
 * @param {string} label
 * @returns {number | undefined}
 */
export const parsePositiveInteger = (text, label) => {
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    throw makeError(
      X`@endo/host-android-admin "${q(label)}" must be a positive integer, got ${q(text)}`,
    );
  }
  return value;
};
harden(parsePositiveInteger);

/**
 * Formula entry point.  The daemon's `make-unconfined` formula loads this
 * module by file URL in a Node worker and calls
 * `make(powers, context, { env })`.
 *
 * Recognized `env` keys:
 *
 * - `policy` (required): a JSON object with `allowedActions` and optionally
 *   `allowedPackages`, `allowedRestrictions`, and `allowDestructive`.
 * - `bridge` (optional): `'nodejs-mobile'` (default) to reach the embedding
 *   app's channel, or `'mock'` for an in-memory fake device.  The mock is
 *   for desktop bring-up and tests and is never selected implicitly.
 * - `channelModule` (optional): the specifier of the embedding's bridge
 *   module, default `'rn-bridge'` — the module nodejs-mobile exposes on the
 *   Node side.
 * - `timeoutMs` (optional): per-call bound on the bridge, default 30000.
 *
 * @param {unknown} _powers - Daemon-supplied powers; unused.  The channel to
 *   the privileged app, not a daemon power, is the authority this formula
 *   wields.
 * @param {unknown} context - Formula context; its cancellation tears down the
 *   transport.
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (_powers, context, { env = {} } = {}) => {
  await null;
  const policy = parsePolicy(env.policy);
  const timeoutMs = parsePositiveInteger(env.timeoutMs, 'timeoutMs');
  const bridge = env.bridge || 'nodejs-mobile';

  /** @type {() => void} */
  let stop = () => {};
  /** @type {(request: any) => Promise<any>} */
  let transport;

  if (bridge === 'mock') {
    // Explicitly selected only; never a fallback.  A silent fall back to a
    // fake device would let a misconfigured deployment report success for
    // administrative actions that never touched hardware.
    ({ transport } = makeMockDeviceBridge());
  } else if (bridge === 'nodejs-mobile') {
    // The embedding's bridge module exists only inside the Android
    // application; the adapter imports it dynamically so this module still
    // loads everywhere else, including in the desktop tests that exercise the
    // mock path.
    const channel = await adaptNodejsMobileChannel(
      env.channelModule || 'rn-bridge',
    );
    ({ transport, stop } = makeChannelTransport({ channel, timeoutMs }));
  } else {
    throw makeError(
      X`@endo/host-android-admin "bridge" env must be 'nodejs-mobile' or 'mock', got ${q(bridge)}`,
    );
  }

  const { client, control } = makeAndroidAdminAndControl(
    harden({ transport, policy }),
  );

  // A formula is cancelled when its dependencies die or the host revokes it.
  // Revoke the capability and tear down the channel subscription rather than
  // leaving a live administrative path to the device behind.
  if (context !== undefined) {
    E(/** @type {{ whenCancelled: () => Promise<unknown> }} */ (context))
      .whenCancelled()
      .catch(() => {
        control.revoke();
        stop();
      });
  }

  return makeExo('AndroidAdminKit', AndroidAdminKitInterface, {
    client: () => client,
    control: () => control,
    help: () => androidAdminKitHelp,
  });
};
harden(make);
