import {
  TypeError,
  assign,
  create,
  defineProperty,
  entries,
  freeze,
  getOwnPropertyDescriptor,
  hasOwn,
  is,
  unscopablesSymbol,
} from './commons.js';
import { makeEvalFunction } from './make-eval-function.js';
import { makeFunctionConstructor } from './make-function-constructor.js';
import { constantProperties, universalPropertyNames } from './permits.js';

/**
 * Universal globals that a shim may install before `lockdown`, locked
 * first-wins, and that `lockdown` then leaves in place rather than redefining.
 * Every other universal global keeps the fail-closed behavior: a pre-lockdown
 * non-configurable binding makes `lockdown` throw.
 * So after `lockdown`, these are the only universal globals whose
 * start-compartment binding stays non-writable and non-configurable; a child
 * compartment's binding is writable and configurable as usual.
 *
 * An entry here reaches every compartment, including one built with no
 * endowments to confine untrusted code, so its value must confer no authority.
 * `SturdyRef` qualifies: it only constructs, brand-checks, and dispatches to a
 * handler the caller already holds. A shape check alone does not establish
 * this.
 */
const firstWinsPropertyNames = freeze({
  __proto__: null,
  SturdyRef: true, // Shimmed by `@endo/sturdyref`.
});

/**
 * Whether a pre-existing global binding is exactly the first-wins shape a shim
 * installs: a non-writable, non-enumerable, non-configurable data property
 * whose value is the intrinsic `lockdown` would install. Any other shape falls
 * through to the ordinary redefinition, which throws on a non-configurable
 * binding, so a misconfigured shim fails loudly.
 * In the start compartment `value` was sampled from this same binding, so the
 * value comparison always holds there; it guards only against a future change
 * in how `lockdown` samples the intrinsic.
 *
 * @param {PropertyDescriptor | undefined} descriptor
 * @param {unknown} value
 */
const isFirstWinsDescriptor = (descriptor, value) =>
  descriptor !== undefined &&
  hasOwn(descriptor, 'value') &&
  is(descriptor.value, value) &&
  descriptor.writable === false &&
  descriptor.enumerable === false &&
  descriptor.configurable === false;

/**
 * The host's ordinary global object is not provided by a `with` block, so
 * assigning to Symbol.unscopables has no effect.
 * Since this shim uses `with` blocks to create a confined lexical scope for
 * guest programs, we cannot emulate the proper behavior.
 * With this shim, assigning Symbol.unscopables causes the given lexical
 * names to fall through to the terminal scope proxy.
 * But, we can install this setter to prevent a program from proceding on
 * this false assumption.
 *
 * @param {object} globalObject
 */
export const setGlobalObjectSymbolUnscopables = globalObject => {
  defineProperty(
    globalObject,
    unscopablesSymbol,
    freeze(
      assign(create(null), {
        set: freeze(() => {
          throw TypeError(
            `Cannot set Symbol.unscopables of a Compartment's globalThis`,
          );
        }),
        enumerable: false,
        configurable: false,
      }),
    ),
  );
};

/**
 * setGlobalObjectConstantProperties()
 * Initializes a new global object using a process similar to ECMA specifications
 * (SetDefaultGlobalBindings). This process is split between this function and
 * `setGlobalObjectMutableProperties`.
 *
 * @param {object} globalObject
 */
export const setGlobalObjectConstantProperties = globalObject => {
  for (const [name, constant] of entries(constantProperties)) {
    defineProperty(globalObject, name, {
      value: constant,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
};

/**
 * setGlobalObjectMutableProperties()
 * Create new global object using a process similar to ECMA specifications
 * (portions of SetRealmGlobalObject and SetDefaultGlobalBindings).
 * `newGlobalPropertyNames` should be either `initialGlobalPropertyNames` or
 * `sharedGlobalPropertyNames`.
 *
 * @param {object} globalObject
 * @param {object} args
 * @param {object} args.intrinsics
 * @param {object} args.newGlobalPropertyNames
 * @param {Function} args.makeCompartmentConstructor
 * @param {(object) => void} args.markVirtualizedNativeFunction
 * @param {Compartment} [args.parentCompartment]
 */
export const setGlobalObjectMutableProperties = (
  globalObject,
  {
    intrinsics,
    newGlobalPropertyNames,
    makeCompartmentConstructor,
    markVirtualizedNativeFunction,
    parentCompartment,
  },
) => {
  for (const [name, intrinsicName] of entries(universalPropertyNames)) {
    if (hasOwn(intrinsics, intrinsicName)) {
      const value = intrinsics[intrinsicName];
      if (
        hasOwn(firstWinsPropertyNames, name) &&
        isFirstWinsDescriptor(
          getOwnPropertyDescriptor(globalObject, name),
          value,
        )
      ) {
        // The shim already locked the start compartment's binding to the very
        // intrinsic we would install, so leave it. A child compartment gets
        // the same value from its own call to this function, where its fresh
        // global object has no such binding yet.
        // eslint-disable-next-line no-continue
        continue;
      }
      defineProperty(globalObject, name, {
        value,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }

  for (const [name, intrinsicName] of entries(newGlobalPropertyNames)) {
    if (hasOwn(intrinsics, intrinsicName)) {
      defineProperty(globalObject, name, {
        value: intrinsics[intrinsicName],
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }

  const perCompartmentGlobals = {
    globalThis: globalObject,
  };

  perCompartmentGlobals.Compartment = freeze(
    makeCompartmentConstructor(
      makeCompartmentConstructor,
      intrinsics,
      markVirtualizedNativeFunction,
      {
        parentCompartment,
        enforceNew: true,
      },
    ),
  );

  // TODO These should still be tamed according to the permits before
  // being made available.
  for (const [name, value] of entries(perCompartmentGlobals)) {
    defineProperty(globalObject, name, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    if (typeof value === 'function') {
      markVirtualizedNativeFunction(value);
    }
  }
};

/**
 * setGlobalObjectEvaluators()
 * Set the eval and the Function evaluator on the global object with given evalTaming policy.
 *
 * @param {object} globalObject
 * @param {Function} evaluator
 * @param {(object) => void} markVirtualizedNativeFunction
 */
export const setGlobalObjectEvaluators = (
  globalObject,
  evaluator,
  markVirtualizedNativeFunction,
) => {
  {
    const f = freeze(makeEvalFunction(evaluator));
    markVirtualizedNativeFunction(f);
    defineProperty(globalObject, 'eval', {
      value: f,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  {
    const f = freeze(makeFunctionConstructor(evaluator));
    markVirtualizedNativeFunction(f);
    defineProperty(globalObject, 'Function', {
      value: f,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
};
