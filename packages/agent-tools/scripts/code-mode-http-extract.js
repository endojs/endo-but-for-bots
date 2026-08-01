// @ts-check
/// <reference types="ses"/>

/**
 * HTTP code-mode declarations from `@endo/exo-http-client`'s checked
 * TypeScript source.  The source's `HttpResponse.stream()` references the
 * generic `@endo/exo-stream` type, so this extractor supplies the small
 * passable-reader surface that is actually usable in a prompt declaration.
 * It must never silently become `unknown`.
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

const PASSABLE_BYTES_READER = harden({
  name: 'PassableBytesReader',
  text: `{
  streamBase64: (
    synPromise: HttpStreamInputNode | Promise<HttpStreamInputNode>,
  ) => Promise<HttpStreamOutputNode>;
  readReturnPattern: () => unknown | undefined;
}`,
});

const PASSABLE_BYTES_READER_NODES = harden([
  {
    name: 'HttpStreamInputNode',
    text: `{
  value: unknown;
  promise: Promise<HttpStreamInputNode> | null;
}`,
  },
  {
    name: 'HttpStreamOutputNode',
    text: `{
  value: string | undefined;
  promise: Promise<HttpStreamOutputNode> | null;
}`,
  },
]);

/**
 * @returns {import('./code-mode-type-extract.js').GlobalTypeIR}
 */
export const buildHttpIR = () => {
  const fileName = fileURLToPath(HTTP_TYPES_URL);
  const extracted = extractTsFileTextIR({
    fileName,
    text: readFileSync(fileName, 'utf8'),
    rootType: 'HttpClient',
  });
  const httpResponse = extracted.auxTypes.find(
    type => type.name === 'HttpResponse',
  );
  if (httpResponse === undefined) {
    throw new Error('HttpClient must reach HttpResponse');
  }
  if (!httpResponse.text.includes('stream: () => unknown;')) {
    throw new Error(
      'HttpResponse.stream extraction changed; update the explicit bytes-reader contract',
    );
  }
  return harden({
    ...extracted,
    auxTypes: [
      ...extracted.auxTypes
        .filter(type => type.name !== 'PassableBytesReader')
        .map(type =>
          type.name === 'HttpResponse'
            ? harden({
                ...type,
                text: type.text.replace(
                  'stream: () => unknown;',
                  'stream: () => PassableBytesReader;',
                ),
              })
            : type,
        ),
      ...PASSABLE_BYTES_READER_NODES,
      PASSABLE_BYTES_READER,
    ],
  });
};
harden(buildHttpIR);

/**
 * @returns {{ http: { aux: string, body: string } }}
 */
export const buildHttpTypeDeclarations = () =>
  harden({ http: renderDeclaration(buildHttpIR(), { auxPrefix: 'Http' }) });
harden(buildHttpTypeDeclarations);
