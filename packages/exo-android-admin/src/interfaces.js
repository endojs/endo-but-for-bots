// @ts-check
/// <reference types="ses"/>

import { M } from '@endo/patterns';

// #region Shape primitives

/**
 * The policy surface `inspect()` reveals.  Deliberately an *open* record on
 * `deviceOwner` for {@link DeviceStateShape} but a *closed* one here: the
 * bounds are exactly these five fields, so a future `inspect()` that
 * regressed to include the transport, the bridge's channel name, or any other
 * host-side handle would be rejected by the guard rather than leaking it to a
 * remote holder.  `M.splitRecord` is open by default (its rest pattern
 * defaults to `M.any()`), so closing it takes an explicit empty rest pattern.
 */
const AdminPolicyShape = M.splitRecord(
  {
    allowedActions: M.arrayOf(M.string()),
    allowedPackages: M.arrayOf(M.string()),
    allowedRestrictions: M.arrayOf(M.string()),
    allowDestructive: M.boolean(),
    revoked: M.boolean(),
  },
  undefined,
  harden({}),
);

/**
 * The policy record accepted by `attenuate()` and `setPolicy()`.  Only
 * `allowedActions` is required; the remaining allowlists default to empty,
 * which is the safe direction — an omitted list grants nothing.
 */
const AdminPolicyArgShape = M.splitRecord(
  { allowedActions: M.arrayOf(M.string()) },
  {
    allowedPackages: M.arrayOf(M.string()),
    allowedRestrictions: M.arrayOf(M.string()),
    allowDestructive: M.boolean(),
  },
);

/**
 * Device state is an *open* record: the bridge reports `deviceOwner` plus
 * whatever identifying fields the Android side knows (model, API level,
 * security patch).  Pinning the full set here would make every Android-side
 * addition a breaking protocol change for no security benefit — the values
 * are already flowing outward to a holder authorized to read device state.
 */
const DeviceStateShape = M.splitRecord({ deviceOwner: M.boolean() });

// #endregion

const passwordComplexities = harden(['none', 'low', 'medium', 'high']);

/** The four `DevicePolicyManager` password-complexity buckets. */
export const PasswordComplexityShape = M.or(...passwordComplexities);

/**
 * Runtime guard for the guest-facing `AndroidAdmin` facet.
 *
 * Async methods use `callWhen` so the returns-guard applies to the *resolved*
 * value (`M.promise()` takes a label, not a payload shape, so it cannot
 * constrain a resolution).  `attenuate` and `inspect` are synchronous: the
 * former derives a facet from already-held authority and the latter reads
 * local state, so neither needs to reach the bridge.
 */
export const AndroidAdminInterface = M.interface('AndroidAdmin', {
  // Queries.
  getDeviceState: M.callWhen().returns(DeviceStateShape),
  listUserRestrictions: M.callWhen().returns(M.arrayOf(M.string())),
  isApplicationHidden: M.callWhen(M.string()).returns(M.boolean()),

  // Mutations.  Each resolves to `undefined`: success is the absence of a
  // failure envelope, so there is no bridge return value worth surfacing.
  lockNow: M.callWhen().returns(),
  setCameraDisabled: M.callWhen(M.boolean()).returns(),
  setScreenCaptureDisabled: M.callWhen(M.boolean()).returns(),
  setMaximumTimeToLock: M.callWhen(M.number()).returns(),
  setRequiredPasswordComplexity: M.callWhen(PasswordComplexityShape).returns(),
  addUserRestriction: M.callWhen(M.string()).returns(),
  clearUserRestriction: M.callWhen(M.string()).returns(),
  setApplicationHidden: M.callWhen(M.string(), M.boolean()).returns(),
  setUninstallBlocked: M.callWhen(M.string(), M.boolean()).returns(),

  // Destructive.
  reboot: M.callWhen().returns(),
  wipeData: M.callWhen().optional(M.string()).returns(),

  // Delegation and introspection.
  attenuate: M.call(AdminPolicyArgShape).returns(M.remotable('AndroidAdmin')),
  inspect: M.call().returns(AdminPolicyShape),
  help: M.call().returns(M.string()),
});

/**
 * Runtime guard for the host-retained `AndroidAdminControl` facet.  This
 * facet is never vended: `setPolicy` can *widen* authority, which is exactly
 * the power the guest must not hold.
 */
export const AndroidAdminControlInterface = M.interface('AndroidAdminControl', {
  inspect: M.call().returns(AdminPolicyShape),
  setPolicy: M.call(AdminPolicyArgShape).returns(),
  revoke: M.call().returns(),
  isRevoked: M.call().returns(M.boolean()),
  help: M.call().returns(M.string()),
});
