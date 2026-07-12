/* global process */
import os from 'os';

import { E } from '@endo/far';

import { withEndoHost } from '../context.js';
import { formatWorkers } from './workers-format.js';

/**
 * List workers and their tenanted capabilities.
 *
 * @param {object} options
 * @param {boolean} [options.json] - Output as JSON.
 */
export const workers = async ({ json }) =>
  withEndoHost({ os, process }, async ({ host }) => {
    const entries = await E(host).listWithTypes();
    const workerEntries = entries.filter(e => e.type === 'worker');

    /** @type {Array<{ name: string, tenants: Array<{ name: string, type: string }> }>} */
    const listing = [];

    for (const { name } of workerEntries) {
      // eslint-disable-next-line no-await-in-loop
      const tenants = await E(host).listWorkerTenants(name);
      listing.push({ name, tenants });
    }

    if (!json && listing.length === 0) {
      console.error('No workers found.');
      return;
    }

    console.log(formatWorkers(listing, { json }));
  });
