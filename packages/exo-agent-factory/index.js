// @ts-check
// reexport-policy-exempt: this is the package's own entry point, not a
// compatibility shim; each name has no older home to deprecate.

export {
  prepareChildAgentCoordinator,
  LIFECYCLE_NAME,
} from './src/coordinator.js';
export {
  intersectPolicy,
  makeRootPolicy,
  isOrdinaryName,
} from './src/policy.js';
export * from './src/interfaces.js';
