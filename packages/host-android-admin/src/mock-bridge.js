// @ts-check
/// <reference types="ses"/>

/**
 * An in-memory stand-in for the privileged Android side of the bridge.
 *
 * This is the piece that makes the admin surface testable without a device.
 * It implements the same wire contract the Kotlin side implements — the same
 * request envelope, the same result envelope, the same error-as-data
 * discipline — over a fake `DevicePolicyManager` whose state is inspectable
 * from the test.
 *
 * It is deliberately shipped rather than confined to a test directory: a
 * cross-daemon integration test lives in a different package than this one,
 * and desktop bring-up of the daemon-side wiring wants the same fake.
 *
 * It is *not* a security boundary and must never be reachable from a
 * production formula path; `make()` selects it only on an explicit
 * `ENDO_ANDROID_BRIDGE=mock`.
 */

import { PROTOCOL_VERSION } from '@endo/exo-android-admin';

/** @import { AdminRequest, AdminResult } from '@endo/exo-android-admin' */
/** @import { MockDeviceState } from './types.js' */

/**
 * @param {string} name
 * @param {string} message
 * @returns {AdminResult}
 */
const failure = (name, message) =>
  harden({ ok: false, error: { name, message } });

/**
 * @param {unknown} [value]
 * @returns {AdminResult}
 */
const success = value =>
  value === undefined ? harden({ ok: true }) : harden({ ok: true, value });

/**
 * Build a mock bridge and its observable device state.
 *
 * @param {object} [options]
 * @param {boolean} [options.deviceOwner] - when false, every privileged action
 *   answers with a `SecurityException`, the way a real device does for an app
 *   that was never provisioned as device owner.
 * @param {string} [options.model]
 * @param {number} [options.apiLevel]
 * @returns {{
 *   transport: (request: AdminRequest) => Promise<AdminResult>,
 *   state: MockDeviceState,
 * }}
 */
export const makeMockDeviceBridge = ({
  deviceOwner = true,
  model = 'SM-A375F',
  apiLevel = 34,
} = {}) => {
  /** @type {MockDeviceState} */
  const state = {
    deviceOwner,
    model,
    apiLevel,
    restrictions: new Set(),
    hiddenPackages: new Set(),
    uninstallBlockedPackages: new Set(),
    cameraDisabled: false,
    screenCaptureDisabled: false,
    maximumTimeToLockMs: 0,
    passwordComplexity: 'none',
    lockCount: 0,
    rebootCount: 0,
    wiped: false,
    wipeReason: undefined,
  };

  /**
   * @param {AdminRequest} request
   * @returns {AdminResult}
   */
  const dispatch = request => {
    if (request.v !== PROTOCOL_VERSION) {
      return failure(
        'UnsupportedVersion',
        `protocol version ${request.v} is not implemented by this build`,
      );
    }
    const { action } = request;
    const args = /** @type {Record<string, any>} */ (request.args || {});

    // `getDeviceState` answers even without device-owner status: an operator
    // needs to be able to see *that* provisioning failed.
    if (action === 'getDeviceState') {
      return success(
        harden({
          deviceOwner: state.deviceOwner,
          model: state.model,
          apiLevel: state.apiLevel,
        }),
      );
    }

    if (!state.deviceOwner) {
      return failure(
        'SecurityException',
        'Calling package is not the device owner',
      );
    }

    switch (action) {
      case 'listUserRestrictions':
        return success(harden([...state.restrictions].sort()));
      case 'isApplicationHidden':
        return success(state.hiddenPackages.has(args.packageName));

      case 'lockNow':
        state.lockCount += 1;
        return success();
      case 'setCameraDisabled':
        state.cameraDisabled = args.disabled;
        return success();
      case 'setScreenCaptureDisabled':
        state.screenCaptureDisabled = args.disabled;
        return success();
      case 'setMaximumTimeToLock':
        state.maximumTimeToLockMs = args.timeMs;
        return success();
      case 'setRequiredPasswordComplexity':
        state.passwordComplexity = args.complexity;
        return success();
      case 'addUserRestriction':
        state.restrictions.add(args.key);
        return success();
      case 'clearUserRestriction':
        state.restrictions.delete(args.key);
        return success();
      case 'setApplicationHidden':
        if (args.hidden) {
          state.hiddenPackages.add(args.packageName);
        } else {
          state.hiddenPackages.delete(args.packageName);
        }
        return success();
      case 'setUninstallBlocked':
        if (args.blocked) {
          state.uninstallBlockedPackages.add(args.packageName);
        } else {
          state.uninstallBlockedPackages.delete(args.packageName);
        }
        return success();

      case 'reboot':
        state.rebootCount += 1;
        return success();
      case 'wipeData':
        state.wiped = true;
        state.wipeReason = args.reason;
        return success();

      default:
        // Never a silent no-op: an action this build does not know must fail,
        // or a caller would believe a policy took effect that never did.
        return failure(
          'UnknownAction',
          `action ${action} is not in this build's catalog`,
        );
    }
  };

  const transport = async (/** @type {AdminRequest} */ request) =>
    dispatch(request);

  return { transport, state };
};
harden(makeMockDeviceBridge);
