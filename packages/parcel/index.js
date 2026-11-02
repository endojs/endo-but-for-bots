// reexport-policy-exempt: this public entry intentionally filters the
// side-effect-free constructor kit down to the ponyfill delegation surface.
export { isParcel, locate, makeParcel, open } from './no-shim.js';
