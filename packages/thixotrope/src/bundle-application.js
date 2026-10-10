// @ts-check
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';
import harden from '@endo/harden';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/** Read and bundle locally; application code executes only in the guest. @param {string} file */
export const bundleApplication = async file => {
  const bundle = await makeBundle(
    makeReadPowers({ fs, path, url, crypto }),
    url.pathToFileURL(path.resolve(file)).href,
  );
  return harden({
    bundle,
    digest: crypto.createHash('sha256').update(bundle).digest('hex'),
  });
};
harden(bundleApplication);
