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
 * every segment of an endowment path must be an ordinary name so none can
 * shadow a special name such as `@self` or `@pins` in a guest directory.
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

/** @param {readonly string[]} path */
const pathKey = path => path.join('\0');

/**
 * @param {unknown} path
 * @returns {asserts path is string[]}
 */
const assertEndowmentPath = path => {
  if (!Array.isArray(path) || path.length === 0) {
    throw Fail`Endowment path must be a non-empty pet name path`;
  }
  for (const name of path) assertOrdinaryName(name, 'endowment path segment');
};

/** @param {readonly (readonly string[])[]} paths */
const normalizeEndowmentPaths = paths => {
  const byKey = new Map();
  for (const path of paths) {
    assertEndowmentPath(path);
    byKey.set(pathKey(path), [...path]);
  }
  return [...byKey.values()].sort((left, right) =>
    pathKey(left).localeCompare(pathKey(right)),
  );
};

/**
 * The largest policy count. Both counts are natural numbers this package
 * profiles to four bytes: a namespace retaining more than `2**32 - 1`
 * children, or instructions beyond `2**32 - 1` UTF-8 bytes, is outside any
 * deployment the factory serves. The bound is that profile choice, not a
 * JavaScript limit, so `number` represents every admitted count exactly and
 * `Math.min` over two of them is exact.
 */
export const MAX_POLICY_COUNT = 2 ** 32 - 1;
harden(MAX_POLICY_COUNT);

/**
 * @param {unknown} n
 * @param {string} field
 * @returns {asserts n is number}
 */
const assertCount = (n, field) => {
  (typeof n === 'number' &&
    Number.isInteger(n) &&
    n >= 0 &&
    n <= MAX_POLICY_COUNT) ||
    Fail`Policy field ${q(field)} must be an integer from 0 to ${q(MAX_POLICY_COUNT)}`;
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
  const { maxChildren, maxInstructionBytes, endowmentPaths, ...rest } = policy;
  Object.keys(rest).length === 0 ||
    Fail`Unknown policy fields ${q(Object.keys(rest))}`;
  assertCount(maxChildren, 'maxChildren');
  assertCount(maxInstructionBytes, 'maxInstructionBytes');
  if (!Array.isArray(endowmentPaths)) {
    throw Fail`Root policy requires an endowmentPaths list`;
  }
  return harden({
    maxChildren,
    maxInstructionBytes,
    endowmentPaths: normalizeEndowmentPaths(endowmentPaths),
  });
};
harden(makeRootPolicy);

/**
 * Intersect a requested policy with the issuing namespace's effective policy.
 * The result can only reduce: a larger quota or instruction bound is clamped
 * to the issuer's, and an endowment path the issuer excludes is dropped. An
 * absent field inherits.
 *
 * @param {EffectivePolicy} issuer
 * @param {ChildAgentPolicy} [requested]
 * @returns {EffectivePolicy}
 */
export const intersectPolicy = (issuer, requested = {}) => {
  const { maxChildren, maxInstructionBytes, endowmentPaths, ...rest } =
    requested;
  Object.keys(rest).length === 0 ||
    Fail`Unknown policy fields ${q(Object.keys(rest))}`;
  if (maxChildren !== undefined) assertCount(maxChildren, 'maxChildren');
  if (maxInstructionBytes !== undefined) {
    assertCount(maxInstructionBytes, 'maxInstructionBytes');
  }
  let paths = issuer.endowmentPaths;
  if (endowmentPaths !== undefined) {
    Array.isArray(endowmentPaths) ||
      Fail`Policy field "endowmentPaths" must be a list`;
    const requestedPaths = new Set(
      normalizeEndowmentPaths(endowmentPaths).map(pathKey),
    );
    paths = issuer.endowmentPaths.filter(path =>
      requestedPaths.has(pathKey(path)),
    );
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
    endowmentPaths: paths,
  });
};
harden(intersectPolicy);

/**
 * Refuse a `create` request the namespace's policy does not admit. Quota is
 * checked separately because it spans ancestor namespaces.
 *
 * @param {EffectivePolicy} policy
 * @param {string} instructions
 * @param {string[][]} endowmentPaths
 */
export const assertCreateAdmitted = (policy, instructions, endowmentPaths) => {
  typeof instructions === 'string' || Fail`Instructions must be a string`;
  encodeUtf8(instructions).length <= policy.maxInstructionBytes ||
    Fail`Instructions exceed this factory's ${q(policy.maxInstructionBytes)}-byte bound`;
  const admitted = new Set(policy.endowmentPaths.map(pathKey));
  const seen = new Set();
  for (const path of endowmentPaths) {
    assertEndowmentPath(path);
    const key = pathKey(path);
    !seen.has(key) || Fail`Duplicate endowment path ${q(path)}`;
    seen.add(key);
    admitted.has(key) ||
      Fail`This factory does not admit the endowment path ${q(path)}`;
  }
  const sorted = [...endowmentPaths].sort((left, right) =>
    pathKey(left).localeCompare(pathKey(right)),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const shorter = sorted[index - 1];
    const longer = sorted[index];
    !shorter.every((name, offset) => longer[offset] === name) ||
      Fail`Endowment path ${q(shorter)} cannot also be a directory`;
  }
};
harden(assertCreateAdmitted);
