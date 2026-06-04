// @ts-check
/**
 * Parser wrappers that apply the SES censorship-evasion transform from
 * `@endo/evasive-transform` to module source bytes before delegating to
 * the underlying compartment-mapper parsers.
 *
 * Source-only ZIP archives produced by `@endo/compartment-mapper`'s
 * `makeArchive` (with the source parsers from
 * `@endo/compartment-mapper/import-parsers.js`) retain the original
 * untransformed module sources.  When such an archive is imported in a
 * Node.js worker, the source still has to evade SES censorship before it
 * reaches the compartment, or modules that contain a TypeScript JSDoc
 * `import()` annotation or a `@endo/errors` dynamic `import()` call will
 * fail at evaluation time with an SES SyntaxError.
 *
 * The transform was previously applied at bundle time inside
 * `@endo/bundle-source`'s `endoZipBase64` path.  After the pivot to the
 * source-only archive workflow (`makeArchive` replacing `bundleSource`)
 * the transform was no longer being applied anywhere.  This module
 * reintroduces it on the Node worker side, on the load path between the
 * archive bytes and the compartment.
 *
 * Only `mjs` and `cjs` source parsers are wrapped.  The pre-compiled
 * formats (`pre-mjs-json`, `pre-cjs-json`) carry source that has already
 * been transformed elsewhere and must not be re-transformed.  Non-source
 * parsers (`json`, `text`, `bytes`) operate on data and are untouched.
 *
 * The Rust supervisor reads the same untransformed archives and does NOT
 * apply this transform; the Rust path remains the canonical
 * untransformed-archive shape, and the wrappers here only affect the
 * Node worker's load path.
 *
 * @module
 */

import { evadeCensor } from '@endo/evasive-transform';
import { defaultParserForLanguage as allParsers } from '@endo/compartment-mapper/import-archive-all-parsers.js';
import { bytesFromText } from '@endo/bytes/from-string.js';
import { bytesToText } from '@endo/bytes/to-string.js';

/**
 * @import {
 *   AsyncParserImplementation,
 *   ParseFn,
 *   ParseResult,
 *   ParserForLanguage,
 *   ParserImplementation,
 * } from '@endo/compartment-mapper'
 */

/**
 * Wrap a synchronous source-parser implementation so that module bytes
 * pass through `evadeCensor` before being parsed.  The returned
 * implementation is async because `evadeCensor` is async; the
 * compartment-mapper's link pipeline transparently switches to the async
 * trampoline when any parser in the `parserForLanguage` map is async.
 *
 * @param {ParserImplementation} inner - The synchronous source parser to
 *   wrap (typically `parseMjs` or `parseCjs` from
 *   `@endo/compartment-mapper/import-parsers.js`).
 * @param {'module' | 'script'} sourceType - Babel source type passed to
 *   `evadeCensor`; `module` for `mjs`, `script` for `cjs`.
 * @returns {AsyncParserImplementation}
 */
const wrapWithEvadeCensor = (inner, sourceType) => {
  /** @type {import('@endo/compartment-mapper').AsyncParseFn} */
  const parse = async (
    bytes,
    specifier,
    moduleLocation,
    packageLocation,
    options = {},
  ) => {
    const source = bytesToText(bytes);
    const { code: transformedSource } = await evadeCensor(source, {
      sourceType,
      sourceUrl: moduleLocation,
    });
    const transformedBytes = bytesFromText(transformedSource);
    return /** @type {ParseResult} */ (
      /** @type {ParseFn} */ (inner.parse)(
        transformedBytes,
        specifier,
        moduleLocation,
        packageLocation,
        options,
      )
    );
  };
  return {
    parse,
    heuristicImports: inner.heuristicImports,
    synchronous: false,
  };
};

const mjsParser = /** @type {ParserImplementation} */ (allParsers.mjs);
const cjsParser = /** @type {ParserImplementation} */ (allParsers.cjs);

/**
 * A `parserForLanguage` map suitable for evaluating source-only ZIP
 * archives in a Node.js worker.  Behaves like
 * `@endo/compartment-mapper/import-archive-all-parsers.js` but with the
 * `mjs` and `cjs` source parsers wrapped to apply
 * `@endo/evasive-transform`'s censorship-evasion transform before the
 * compartment sees the source.
 *
 * @satisfies {ParserForLanguage}
 */
export const evasiveParserForLanguage = Object.freeze(
  /** @type {const} */ ({
    ...allParsers,
    mjs: wrapWithEvadeCensor(mjsParser, 'module'),
    cjs: wrapWithEvadeCensor(cjsParser, 'script'),
  }),
);
