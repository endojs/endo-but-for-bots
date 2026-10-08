// Entry-point fixture for env-options-in-compartment.test.js.
//
// Loaded via `importLocation` from `@endo/compartment-mapper` so that
// `@endo/env-options` is resolved and instantiated inside a sub-compartment
// using the package's actual on-disk source.
// The compartment-mapper plumbs the per-compartment `process` global into the
// sub-compartment's `globalThis`, allowing the captor to read the
// sub-compartment's own `process.env` rather than the parent process's.
//
// This module mirrors the `ENDO_RANK_STRINGS` branch in
// `packages/marshal/src/rankOrder.js` for plain strings: the option is
// captured once at module evaluation and used to choose between code-unit
// and code-point comparison.

import { getEnvironmentOption } from '@endo/env-options';

const ENDO_RANK_STRINGS = getEnvironmentOption(
  'ENDO_RANK_STRINGS',
  'utf16-code-unit-order',
  ['unicode-code-point-order', 'error-if-order-choice-matters'],
);

export const capturedSetting = ENDO_RANK_STRINGS;

/**
 * @param {string} left
 * @param {string} right
 * @returns {-1 | 0 | 1}
 */
const codeUnitCompare = (left, right) => {
  // eslint-disable-next-line no-nested-ternary
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * @param {string} left
 * @param {string} right
 * @returns {-1 | 0 | 1}
 */
const codePointCompare = (left, right) => {
  // Iterate by code point rather than by UTF-16 code unit.
  const leftCodePoints = [...left];
  const rightCodePoints = [...right];
  const commonLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let i = 0; i < commonLength; i += 1) {
    const leftCodePoint = /** @type {number} */ (
      leftCodePoints[i].codePointAt(0)
    );
    const rightCodePoint = /** @type {number} */ (
      rightCodePoints[i].codePointAt(0)
    );
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }
  // eslint-disable-next-line no-nested-ternary
  return leftCodePoints.length < rightCodePoints.length
    ? -1
    : leftCodePoints.length > rightCodePoints.length
      ? 1
      : 0;
};

/**
 * @param {string} left
 * @param {string} right
 * @returns {-1 | 0 | 1}
 */
export const compareStrings = (left, right) => {
  switch (ENDO_RANK_STRINGS) {
    case 'utf16-code-unit-order':
      return codeUnitCompare(left, right);
    case 'unicode-code-point-order':
      return codePointCompare(left, right);
    default:
      throw Error(`Unexpected ENDO_RANK_STRINGS ${ENDO_RANK_STRINGS}`);
  }
};
