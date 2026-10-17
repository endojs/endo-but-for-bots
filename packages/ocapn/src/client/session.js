// @ts-check

/**
 * @import { OcapnLocation, OcapnSignature } from '../codecs/components.js'
 * @import { OcapnPublicKey } from '../cryptography.js'
 * @import { Ocapn } from './ocapn.js'
 * @import { Connection, InternalSession, SelfIdentity, SessionId } from './types.js'
 */

import harden from '@endo/harden';
import { ONE_N, ZERO_N } from '@endo/nat';

/**
 * @param {object} options
 * @param {SessionId} options.id
 * @param {SelfIdentity} options.selfIdentity
 * @param {OcapnLocation} options.peerLocation
 * @param {OcapnPublicKey} options.peerPublicKey
 * @param {OcapnSignature} options.peerLocationSig
 * @param {Ocapn} options.ocapn
 * @param {Connection} options.connection
 * @returns {InternalSession}
 */
export const makeSession = ({
  id,
  selfIdentity,
  peerLocation,
  peerPublicKey,
  peerLocationSig,
  ocapn,
  connection,
}) => {
  const { keyPair, location, locationSignature } = selfIdentity;
  let nextHandoffCount = ZERO_N;
  return harden({
    id,
    connection,
    ocapn,
    peer: {
      publicKey: peerPublicKey,
      location: peerLocation,
      locationSignature: peerLocationSig,
    },
    self: {
      keyPair,
      location,
      locationSignature,
    },
    getHandoffCount: () => {
      return nextHandoffCount;
    },
    takeNextHandoffCount: () => {
      const current = nextHandoffCount;
      nextHandoffCount += ONE_N;
      return current;
    },
  });
};
