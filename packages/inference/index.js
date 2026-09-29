// The provider-neutral inference seam. Nothing here names a provider.
// Guards live in `./src/interface.js` so that a consumer without
// `@endo/patterns` (a deployment harness) can still use the enrichers.
export { makeSlotAdmission, withAdmission } from './src/admission.js';
export { withUsageRecord, makeRunId } from './src/usage.js';
export { withResultGuard } from './src/result.js';
