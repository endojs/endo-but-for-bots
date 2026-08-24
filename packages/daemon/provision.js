// @ts-check

// Thunk module retained for the package's secondary public export.
// The host-side provider remains reachable only through
// `E(host).provideGuest(name, { authority })`.

export { EndoGuestAuthorityShape } from './src/provision/index.js';
