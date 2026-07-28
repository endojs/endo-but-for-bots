// @ts-check

/* This module wraps the existing `makeHandledPromise()` factory in a
 * function-shaped `delegate(handler)` API that matches the expected TC39
 * `Promise.delegate` direction, plus a peer bank of dispatch functions
 * (`applyMethod`, `applyFunction`, `get`, etc.) that each install at
 * their own registered-symbol slot on `Promise`.
 *
 * `make()` returns the bank as an object of fresh, unregistered
 * functions sharing one underlying `HandledPromise` constructor. The
 * caller (typically `install.js`) is responsible for placing each
 * function at `Promise[Symbol.for(<name>)]`. The functions themselves
 * carry no own properties: dispatch is between peers on `Promise`, not
 * down through `delegate`.
 */

import { makeHandledPromise } from './handled-promise.js';

/** @import { Handler, HandledExecutor, HandledPromiseConstructor, HandledPromiseStaticMethods } from './handled-promise.js' */
/** @import { ResolveWithPresenceOptionsBag } from './handled-promise.js' */

/**
 * @template R
 * @typedef {{
 *   promise: Promise<R>,
 *   resolve: (value?: R | PromiseLike<R>) => void,
 *   reject: (reason?: unknown) => void,
 *   resolveWithPresence: (
 *     presenceHandler?: Handler<{}>,
 *     options?: ResolveWithPresenceOptionsBag<{}>,
 *   ) => object,
 * }} DelegateSettler
 */

/**
 * @typedef {<R>(handler?: Handler<Promise<R>>) => DelegateSettler<R>} Delegate
 */

/**
 * @typedef {{
 *   delegate: Delegate,
 *   applyFunction: HandledPromiseStaticMethods['applyFunction'],
 *   applyFunctionSendOnly: HandledPromiseStaticMethods['applyFunctionSendOnly'],
 *   applyMethod: HandledPromiseStaticMethods['applyMethod'],
 *   applyMethodSendOnly: HandledPromiseStaticMethods['applyMethodSendOnly'],
 *   get: HandledPromiseStaticMethods['get'],
 *   getSendOnly: HandledPromiseStaticMethods['getSendOnly'],
 *   resolve: HandledPromiseConstructor['resolve'],
 *   HandledPromise: HandledPromiseConstructor,
 * }} Bank
 */

/**
 * Build a fresh, unregistered bank of delegate-and-dispatch functions
 * sharing one underlying `HandledPromise` constructor.
 *
 * Production code should not call this directly: use the install path
 * (`installOrAdoptOne()` / `installOrAdoptAll()` from `./install.js`)
 * or the lexical ponyfill thunks exported from the package's main
 * entry. Tests that need an isolated handler graph (independent of the
 * realm-shared one) call this to obtain an unregistered bank.
 *
 * @returns {Bank}
 */
export const make = () => {
  const HandledPromise = makeHandledPromise();

  /**
   * @template R
   * @param {Handler<Promise<R>>} [handler]
   * @returns {DelegateSettler<R>}
   */
  const delegate = handler => {
    /** @type {any} */
    let resolve;
    /** @type {any} */
    let reject;
    /** @type {any} */
    let resolveWithPresence;
    /** @type {HandledExecutor<R>} */
    const executor = (rH, rJ, rWP) => {
      resolve = rH;
      reject = rJ;
      resolveWithPresence = rWP;
    };
    const promise = new HandledPromise(executor, handler);
    // The settler-bag bindings are assigned synchronously by the
    // executor above; cast through `any` typed locals above to avoid
    // definite-assignment lint noise on the bag fields.
    return /** @type {DelegateSettler<R>} */ ({
      promise,
      resolve,
      reject,
      resolveWithPresence,
    });
  };

  // Single-level freeze. The bank functions are vetted-shim code that
  // can run before `lockdown()` is available; the static methods come
  // from the HandledPromise constructor, which lockdown will harden as
  // part of its intrinsic-graph traversal.
  Object.freeze(delegate);

  // Use the unbound static methods directly. The HandledPromise static
  // methods are closure-based (they capture HandledPromise and the
  // dispatch tables in their closure scope, not via `this`), so binding
  // is unnecessary and would break identity with the peers exposed on
  // the constructor itself. Sharing the same function reference between
  // `HandledPromise.<name>`, `Promise[Symbol.for(<name>)]`, and the
  // lexical thunk's resolved target preserves
  // `E.resolve === HandledPromise.resolve === Promise[@resolve]`.
  /** @type {Bank} */
  const bank = {
    // eslint-disable-next-line object-shorthand
    delegate: /** @type {Delegate} */ (delegate),
    applyFunction: HandledPromise.applyFunction,
    applyFunctionSendOnly: HandledPromise.applyFunctionSendOnly,
    applyMethod: HandledPromise.applyMethod,
    applyMethodSendOnly: HandledPromise.applyMethodSendOnly,
    get: HandledPromise.get,
    getSendOnly: HandledPromise.getSendOnly,
    resolve: HandledPromise.resolve,
    HandledPromise,
  };
  for (const key of Object.keys(bank)) {
    if (key !== 'HandledPromise') {
      Object.freeze(/** @type {any} */ (bank)[key]);
    }
  }
  Object.freeze(bank);
  return bank;
};
Object.freeze(make);
