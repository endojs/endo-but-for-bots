// @ts-check

import harden from '@endo/harden';
import { makeNodeReader, makeNodeWriter } from '@endo/stream-node';

/** @import {MignonicPowers} from './types.js'; */

/**
 * @param {object} modules
 * @param {typeof import('fs')} modules.fs
 * @param {typeof import('url')} modules.url
 * @returns {MignonicPowers}
 */
export const makePowers = ({ fs, url }) => {
  // @ts-ignore This is in fact how you open a file descriptor.
  const reader = makeNodeReader(fs.createReadStream(null, { fd: 3 }));
  // @ts-ignore This is in fact how you open a file descriptor.
  const writer = makeNodeWriter(fs.createWriteStream(null, { fd: 4 }));

  const connection = {
    reader,
    writer,
  };

  const { pathToFileURL } = url;

  // The evasive-transform-wrapped parser map is Node-specific: it pulls
  // in `@endo/evasive-transform` (and transitively Babel) to apply the
  // SES censorship-evasion transform to mjs/cjs source bytes on the
  // archive-import path. Wiring it here, rather than from `worker.js`,
  // keeps the platform-agnostic worker free of `@babel/*` and lets the
  // Rust supervisor pick a different loader. The dynamic import keeps
  // workers that never call `makeArchive` / `makeFromTree` off the
  // Babel load cost.
  const loadArchiveParsers = async () => {
    const { evasiveParserForLanguage } =
      await import('./worker-archive-parsers.js');
    return evasiveParserForLanguage;
  };

  return harden({
    connection,
    pathToFileURL: path => pathToFileURL(path).toString(),
    loadArchiveParsers,
  });
};
