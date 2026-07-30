// @ts-check

import { createHash } from 'node:crypto';

import harden from '@endo/harden';

import { assertOutput, assertUint8Array } from './assert.js';

const { apply } = Reflect;
const { set: setUint8Array } = Uint8Array.prototype;

/** @param {Uint8Array} bytes */
export const sha256 = bytes => {
  assertUint8Array(bytes);
  return new Uint8Array(createHash('sha256').update(bytes).digest());
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
