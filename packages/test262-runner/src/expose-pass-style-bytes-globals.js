/* global globalThis */
import '@endo/eventual-send/shim.js';

import { compareBytes } from '@endo/bytes/compare.js';
import { concatBytes } from '@endo/bytes/concat.js';
import { frozenBytes, thawedBytes } from '@endo/immutable-arraybuffer';
import { passStyleOf } from '@endo/pass-style';

globalThis.compareBytes = compareBytes;
globalThis.concatBytes = concatBytes;
globalThis.frozenBytes = frozenBytes;
globalThis.passStyleOf = passStyleOf;
globalThis.thawedBytes = thawedBytes;
