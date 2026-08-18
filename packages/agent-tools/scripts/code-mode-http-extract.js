// @ts-check
/// <reference types="ses"/>

/**
 * HTTP code-mode declarations from `@endo/exo-http-client`'s checked
 * TypeScript source.
 *
 * Every type in the rendered declaration comes from a checked type source:
 * `HttpResponse.stream()` returns
 * `import('@endo/exo-stream').PassableBytesReader`, which the shared extractor
 * (`code-mode-type-extract.js`) follows into `@endo/exo-stream`'s own
 * `types.d.ts` along with the stream-node types it reaches. The types those
 * reach in turn outside the `@endo` namespace, and those in `@endo` packages
 * that publish no type source (`Pattern` from `@endo/patterns`, `Passable`
 * from `@endo/pass-style`), collapse to `unknown` there rather than here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  extractTsFileTextIR,
  renderDeclaration,
} from './code-mode-type-extract.js';

const HTTP_TYPES_URL = new URL(
  '../../exo-http-client/src/types.ts',
  import.meta.url,
);

/**
 * @returns {import('./code-mode-type-extract.js').GlobalTypeIR}
 */
export const buildHttpIR = () => {
  const fileName = fileURLToPath(HTTP_TYPES_URL);
  return extractTsFileTextIR({
    fileName,
    text: readFileSync(fileName, 'utf8'),
    rootType: 'HttpClient',
  });
};
harden(buildHttpIR);

/**
 * @returns {{ http: { aux: string, body: string } }}
 */
export const buildHttpTypeDeclarations = () =>
  harden({
    http: renderDeclaration(buildHttpIR(), {
      globalName: 'http',
      auxPrefix: 'Http',
    }),
  });
harden(buildHttpTypeDeclarations);
