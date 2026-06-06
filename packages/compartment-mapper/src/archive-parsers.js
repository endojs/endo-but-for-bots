/* Provides a set of default language behaviors (parsers) suitable for creating
 * archives (zip files with a `compartment-map.json` and a file for each
 * module) with pre-compiled sources.
 *
 * This module entrains a dependency upon the core of Babel.
 */
/** @import {ParserForLanguage} from './types.js' */

import { evadeCensor } from '@endo/evasive-transform';
import parserJson from './parse-json.js';
import parserText from './parse-text.js';
import parserBytes from './parse-bytes.js';
import parserArchiveCjs from './parse-archive-cjs.js';
import parserArchiveMjs from './parse-archive-mjs.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** @satisfies {Readonly<ParserForLanguage>} */
export const defaultParserForLanguage = Object.freeze(
  /** @type {const} */ ({
    mjs: parserArchiveMjs,
    'pre-mjs-json': parserArchiveMjs,
    cjs: parserArchiveCjs,
    'pre-cjs-json': parserArchiveCjs,
    json: parserJson,
    text: parserText,
    bytes: parserBytes,
  }),
);

/**
 * Evasive transforms for source-preserving archives.
 *
 * These prevent SES false positives from comment and literal text,
 * including JSDoc `import(...)` annotations in transitive dependencies.
 */
export const defaultModuleTransforms = Object.freeze({
  async mjs(sourceBytes, specifier, location, _packageLocation, options = {}) {
    const source = textDecoder.decode(sourceBytes);
    const priorSourceMap =
      typeof options.sourceMap === 'string' ? options.sourceMap : undefined;
    const { code, map } = await evadeCensor(source, {
      sourceType: 'module',
      sourceMap: priorSourceMap,
      sourceUrl: new URL(specifier, location).href,
    });
    return {
      bytes: textEncoder.encode(code),
      parser: 'mjs',
      sourceMap: map ? JSON.stringify(map) : undefined,
    };
  },
  async cjs(sourceBytes, specifier, location, _packageLocation, options = {}) {
    const source = textDecoder.decode(sourceBytes);
    const priorSourceMap =
      typeof options.sourceMap === 'string' ? options.sourceMap : undefined;
    const { code, map } = await evadeCensor(source, {
      sourceType: 'script',
      sourceMap: priorSourceMap,
      sourceUrl: new URL(specifier, location).href,
    });
    return {
      bytes: textEncoder.encode(code),
      parser: 'cjs',
      sourceMap: map ? JSON.stringify(map) : undefined,
    };
  },
});
