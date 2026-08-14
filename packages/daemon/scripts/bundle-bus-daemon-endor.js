/**
 * Bundle the XS daemon scripts into a standalone IIFE for evaluation
 * in the XS JavaScript engine.
 *
 * Produces one file:
 *   daemon_bootstrap.js — daemon entry point (CapTP, powers, daemon core)
 *
 * The SES boot script (ses_boot.js) is shared with the worker and
 * produced by bundle-bus-worker-xs-ses-boot.js.
 *
 * Like its siblings, this script carries no package exclusion list.
 * It used to prune a hand-maintained set of Node-only packages from
 * the compartment map through `packageDependenciesHook`; bundling
 * with and without that list produces identical results, because
 * `makeBundle` retains only the modules the entry point's import
 * graph actually reaches.  An unreached package costs nothing, and a
 * reached one cannot be pruned at all -- dropping its dependency edge
 * only turns the static import into an unresolvable specifier.
 * Steer retention with the package's `exports` / `imports` conditions
 * (the `xs` condition), not by editing the dependency graph.
 *
 * Usage: node packages/daemon/scripts/bundle-bus-daemon-endor.js
 */
import '@endo/init';
import fs from 'fs';
import url from 'url';
import crypto from 'crypto';
import path from 'path';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';

// `path` is a power `makeReadPowers` asks for, not path math: the
// paths this script computes are `new URL` arithmetic, per the
// prevailing Endo convention, as in its two sibling bundlers.
const readPowers = makeReadPowers({ fs, url, crypto, path });
const scriptUrl = new URL(import.meta.url);
const outDir = new URL('../../../rust/endo/xsnap/src/', scriptUrl);

// Bundle the daemon entry point
const daemonUrl = new URL('../src/bus-manager-endor.js', scriptUrl).href;

const daemonBundle = await makeBundle(readPowers, daemonUrl, {
  // This Endor bundle currently runs on XS, so resolve the `xs` arm of
  // every conditional export. `@endo/sha256` routes that condition to
  // its engine-independent Endor host contract; without it the bundle
  // would silently take the package's `default` arm, a pure-JS digest.
  // The compartment mapper adds `import`, `default`, and `endo` to
  // whatever is passed here.
  //
  // The sibling generators (bundle-bus-worker-xs.js and
  // bundle-bus-worker-xs-ses-boot.js) do not pass it, because nothing
  // their entry points reach has an `xs` arm to select: only the
  // daemon graph carries `@endo/sha256` today.  Add it there too the
  // moment a worker-graph package grows a condition-dependent
  // implementation, since the failure mode is a silently wrong arm
  // rather than an error.
  conditions: new Set(['xs']),
});
const daemonPath = new URL('daemon_bootstrap.js', outDir);
fs.writeFileSync(daemonPath, daemonBundle);
console.log(`Wrote ${daemonPath} (${daemonBundle.length} bytes)`);
