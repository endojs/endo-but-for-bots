// @ts-check
/// <reference types="ses"/>

/**
 * Shared plumbing for named guest authority: binding validation,
 * denied-segment normalization, and deterministic concurrency ordering.
 * This module is deliberately free of `node:` imports.
 */

import { makeError, q, X } from '@endo/errors';

import { defaultDeniedSegments } from '../mount.js';
import { isPetName } from '../pet-name.js';

/**
 * The daemon polices only its own namespace: a binding name must be a valid
 * pet name and must not shadow a host-reserved infrastructure sibling.
 * Language-identifier and product-binding rules belong to the layer that
 * binds names into a compartment (agentry), not here.
 *
 * @param {string} name
 * @param {string} label
 */
export const assertProvisionBindingName = (name, label) => {
  if (!isPetName(name)) {
    throw makeError(X`${q(label)} must be a non-reserved pet name`);
  }
};
harden(assertProvisionBindingName);

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export const assertPathString = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw makeError(X`${q(label)} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw makeError(X`${q(label)} must not contain NUL bytes`);
  }
  return value;
};
harden(assertPathString);

/**
 * @param {string[] | undefined} value
 * @param {string} label
 * @returns {string[]}
 */
export const normalizeDeniedSegments = (value, label) =>
  harden(
    [
      ...new Set(
        (value ?? defaultDeniedSegments).map((segment, index) => {
          if (
            segment === '.' ||
            segment === '..' ||
            segment.includes('/') ||
            segment.includes('\\')
          ) {
            throw makeError(
              X`${q(`${label}[${index}]`)} must be one path segment`,
            );
          }
          return segment.toLowerCase();
        }),
      ),
    ].sort(),
  );
harden(normalizeDeniedSegments);

/**
 * Await every job, then surface the first failure in declaration order so
 * diagnostics stay deterministic even though the jobs run concurrently.
 *
 * @template T
 * @param {Array<Promise<T>>} jobs
 * @returns {Promise<T[]>}
 */
export const allInOrder = async jobs => {
  const outcomes = await Promise.allSettled(jobs);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      throw outcome.reason;
    }
  }
  return outcomes.map(
    outcome => /** @type {PromiseFulfilledResult<T>} */ (outcome).value,
  );
};
harden(allInOrder);
