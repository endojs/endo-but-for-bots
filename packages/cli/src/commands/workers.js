/* global process */
import os from 'os';

import { E } from '@endo/far';

import { withEndoHost } from '../context.js';

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

    if (workerEntries.length === 0) {
      if (!json) {
        console.log('No workers found.');
      } else {
        console.log('[]');
      }
      return;
    }

    /** @type {Array<{ name: string, tenants: Array<{ name: string, type: string }> }>} */
    const result = [];

    for (const { name } of workerEntries) {
      // eslint-disable-next-line no-await-in-loop
      const tenants = await E(host).listWorkerTenants(name);
      result.push({ name, tenants });
    }

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const { name, tenants } of result) {
        const count = tenants.length;
        console.log(`${name} (${count} tenant${count !== 1 ? 's' : ''})`);
        for (const tenant of tenants) {
          console.log(`  ${tenant.name} [${tenant.type}]`);
        }
      }
    }
  });
