// @ts-check

import harden from '@endo/harden';
import { sha256 } from '@noble/hashes/sha2';

const textEncoder = new TextEncoder();

const LABEL_PREFIX = 'slots/session/';

/**
 * Deterministic session identifier.  Must match
 * `slots::session::SessionId::from_label(label)` in the Rust crate:
 *
 *   SHA-256("slots/session/" || label.utf8()) → 32 bytes
 *
 * @param {string} label
 * @returns {Uint8Array} 32 bytes
 */
export const sessionIdFromLabel = label => {
  const bytes = textEncoder.encode(`${LABEL_PREFIX}${label}`);
  return sha256(bytes);
};
harden(sessionIdFromLabel);

/**
 * Hex encoding of a session id — useful for logs and diagnostics.
 *
 * @param {Uint8Array} id
 * @returns {string}
 */
export const sessionIdHex = id => {
  let out = '';
  for (let i = 0; i < id.length; i += 1) {
    const byte = id[i];
    out += (byte < 16 ? '0' : '') + byte.toString(16);
  }
  return out;
};
harden(sessionIdHex);
