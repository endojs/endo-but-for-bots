import base from '../../ava-endo-lockdown.config.mjs';

// This explicit lane requires the built wasm launcher and native worker; the
// ordinary JS suite does not.
export default {
  ...base,
  files: ['test/ironhorse-wasm/runtime-identity.js'],
  timeout: '3m',
  concurrency: 1,
};
