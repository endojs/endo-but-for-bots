// @ts-check

/** @import { Context, FormulaIdentifier, WeakMultimap } from './types.js' */

/**
 * Register only the root result of a peer's provide(originalId). Nested
 * presences do not acquire formula identities merely by arriving from a peer.
 * Each registration belongs to its importing context, including while that
 * context's asynchronous cancellation hooks are still draining.
 *
 * @param {object} powers
 * @param {WeakMultimap<object, FormulaIdentifier>} powers.idForRef
 * @param {Map<FormulaIdentifier, object>} powers.refForId
 * @param {Map<FormulaIdentifier, { context: Context }>} powers.controllerForId
 */
export const makeImportedReferenceRegistrar = ({
  idForRef,
  refForId,
  controllerForId,
}) => {
  /** @type {Map<FormulaIdentifier, object>} */
  const owners = new Map();

  /**
   * @param {FormulaIdentifier} id
   * @param {unknown} value
   * @param {Context} context
   */
  const register = (id, value, context) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      controllerForId.get(id)?.context !== context
    ) {
      return;
    }

    const previous = refForId.get(id);
    if (previous !== undefined && previous !== value) {
      idForRef.delete(previous, id);
    }
    const owner = harden({});
    owners.set(id, owner);
    idForRef.add(value, id);
    refForId.set(id, value);
    context.onCancel(() => {
      // A successor may resolve to the same presence under the same ID.
      // Reference equality alone cannot identify the owner being cancelled.
      if (owners.get(id) !== owner) return;
      owners.delete(id);
      if (refForId.get(id) === value) refForId.delete(id);
      idForRef.delete(value, id);
    });
  };
  return harden(register);
};
harden(makeImportedReferenceRegistrar);
