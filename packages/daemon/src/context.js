// @ts-check

import harden from '@endo/harden';
import { makeCancelKit } from '@endo/cancel';
import { makePromiseKit } from '@endo/promise-kit';

/** @import { PromiseKit } from '@endo/promise-kit' */
/** @import { Context, FormulaIdentifier } from './types.js' */

/**
 * Creates a factory function for generating `Context` objects.
 *
 * @param {object} args
 * @param {Map<FormulaIdentifier, { context: Context }>} args.controllerForId
 * @param {(id: FormulaIdentifier) => { context: Context }} args.provideController
 * @param {(id: FormulaIdentifier) => string | undefined} args.getFormulaType
 */
export const makeContextMaker = ({
  controllerForId,
  provideController,
  getFormulaType,
}) => {
  /**
   * Creates a new lifecycle-managed context for a specific guest formula.
   *
   * This context tracks the formula's status, handles cancellation propagation
   * to dependents, and manages cleanup hooks.
   *
   * @param {FormulaIdentifier} id - The unique identifier for the formula.
   * @returns {Context}
   */
  const makeContext = id => {
    let done = false;
    /** @type {Error | undefined} */
    let cancellationReason;
    const { cancelled, cancel: rejectCancelled } = makeCancelKit();
    const { promise: disposed, resolve: resolveDisposed } =
      /** @type {PromiseKit<void>} */ (makePromiseKit());
    cancelled.catch(() => {});

    /** @type {Map<FormulaIdentifier, Context>} */
    const dependents = new Map();
    /** @type {Array<() => void | Promise<void>>} */
    const hooks = [];

    /**
     * Triggers cancellation of this context and all registered dependents.
     *
     * @type {Context['cancel']}
     */
    const cancel = (reason, prefix = '*') => {
      if (done) return disposed;
      done = true;
      cancellationReason = reason || harden(new Error('Cancelled'));
      rejectCancelled(cancellationReason);

      const formulaType = getFormulaType(id) || '?';
      console.log(
        `${prefix} ${id} (${formulaType}) REASON: ${reason?.message || reason}`,
      );

      controllerForId.delete(id);
      for (const dependentContext of dependents.values()) {
        dependentContext.cancel(reason, ` ${prefix}`);
      }
      dependents.clear();

      const dispose = (async () => {
        await null;
        /** @type {unknown[]} */
        const failures = [];
        for (const hook of hooks.reverse()) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await hook();
          } catch (failure) {
            failures.push(failure);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            `Cancellation hooks failed for ${id}`,
          );
        }
      })();

      resolveDisposed(dispose);

      return disposed;
    };

    /**
     * Registers a dependent formula that will be cancelled if this one is cancelled.
     *
     * @param {FormulaIdentifier} dependentId - The identifier of the dependent formula.
     */
    const thatDiesIfThisDies = dependentId => {
      const dependentController = provideController(dependentId);
      if (done) {
        dependentController.context.cancel(cancellationReason, ' *').catch(
          // The dependent exposes hook failures through its `disposed` promise.
          () => {},
        );
        return;
      }
      dependents.set(dependentId, dependentController.context);
    };

    /**
     * Registers this context as a dependent of the formula with the given identifier.
     *
     * @param {FormulaIdentifier} dependencyId - The identifier of the formula this context depends on.
     */
    const thisDiesIfThatDies = dependencyId => {
      const dependencyController = provideController(dependencyId);
      dependencyController.context.thatDiesIfThisDies(id);
    };

    /**
     * Registers a function to be called when this context is canceled.
     *
     * @param {() => void | Promise<void>} hook - A function with no parameters to execute during disposal.
     */
    const onCancel = hook => {
      if (done) {
        // The context was already canceled by the time this hook registered —
        // e.g. cancellation fired during an `await` in the registrant's async
        // constructor, which resumes only after `cancel` has drained `hooks`.
        // Fire the hook immediately rather than dropping it, so a late-
        // registered liveness gate still observes revocation. Dropping it
        // silently latches such a gate open forever. Mirrors the already-
        // canceled path of `thatDiesIfThisDies` above, and swallows failures
        // the same way, since a hook registered after cancellation has no
        // `disposed` channel left to surface through.
        Promise.resolve()
          .then(hook)
          .catch(() => {});
        return;
      }
      hooks.push(hook);
    };

    return /** @type {Context} */ ({
      id,
      cancel,
      cancelled,
      disposed,
      thatDiesIfThisDies,
      thisDiesIfThatDies,
      onCancel,
    });
  };

  return makeContext;
};
