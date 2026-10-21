/**
 * Bundle the XS-hosted compartment mapper that `endor run <entry.js>` uses
 * to turn an entry module into an archive in the CAS.
 *
 * Produces one file:
 *   endor_run_mapper.js — script that installs
 *   globalThis.endorRunMapEntryPoint (see ../src/endor-run-mapper-xs.js)
 *
 * The bundle is built with the `xs` condition so that `ses` and
 * `@endo/module-source` select their XS variants: SES-for-XS lockdown and
 * a module-source adapter over the native XS `ModuleSource`.
 *
 * Usage: node packages/daemon/scripts/bundle-endor-run-mapper-xs.mjs
 */
import '@endo/init';
import fs from 'fs';
import url from 'url';
import crypto from 'crypto';
import path from 'path';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';

const readPowers = makeReadPowers({ fs, url, crypto, path });
const outDirectory = url.fileURLToPath(
  new URL('../../../rust/endo/xsnap/src/', import.meta.url),
);

const mapperLocation = new URL('../src/endor-run-mapper-xs.js', import.meta.url)
  .href;

// Only these daemon dependencies are reachable from the mapper entry; the
// rest (libp2p, sqlite, Node streams) never load under XS.
const INCLUDED_PACKAGES = new Set(['@endo/compartment-mapper', 'ses']);

const mapperBundle = await makeBundle(readPowers, mapperLocation, {
  conditions: new Set(['xs']),
  packageDependenciesHook: ({ canonicalName, dependencies }) => {
    if (canonicalName !== '@endo/daemon') {
      return { dependencies };
    }
    return {
      dependencies: new Set(
        [...dependencies].filter(dependency =>
          INCLUDED_PACKAGES.has(dependency),
        ),
      ),
    };
  },
});
const mapperPath = path.join(outDirectory, 'endor_run_mapper.js');
fs.writeFileSync(mapperPath, mapperBundle);
console.log(`Wrote ${mapperPath} (${mapperBundle.length} bytes)`);
