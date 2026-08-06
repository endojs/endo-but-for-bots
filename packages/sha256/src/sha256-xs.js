// @ts-check
/* global hostSha256Init, hostSha256UpdateBytes, hostSha256Finish */

import { decodeHex } from '@endo/hex';
import harden from '@endo/harden';

import { assertOutput, assertUint8Array } from './assert.js';
import { sha256 as sha256Browser } from './sha256-browser.js';

const { apply } = Reflect;
const { set: setUint8Array } = Uint8Array.prototype;

const hasHostSha256 =
  typeof hostSha256Init === 'function' &&
  typeof hostSha256UpdateBytes === 'function' &&
  typeof hostSha256Finish === 'function';

/** @param {Uint8Array} bytes */
export const sha256 = bytes => {
  assertUint8Array(bytes);
  if (!hasHostSha256) {
    return sha256Browser(bytes);
  }
  const handle = hostSha256Init();
  hostSha256UpdateBytes(handle, bytes);
  return decodeHex(hostSha256Finish(handle));
};
harden(sha256);

/**
 * @param {Uint8Array} output
 * @param {Uint8Array} bytes
 * @param {number} [offset]
 */
export const sha256Into = (output, bytes, offset = 0) => {
  assertOutput(output, offset);
  apply(setUint8Array, output, [sha256(bytes), offset]);
  return 32;
};
harden(sha256Into);
