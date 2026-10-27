/**
 * @module Alters the XS implementation of Lockdown to be backward compatible
 * with SES, providing Compartment constructors in every Compartment that can
 * be used with either native ModuleSources or module sources pre-compiled for
 * the SES Compartment, depending on the __native__ Compartment constructor
 * option.
 */
import { globalThis } from '../src/commons.js';
import { NativeStartCompartment } from './commons.js';
import { repairIntrinsics } from '../src/lockdown.js';
import { adaptCompartmentConstructors } from './compartment.js';

const lockdown = options => {
  // New compartments must get their intrinsics from lockdown, as on other
  // engines, so the shim Compartment constructor cannot be the one made when
  // SES was imported, which sampled the then-untamed globals.
  // Nor can it be the `Compartment` that `repairIntrinsics` installs on
  // `globalThis`: that one enforces `new`, but `adaptCompartmentConstructors`
  // initializes each native compartment by calling the shim constructor as a
  // function. `repairIntrinsics` hands us an otherwise identical constructor
  // that does not enforce `new`.
  // The prototype methods (`shimEvaluate`, `shimImport`, ...) still come from
  // the import-time constructor in `./compartment.js`; they apply to
  // compartments from this constructor through the module-level
  // `privateFields` WeakMap in `../src/compartment.js`.
  /** @type {Compartment['constructor'] | undefined} */
  let LockdownShimStartCompartment;
  const hardenIntrinsics = repairIntrinsics(options, ShimStartCompartment => {
    LockdownShimStartCompartment = ShimStartCompartment;
  });
  hardenIntrinsics();
  // Replace global Compartment with a version that is hardened and hardens
  // transitive child Compartment.
  // @ts-expect-error Incomplete global type on XS.
  globalThis.Compartment = adaptCompartmentConstructors(
    NativeStartCompartment,
    LockdownShimStartCompartment,
    harden,
  );
};

globalThis.lockdown = lockdown;
