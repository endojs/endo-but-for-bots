// @ts-check

/* A SturdyRef for a daemon formula, obtained without incarnating it.
 *
 * The daemon's formula graph names every value it can make by a formula
 * identifier. Handing out a live reference requires incarnating the formula,
 * which may start a worker, open a store, or dial a peer. A SturdyRef for a
 * formula defers all of that: minting the ref records only the identifier,
 * and the formula is incarnated when, and only when, someone enlivens the
 * ref (see `@endo/sturdyref`'s `enliven`).
 *
 * The identifier is closely held. The ref's handler closes over it, and the
 * only way to recover it from a ref is the `formulaIdOf` function of the kit
 * that minted it, which the daemon keeps to itself (for example, to persist
 * the ref or to export it over OCapN under a swiss number).
 */

import harden from '@endo/harden';
import { makeSturdyRef, isSturdyRef } from '@endo/sturdyref';
import { assertValidId } from './formula-identifier.js';

/** @typedef {ReturnType<typeof makeSturdyRef>} SturdyRef */

/**
 * @param {object} powers
 * @param {(id: string) => unknown} powers.provide - incarnates the formula
 *   named by `id` (or returns its existing incarnation) and returns its value.
 */
export const makeFormulaSturdyRefKit = ({ provide }) => {
  /**
   * From each minted ref to the formula identifier it designates. Never
   * reachable from the ref itself.
   *
   * @type {WeakMap<SturdyRef, string>}
   */
  const idForSturdyRef = new WeakMap();

  /**
   * Mint a SturdyRef designating the formula `id`. Does not incarnate the
   * formula and does not consult the formula graph; enlivening the ref does
   * both, rejecting if `id` names no formula.
   *
   * @param {string} id
   * @returns {SturdyRef}
   */
  const sturdyRefForFormula = id => {
    assertValidId(id);
    const ref = makeSturdyRef(
      harden({
        enliven: () => provide(id),
      }),
    );
    idForSturdyRef.set(ref, id);
    return ref;
  };

  /**
   * The formula identifier a ref minted by this kit designates, or
   * `undefined` for any other value, including SturdyRefs minted elsewhere.
   *
   * @param {unknown} ref
   * @returns {string | undefined}
   */
  const formulaIdOf = ref =>
    isSturdyRef(ref)
      ? idForSturdyRef.get(/** @type {SturdyRef} */ (ref))
      : undefined;

  return harden({ sturdyRefForFormula, formulaIdOf });
};
harden(makeFormulaSturdyRefKit);
