// @ts-check
// reexport-policy-exempt: this is the package's own entry point, not a
// compatibility shim; each name has no older home to deprecate.
//
// Deliberately omitted: `src/config.js` (environment parsing for the
// `npm-registry-server` bin, not a library surface), `STATUS_ERRORS`
// from `src/errors.js` (the HTTP adapter's internal status-to-code table),
// and `isAllowlistEntry` from `src/names.js` (the grant store's input
// validator; `makeGrants().putGrant` is the public way to exercise it).

export { makeFileCas } from './src/cas.js';
export {
  canonicalizePackageName,
  encodePackageName,
  tarballFileName,
  allowlistCovers,
} from './src/names.js';
export {
  compareSemver,
  devDateTagForVersion,
  isDateTag,
  isWritableDevTag,
  parseSemver,
} from './src/dev-release.js';
export { makeGrants, makeToken, hashToken } from './src/grants.js';
export { makeRegistryStore, SCHEMA_VERSION } from './src/store.js';
export {
  ingestTarball,
  digestTarball,
  verifyTarball,
  defaultArchiveLimits,
} from './src/tarball.js';
export { makeRegistry } from './src/registry.js';
export { makeNodeFetch } from './src/node-fetch.js';
export { makeRequestHandler } from './src/http.js';
export { openRegistry, startRegistryServer } from './src/server.js';
export { RegistryHttpError, isRegistryHttpError } from './src/errors.js';
