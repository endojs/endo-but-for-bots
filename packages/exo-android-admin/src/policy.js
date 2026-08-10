// @ts-check
/// <reference types="ses"/>

/**
 * Policy validation, intersection, and permission checks for the
 * `AndroidAdmin` capability.
 *
 * The policy is the whole of the guest-facing security story, so it is kept
 * in one place and made total: every action must be named to be reachable,
 * every package- or restriction-scoped action must additionally name its
 * subject, and destructive actions need a separate flag on top of both.
 */

import { Fail, q } from '@endo/errors';

import { ACTIONS, assertActionName, specFor } from './protocol.js';

/** @import { AdminPolicy, AdminPolicyBounds } from './types.js' */

/**
 * Validate a list of strings destined for an allowlist, returning a frozen
 * copy so a later mutation of the caller's array cannot widen authority
 * after construction.
 *
 * @param {unknown} list
 * @param {string} label
 * @returns {readonly string[]}
 */
const validateStringList = (list, label) => {
  Array.isArray(list) || Fail`${q(label)} must be an array of strings`;
  for (const item of /** @type {unknown[]} */ (list)) {
    (typeof item === 'string' && item.length > 0) ||
      Fail`${q(label)} must contain only non-empty strings, got ${q(item)}`;
  }
  return harden([.../** @type {string[]} */ (list)]);
};

/**
 * Validate a policy and settle its optional fields.
 *
 * Unknown action names are rejected rather than ignored: silently dropping a
 * misspelled action would produce a capability quietly weaker than the
 * operator believes they granted, and the failure would only appear when the
 * call was attempted against a real device.
 *
 * @param {AdminPolicy} policy
 * @returns {AdminPolicyBounds}
 */
export const validatePolicy = policy => {
  (policy !== null && typeof policy === 'object') ||
    Fail`policy must be an object, got ${q(policy)}`;
  const allowedActions = validateStringList(
    policy.allowedActions,
    'allowedActions',
  );
  for (const action of allowedActions) {
    assertActionName(action);
  }
  const allowedPackages = validateStringList(
    policy.allowedPackages ?? [],
    'allowedPackages',
  );
  const allowedRestrictions = validateStringList(
    policy.allowedRestrictions ?? [],
    'allowedRestrictions',
  );
  const allowDestructive = policy.allowDestructive ?? false;
  typeof allowDestructive === 'boolean' ||
    Fail`allowDestructive must be a boolean, got ${q(allowDestructive)}`;
  return harden({
    allowedActions,
    allowedPackages,
    allowedRestrictions,
    allowDestructive,
  });
};
harden(validatePolicy);

/**
 * Intersect two already-validated bounds, producing one no stronger than
 * either.  Booleans intersect by conjunction; lists intersect by membership.
 *
 * This is what makes `attenuate` safe to expose on the guest facet: whatever
 * a holder asks for, the result is bounded by what the holder already had, so
 * delegation can only narrow authority.  It is also cheap enough to recompute
 * on every call, which is what lets a derived facet track a later narrowing
 * of its parent instead of holding a stale snapshot.
 *
 * @param {AdminPolicyBounds} a
 * @param {AdminPolicyBounds} b
 * @returns {AdminPolicyBounds}
 */
export const intersectBounds = (a, b) => {
  const intersectList = (
    /** @type {readonly string[]} */ left,
    /** @type {readonly string[]} */ right,
  ) => harden(left.filter(item => right.includes(item)));
  return harden({
    allowedActions: intersectList(a.allowedActions, b.allowedActions),
    allowedPackages: intersectList(a.allowedPackages, b.allowedPackages),
    allowedRestrictions: intersectList(
      a.allowedRestrictions,
      b.allowedRestrictions,
    ),
    allowDestructive: a.allowDestructive && b.allowDestructive,
  });
};
harden(intersectBounds);

/**
 * Validate `restriction` and intersect it with `base`.
 *
 * @param {AdminPolicyBounds} base
 * @param {AdminPolicy} restriction
 * @returns {AdminPolicyBounds}
 */
export const intersectPolicies = (base, restriction) =>
  intersectBounds(base, validatePolicy(restriction));
harden(intersectPolicies);

/**
 * Assert that `policy` permits `action` against `positional` arguments.
 *
 * Checks run before anything reaches the bridge, in escalating order:
 * the action must be named; a destructive action must additionally clear
 * `allowDestructive`; and a scoped action's subject — the package name or
 * restriction key, which is always the action's first argument — must appear
 * in the corresponding allowlist.
 *
 * Revocation is checked by the caller against the live shared cell, not here:
 * these bounds are immutable, so a `revoked` field on them could only ever be
 * a stale copy.
 *
 * @param {AdminPolicyBounds} policy
 * @param {string} action
 * @param {readonly unknown[]} positional
 * @returns {void}
 */
export const assertPermitted = (policy, action, positional) => {
  const spec = specFor(action);
  policy.allowedActions.includes(action) ||
    Fail`admin action ${q(action)} is not permitted by policy`;
  if (spec.kind === 'destructive') {
    policy.allowDestructive ||
      Fail`admin action ${q(action)} is destructive and policy does not allow destructive actions`;
  }
  if (spec.scope !== undefined) {
    const subject = positional[0];
    // A `cond || Fail` expression does not narrow `subject` for the type
    // checker; the `if`/`throw` form does, which keeps this check-free
    // downstream without a type assertion.
    if (typeof subject !== 'string') {
      throw Fail`admin action ${q(action)} requires a ${q(spec.scope)} name as its first argument`;
    }
    const allowed =
      spec.scope === 'package'
        ? policy.allowedPackages
        : policy.allowedRestrictions;
    allowed.includes(subject) ||
      Fail`admin action ${q(action)} may not target ${q(spec.scope)} ${q(subject)}`;
  }
};
harden(assertPermitted);

/**
 * The set of every action name, for the convenience of callers minting a
 * fully-authorized control policy in tests and bring-up scripts.  Never a
 * default: a real deployment names the actions it means to grant.
 */
export const ALL_ACTIONS = harden(Object.keys(ACTIONS).sort());
