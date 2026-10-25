// @ts-check

import { sha256 } from '@endo/sha256';

/**
 * Fae names have a 63-character limit. Hash the complete durable identity and
 * role; connection hints do not change identity. Keep 224 digest bits so both
 * book and helper names fit without truncating either original identifier.
 * @param {string} locator
 * @param {string} role
 */
export const makeAuthorName = (locator, role) => {
  const identity = new URL(locator);
  const formula = identity.pathname.slice(1).split('@')[0];
  const bytes = new TextEncoder().encode(
    JSON.stringify([identity.hostname, formula, role]),
  );
  const digest = sha256(bytes);
  const suffix = Array.from(digest.subarray(0, 28), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `whylip-${suffix}`;
};
harden(makeAuthorName);
