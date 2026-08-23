// @ts-check

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';

import { makeArchive } from '@endo/compartment-mapper';
import { defaultParserForLanguage as sourceParserForLanguage } from '@endo/compartment-mapper/import-parsers.js';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';
import { makeError, q, X } from '@endo/errors';
import harden from '@endo/harden';
import { transformSync } from 'amaro';

/** @import { ArchiveOptions, AsyncParserImplementation, ParserImplementation } from '@endo/compartment-mapper' */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Make a TypeScript parser that strips types before delegating to the existing
 * JavaScript source parser.
 *
 * XXX This duplicates the TypeScript parser setup in
 * `@endo/bundle-source/src/endo.js`. Refactor both packages to use a shared
 * public helper once the archive/parser API has an appropriate home.
 *
 * @param {ParserImplementation} sourceParser
 * @returns {AsyncParserImplementation}
 */
const makeTypeScriptParser = sourceParser => ({
  async parse(
    sourceBytes,
    specifier,
    moduleLocation,
    packageLocation,
    options = undefined,
  ) {
    const sourceText = textDecoder.decode(sourceBytes);
    let code;
    try {
      ({ code } = transformSync(sourceText, {
        mode: 'strip-only',
        filename: moduleLocation,
      }));
    } catch (error) {
      const message =
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
          ? error.message
          : `${error}`;
      throw makeError(
        X`Cannot strip types from ${q(moduleLocation)}: ${q(message)}`,
      );
    }
    return sourceParser.parse(
      textEncoder.encode(code),
      specifier,
      moduleLocation,
      packageLocation,
      options,
    );
  },
  heuristicImports: sourceParser.heuristicImports,
  synchronous: false,
});

const workspaceLanguageForExtension = harden({ mts: 'mts', cts: 'cts' });
const workspaceModuleLanguageForExtension = harden({ ts: 'mts' });
const workspaceCommonjsLanguageForExtension = harden({ ts: 'cts' });

/**
 * Create the source archive used by the CLI's confined make, run, and archive
 * commands, including strip-only TypeScript support for workspace sources.
 *
 * @param {string} moduleLocation
 * @param {ArchiveOptions} [options] - Options augment the CLI defaults. Custom
 *   JavaScript parsers are also used as the delegates for TypeScript sources,
 *   unless a corresponding TypeScript parser is supplied explicitly.
 * @returns {Promise<Uint8Array>}
 */
export const makeCliArchive = (moduleLocation, options = {}) => {
  const readPowers = makeReadPowers({ fs, url, crypto, path });
  const effectiveSourceParserForLanguage = {
    ...sourceParserForLanguage,
    ...options.parserForLanguage,
  };
  const parserForLanguage = {
    ...effectiveSourceParserForLanguage,
    mts:
      options.parserForLanguage?.mts ??
      makeTypeScriptParser(effectiveSourceParserForLanguage.mjs),
    cts:
      options.parserForLanguage?.cts ??
      makeTypeScriptParser(effectiveSourceParserForLanguage.cjs),
  };
  return makeArchive(readPowers, moduleLocation, {
    ...options,
    parserForLanguage,
    workspaceLanguageForExtension: {
      ...workspaceLanguageForExtension,
      ...options.workspaceLanguageForExtension,
    },
    workspaceModuleLanguageForExtension: {
      ...workspaceModuleLanguageForExtension,
      ...options.workspaceModuleLanguageForExtension,
    },
    workspaceCommonjsLanguageForExtension: {
      ...workspaceCommonjsLanguageForExtension,
      ...options.workspaceCommonjsLanguageForExtension,
    },
  });
};
harden(makeCliArchive);
