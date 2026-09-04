// @ts-check

// This thunk filters the public provisioning surface while preserving a
// physical legacy-resolution path and its paired type-only re-export index.
export {
  provisionEndoCodeMode,
  reconstructEndoCodeMode,
} from './src/code-mode-provisioning.js';
export { EndoCredentialUnavailableError } from './src/code-mode-provision-host.js';
export { normalizeEndoProvisionSpec } from './src/code-mode-provision-policy.js';
