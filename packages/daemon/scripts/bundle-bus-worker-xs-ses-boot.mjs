/**
 * Bundle the SES-adjacent boot script
 * (`packages/daemon/src/bus-worker-xs-ses-boot.js`) into a standalone
 * IIFE for evaluation in the XS JavaScript engine.
 *
 * Produces one file:
 *   ses_boot.js — runs after polyfills + SES lockdown and before the
 *   daemon / worker bootstrap.  Installs `harden` and the
 *   `HandledPromise` shim on `globalThis`.
 *
 * Mirrors `bundle-bus-daemon-rust-xs.mjs` and
 * `bundle-bus-worker-xs.mjs`: same compartment-mapper pipeline,
 * same Node-only excluded packages.
 *
 * Usage: node packages/daemon/scripts/bundle-bus-worker-xs-ses-boot.mjs
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

// Node-only packages excluded from the XS ses-boot bundle.
const EXCLUDED_PACKAGES = new Set(['@endo/init', '@endo/lockdown', 'ses']);

const entryUrl = url.pathToFileURL(
  path.resolve(__dirname, '../src/bus-worker-xs-ses-boot.js'),
).href;

const bundle = await makeBundle(readPowers, entryUrl, {
  packageDependenciesHook: ({ canonicalName, dependencies }) => {
    const filtered = new Set(
      [...dependencies].filter(dep => !EXCLUDED_PACKAGES.has(dep)),
    );
    if (filtered.size !== dependencies.size) {
      const removed = [...dependencies].filter(d => !filtered.has(d));
      console.log(
        `  ${canonicalName}: excluded ${removed.length} Node-only dep(s): ${removed.join(', ')}`,
      );
    }
    return { dependencies: filtered };
  },
});
const outPath = path.join(outDir, 'ses_boot.js');
fs.writeFileSync(outPath, bundle);
console.log(`Wrote ${outPath} (${bundle.length} bytes)`);
