// @ts-check
/// <reference types="ses"/>

/**
 * The `AndroidAdmin` capability: a policy-bounded, remotable surface over an
 * Android device's `DevicePolicyManager`.
 *
 * The host constructs the pair and retains `control`; only `client` is ever
 * vended to a remote peer.  Every call is checked against the policy bounds
 * *before* a request is built, so an unauthorized action never reaches the
 * privileged Android side of the bridge at all.
 *
 * The exo is portable: it holds no Android, Node, or channel authority of its
 * own, only an injected {@link AdminTransport}.  That is what lets the entire
 * guest-facing surface be exercised on a desktop daemon against a mock bridge
 * (see `@endo/host-android-admin`'s mock), reserving a physical device for
 * acceptance testing.
 */

import { Fail, q } from '@endo/errors';
import { makeExo } from '@endo/exo';

import {
  AndroidAdminControlInterface,
  AndroidAdminInterface,
} from './interfaces.js';
import { makeRequest, unwrapResult } from './protocol.js';
import { assertPermitted, intersectBounds, validatePolicy } from './policy.js';

/**
 * @import {
 *   AdminPolicy,
 *   AdminPolicyBounds,
 *   AdminTransport,
 *   AndroidAdmin,
 *   AndroidAdminControl,
 * } from './types.js'
 */

const androidAdminHelp = `\
AndroidAdmin - A policy-bounded Android device administration capability.

Calls are checked against an allowlist of actions, target packages, and user
restrictions before reaching the device; destructive actions (reboot, wipe)
need a separate policy flag. inspect() reports the bounds in force.
attenuate(policy) derives a strictly weaker capability to delegate onward.`;

const androidAdminControlHelp = `\
AndroidAdminControl - The host-side companion to an AndroidAdmin.

Retained by the device-side host and never vended. Use setPolicy() to
re-scope the authority of every facet derived from this client, and revoke()
to sever them all at once.`;

/**
 * Create a paired `AndroidAdmin` / `AndroidAdminControl` capability.
 *
 * @param {object} args
 * @param {AdminTransport} args.transport - the seam to the privileged
 *   Android side.  A nodejs-mobile channel, a desktop mock, and a
 *   Robolectric harness are all assignable to this shape.
 * @param {AdminPolicy} args.policy - the initial authority bounds.
 * @returns {{ client: AndroidAdmin, control: AndroidAdminControl }}
 */
