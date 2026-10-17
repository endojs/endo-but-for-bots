// @ts-check

import { compareUint8Arrays } from './bytewise-compare.js';

/**
 * Whether this side's dial is the one both sides keep when they redial
 * at once (designs/ocapn-noise-session-reconnect.md § 3, Crossed-Hellos
 * Tiebreaker): the side whose handshake ephemeral is the greater, as a
 * 32-byte big-endian integer.
 *
 * Equal ephemerals do not occur between honest peers, but a peer that
 * echoed ours back would leave both sides deferring to the other's
 * dial. The side that opened the session wins that tie, and exactly
 * one side did.
 *
 * @param {Uint8Array} localEphemeral
 * @param {Uint8Array} peerEphemeral
 * @param {boolean} isInitiator - Whether this side opened the session.
 * @returns {boolean}
 */
export const initiatesOnCrossedHellos = (
  localEphemeral,
  peerEphemeral,
  isInitiator,
) => {
  const order = compareUint8Arrays(localEphemeral, peerEphemeral);
  return order > 0 || (order === 0 && isInitiator);
};
