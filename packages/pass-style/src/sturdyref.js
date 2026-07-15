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
 * @import {Rejector} from '@endo/errors/rejector.js';
 * @import {PassStyleHelper} from './internal-types.js';
 * @import {PassStyle} from './types.js';
 */

const { ownKeys } = Reflect;
const { isArray } = Array;
const { getPrototypeOf, getOwnPropertyDescriptors } = Object;

const STURDYREF_TO_STRING_TAG = 'SturdyRef';

/**
 * A SturdyRef reveals its addressing information through a get-only,
 * non-enumerable accessor on its tag-record prototype. Placing `location`
 * (and the optional `type` hint) on the prototype as an accessor — rather
 * than as an own data property on the instance — lets `assertRestValid`
 * insist the instance carries no own properties, so the trusted prototype
 * getter is the only source of the value. A forger cannot shadow it with an
 * own data property carrying attacker-chosen data.
 *
 * @param {PropertyDescriptor | undefined} desc
 * @param {string} name
 * @param {Rejector} reject
 * @returns {boolean}
 */
const confirmAccessorDescriptor = (desc, name, reject) =>
  (desc !== undefined ||
    (reject && reject`sturdyref ${q(name)} accessor expected`)) &&
  (typeof desc?.get === 'function' ||
    (reject && reject`sturdyref ${q(name)} must be a get accessor`)) &&
  (desc?.set === undefined ||
    (reject && reject`sturdyref ${q(name)} must not have a setter`)) &&
  (!desc?.enumerable ||
    (reject && reject`sturdyref ${q(name)} must not be enumerable`));

/**
 * Structural check that `location` is a passable, parsed OCapN locator:
 * a `copyRecord` naming a peer (a string `designator`, a string
 * `transport` and/or `network`, and `hints` that are either `false` or a
 * `copyRecord`). `@endo/pass-style` only knows the parsed shape; the on-wire
 * serialization of the locator is owned by `@endo/ocapn`.
 *
 * @param {any} location
 * @param {(val: any) => PassStyle} passStyleOfRecur
 * @param {Rejector} reject
 * @returns {boolean}
 */
const confirmPassableLocation = (location, passStyleOfRecur, reject) =>
  (passStyleOfRecur(location) === 'copyRecord' ||
    (reject &&
      reject`A sturdyref location must be a copyRecord: ${location}`)) &&
  (typeof location.designator === 'string' ||
    (reject &&
      reject`A sturdyref location needs a string designator: ${location}`)) &&
  (typeof location.transport === 'string' ||
    typeof location.network === 'string' ||
    (reject &&
      reject`A sturdyref location needs a string transport or network: ${location}`)) &&
  (location.hints === false ||
    passStyleOfRecur(location.hints) === 'copyRecord' ||
    (reject &&
      reject`A sturdyref location hints must be false or a copyRecord: ${location}`));

/**
 * `@endo/pass-style` defines the **shape** of the `'sturdyref'` category and
 * recognises/validates it, but it does **not** construct sturdyrefs.
 * Construction (minting an instance that satisfies this shape and binding it
 * to its closely-held `(location, swissNum)` tuple) is the role of the CapTP
 * session manager (`@endo/ocapn`). This helper therefore only recognises and
 * validates; there is no maker here and no module-private locator map.
 *
 * A valid SturdyRef is an object with no own properties whose prototype is a
 * tag record carrying `[PASS_STYLE]: 'sturdyref'`, `[Symbol.toStringTag]:
 * 'SturdyRef'`, a get-only non-enumerable `location` accessor returning a
 * deep-frozen parsed `OcapnLocation` `copyRecord`, and an optional get-only
 * non-enumerable string `type` hint accessor. The secret (swiss number) is
 * never a property, on the instance or its prototype.
 *
 * @type {PassStyleHelper}
 */
export const SturdyRefHelper = harden({
  styleName: 'sturdyref',

  confirmCanBeValid: (candidate, reject) =>
    (!isPrimitive(candidate) ||
      (reject &&
        reject`A sturdyref must be a non-primitive object: ${candidate}`)) &&
    (!isArray(candidate) ||
      (reject && reject`An array cannot be a sturdyref: ${candidate}`)) &&
    confirmPassStyle(candidate, candidate[PASS_STYLE], 'sturdyref', reject),

  assertRestValid: (candidate, passStyleOfRecur) => {
    // The instance itself carries no own properties: all structure lives on
    // its tag-record prototype, so the trusted `location`/`type` accessors
    // are the only source of those values.
    const ownDescs = getOwnPropertyDescriptors(candidate);
    ownKeys(ownDescs).length === 0 ||
      Fail`A sturdyref must have no own properties: ${q(ownKeys(ownDescs))}`;

    const proto = getPrototypeOf(candidate);
    confirmTagRecord(proto, 'sturdyref', Fail);
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
      location: locationDesc,
      type: typeDesc,
      ...restDescs
    } = getOwnPropertyDescriptors(proto);

    ownKeys(restDescs).length === 0 ||
      Fail`Unexpected properties on sturdyref prototype ${q(
        ownKeys(restDescs),
      )}`;

    // `location` is a mandatory, non-enumerable, get-only accessor whose
    // value is a passable parsed locator.
    confirmAccessorDescriptor(locationDesc, 'location', Fail);
    confirmPassableLocation(candidate.location, passStyleOfRecur, Fail);

    // `type` is an optional, non-enumerable, get-only accessor. When
    // present its value must be a string; it is an advisory hint excluded
    // from a SturdyRef's identity.
    if (typeDesc !== undefined) {
      confirmAccessorDescriptor(typeDesc, 'type', Fail);
      typeof candidate.type === 'string' ||
        Fail`A sturdyref type hint must be a string: ${candidate}`;
    }
  },
});
