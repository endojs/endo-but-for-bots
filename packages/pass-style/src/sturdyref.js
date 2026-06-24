import harden from '@endo/harden';
import { Fail } from '@endo/errors';
import {
  PASS_STYLE,
  confirmTagRecord,
  confirmPassStyle,
} from './passStyle-helpers.js';

/**
 * @import {PassStyleHelper} from './internal-types.js';
 * @import {SturdyRef} from './types.js';
 */

const { ownKeys } = Reflect;
const {
  create,
  prototype: objectPrototype,
  getOwnPropertyDescriptors,
} = Object;

const STURDYREF_TAG = 'sturdyref';
const STURDYREF_TO_STRING_TAG = 'SturdyRef';

/**
 * The canonical off-band map from a SturdyRef to the locator it addresses.
 *
 * A SturdyRef's tagged record is deliberately opaque: it carries no
 * payload, so the only way to recover its locator is through this
 * module-private map, and the only way to populate the map is
 * `makeSturdyRef`. A `'sturdyref'`-tagged record that this module did not
 * mint therefore has no entry, and `passStyleOf` rejects it.
 *
 * Holding the locator off-band (rather than as a tagged payload) keeps the
 * locator secret out of reach of pass-style introspection. The secret is
 * the long-lived authority that grants access to the addressed capability,
 * so it must not leak through a passable surface. This map previously
 * lived in `@endo/ocapn` (as `sturdyRefDetails`); it moves here so that
 * `@endo/pass-style` owns the single "is this a SturdyRef, and what does
 * it locate?" lookup that every marshaling layer and the daemon consult.
 *
 * @type {WeakMap<SturdyRef, any>}
 */
const sturdyRefLocators = new WeakMap();

/**
 * @type {PassStyleHelper}
 */
export const SturdyRefHelper = harden({
  styleName: 'sturdyref',

  confirmCanBeValid: (candidate, reject) =>
    (sturdyRefLocators.has(candidate) ||
      (reject &&
        reject`A sturdyref record must be minted by makeSturdyRef: ${candidate}`)) &&
    confirmPassStyle(candidate, candidate[PASS_STYLE], 'sturdyref', reject),

  assertRestValid: candidate => {
    confirmTagRecord(candidate, 'sturdyref', Fail);

    // Typecasts needed due to https://github.com/microsoft/TypeScript/issues/1863
    const passStyleKey = /** @type {unknown} */ (PASS_STYLE);
    const tagKey = /** @type {unknown} */ (Symbol.toStringTag);
    const {
      // confirmTagRecord already verified the PASS_STYLE and
      // Symbol.toStringTag own data properties.
      [/** @type {string} */ (passStyleKey)]: _passStyleDesc,
      [/** @type {string} */ (tagKey)]: _labelDesc,
      ...restDescs
    } = getOwnPropertyDescriptors(candidate);
    // A SturdyRef is opaque: it has no payload and no other own properties.
    ownKeys(restDescs).length === 0 ||
      Fail`Unexpected properties on sturdyref record ${ownKeys(restDescs)}`;
  },
});

/**
 * Mint a SturdyRef: an opaque, hardened, pass-by-copy tagged record whose
 * `passStyleOf` is `'sturdyref'`. The `locator` is the off-band addressing
 * information the bearer can present to re-acquire the live capability; it
 * is held in a module-private WeakMap, never on the record itself, so
 * pass-style introspection cannot leak it.
 *
 * @template L
 * @param {L} locator
 * @returns {SturdyRef}
 */
export const makeSturdyRef = locator => {
  const sturdyRef = /** @type {SturdyRef} */ (
    harden(
      create(objectPrototype, {
        [PASS_STYLE]: { value: STURDYREF_TAG },
        [Symbol.toStringTag]: { value: STURDYREF_TO_STRING_TAG },
      }),
    )
  );
  sturdyRefLocators.set(sturdyRef, harden(locator));
  return sturdyRef;
};
harden(makeSturdyRef);

/**
 * Reveal the off-band locator that a SturdyRef addresses. Throws if
 * `sturdyRef` was not minted by `makeSturdyRef`.
 *
 * Spelling note: the name `getStudyRefLocator` (with "Study", missing the
 * second "r" of "Sturdy") is the name the sturdy-refs design and its
 * acceptance criteria specify. It is kept verbatim so the cross-package
 * contract spelling matches the specification.
 *
 * @param {SturdyRef} sturdyRef
 * @returns {any}
 */
export const getStudyRefLocator = sturdyRef => {
  sturdyRefLocators.has(sturdyRef) ||
    Fail`Not a SturdyRef minted by makeSturdyRef: ${sturdyRef}`;
  return sturdyRefLocators.get(sturdyRef);
};
harden(getStudyRefLocator);
