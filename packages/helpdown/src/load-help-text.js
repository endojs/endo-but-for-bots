// @ts-check

/**
 * Filesystem loaders for helpdown Markdown files.
 *
 * These are the only helpdown functions that touch a host builtin, which is
 * why they live behind the `@endo/helpdown/tools.js` entry rather than the
 * package's main entry: a build script can reach for them, and a module on a
 * bundle graph where `fs` does not resolve never has to.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import harden from '@endo/harden';

import { parseHelpdown } from './parse-helpdown.js';

/** @import { HelpText } from './types.js' */

/**
 * Read a helpdown Markdown file and yield [name, HelpText] entries.
 *
 * @param {URL} path - URL to the Markdown file
 * @returns {AsyncIterable<[string, HelpText]>}
 */
export const loadHelpTextFile = path => {
  return harden({
    [Symbol.asyncIterator]: () => {
      /** @type {Array<[string, HelpText]> | undefined} */
      let entries;
      let index = 0;

      return harden({
        /** @returns {Promise<IteratorResult<[string, HelpText]>>} */
        next: async () => {
          await null;
          if (entries === undefined) {
            const text = await readFile(path, 'utf-8');
            entries = parseHelpdown(text);
          }
          if (index < entries.length) {
            const value = entries[index];
            index += 1;
            return harden({ value, done: false });
          }
          return harden({ value: undefined, done: true });
        },
      });
    },
  });
};
harden(loadHelpTextFile);

/**
 * Synchronously read and parse a helpdown Markdown file.
 *
 * @param {URL} path - URL to the Markdown file
 * @returns {Map<string, HelpText>}
 */
export const readHelpTextFileSync = path => {
  const text = readFileSync(path, 'utf-8');
  const entries = parseHelpdown(text);
  return new Map(entries);
};
harden(readHelpTextFileSync);
