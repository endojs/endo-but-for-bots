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
import {
  isParcel as isRealmParcel,
  locate,
  makeParcel as makeRealmParcel,
} from '@endo/parcel';
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
  params.set('peer', JSON.stringify(location));
  if (typeof secret === 'string') {
    params.set('text', secret);
  } else {
    params.set('value', encodeHex(thawedBytes(secret)));
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
  const text = params.get('text');
  const value = params.get('value');
  if ((text === null) === (value === null)) {
    throw TypeError('OCapN Parcel location must carry one value');
  }
  const location = JSON.parse(/** @type {string} */ (peer));
  if (!location || location.type !== 'ocapn-peer') {
    throw TypeError('OCapN Parcel peer is malformed');
  }
  return harden({
    location,
    secret:
      text !== null
        ? text
        : frozenBytes(decodeHex(/** @type {string} */ (value), 'Parcel value')),
  });
};

/**
 * @param {unknown} value
 * @returns {value is Parcel}
 */
export const isParcel = value => isRealmParcel(value);

/**
 * Read OCapN coordinates with the caller's privileged initial Parcel
 * constructor. A Parcel with a location for another scheme has no OCapN
 * details and is rejected by the OCapN wire codec.
 *
 * @param {Parcel} parcel
 * @returns {ParcelDetails | undefined}
 */
export const getParcelDetails = parcel => {
  try {
    return parseParcelLocation(locate(parcel));
  } catch {
    return undefined;
  }
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
 * @param {ParcelDetails} details
 * @param {(location: OcapnLocation) => Promise<InternalSession>} provideSession
 * @param {(location: OcapnLocation) => boolean} isSelfLocation
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} locator
 */
export const openParcelDetails = async (
  details,
  provideSession,
  isSelfLocation,
  locator,
) => {
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

/**
 * @param {Parcel} parcel
 * @param {(location: OcapnLocation) => Promise<InternalSession>} provideSession
 * @param {(location: OcapnLocation) => boolean} isSelfLocation
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} locator
 */
export const openParcel = async (
  parcel,
  provideSession,
  isSelfLocation,
  locator,
) => {
  const details = getParcelDetails(parcel);
  if (!details) {
    throw Error('OCapN Parcel details not found');
  }
  return openParcelDetails(details, provideSession, isSelfLocation, locator);
};

/**
 * @typedef {object} ParcelTracker
 * @property {(location: OcapnLocation, secret: string | Uint8Array) => Parcel} makeParcel
 * @property {(secretBytes: Uint8Array) => Promise<any | undefined>} lookup
 */

/**
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} locator
 * @param {OpenParcelDetails} [openDetails]
 * @returns {ParcelTracker}
 */
export const makeParcelTracker = (locator, openDetails = openUnbound) =>
  harden({
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
