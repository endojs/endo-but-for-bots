// @ts-check

/// <reference types="./types.d.ts" />

/** @import { EdgeName, Name, NamePath, PetName, SpecialName } from './types.js' */

import { q } from '@endo/errors';

/**
 * A valid name is 1–255 chars, contains no `/`, `\0`, or `@`, and is not `.`
 * or `..`.
 * @param {string} name
 * @returns {boolean}
 */
export const isValidName = name =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 255 &&
  !name.includes('/') &&
  !name.includes('\0') &&
  !name.includes('@') &&
  name !== '.' &&
  name !== '..';

const validSpecialNamePattern = /^@[a-z][a-z0-9-]{0,127}$/;

/**
 * @param {string} petName
 * @returns {petName is PetName}
 */
export const isPetName = petName => isValidName(petName);

/**
 * @param {string} name
 * @returns {name is SpecialName}
 */
export const isSpecialName = name => validSpecialNamePattern.test(name);

/**
 * @param {string} name
 * @returns {name is Name}
 */
export const isName = name => isPetName(name) || isSpecialName(name);

/**
 * @param {string} petName
 * @returns {asserts petName is PetName}
 */
export const assertPetName = petName => {
  if (typeof petName !== 'string' || !isPetName(petName)) {
    throw new Error(`Invalid pet name ${q(petName)}`);
  }
};

/**
 * @param {string} name
 * @returns {asserts name is SpecialName}
 */
export const assertSpecialName = name => {
  if (typeof name !== 'string' || !isSpecialName(name)) {
    throw new Error(`Invalid special name ${q(name)}`);
  }
};

/**
 * @param {string} name
 * @returns {asserts name is Name}
 */
export const assertName = name => {
  if (typeof name !== 'string' || !isName(name)) {
    throw new Error(`Invalid name ${q(name)}`);
  }
};

/**
 * Edge names can be either regular pet names or special names.
 * @param {string} edgeName
 * @returns {asserts edgeName is EdgeName}
 */
export const assertEdgeName = edgeName => {
  if (typeof edgeName !== 'string' || !isName(edgeName)) {
    throw new Error(`Invalid edge name ${q(edgeName)}`);
  }
};

/**
 * @param {string[]} names
 * @returns {asserts names is Name[]}
 */
export const assertNames = names => {
  for (const name of names) {
    assertName(name);
  }
};

/**
 * @param {string[]} petNames
 * @returns {asserts petNames is PetName[]}
 */
export const assertPetNames = petNames => {
  for (const petName of petNames) {
    assertPetName(petName);
  }
};

/**
 * @param {string[]} namePath
 * @returns {asserts namePath is NamePath}
 */
export const assertNamePath = namePath => {
  if (!Array.isArray(namePath) || namePath.length < 1) {
    throw new Error(`Invalid name path`);
  }
  for (const name of namePath) {
    assertName(name);
  }
};

/**
 * Asserts that the path is a valid name path ending in a pet name.
 * Returns the validated path, the prefix path (all but the last element),
 * and the final pet name.
 * @param {string[]} path
 * @returns {{ namePath: NamePath, prefixPath: NamePath, petName: PetName }}
 */
export const assertPetNamePath = path => {
  if (!Array.isArray(path) || path.length < 1) {
    throw new Error(`Invalid name path`);
  }
  const lastIndex = path.length - 1;
  for (let i = 0; i < lastIndex; i += 1) {
    assertName(path[i]);
  }
  const petName = path[lastIndex];
  assertPetName(petName);
  return {
    namePath: /** @type {NamePath} */ (path),
    prefixPath: /** @type {NamePath} */ (path.slice(0, -1)),
    petName,
  };
};

/**
 * Validates a pet-name path argument: an array of path components.
 *
 * A bare string is refused rather than treated as a one-segment path, so
 * that a caller (typically an agent) that passed a delimited string such as
 * `'dir/name'` learns that the invocation was invalid and retries with an
 * array of path components such as `['dir', 'name']`.
 *
 * @param {unknown} namePath
 * @returns {NamePath}
 */
export const namePathFrom = namePath => {
  if (typeof namePath === 'string') {
    // Suggest wrapping the string only when the result would be valid.
    const example = isName(namePath)
      ? `${q([namePath])} or ${q(['directory', 'name'])}`
      : q(['directory', 'name']);
    throw new TypeError(
      `Invalid pet-name path ${q(namePath)}: a string is not a pet-name path and is never split on a delimiter; try again with an array of path components, for example ${example}`,
    );
  }
  assertNamePath(/** @type {string[]} */ (namePath));
  return /** @type {NamePath} */ (namePath);
};

/**
 * Validates a **pet-name path**: a name path
 * whose final segment is a pet name (the others may be any name). This is
 * the canonical validator for a store target — a place a new value is
 * named — combining {@link namePathFrom} (refuse a string, validate each segment)
 * with {@link assertPetNamePath} (require a pet-name leaf). Returns the
 * full path, the prefix path (all but the last segment), and the final
 * pet name.
 *
 * Use {@link namePathFrom} instead when the leaf may be a special name
 * (e.g. resolving an existing `@main` worker or `@agent` powers).
 *
 * @param {unknown} namePath
 * @returns {{ namePath: NamePath, prefixPath: NamePath, petName: PetName }}
 */
export const petNamePathFrom = namePath =>
  assertPetNamePath(namePathFrom(namePath));

/**
 * Encodes a name path as a single string, for deriving one pet name from a
 * whole path. Each segment is percent-encoded and the segments are joined
 * with `%2F`, so distinct paths always yield distinct labels:
 * `['team-a', 'bob']` is `team-a%2Fbob` and `['team', 'a-bob']` is
 * `team%2Fa-bob`. A one-segment path of ordinary characters is unchanged.
 *
 * @param {NamePath} namePath
 * @returns {string}
 */
export const namePathLabel = namePath =>
  namePath.map(segment => encodeURIComponent(segment)).join('%2F');
