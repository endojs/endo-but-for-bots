/**
 * Bundle the archive text endowments (web-platform `TextEncoder`,
 * `TextDecoder`, `atob`, `btoa`) into a standalone script for
 * evaluation in the XS JavaScript engine.
 *
 * The base64 codec is drawn from `@endo/base64` through this bundle
 * rather than reimplemented in the xsnap crate; the entry module
 * (`../src/archive-text-endowments-xs.js`) contributes only the thin
 * WHATWG adaptation layer.
 *
 * Produces:
 *   rust/endo/xsnap/src/archive_text_endowments.js — a side-effecting
 *     bundle that installs the endowments onto
 *     `globalThis.__archiveEndowments`.
 *
 * Usage: node packages/daemon/scripts/bundle-archive-text-endowments-xs.mjs
 */
import '@endo/init';
import fs from 'fs';
import url from 'url';
import crypto from 'crypto';
import path from 'path';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';

const readPowers = makeReadPowers({ fs, url, crypto, path });
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../../../rust/endo/xsnap/src');

const entryUrl = url.pathToFileURL(
  path.resolve(__dirname, '../src/archive-text-endowments-xs.js'),
).href;

const bundle = await makeBundle(readPowers, entryUrl);

// The xsnap runtime evaluates this bundle as a plain script via the
// `machine.eval` FFI (see `ARCHIVE_TEXT_ENDOWMENTS_JS` in
// `rust/endo/xsnap/src/lib.rs`), and that FFI converts the script's
// completion value into a Rust value. A compartment-mapper script
// bundle's completion value is the entry's module-namespace object (a
// null-prototype exotic), which the converter cannot represent and on
// which it crashes. The bundle's side effect — installing the
// endowments onto `globalThis.__archiveEndowments` — has already run by
// then, so force a trivial completion value with a trailing statement,
// exactly as the previous hand-written IIFE did (its completion value
// was `undefined`).
const script = `${bundle}\n;undefined;\n`;

const outPath = path.join(outDir, 'archive_text_endowments.js');
fs.writeFileSync(outPath, script);
console.log(`Wrote ${outPath} (${script.length} bytes)`);
