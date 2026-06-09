import harden from '@endo/harden';
import { X, Fail } from '@endo/errors';

/**
 * @import {PassStyleHelper} from './internal-types.js';
 */

const { getPrototypeOf, getOwnPropertyDescriptor } = Object;
const { ownKeys, apply } = Reflect;

// Detects the presence of immutable ArrayBuffer support in the underlying
// platform and provides either suitable values from that implementation or
// values that will consistently deny that immutable ArrayBuffers exist.
//
// After the drop-the-pseudo-prototype redesign of
// @endo/immutable-arraybuffer, emulated immutable buffers directly inherit
// from ArrayBuffer.prototype rather than from an intermediate prototype.
// The brand check that distinguishes them from genuine ArrayBuffers is the
// `immutable` accessor installed on ArrayBuffer.prototype by the shim (or
// natively, once the proposal stabilises). The prototype identity check
// remains as a structural guard against a tampered prototype chain.
const arrayBufferPrototype = ArrayBuffer.prototype;
const immutableDescriptor = getOwnPropertyDescriptor(
  arrayBufferPrototype,
  'immutable',
);
const immutableGetter =
  /** @type {((this: ArrayBuffer) => boolean) | undefined} */ (
    immutableDescriptor?.get
  ) || (() => false);

/**
 * @type {PassStyleHelper}
 */
export const ByteArrayHelper = harden({
  styleName: 'byteArray',

  confirmCanBeValid: (candidate, reject) =>
    (candidate instanceof ArrayBuffer && candidate.immutable) ||
    (reject && reject`Immutable ArrayBuffer expected: ${candidate}`),

  assertRestValid: (candidate, _passStyleOfRecur) => {
    getPrototypeOf(candidate) === arrayBufferPrototype ||
      assert.fail(X`Malformed ByteArray ${candidate}`, TypeError);
    apply(immutableGetter, candidate, []) ||
      Fail`Must be an immutable ArrayBuffer: ${candidate}`;
    ownKeys(candidate).length === 0 ||
      assert.fail(
        X`ByteArrays must not have own properties: ${candidate}`,
        TypeError,
      );
  },
});
