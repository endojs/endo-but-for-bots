/**
 * Bundle the XS worker bootstrap into a standalone IIFE for
 * evaluation in the XS JavaScript engine.
 *
 * Produces one file:
 *   worker_bootstrap.js — worker entry point (CapTP, exo facet,
 *   single CapTP session keyed on the daemon's handle)
 *
 * Uses the same compartment-mapper pipeline as
 * `bundle-bus-daemon-endor.js`, with output to
 * `rust/endo/xsnap/src/worker_bootstrap.js`.
 *
 * No package exclusion list, in any of the three: `makeBundle`
 * retains only the modules the entry point actually reaches, so
 * whether a Node-only package appears in the compartment graph is
 * immaterial as long as none of its modules are retained.
 * `bus-worker-xs.js` reaches none of `@endo/daemon`'s Node-only
 * paths, so the bundle is byte-identical with and without such a
 * list.  Should a future import pull a Node-only module in, steer
 * retention with the package's `exports` / `imports` conditions (the
 * `xs` condition) rather than by pruning the dependency graph -- a
 * reached module cannot be pruned that way anyway.
 *
 * Usage: node packages/daemon/scripts/bundle-bus-worker-xs.js
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
const workerUrl = new URL('../src/bus-worker-xs.js', scriptUrl).href;

const workerBundle = await makeBundle(readPowers, workerUrl, {});
const workerPath = new URL('worker_bootstrap.js', outDir);
fs.writeFileSync(workerPath, workerBundle);
console.log(`Wrote ${workerPath} (${workerBundle.length} bytes)`);
