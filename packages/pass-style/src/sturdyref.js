import harden from '@endo/harden';
import { Fail, q } from '@endo/errors';
import {
  PASS_STYLE,
  confirmTagRecord,
  confirmPassStyle,
  isPrimitive,
  getTag,
} from './passStyle-helpers.js';

/**
 * @import {PassStyleHelper} from './internal-types.js';
 * @import {SturdyRef} from './types.js';
 */

const { ownKeys } = Reflect;
const { isArray } = Array;
const { create, prototype: objectPrototype } = Object;
const { getPrototypeOf, getOwnPropertyDescriptors } = Object;

const STURDYREF_PASS_STYLE = 'sturdyRef';
const STURDYREF_TO_STRING_TAG = 'SturdyRef';

/**
 * A SturdyRef is an **opaque** first-class `@endo/pass-style` value. It is a
 * bare identity — an object with no own properties whose tag-record prototype
 * carries only `[PASS_STYLE]: 'sturdyRef'` and `[Symbol.toStringTag]:
 * 'SturdyRef'`. It exposes **nothing** through introspection: no `location`,
 * no `secret`, no `type`. The mapping from a SturdyRef's identity to its
 * locator is held off-band — by the realm-global `SturdyRef` shim (see
 * `./sturdy-ref-shim.js`) and, closely held, by each CapTP instance
 * (`@endo/ocapn`). `@endo/pass-style` therefore constructs the opaque identity
 * (`makeSturdyRef`) and recognises/validates the shape, but knows nothing of
 * where a SturdyRef points.
 *
 * The tag-record prototype is the sole source of the pass-style metadata; the
 * instance is required to carry no own properties, so a forger cannot smuggle
 * attacker-chosen data onto a SturdyRef.
 *
 * @type {PassStyleHelper}
 */
export const SturdyRefHelper = harden({
  styleName: STURDYREF_PASS_STYLE,

  confirmCanBeValid: (candidate, reject) =>
    (!isPrimitive(candidate) ||
      (reject &&
        reject`A sturdyref must be a non-primitive object: ${candidate}`)) &&
    (!isArray(candidate) ||
      (reject && reject`An array cannot be a sturdyref: ${candidate}`)) &&
    confirmPassStyle(
      candidate,
      candidate[PASS_STYLE],
      STURDYREF_PASS_STYLE,
      reject,
    ),

  assertRestValid: candidate => {
    // The instance itself carries no own properties: all structure lives on
    // its tag-record prototype. A candidate with extra own properties (a
    // forgery smuggling attacker data) is rejected here.
    const ownDescs = getOwnPropertyDescriptors(candidate);
    ownKeys(ownDescs).length === 0 ||
      Fail`A sturdyref must have no own properties: ${q(ownKeys(ownDescs))}`;

    // The prototype must be a proper tag record inheriting from
    // Object.prototype (a candidate with an invalid prototype is rejected by
    // confirmTagRecord) and tagged `SturdyRef`.
    const proto = getPrototypeOf(candidate);
    confirmTagRecord(proto, STURDYREF_PASS_STYLE, Fail);
    getTag(proto) === STURDYREF_TO_STRING_TAG ||
      Fail`A sturdyref tag must be ${q(STURDYREF_TO_STRING_TAG)}: ${candidate}`;

    // Typecasts needed due to https://github.com/microsoft/TypeScript/issues/1863
    const passStyleKey = /** @type {unknown} */ (PASS_STYLE);
    const tagKey = /** @type {unknown} */ (Symbol.toStringTag);
    const {
      // confirmTagRecord already verified the PASS_STYLE and
      // Symbol.toStringTag own data properties on the prototype.
      [/** @type {string} */ (passStyleKey)]: _passStyleDesc,
      [/** @type {string} */ (tagKey)]: _tagDesc,
      ...restDescs
    } = getOwnPropertyDescriptors(proto);

    // The tag record carries *only* the pass-style metadata; a SturdyRef is
    // opaque, so any further property on its prototype is a forgery.
    ownKeys(restDescs).length === 0 ||
      Fail`Unexpected properties on sturdyref prototype ${q(
        ownKeys(restDescs),
      )}`;
  },
});

/**
 * Construct an opaque SturdyRef: a hardened object with no own properties whose
 * hardened tag-record prototype carries `[PASS_STYLE]: 'sturdyRef'` and
 * `[Symbol.toStringTag]: 'SturdyRef'` and nothing else. `passStyleOf` returns
 * `'sturdyRef'` for the result. The SturdyRef reveals nothing about where it
 * points; that mapping is held off-band (see the module comment on
 * `SturdyRefHelper`).
 *
 * @returns {SturdyRef}
 */
export const makeSturdyRef = () => {
  const proto = harden(
    create(objectPrototype, {
      [PASS_STYLE]: { value: STURDYREF_PASS_STYLE, enumerable: false },
      [Symbol.toStringTag]: {
        value: STURDYREF_TO_STRING_TAG,
        enumerable: false,
      },
    }),
  );
  return /** @type {SturdyRef} */ (harden(create(proto)));
};
harden(makeSturdyRef);
