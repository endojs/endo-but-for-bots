// @ts-check
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';
import { encodeHex } from '@endo/hex';
import { sha256 } from '@noble/hashes/sha2.js';

import { HEX128_PATTERN } from '../random-id.js';

// Worker ids are host-generated unguessable random hex, never
// user-chosen names: reaching a worker requires a capability (a
// publication, a durable cross-worker link, or a facade), not a string.
const WORKER_ID_PATTERN = HEX128_PATTERN;

// Resume tokens arrive over the network and become directory names:
// validate the exact shape the durable netlayer mints before any
// filesystem use.
const SESSION_TOKEN_PATTERN = HEX128_PATTERN;

/** @param {string} token */
export const isSessionToken = token =>
  typeof token === 'string' && SESSION_TOKEN_PATTERN.test(token);
harden(isSessionToken);

/** @param {string} token */
export const assertSessionToken = token => {
  isSessionToken(token) ||
    Fail`Session token must match ${q(SESSION_TOKEN_PATTERN.source)}`;
};
harden(assertSessionToken);

/** @param {string} workerId */
export const assertWorkerId = workerId => {
  WORKER_ID_PATTERN.test(workerId) ||
    Fail`Worker id must match ${q(WORKER_ID_PATTERN.source)}, got ${q(
      workerId,
    )}`;
};
harden(assertWorkerId);

// A stored bundle is named by the SHA-256 of its bytes, as lowercase hex;
// the digest becomes a file name, so its shape is checked before any
// filesystem use.
const BUNDLE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const encoder = new TextEncoder();

/**
 * The digest a stored bundle is named by: the SHA-256 of its UTF-8 bytes,
 * as lowercase hex, which `assertBundleDigest` accepts.
 * @param {string} text
 */
export const bundleDigestOf = text => encodeHex(sha256(encoder.encode(text)));
harden(bundleDigestOf);

/** @param {string} digest */
export const assertBundleDigest = digest => {
  (typeof digest === 'string' && BUNDLE_DIGEST_PATTERN.test(digest)) ||
    Fail`Bundle digest must match ${q(BUNDLE_DIGEST_PATTERN.source)}, got ${q(
      digest,
    )}`;
};
harden(assertBundleDigest);
