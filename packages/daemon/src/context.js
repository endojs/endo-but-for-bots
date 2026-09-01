// @ts-check

import harden from '@endo/harden';
import { makeCancelKit } from '@endo/cancel';
import { makePromiseKit } from '@endo/promise-kit';

/** @import { PromiseKit } from '@endo/promise-kit' */
/** @import { Context, FormulaIdentifier } from './types.js' */

/**
 * Throw one failure directly and combine multiple failures without losing any
 * of them.
 *
 * @param {unknown[]} failures
 * @param {string} message
 * @param {boolean} [alwaysAggregate]
 * @returns {never}
 */
export const throwFailures = (failures, message, alwaysAggregate = false) => {
  if (!alwaysAggregate && failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
};
harden(throwFailures);

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
    let disposalFinished = false;

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
        while (hooks.length > 0) {
          const hook = /** @type {() => void | Promise<void>} */ (hooks.pop());
          try {
            // eslint-disable-next-line no-await-in-loop
            await hook();
          } catch (failure) {
            failures.push(failure);
          }
        }
        disposalFinished = true;
        if (failures.length > 0) {
          throwFailures(failures, `Cancellation hooks failed for ${id}`, true);
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
     * Registers a function to be called when this context is cancelled.
     *
     * @param {() => void | Promise<void>} hook - A function with no parameters to execute during disposal.
     */
    const onCancel = hook => {
      if (done) {
        // A hook registered after cancellation always runs. Dropping it was
        // safe only while every hook was registered synchronously with the
        // resource it releases; a formula that mints a host resource (a
        // sandbox slice, its projections) registers before the first await
        // and cannot un-mint what it produced after cancellation began, so a
        // dropped hook is a leaked slice rather than a no-op. Callers observe
        // the hook through the returned promise — see `context.test.js`,
        // "onCancel after cancel runs the late hook".
        //
        // Cancellation may race an asynchronously minted resource. Queue a
        // late hook while disposal is still in progress so `disposed` cannot
        // fulfill before the resource cleanup it represents.
        if (!disposalFinished) {
          const { promise, resolve, reject } = /** @type {PromiseKit<void>} */ (
            makePromiseKit()
          );
          promise.catch(() => {});
          hooks.push(async () => {
            try {
              await hook();
              resolve(undefined);
            } catch (error) {
              reject(error);
              throw error;
            }
          });
          return promise;
        }
        // Once disposal has already settled, no existing promise can be
        // extended retroactively. Still run the hook and report its result to
        // the caller that registered it.
        const lateHook = Promise.resolve().then(hook);
        // Existing callers register cleanup without awaiting the return
        // value. Keep the rejection available to callers that do await it,
        // while preventing an unhandled rejection when they do not.
        lateHook.catch(() => {});
        return lateHook;
      }
      hooks.push(hook);
      return Promise.resolve();
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
