// @ts-check

/* A Parcel for a daemon formula, obtained without incarnating it.
 *
 * The daemon's formula graph names every value it can make by a formula
 * identifier. Handing out a live reference requires incarnating the formula,
 * which may start a worker, open a store, or dial a peer. A Parcel for a
 * formula defers all of that: minting the ref records only the identifier,
 * and the formula is incarnated when, and only when, someone opens the
 * ref (see `@endo/parcel`'s `open`).
 *
 * The identifier is closely held. The ref's handler closes over it, and the
 * only way to recover it from a ref is the `formulaIdOf` function of the kit
 * that minted it, which the daemon keeps to itself (for example, to persist
 * the ref or to export it over OCapN under a swiss number).
 *
 * Minting adds no retention edge: a ref does not keep its formula alive
 * against the formula graph's collector. A holder that needs the formula to
 * survive must keep it reachable by other means; opening a ref whose
 * formula has been collected rejects, because `provide` itself refuses a
 * collected formula (see `getFormulaForId` in `manager.js`).
 *
 * A ref is passable, so it may reach a holder who does not hold the kit.
 * Errors from opening are `provide`'s own; the daemon's collected-formula
 * error redacts the identifier, but other failures of `provide` may not.
 *
 * `parcelForFormula` carries the same authority as `provide`: whoever
 * holds a ref it mints gets the formula's value on opening. Hold the kit
 * only where `provide` is already held, and mint only from an identifier the
 * caller already has authority over, never from a caller-supplied string.
 *
 * The OCapN client (`@endo/ocapn`'s `makeParcelTracker`) mints the same
 * realm-shared `@endo/parcel` kind of ref; the two differ only in which
 * closely held tracker mints and opens them.
 */

import harden from '@endo/harden';
import { makeParcel, isParcel } from '@endo/parcel';
import { assertValidId } from './formula-identifier.js';

/** @import { ParcelObject } from '@endo/pass-style' */
/** @import { FormulaIdentifier } from './types.js' */

/**
 * @param {object} powers
 * @param {(id: FormulaIdentifier) => unknown} powers.provide - incarnates the formula
 *   named by `id` (or returns its existing incarnation) and returns its value,
 *   rejecting if the formula is unknown or has been collected.
 */
export const makeFormulaParcelKit = ({ provide }) => {
  /**
   * From each minted ref to the formula identifier it designates. Never
   * reachable from the ref itself.
   *
   * @type {WeakMap<ParcelObject, FormulaIdentifier>}
   */
  const formulaIdForParcel = new WeakMap();

  /**
   * Mint a Parcel designating the local formula `formulaId`. Does not
   * incarnate the formula and does not consult the formula graph; opening
   * the ref calls `provide`, which incarnates the formula, or rejects if the
   * daemon knows no such formula or has collected it. This kit is for the
   * daemon's own formulas; a ref to an object on another node is minted and
   * opened by the OCapN client's `makeParcelTracker`.
   *
   * @param {FormulaIdentifier} formulaId
   * @returns {ParcelObject}
   */
  const parcelForFormula = formulaId => {
    assertValidId(formulaId);
    const parcel = /** @type {ParcelObject} */ (
      makeParcel(formulaId, () => provide(formulaId))
    );
    formulaIdForParcel.set(parcel, formulaId);
    return parcel;
  };

  /**
   * The formula identifier a ref minted by this kit designates, or
   * `undefined` for any other value, including Parcels minted elsewhere.
   *
   * @param {unknown} ref
   * @returns {FormulaIdentifier | undefined}
   */
  const formulaIdOf = ref =>
    isParcel(ref)
      ? formulaIdForParcel.get(/** @type {ParcelObject} */ (ref))
      : undefined;

  return harden({ parcelForFormula, formulaIdOf });
};
harden(makeFormulaParcelKit);
