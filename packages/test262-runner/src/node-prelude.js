import 'ses/lockdown-shim.js';
import 'ses/compartment-shim.js';

// Expose pass-style bytes helpers as globals for pass-style-bytes parity tests.
// The immutable-arraybuffer shim is already installed via the ses lockdown import
// above (ses/src/lockdown.js eagerly imports @endo/immutable-arraybuffer/shim.js);
// the second import inside to-bytes.js is detect-then-skip and is a no-op.
/* global globalThis */
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
