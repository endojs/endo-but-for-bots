// @ts-nocheck
/* global print */

// XS spot check for the synchronous pure-JavaScript SHA-256 implementation.
//
// This is the code that runs under the `browser` and `default` conditions and,
// crucially, on legacy XS hosts (such as the Agoric chain) that lack the native
// SHA-256 host functions the `xs` condition uses. We import the concrete
// implementation module directly — not the `@endo/sha256` package entry — so
// only the pure-JS path is entrained, needing no host globals.
//
// `xst` resolves module specifiers as plain paths and has no notion of
// `node_modules`, so a bare specifier like `@endo/hex` silently resolves to
// nothing and its named imports fail to link. The package `test:xs` script
// therefore bundles this file with `@endo/compartment-mapper` first (see
// `scripts/generate-test-xs.js`) and runs the bundle, the same arrangement
// `@endo/module-source` and `ses` use for their XS tests. CI's test-xs job
// exercises it through the usual `yarn test:xs` mechanism.

import { encodeHex } from '@endo/hex';

import { sha256, sha256Into } from '../src/sha256-browser.js';
import { sha256Vectors } from './_vectors.js';

// Encode ASCII text to bytes without relying on TextEncoder, which XS lacks.
const ascii = text => Uint8Array.from(text, ch => ch.charCodeAt(0));

for (const [text, want] of sha256Vectors) {
  const got = encodeHex(sha256(ascii(text)));
  if (got !== want) {
    throw Error(`sha256(${JSON.stringify(text)}) = ${got}, want ${want}`);
  }
  print(`# ok sha256(${JSON.stringify(text)})`);
}

// Exercise the offset-writing entry point too.
{
  const out = new Uint8Array(40).fill(0xff);
  const written = sha256Into(out, ascii('abc'), 4);
  if (written !== 32) {
    throw Error(`sha256Into returned ${written}, want 32`);
  }
  const got = encodeHex(out.subarray(4, 36));
  const want =
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  if (got !== want) {
    throw Error(`sha256Into digest = ${got}, want ${want}`);
  }
  for (let i = 0; i < 4; i += 1) {
    if (out[i] !== 0xff) {
      throw Error('sha256Into overwrote bytes before its offset');
    }
  }
  print('# ok sha256Into writes at its requested offset');
}

print('# @endo/sha256 pure-JavaScript implementation validated under XS');
