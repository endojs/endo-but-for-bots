/**
 * Bundle the XS worker bootstrap into a standalone IIFE for
 * evaluation in the XS JavaScript engine.
 *
 * Produces one file:
 *   worker_bootstrap.js — worker entry point (CapTP, exo facet,
 *   single CapTP session keyed on the daemon's handle)
 *
 * Mirrors `bundle-bus-daemon-rust-xs.mjs`: same compartment-mapper
 * pipeline, same Node-only excluded packages, output to
 * `rust/endo/xsnap/src/worker_bootstrap.js`.
 *
 * Usage: node packages/daemon/scripts/bundle-bus-worker-xs.mjs
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

// Node.js-only packages that must be excluded from the XS worker
// bundle.  These are declared in @endo/daemon's package.json but
// never imported by bus-worker-xs.js or its transitive dependencies.
const EXCLUDED_PACKAGES = new Set([
  '@endo/stream-node',
  '@endo/compartment-mapper',
  '@endo/import-bundle',
  '@endo/init',
  '@endo/lockdown',
  '@endo/platform/proc',
  '@endo/platform/fs/node',
  '@endo/platform/exo-fs',
  '@endo/relay-server',
  '@endo/where',
  '@chainsafe/libp2p-noise',
  '@chainsafe/libp2p-yamux',
  '@libp2p/autonat',
  '@libp2p/bootstrap',
  '@libp2p/circuit-relay-v2',
  '@libp2p/crypto',
  '@libp2p/dcutr',
  '@libp2p/identify',
  '@libp2p/kad-dht',
  '@libp2p/ping',
  '@libp2p/webrtc',
  '@libp2p/websockets',
  '@multiformats/multiaddr',
  'libp2p',
  'ses',
  'ws',
]);

const workerUrl = url.pathToFileURL(
  path.resolve(__dirname, '../src/bus-worker-xs.js'),
).href;

const workerBundle = await makeBundle(readPowers, workerUrl, {
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
const workerPath = path.join(outDir, 'worker_bootstrap.js');
fs.writeFileSync(workerPath, workerBundle);
console.log(`Wrote ${workerPath} (${workerBundle.length} bytes)`);
