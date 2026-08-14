/**
 * Bundle the SES-adjacent boot script
 * (`packages/daemon/src/bus-worker-xs-ses-boot.js`) into a standalone
 * IIFE for evaluation in the XS JavaScript engine.
 *
 * Produces one file:
 *   ses_boot.js — runs after `polyfills.js` and the host-power
 *   aliases and before the daemon / worker bootstrap.  Installs the
 *   `HandledPromise` shim on `globalThis`.  Despite the name it does
 *   not call `lockdown()`; see the entry point's header.
 *
 * Uses the same compartment-mapper pipeline as
 * `bundle-bus-daemon-endor.js` and writes to the same output
 * directory.  None of the three carries a package exclusion list:
 * module retention follows the entry point's import graph, so a
 * package whose modules are never reached costs nothing.  Steer
 * retention with `exports` / `imports` conditions if that ever
 * changes.
 *
 * Usage: node packages/daemon/scripts/bundle-bus-worker-xs-ses-boot.js
 */
import '@endo/init';
import fs from 'fs';
import url from 'url';
import crypto from 'crypto';
import path from 'path';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';

const readPowers = makeReadPowers({ fs, url, crypto, path });
const scriptUrl = new URL(import.meta.url);
const outDir = new URL('../../../rust/endo/xsnap/src/', scriptUrl);
const entryUrl = new URL('../src/bus-worker-xs-ses-boot.js', scriptUrl).href;

const bundle = await makeBundle(readPowers, entryUrl, {});
const outPath = new URL('ses_boot.js', outDir);
fs.writeFileSync(outPath, bundle);
console.log(`Wrote ${outPath} (${bundle.length} bytes)`);
