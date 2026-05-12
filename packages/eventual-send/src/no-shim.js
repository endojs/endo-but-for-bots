// @ts-check

/* This module is the LAZY surface of `@endo/eventual-send`.
 *
 * Importing it does NOT install any peer at
 * `Promise[Symbol.for(<name>)]`. Each exported lexical ponyfill thunk
 * defers the install (or adoption of a previously-installed peer)
 * until first call. This lets consumers that only want the type
 * surface, or that defer their first call until after `@endo/init` has
 * run, avoid triggering the install at module load.
 *
 * Consumers that want eager install behavior import
 * `@endo/eventual-send/shim.js` instead (typically transitively via
 * `@endo/init` or `@endo/lockdown`).
 *
 * Each thunk caches the realm-shared peer it resolved on first call,
 * so subsequent calls dispatch with one indirection.
 */

import { installOrAdoptOne } from './install.js';
import makeE from './E.js';

// XXX module exports for HandledPromise fail if these aren't in scope
/** @import {Handler, HandledExecutor, HandledPromiseConstructor} from './handled-promise.js' */
/** @import {ECallableOrMethods, EGetters, ERef, ESendOnlyCallableOrMethods, LocalRecord, RemoteFunctions} from './E.js' */

/** @import { Bank, Delegate, DelegateSettler } from './make.js' */

/**
 * Build a lexical ponyfill thunk for a single peer name. The thunk
 * resolves `installOrAdoptOne(name)` on first call, caches the
 * resulting realm-shared function in module scope, and dispatches.
 *
 * Subsequent calls hit the cache directly with no symbol lookup.
 *
 * @template {keyof Bank} N
 * @param {N} name
 * @returns {Bank[N]}
 */
const makeThunk = name => {
  /** @type {Bank[N] | undefined} */
  let resolved;
  /** @type {Bank[N]} */
  const thunk = /** @type {any} */ (
    function thunkBody(/** @type {any[]} */ ...args) {
      if (!resolved) {
        resolved = installOrAdoptOne(name);
      }
      return /** @type {any} */ (resolved)(...args);
    }
  );
  return thunk;
};

/**
 * `delegate(handler)` returns a settler bag for a new pending promise
 * routed through the supplied handler. The promise is an ordinary
 * `Promise` instance whose pending operations dispatch via the handler.
 *
 * Lazy ponyfill thunk: first call resolves the realm-shared
 * `Promise[Symbol.for('delegate')]` peer (installing it if absent).
 *
 * @type {Delegate}
 */
export const delegate = makeThunk('delegate');

/**
 * Eventually invoke a method on a target with the supplied arguments.
 * Returns a promise for the result.
 *
 * Lazy ponyfill thunk for the realm-shared
 * `Promise[Symbol.for('applyMethod')]` peer.
 */
export const applyMethod = makeThunk('applyMethod');

/**
 * Like `applyMethod` but does not wait for or surface the result.
 */
export const applyMethodSendOnly = makeThunk('applyMethodSendOnly');

/**
 * Eventually invoke the target as a function with the supplied
 * arguments. Returns a promise for the result.
 */
export const applyFunction = makeThunk('applyFunction');

/**
 * Like `applyFunction` but does not wait for or surface the result.
 */
export const applyFunctionSendOnly = makeThunk('applyFunctionSendOnly');

/**
 * Eventually read a property from the target. Returns a promise for
 * the value.
 */
export const get = makeThunk('get');

/**
 * Like `get` but does not wait for or surface the result.
 */
export const getSendOnly = makeThunk('getSendOnly');

/**
 * Wrap a value as a `HandledPromise`, threading presences through the
 * realm-shared handler graph.
 *
 * Note: at the symbol-slot level this is the realm-shared
 * `HandledPromise.resolve`. The peer at `Promise[Symbol.for('resolve')]`
 * is the static method, not the constructor; the constructor lives at
 * `Promise[Symbol.for('HandledPromise')]`.
 */
export const resolve = makeThunk('resolve');

// Back-compat: legacy callers expect a `HandledPromise` constructor
// with the static methods attached. Build a lazy adapter that defers
// to the realm-shared peers. Module load does NOT trigger install;
// only `new HandledPromise(...)` or reading a static does.
//
// The adapter is a regular `function` (not an arrow) so legacy callers
// that do `new HandledPromise(executor, handler)` continue to work.
// The constructor body forwards to `delegate(handler)` and wires the
// executor up to the settler bag.
//
// The static-method surface is exposed via getter properties that each
// return the SAME function reference held by the realm-shared peer at
// `Promise[Symbol.for(<name>)]`. This preserves identity with
// `globalThis.HandledPromise.<name>` (which the eager shim sets to the
// realm constructor) so that
// `t.is(E.resolve, HandledPromise.resolve)` and similar identity
// assertions hold across the shim and lazy paths. The getters trigger
// the lazy install on first read; module load remains side-effect-free.
/**
 * @template R
 * @this {unknown}
 * @param {HandledExecutor<R>} executor
 * @param {Handler<Promise<R>>} [handler]
 * @returns {Promise<R>}
 */
function lazyHandledPromise(executor, handler) {
  // Permit `HandledPromise(executor, handler)` (without `new`) for
  // back-compat parity with the eager shim's constructor, which the
  // legacy `function X` form also tolerated.
  const settler = /** @type {any} */ (delegate)(handler);
  executor(settler.resolve, settler.reject, settler.resolveWithPresence);
  return settler.promise;
}

