// @ts-check
/**
 * Minimal extension → MIME type lookup for the static asset server.
 *
 * Intentionally small: the asset server only needs to label the
 * handful of file types a typical web bundle ships. Unknown
 * extensions fall back to `application/octet-stream`, which is the
 * safe default — browsers download rather than execute it.
 */

const TEXT = 'charset=utf-8';

/**
 * Map of lower-case file extension (no leading dot) to MIME type.
 */
const byExtension = harden({
  html: `text/html; ${TEXT}`,
  htm: `text/html; ${TEXT}`,
  css: `text/css; ${TEXT}`,
  js: `text/javascript; ${TEXT}`,
  mjs: `text/javascript; ${TEXT}`,
  cjs: `text/javascript; ${TEXT}`,
  json: `application/json; ${TEXT}`,
  map: `application/json; ${TEXT}`,
  txt: `text/plain; ${TEXT}`,
  md: `text/markdown; ${TEXT}`,
  xml: `application/xml; ${TEXT}`,
  svg: `image/svg+xml; ${TEXT}`,
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  zip: 'application/zip',
  webmanifest: 'application/manifest+json',
});

/**
 * Resolve the MIME `Content-Type` for a file name from its
 * extension.
 *
 * @param {string} name  the file's last path segment (or full name)
 * @returns {string}
 */
export const contentTypeForName = name => {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return 'application/octet-stream';
  }
  const ext = name.slice(dot + 1).toLowerCase();
  return byExtension[ext] || 'application/octet-stream';
};
harden(contentTypeForName);
