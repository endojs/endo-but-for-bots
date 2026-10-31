// @ts-check

import harden from '@endo/harden';
import { Fail, q } from '@endo/errors';
import { encodeUtf8 } from '@endo/utf8';

/**
 * @import { ChildAgentPolicy, EffectivePolicy, RootPolicy } from './types.js'
 */

/**
 * The daemon's ordinary pet-name rule (`packages/daemon/src/pet-name.js`): 1 to
 * 255 characters with no `/`, NUL, or `@`, and neither `.` nor `..`. Child and
 * endowment names must be ordinary names so neither can shadow a special name
 * such as `@self` or `@pins` in a guest directory.
 *
 * @param {unknown} name
 * @returns {name is string}
 */
export const isOrdinaryName = name =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 255 &&
  !name.includes('/') &&
  !name.includes('\0') &&
  !name.includes('@') &&
  name !== '.' &&
  name !== '..';
harden(isOrdinaryName);

/**
 * @param {unknown} name
 * @param {string} what
 * @returns {asserts name is string}
 */
export const assertOrdinaryName = (name, what) => {
  isOrdinaryName(name) || Fail`${q(what)} must be an ordinary pet name`;
};
harden(assertOrdinaryName);

/**
 * @param {unknown} n
 * @param {string} field
 * @returns {asserts n is number}
 */
const assertCount = (n, field) => {
  (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) ||
    Fail`Policy field ${q(field)} must be a non-negative safe integer`;
};

/**
 * Validate and normalize the root policy a deployment installs. Unlike a
 * `bind` argument, every field is required: the root bounds everything below
 * it, so it cannot inherit.
 *
 * @param {RootPolicy} policy
 * @returns {EffectivePolicy}
 */
export const makeRootPolicy = policy => {
  const { maxChildren, maxInstructionBytes, endowmentNames, ...rest } = policy;
  Object.keys(rest).length === 0 ||
    Fail`Unknown policy fields ${q(Object.keys(rest))}`;
  assertCount(maxChildren, 'maxChildren');
  assertCount(maxInstructionBytes, 'maxInstructionBytes');
  if (!Array.isArray(endowmentNames)) {
    throw Fail`Root policy requires an endowmentNames list`;
  }
  for (const name of endowmentNames) {
    assertOrdinaryName(name, 'endowment name');
  }
  return harden({
    maxChildren,
    maxInstructionBytes,
    endowmentNames: [...new Set(endowmentNames)].sort(),
  });
};
harden(makeRootPolicy);

/**
 * Intersect a requested policy with the issuing namespace's effective policy.
 * The result can only reduce: a larger quota or instruction bound is clamped
 * to the issuer's, and an endowment name the issuer excludes is dropped. An
 * absent field inherits.
 *
 * @param {EffectivePolicy} issuer
 * @param {ChildAgentPolicy} [requested]
 * @returns {EffectivePolicy}
 */
export const intersectPolicy = (issuer, requested = {}) => {
  const { maxChildren, maxInstructionBytes, endowmentNames, ...rest } =
    requested;
  Object.keys(rest).length === 0 ||
    Fail`Unknown policy fields ${q(Object.keys(rest))}`;
  if (maxChildren !== undefined) assertCount(maxChildren, 'maxChildren');
  if (maxInstructionBytes !== undefined) {
    assertCount(maxInstructionBytes, 'maxInstructionBytes');
  }
  let names = issuer.endowmentNames;
  if (endowmentNames !== undefined) {
    Array.isArray(endowmentNames) ||
      Fail`Policy field "endowmentNames" must be a list`;
    for (const name of endowmentNames) {
      assertOrdinaryName(name, 'endowment name');
    }
    const requestedNames = new Set(endowmentNames);
    names = issuer.endowmentNames.filter(name => requestedNames.has(name));
  }
  return harden({
    maxChildren:
      maxChildren === undefined
        ? issuer.maxChildren
        : Math.min(maxChildren, issuer.maxChildren),
    maxInstructionBytes:
      maxInstructionBytes === undefined
        ? issuer.maxInstructionBytes
        : Math.min(maxInstructionBytes, issuer.maxInstructionBytes),
    endowmentNames: names,
  });
};
harden(intersectPolicy);

/**
 * Refuse a `create` request the namespace's policy does not admit. Quota is
 * checked separately because it spans ancestor namespaces.
 *
 * @param {EffectivePolicy} policy
 * @param {string} instructions
 * @param {string[]} endowmentNames
 */
export const assertCreateAdmitted = (policy, instructions, endowmentNames) => {
  typeof instructions === 'string' || Fail`Instructions must be a string`;
  encodeUtf8(instructions).length <= policy.maxInstructionBytes ||
    Fail`Instructions exceed this factory's ${q(policy.maxInstructionBytes)}-byte bound`;
  for (const name of endowmentNames) {
    assertOrdinaryName(name, 'endowment name');
    policy.endowmentNames.includes(name) ||
      Fail`This factory does not admit the endowment name ${q(name)}`;
  }
};
harden(assertCreateAdmitted);
