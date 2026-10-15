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
 * Initial or shared globals that a shim may install before `lockdown`, locked
 * first-wins, and that `lockdown` then leaves in place rather than redefining.
 * Any other pre-lockdown non-configurable binding among the names `lockdown`
 * defines makes it throw.
 */
const firstWinsPropertyNames = freeze({
  __proto__: null,
  Parcel: true,
});

/**
 * Whether a pre-existing global binding is exactly the locked data property a
 * first-wins shim installs, holding the intrinsic `lockdown` sampled.
 * The value comparison matters: a reentrant Proxy trap can re-point the
 * binding after sampling.
 *
 * @param {PropertyDescriptor | undefined} descriptor
 * @param {unknown} value
 * @returns {boolean}
 */
const isFirstWinsDescriptor = (descriptor, value) =>
  descriptor !== undefined &&
  hasOwn(descriptor, 'value') &&
  is(descriptor.value, value) &&
  descriptor.writable === false &&
  descriptor.enumerable === false &&
  descriptor.configurable === false;

/**
 * Define the first-wins globals, ahead of the general install loop, which
 * skips them.
 * A child global starts without these bindings and receives the ordinary
 * mutable shared binding.
 * On the start global, the shim's locked binding stays in place, and a binding
 * deleted or re-pointed after sampling is restored to the sampled value,
 * locked.
 *
 * @param {object} globalObject
 * @param {object} intrinsics
 * @param {object} newGlobalPropertyNames
 * @param {boolean} isStartGlobal
 */
const defineFirstWinsGlobals = (
  globalObject,
  intrinsics,
  newGlobalPropertyNames,
  isStartGlobal,
) => {
  for (const [name, intrinsicName] of entries(newGlobalPropertyNames)) {
    if (
      hasOwn(firstWinsPropertyNames, name) &&
      hasOwn(intrinsics, intrinsicName)
    ) {
      const value = intrinsics[intrinsicName];
      const descriptor = getOwnPropertyDescriptor(globalObject, name);
      if (!isFirstWinsDescriptor(descriptor, value)) {
        const locked =
          descriptor === undefined
            ? isStartGlobal
            : !is(descriptor.value, value);
        defineProperty(globalObject, name, {
          value,
          writable: !locked,
          enumerable: false,
          configurable: !locked,
        });
      }
    }
  }
};

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
      defineProperty(globalObject, name, {
        value: intrinsics[intrinsicName],
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }

  defineFirstWinsGlobals(
    globalObject,
    intrinsics,
    newGlobalPropertyNames,
    parentCompartment === undefined,
  );

  for (const [name, intrinsicName] of entries(newGlobalPropertyNames)) {
    if (
      hasOwn(intrinsics, intrinsicName) &&
      !hasOwn(firstWinsPropertyNames, name)
    ) {
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
