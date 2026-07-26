// @ts-check
/* global crypto */

/** @import { SturdyRef } from '@endo/pass-style' */

import { isSturdyRef } from '@endo/pass-style';

const handlePrefix = 'sturdyref:';

/**
 * @returns {string}
 */
const makeOpaqueSuffix = () => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * An in-memory, transcript-local SturdyRef escrow. A handle is presentation
 * text only: it has no locator-derived content and is useful solely while this
 * table remains alive. This module intentionally creates no retention edge.
 *
 * @returns {{ render: (value: unknown) => unknown, redeem: (value: unknown) => unknown }}
 */
export const makeSturdyRefEscrow = () => {
  /** @type {Map<string, SturdyRef>} */
  const sturdyRefs = new Map();

  /** @param {SturdyRef} sturdyRef */
  const mintHandle = sturdyRef => {
    let handle;
    do {
      handle = `${handlePrefix}${makeOpaqueSuffix()}`;
    } while (sturdyRefs.has(handle));
    sturdyRefs.set(handle, sturdyRef);
    return handle;
  };

  /** @param {unknown} value @returns {unknown} */
  const render = value => {
    if (isSturdyRef(value)) return mintHandle(value);
    if (Array.isArray(value)) return harden(value.map(render));
    if (value !== null && typeof value === 'object') {
      const record = /** @type {Record<string, unknown>} */ (value);
      return harden(
        Object.fromEntries(
          Object.entries(record).map(([key, entry]) => [key, render(entry)]),
        ),
      );
    }
    return value;
  };

  /** @param {unknown} value @returns {unknown} */
  const redeem = value => {
    if (typeof value === 'string' && value.startsWith(handlePrefix)) {
      const sturdyRef = sturdyRefs.get(value);
      if (sturdyRef === undefined) {
        throw Error('unknown sturdyref handle');
      }
      return sturdyRef;
    }
    if (Array.isArray(value)) return harden(value.map(redeem));
    if (value !== null && typeof value === 'object') {
      const record = /** @type {Record<string, unknown>} */ (value);
      return harden(
        Object.fromEntries(
          Object.entries(record).map(([key, entry]) => [key, redeem(entry)]),
        ),
      );
    }
    return value;
  };

  return harden({ render, redeem });
};
harden(makeSturdyRefEscrow);
