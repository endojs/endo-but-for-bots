// XS+SES prelude: sets up the SES lockdown shim for XS and exposes
// pass-style bytes helpers as globals for pass-style-bytes parity tests.
// XS ships native Compartment and hardening support; the conditional
// exports in ses/lockdown-shim.js resolve to src-xs/lockdown-shim.js
// when the "xs" condition is active, adapting those to the SES API shape.
/* global globalThis */
import 'ses/lockdown-shim.js';

// Expose pass-style bytes helpers as globals for pass-style-bytes parity tests.
// The immutable-arraybuffer shim is installed via ses/src/lockdown.js (imported
// transitively from ses/lockdown-shim.js above); the detect-then-skip guard in
// the shim makes re-installation a no-op when native support is present.
import { frozenBytes } from '@endo/pass-style/to-bytes.js';
import { thawnBytes } from '@endo/pass-style/from-bytes.js';
import { concatBytes } from '@endo/pass-style/concat-bytes.js';
import { encodeUtf8 } from '@endo/pass-style/encode-utf8.js';
import { decodeUtf8 } from '@endo/pass-style/decode-utf8.js';
import { strictDecodeUtf8 } from '@endo/pass-style/strict-decode-utf8.js';

globalThis.frozenBytes = frozenBytes;
globalThis.thawnBytes = thawnBytes;
globalThis.concatBytes = concatBytes;
globalThis.encodeUtf8 = encodeUtf8;
globalThis.decodeUtf8 = decodeUtf8;
globalThis.strictDecodeUtf8 = strictDecodeUtf8;
