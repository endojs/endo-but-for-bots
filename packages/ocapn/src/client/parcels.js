// spell-out-exempt: swissNum spells the OCapN "Swiss number" domain term used package-wide.
// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { InternalSession } from './types.js'
 * @import { ParcelObject } from '@endo/pass-style'
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { decodeHex, encodeHex } from '@endo/hex';
import { frozenBytes, thawedBytes } from '@endo/immutable-arraybuffer';
import { makeParcel as makeRealmParcel } from '@endo/parcel';
import {
  decodeSwissnum,
  encodeSwissnum,
  swissnumFromBytes,
  swissnumToBytes,
} from './util.js';

/** @typedef {ParcelObject} Parcel */

/**
 * @typedef {object} ParcelDetails
 * @property {OcapnLocation} location
 * @property {string | Uint8Array} secret
 */

/** @typedef {(details: ParcelDetails) => Promise<unknown>} OpenParcelDetails */

/**
 * Encode the OCapN coordinates into the opaque location held by Parcel.
 * This spelling is internal to Endo; the protocol wire record remains the
 * specification-defined `ocapn-sturdyref` record.
 *
 * @param {OcapnLocation} location
 * @param {string | Uint8Array} secret
 * @returns {string}
 */
export const formatParcelLocation = (location, secret) => {
  const params = new URLSearchParams();
  params.set('ocapn', '1');
  params.set('peer', location.designator);
  params.set('transport', location.transport);
  if (location.network !== undefined) {
    params.set('network', location.network);
  }
  if (location.hints !== false) {
    for (const [key, value] of Object.entries(location.hints).sort()) {
      params.append('hint', `${key}=${value}`);
    }
  }
  if (typeof secret === 'string') {
    params.set('text', secret);
  } else {
    params.set('value', encodeHex(secret));
  }
  return `#${params}`;
};

/**
 * @param {string} parcelLocation
 * @returns {ParcelDetails}
 */
export const parseParcelLocation = parcelLocation => {
  const params = new URLSearchParams(
    parcelLocation.startsWith('#') ? parcelLocation.slice(1) : parcelLocation,
  );
  if (params.get('ocapn') !== '1') {
    throw TypeError('Not an OCapN Parcel location');
  }
  const peer = params.get('peer');
  if (peer === null) {
    throw TypeError('OCapN Parcel location has no peer');
  }
  const transport = params.get('transport');
  if (transport === null) {
    throw TypeError('OCapN Parcel location has no transport');
  }
  const text = params.get('text');
  const value = params.get('value');
  if ((text === null) === (value === null)) {
    throw TypeError('OCapN Parcel location must carry one value');
  }
  const hintEntries = params.getAll('hint').map(hint => {
    const separator = hint.indexOf('=');
    if (separator < 0) {
      throw TypeError('OCapN Parcel location has a malformed hint');
    }
    return [hint.slice(0, separator), hint.slice(separator + 1)];
  });
  const hints =
    hintEntries.length === 0 ? false : Object.fromEntries(hintEntries);
  /** @type {OcapnLocation} */
  const location = {
    type: 'ocapn-peer',
    designator: peer,
    transport,
    hints,
  };
  const network = params.get('network');
  if (network !== null) {
    location.network = network;
  }
  return harden({
    location: harden(location),
    secret:
      text !== null
        ? text
        : frozenBytes(decodeHex(/** @type {string} */ (value), 'Parcel value')),
  });
};

/** @type {OpenParcelDetails} */
const openUnbound = async _details => {
  throw Error('ocapn: Parcel was minted without an OCapN client to open it');
};

/**
 * @param {OcapnLocation} location
 * @param {string | Uint8Array} secret
 * @param {OpenParcelDetails} openDetails
 * @returns {Parcel}
 */
const makeBoundParcel = (location, secret, openDetails) => {
  const parcelLocation = formatParcelLocation(location, secret);
  return /** @type {Parcel} */ (
    makeRealmParcel(parcelLocation, receivedLocation =>
      openDetails(parseParcelLocation(receivedLocation)),
    )
  );
};

/**
 * @param {OcapnLocation} location
 * @param {string | Uint8Array} secret
 * @returns {Parcel}
 */
export const makeParcel = (location, secret) =>
  makeBoundParcel(location, secret, openUnbound);

/**
 * @typedef {object} ParcelTracker
 * @property {(location: OcapnLocation, secret: string | Uint8Array) => Parcel} makeParcel
 * @property {(secretBytes: Uint8Array) => Promise<any | undefined>} lookup
 */

/**
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} locator
 * @param {(location: OcapnLocation) => Promise<InternalSession>} [provideSession]
 * @param {(location: OcapnLocation) => boolean} [isSelfLocation]
 * @returns {ParcelTracker}
 */
export const makeParcelTracker = (
  locator,
  provideSession = undefined,
  isSelfLocation = undefined,
) => {
  const openDetails =
    provideSession === undefined || isSelfLocation === undefined
      ? openUnbound
      : async details => {
          const { location, secret } = details;
          if (isSelfLocation(location)) {
            const value = await locator.get(secret);
            if (value === undefined) {
              throw Error('ocapn: locator has no capability for parcel value');
            }
            return value;
          }
          const { ocapn } = await provideSession(location);
          const wireSecret =
            typeof secret === 'string'
              ? encodeSwissnum(secret)
              : swissnumFromBytes(secret);
          return E(ocapn.getRemoteBootstrap()).fetch(wireSecret);
        };
  return harden({
    makeParcel: (location, secret) =>
      makeBoundParcel(location, secret, openDetails),
    lookup: async secretBytes => {
      const swissNum = swissnumFromBytes(thawedBytes(secretBytes));
      try {
        return locator.get(decodeSwissnum(swissNum));
      } catch {
        return locator.get(swissnumToBytes(swissNum));
      }
    },
  });
};
