// Hardens the package's named exports without disturbing the
// pre-lockdown shim path: `@endo/init/pre.js` imports
// `@endo/base64/shim.js` (which loads `./atob.js` and `./btoa.js`,
// not this module) so that `globalThis.atob` and `globalThis.btoa`
// can be installed before SES `lockdown()` freezes the global.
// Hardening lives here, not in the shim path, so consumers that go
// through `@endo/base64` get hardened bindings while consumers that
// only use the shim do not pull `@endo/harden` into their
// pre-lockdown import chain.

import harden from '@endo/harden';

import { encodeBase64 as _encodeBase64 } from './src/encode.js';
import { decodeBase64 as _decodeBase64 } from './src/decode.js';
import { btoa as _btoa } from './btoa.js';
import { atob as _atob } from './atob.js';

export const encodeBase64 = _encodeBase64;
harden(encodeBase64);

export const decodeBase64 = _decodeBase64;
harden(decodeBase64);

export const btoa = _btoa;
harden(btoa);

export const atob = _atob;
harden(atob);
