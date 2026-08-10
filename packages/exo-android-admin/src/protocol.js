// @ts-check
/// <reference types="ses"/>

/**
 * The wire contract between the portable `AndroidAdmin` exo and the
 * privileged Android side of the bridge.
 *
 * This module is the single source of truth for the protocol: the exo's
 * interface guards, the policy allowlist, the request codec, and the
 * cross-language golden fixtures all derive from {@link ACTIONS}. Adding an
 * administrative action means adding one catalog entry here — not editing a
 * guard, a validator, and a fixture separately, which is how the two halves
 * of a language boundary drift apart.
 *
 * See `../protocol/PROTOCOL.md` for the written specification the Kotlin
 * implementation is built against.
 */

import { Fail, q } from '@endo/errors';

/** @import { ActionName, ActionSpec, AdminRequest, AdminResult } from './types.js' */

/**
 * Protocol version carried in every request envelope. The Android side must
 * reject a request whose `v` it does not implement rather than guessing at
 * the argument shapes of a version it does not know.
 */
export const PROTOCOL_VERSION = 1;
harden(PROTOCOL_VERSION);

/**
 * The closed catalog of administrative actions.
 *
 * Each entry declares:
 *
 * - `kind` — `'query'` reads device state and is side-effect free; `'mutate'`
 *   changes device configuration; `'destructive'` is irreversible or
 *   service-interrupting (wipe, reboot) and is additionally gated by the
 *   policy's `allowDestructive` flag, so a broad action allowlist cannot
 *   grant a device wipe by accident.
 * - `args` — the argument names, in order, as the exo method receives them.
 *   The catalog fixes the wire record's keys; the exo builds
 *   `{ [name]: value }` from the positional method arguments.
 * - `scope` — which policy allowlist, if any, constrains this action's
 *   subject: `'package'` checks `allowedPackages`, `'restriction'` checks
 *   `allowedRestrictions`, and `undefined` means the action allowlist alone
 *   governs it.
 *
 * The set is deliberately small and device-owner-shaped. It is not a mirror
 * of `DevicePolicyManager`; it is the subset an HQ operator has a reason to
 * drive remotely.
 *
 * @type {Record<string, ActionSpec>}
 */
export const ACTIONS = harden({
  // #region Queries

  /** Device identity, API level, and device-owner status. */
  getDeviceState: { kind: 'query', args: [] },
  /** The user restrictions currently in force, as restriction keys. */
  listUserRestrictions: { kind: 'query', args: [] },
  /** Whether a package is currently hidden from the user. */
  isApplicationHidden: {
    kind: 'query',
    args: ['packageName'],
    scope: 'package',
  },

  // #endregion

  // #region Mutations

  /** Lock the screen immediately. */
  lockNow: { kind: 'mutate', args: [] },
  /** Enable or disable the camera device-wide. */
  setCameraDisabled: { kind: 'mutate', args: ['disabled'] },
  /** Enable or disable screen capture device-wide. */
  setScreenCaptureDisabled: { kind: 'mutate', args: ['disabled'] },
  /** Maximum idle time, in milliseconds, before the device locks itself. */
  setMaximumTimeToLock: { kind: 'mutate', args: ['timeMs'] },
  /** Required password complexity: one of none/low/medium/high. */
  setRequiredPasswordComplexity: { kind: 'mutate', args: ['complexity'] },
  /** Impose a user restriction, by restriction key. */
  addUserRestriction: {
    kind: 'mutate',
    args: ['key'],
    scope: 'restriction',
  },
  /** Lift a user restriction, by restriction key. */
  clearUserRestriction: {
    kind: 'mutate',
    args: ['key'],
    scope: 'restriction',
  },
  /** Hide or unhide an installed package. */
  setApplicationHidden: {
    kind: 'mutate',
    args: ['packageName', 'hidden'],
    scope: 'package',
  },
  /** Block or unblock user uninstallation of a package. */
  setUninstallBlocked: {
    kind: 'mutate',
    args: ['packageName', 'blocked'],
    scope: 'package',
  },

  // #endregion

  // #region Destructive

  /** Reboot the device. */
  reboot: { kind: 'destructive', args: [] },
  /** Factory-reset the device. Irreversible. */
  wipeData: { kind: 'destructive', args: ['reason'] },

  // #endregion
});

/** Every action name in the catalog. */
export const ACTION_NAMES = harden(
  /** @type {ActionName[]} */ (Object.keys(ACTIONS).sort()),
);

/**
 * Assert that `name` names an action in the catalog, and narrow it to
 * {@link ActionName}. The boundary check that lets every downstream site —
 * policy intersection, request building, fixture generation — treat the name
 * as known.
 *
 * @param {unknown} name
 * @returns {asserts name is ActionName}
 */
export const assertActionName = name => {
  (typeof name === 'string' && Object.hasOwn(ACTIONS, name)) ||
    Fail`unknown admin action ${q(name)}`;
};
harden(assertActionName);

/**
 * The catalog entry for an action, or a failure naming the unknown action.
 *
 * @param {string} name
 * @returns {ActionSpec}
 */
export const specFor = name => {
  assertActionName(name);
  return ACTIONS[name];
};
harden(specFor);

/**
 * Build the wire request envelope for an action call.
 *
 * Positional method arguments are zipped against the catalog's `args` names,
 * so the record's keys are fixed by the protocol rather than by the calling
 * convention of whichever exo method happens to invoke it. Trailing
 * `undefined` arguments are omitted so an optional argument is absent from
 * the wire record rather than present-and-null.
 *
 * @param {string} action
 * @param {readonly unknown[]} [positional]
 * @returns {AdminRequest}
 */
export const makeRequest = (action, positional = []) => {
  const spec = specFor(action);
  positional.length <= spec.args.length ||
    Fail`action ${q(action)} takes at most ${q(spec.args.length)} arguments, got ${q(positional.length)}`;
  /** @type {Record<string, unknown>} */
  const args = {};
  for (let i = 0; i < spec.args.length; i += 1) {
    const value = positional[i];
    if (value !== undefined) {
      args[spec.args[i]] = value;
    }
  }
  return harden({ v: PROTOCOL_VERSION, action, args });
};
harden(makeRequest);

/**
 * Unwrap a result envelope from the Android side.
 *
 * The bridge answers in data, never in exceptions: a JVM throwable cannot
 * cross the channel as a JavaScript throw, so a failure arrives as
 * `{ ok: false, error }` and is rethrown here, on the JavaScript side of the
 * boundary, where it becomes an ordinary rejection for the caller.
 *
 * @param {string} action - names the action in the thrown error.
 * @param {AdminResult} result
 * @returns {unknown}
 */
export const unwrapResult = (action, result) => {
  (result !== null && typeof result === 'object') ||
    Fail`bridge returned a non-object result for ${q(action)}`;
  if (result.ok === true) {
    return result.value;
  }
  if (result.ok === false) {
    const {
      name = 'Error',
      message = 'bridge reported an unspecified failure',
    } = result.error || {};
    throw Fail`android admin action ${q(action)} failed: ${q(name)}: ${q(message)}`;
  }
  throw Fail`bridge returned a malformed result envelope for ${q(action)}`;
};
harden(unwrapResult);
