/* global process */
import os from 'os';

import { E } from '@endo/far';

import { withEndoHost } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Inspect the formula for a pet-named value.
 *
 * @param {object} options
 * @param {string} options.name - Pet name to inspect.
 * @param {boolean} [options.json] - Output as JSON.
 */
export const inspect = async ({ name, json }) =>
  withEndoHost({ os, process }, async ({ host }) => {
    const namePath = parsePetNamePath(name);
    const result = await E(host).inspect(namePath);
    if (result === undefined) {
      console.error(`No formula found for "${name}"`);
      process.exitCode = 1;
      return;
    }
    const { id, formula } = result;
    if (json) {
      console.log(JSON.stringify({ id, formula }, null, 2));
    } else {
      console.log(`ID: ${id}`);
      console.log(`Type: ${formula.type}`);
      const entries = Object.entries(formula).filter(
        ([key]) => key !== 'type',
      );
      if (entries.length > 0) {
        console.log('Fields:');
        for (const [key, value] of entries) {
          const display =
            typeof value === 'string'
              ? value
              : JSON.stringify(value);
          console.log(`  ${key}: ${display}`);
        }
      }
    }
  });