export const makeAndroidAdminAndControl = ({ transport, policy }) => {
  typeof transport === 'function' ||
    Fail`makeAndroidAdminAndControl: transport must be a function, got ${q(transport)}`;

  /**
   * The root bounds.  Reassigned by `control.setPolicy`, and read through
   * `getRootBounds` rather than captured, so a re-scope reaches every facet
   * already vended — including facets derived by `attenuate`, which recompute
   * their intersection against the live parent on every call.
   */
  let rootBounds = validatePolicy(policy);
  const getRootBounds = () => rootBounds;

  /**
   * Shared revocation state.  Deliberately one cell for the whole family
   * rather than a field on the immutable bounds: revoking the client must
   * also kill every capability derived from it, and a copied flag could not
   * do that.
   */
  let revoked = false;
  const assertNotRevoked = () => {
    !revoked || Fail`AndroidAdmin has been revoked`;
  };

  /**
   * Check a call against the live bounds, then drive it across the bridge.
   *
   * @param {() => AdminPolicyBounds} getBounds
   * @param {string} action
   * @param {readonly unknown[]} positional
   * @returns {Promise<unknown>}
   */
  const invoke = async (getBounds, action, positional) => {
    assertNotRevoked();
    assertPermitted(getBounds(), action, positional);
    const request = makeRequest(action, positional);
    const result = await transport(request);
    return unwrapResult(action, result);
  };

  /**
   * Build a facet over a bounds accessor.  `attenuate` recurses through here,
   * so a derived facet is the same kind of object as its parent — there is no
   * weaker "sub-client" type with a different surface.
   *
   * @param {() => AdminPolicyBounds} getBounds
   * @returns {AndroidAdmin}
   */
  const makeClient = getBounds => {
    /**
     * @param {string} action
     * @param {readonly unknown[]} [positional]
     */
    const call = (action, positional = []) =>
      invoke(getBounds, action, positional);

    const exo = makeExo('AndroidAdmin', AndroidAdminInterface, {
      // #region Queries

      // Queries return the bridge promise directly rather than awaiting it:
      // the `callWhen` guard applies the returns-shape to the resolution, so
      // an extra await would only add a turn.
      getDeviceState() {
        return /** @type {any} */ (call('getDeviceState'));
      },
      listUserRestrictions() {
        return /** @type {any} */ (call('listUserRestrictions'));
      },
      /** @param {string} packageName */
      isApplicationHidden(packageName) {
        return /** @type {any} */ (call('isApplicationHidden', [packageName]));
      },

      // #endregion

      // #region Mutations
      // Each awaits the bridge and resolves to `undefined`: success is the
      // absence of a failure envelope, so any value the Android side happens
      // to return is deliberately not surfaced as part of this contract.

      async lockNow() {
        await call('lockNow');
      },
      /** @param {boolean} disabled */
      async setCameraDisabled(disabled) {
        await call('setCameraDisabled', [disabled]);
      },
      /** @param {boolean} disabled */
      async setScreenCaptureDisabled(disabled) {
        await call('setScreenCaptureDisabled', [disabled]);
      },
      /** @param {number} timeMs */
      async setMaximumTimeToLock(timeMs) {
        await call('setMaximumTimeToLock', [timeMs]);
      },
      /** @param {string} complexity */
      async setRequiredPasswordComplexity(complexity) {
        await call('setRequiredPasswordComplexity', [complexity]);
      },
      /** @param {string} key */
      async addUserRestriction(key) {
        await call('addUserRestriction', [key]);
      },
      /** @param {string} key */
      async clearUserRestriction(key) {
        await call('clearUserRestriction', [key]);
      },
      /**
       * @param {string} packageName
       * @param {boolean} hidden
       */
      async setApplicationHidden(packageName, hidden) {
        await call('setApplicationHidden', [packageName, hidden]);
      },
      /**
       * @param {string} packageName
       * @param {boolean} blocked
       */
      async setUninstallBlocked(packageName, blocked) {
        await call('setUninstallBlocked', [packageName, blocked]);
      },

      // #endregion

      // #region Destructive

      async reboot() {
        await call('reboot');
      },
      /** @param {string} [reason] */
      async wipeData(reason) {
        await call('wipeData', [reason]);
      },

      // #endregion

      /**
       * Derive a strictly weaker capability.  The restriction is validated
       * once, here, but the intersection is recomputed per call against the
       * live parent bounds, so narrowing the parent (or revoking it) narrows
       * or kills every facet derived from it.
       *
       * @param {AdminPolicy} restriction
       */
      attenuate(restriction) {
        const restrictionBounds = validatePolicy(restriction);
        return makeClient(() =>
          intersectBounds(getBounds(), restrictionBounds),
        );
      },

      inspect() {
        return harden({ ...getBounds(), revoked });
      },
      help: () => androidAdminHelp,
    });
    return /** @type {AndroidAdmin} */ (/** @type {unknown} */ (exo));
  };

  const client = makeClient(getRootBounds);

  const control = makeExo('AndroidAdminControl', AndroidAdminControlInterface, {
    inspect() {
      return harden({ ...rootBounds, revoked });
    },
    /**
     * Replace the root bounds.  Unlike `attenuate`, this may *widen*
     * authority — which is precisely why the control facet is never vended.
     *
     * @param {AdminPolicy} next
     */
    setPolicy(next) {
      assertNotRevoked();
      rootBounds = validatePolicy(next);
    },
    revoke() {
      revoked = true;
    },
    isRevoked: () => revoked,
    help: () => androidAdminControlHelp,
  });

  return harden({
    client,
    control: /** @type {AndroidAdminControl} */ (
      /** @type {unknown} */ (control)
    ),
  });
};
harden(makeAndroidAdminAndControl);
