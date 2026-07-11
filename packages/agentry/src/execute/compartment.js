// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeExecute } from './tool.js' */

/**
 * @typedef {object} EStatics
 * @property {(recipient: unknown) => unknown} get
 * @property {(value: unknown) => unknown} resolve
 * @property {(recipient: unknown) => unknown} sendOnly
 * @property {(value: unknown, onFulfilled?: unknown, onRejected?: unknown) => unknown} when
 */

/**
 * @param {unknown} value
 * @returns {value is PromiseLike<unknown>}
 */
const isThenable = value =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? typeof (/** @type {{ then?: unknown }} */ (value).then) === 'function'
    : false;

/**
 * Attach a rejection observer to an eventual-send result without changing the
 * promise returned to the code-mode program. A code block can intentionally
 * use `E.sendOnly()` for fire-and-forget sends, but an ordinary `E()` call must
 * not be able to leave a rejected HandledPromise outside the execute tool's
 * settlement boundary.
 *
 * @param {unknown} baseE
 * @returns {unknown}
 */
const makeTrackedE = baseE => {
  if (typeof baseE !== 'function') {
    return baseE;
  }

  const callableE = /** @type {(recipient: unknown) => unknown} */ (baseE);
  const staticE = /** @type {EStatics} */ (/** @type {unknown} */ (baseE));

  const observe = value => {
    if (isThenable(value)) {
      // The original value is returned to the guest, so `await` and explicit
      // catch handlers retain their normal behavior. This child promise only
      // marks the original rejection as observed at the host boundary.
      Promise.resolve(value).catch(() => undefined);
    }
    return value;
  };

  const makeTrackedTarget = recipient => {
    const targetE = /** @type {(...args: never[]) => unknown} */ (
      callableE(recipient)
    );
    return new Proxy(targetE, {
      get(_target, propertyKey) {
        const operation = Reflect.get(targetE, propertyKey, targetE);
        if (typeof operation !== 'function') {
          return operation;
        }
        return (...args) => observe(Reflect.apply(operation, targetE, args));
      },
      apply(_target, thisArg, args) {
        return observe(Reflect.apply(targetE, thisArg, args));
      },
    });
  };

  const trackedE = Object.assign(recipient => makeTrackedTarget(recipient), {
    get: recipient => {
      const targetGet = /** @type {object} */ (staticE.get(recipient));
      return new Proxy(targetGet, {
        get(_getTarget, property) {
          return observe(Reflect.get(targetGet, property));
        },
      });
    },
    resolve: value => observe(staticE.resolve(value)),
    // E.sendOnly() deliberately has no result promise to observe.
    sendOnly: staticE.sendOnly,
    when: (value, onFulfilled, onRejected) =>
      observe(staticE.when(value, onFulfilled, onRejected)),
  });
  return harden(trackedE);
};

/**
 * Build a Compartment-backed execute function. Callers supply every endowment
 * they want in lexical scope (typically `{ E, workspace, git }` plus stream
 * helpers). The completion value is returned; when `resultName` is supplied it
 * is also handed to `storeResult` for out-of-band capability storage.
 *
 * @param {object} options
 * @param {Record<string, unknown>} options.endowments
 * @param {(value: unknown, resultName: string | string[]) => Promise<void> | void} [options.storeResult]
 * @returns {CodeModeExecute}
 */
export const makeCompartmentExecute = ({ endowments, storeResult }) => {
  const hardenedEndowments = harden({ ...endowments });
  return async ({ source, resultName }) => {
    const baseE = hardenedEndowments.E;
    const scopedEndowments =
      typeof baseE === 'function'
        ? harden({ ...hardenedEndowments, E: makeTrackedE(baseE) })
        : hardenedEndowments;
    const compartment = new Compartment(scopedEndowments);
    const result = await compartment.evaluate(source);
    if (resultName !== undefined) {
      if (storeResult === undefined) {
        throw new Error(
          'execute.resultName was supplied but no storeResult callback is configured',
        );
      }
      await storeResult(result, resultName);
    }
    return result;
  };
};
harden(makeCompartmentExecute);
