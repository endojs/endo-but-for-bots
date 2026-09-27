// @ts-check
/// <reference types="ses"/>
import { passStyleOf } from '@endo/pass-style';
import harden from '@endo/harden';

const HANDLE_PREFIX = 'sturdyref:';

/** @param {unknown} value @returns {boolean} */
const isSturdyRef = value => {
  try {
    return passStyleOf(/** @type {any} */ (value)) === 'sturdyRef';
  } catch {
    return false;
  }
};

/** @param {Uint8Array} bytes @returns {string} */
const bytesToHex = bytes =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * Make a transcript-local escrow for first-class SturdyRef values.
 *
 * The model sees only fresh opaque text handles. Redeeming a handle restores
 * the already-held SturdyRef before the tool's daemon argument guard runs.
 * No lookup, locator conversion, or cross-turn retention happens here.
 *
 * @param {{ randomBytes?: (bytes: Uint8Array) => Uint8Array }} [options]
 */
export const makeSturdyRefEscrow = (options = {}) => {
  const {
    randomBytes = bytes => {
      const { crypto } = globalThis;
      if (
        crypto === undefined ||
        typeof crypto.getRandomValues !== 'function'
      ) {
        throw new Error('sturdyref escrow requires crypto.getRandomValues');
      }
      // Use an ArrayBuffer-backed temporary because the Web Crypto declaration
      // does not accept a Uint8Array whose backing type may be SharedArrayBuffer.
      const random = crypto.getRandomValues(new Uint8Array(bytes.byteLength));
      bytes.set(random);
      return bytes;
    },
  } = options;
  /** @type {Map<string, object>} */
  const sturdyRefs = new Map();

  const makeHandle = () => {
    const bytes = randomBytes(new Uint8Array(16));
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
      throw new TypeError('sturdyref escrow randomBytes must return 16 bytes');
    }
    return `${HANDLE_PREFIX}${bytesToHex(bytes)}`;
  };

  /** @param {unknown} value @returns {unknown} */
  const render = value => {
    if (isSturdyRef(value)) {
      let handle;
      do {
        handle = makeHandle();
      } while (sturdyRefs.has(handle));
      sturdyRefs.set(handle, /** @type {object} */ (value));
      return handle;
    }
    if (Array.isArray(value)) return harden(value.map(render));
    if (value !== null && typeof value === 'object') {
      return harden(
        Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, render(entry)]),
        ),
      );
    }
    return value;
  };

  /** @param {unknown} value @returns {unknown} */
  const redeem = value => {
    if (typeof value === 'string' && value.startsWith(HANDLE_PREFIX)) {
      const sturdyRef = sturdyRefs.get(value);
      if (sturdyRef === undefined) throw new Error('unknown sturdyref handle');
      return sturdyRef;
    }
    if (Array.isArray(value)) return harden(value.map(redeem));
    if (value !== null && typeof value === 'object') {
      return harden(
        Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, redeem(entry)]),
        ),
      );
    }
    return value;
  };

  const clear = () => sturdyRefs.clear();

  return harden({ render, redeem, clear });
};
harden(makeSturdyRefEscrow);