// Names of the static methods that ride along on the constructor-shaped
// `HandledPromise` adapter. Each is exposed as a getter that defers to
// the realm-shared `Promise[Symbol.for(<name>)]` peer on read.
const handledPromiseStaticNames = /** @type {const} */ ([
  'applyFunction',
  'applyFunctionSendOnly',
  'applyMethod',
  'applyMethodSendOnly',
  'get',
  'getSendOnly',
  'resolve',
]);

const handledPromiseStaticDescriptors =
  /** @type {Record<string, PropertyDescriptor>} */ ({});
for (const name of handledPromiseStaticNames) {
  handledPromiseStaticDescriptors[name] = {
    get: () => installOrAdoptOne(name),
    enumerable: true,
    configurable: false,
  };
}
Object.defineProperties(lazyHandledPromise, handledPromiseStaticDescriptors);
Object.freeze(lazyHandledPromise);

/**
 * Backward-compatibility alias for the legacy `HandledPromise`
 * surface. New code should call the lexical ponyfill thunks
 * (`delegate`, `applyMethod`, `applyFunction`, `get`, `resolve`)
 * instead.
 *
 * Both the constructor form (`new HandledPromise(executor, handler)`)
 * and the static-method surface (`HandledPromise.applyMethod`,
 * `.resolve`, etc.) are supported. The constructor form is a thin
 * alias around `delegate(handler)` that wires the executor up to the
 * settler bag; the static methods are getters that defer to the
 * realm-shared peers on first read, and return the SAME function
 * reference held by `Promise[Symbol.for(<name>)]`.
 *
 * The eager shim at `@endo/eventual-send/shim.js` additionally writes
 * `globalThis.HandledPromise` to the actual constructor for legacy
 * `globalThis.HandledPromise` consumers.
 *
 * @type {HandledPromiseConstructor}
 */
export const HandledPromise =
  /** @type {HandledPromiseConstructor} */
  (/** @type {unknown} */ (lazyHandledPromise));

// Lazy `E`: defer the call to `makeE` until first use of any `E`
// surface. `makeE` reads `HandledPromise.resolve` etc. eagerly at
// construction, so passing `lazyHandledPromise` directly would make
// `E.resolve` reference an arrow wrapper rather than the realm-shared
// peer. By deferring `makeE` until first use and binding it to a
// constructor-shaped facade backed by the realm-shared peers, the
// statics on `E` reference the realm peers themselves, so
// `E.resolve === HandledPromise.resolve === installOrAdoptOne('resolve')`.

/** @type {ReturnType<typeof makeE> | undefined} */
let cachedRealE;
const ensureRealE = () => {
  if (!cachedRealE) {
    // Build a constructor-shaped facade for `makeE` whose statics are
    // the realm-shared peers themselves (not arrow wrappers). `makeE`
    // copies these via Object.assign, so the references it captures
    // ARE the realm peers.
    const HP = /** @type {any} */ (
      /** @type {unknown} */ (lazyHandledPromise)
    );
    /** @type {any} */
    const facade = function FacadeHandledPromise(executor, handler) {
      return lazyHandledPromise(executor, handler);
    };
    for (const name of handledPromiseStaticNames) {
      facade[name] = installOrAdoptOne(name);
    }
    facade.HandledPromise = HP;
    Object.freeze(facade);
    cachedRealE = makeE(
      /** @type {HandledPromiseConstructor} */ (
        /** @type {unknown} */ (facade)
      ),
    );
  }
  return cachedRealE;
};

/**
 * Create a Proxy whose method calls eventually-send via the
 * realm-shared peers.
 *
 * `E(x)` returns a proxy on which arbitrary methods can be called; each
 * call returns a promise.
 *
 * `E.get(x)` returns a proxy on which arbitrary properties can be read;
 * each read returns a promise.
 *
 * `E.when(x, res, rej)` is equivalent to
 * `Promise.resolve(x).then(res, rej)`.
 *
 * @param {unknown} x target for method/function call
 * @returns {unknown} method/function call proxy
 */
function lazyE(x) {
  return ensureRealE()(x);
}

// Static surface mirrors the eager `makeE` return: `get`, `resolve`,
// `sendOnly`, `when`. Each is a getter that lazily resolves to the
// realm-bound `E` constructed from the realm-shared peers. This
// preserves identity with `HandledPromise.<name>` because `makeE`
// itself assigns those statics from the constructor argument, which
// holds the realm peers directly.
const eStaticNames = /** @type {const} */ ([
  'get',
  'resolve',
  'sendOnly',
  'when',
]);

const eStaticDescriptors =
  /** @type {Record<string, PropertyDescriptor>} */ ({});
for (const name of eStaticNames) {
  eStaticDescriptors[name] = {
    get: () => /** @type {any} */ (ensureRealE())[name],
    enumerable: true,
    configurable: false,
  };
}
Object.defineProperties(lazyE, eStaticDescriptors);
Object.freeze(lazyE);

export const E = /** @type {ReturnType<typeof makeE>} */ (
  /** @type {unknown} */ (lazyE)
);

// eslint-disable-next-line import/export
export * from './exports.js';
