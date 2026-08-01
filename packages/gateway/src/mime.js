// @ts-check

/**
 * @file MIME-type inference for the gateway's static content-tree
 * serving (`designs/gateway-package.md` § Feature 2, step 5).
 *
 * A weblet formula may carry a `mimeTypes` map of per-extension
 * overrides; for any extension the override does not name, the
 * gateway infers the type from this built-in table. The table is
 * deliberately small: it covers the file kinds a static weblet
 * actually ships (markup, scripts, styles, fonts, common image
 * formats) and falls back to `application/octet-stream` for
 * anything unknown, which is the safe "download, do not execute as
 * markup" default.
 */

/**
 * The fallback content type for an extension the table and the
 * weblet's overrides do not name. `application/octet-stream` tells
 * the browser to treat the bytes as opaque rather than sniffing
 * them as markup.
 */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
harden(DEFAULT_CONTENT_TYPE);

/**
 * Built-in extension to content-type map. Keys are lowercase
 * extensions without a leading dot. Text formats carry an explicit
 * `charset=utf-8` because the gateway serves UTF-8 content trees.
 */
export const DEFAULT_MIME_TYPES = harden({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/vnd.microsoft.icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
});

/**
 * Extract the lowercase extension (without the leading dot) of a
 * file name. Returns the empty string when the name has no
 * extension. A leading dot (a dotfile such as `.well-known`) is not
 * treated as an extension boundary.
 *
 * @param {string} fileName
 * @returns {string}
 */
export const extensionOf = fileName => {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) {
    // No dot, or a leading-dot dotfile: no extension.
    return '';
  }
  return fileName.slice(dot + 1).toLowerCase();
};
harden(extensionOf);

/**
 * Infer a content type for a file name, honoring a weblet's
 * per-extension overrides first and falling back to the built-in
 * table and finally to {@link DEFAULT_CONTENT_TYPE}.
 *
 * @param {string} fileName the last path segment (the file name)
 * @param {Record<string, string>} [overrides] the weblet formula's
 *   `mimeTypes`, keyed by lowercase extension without a leading dot
 * @returns {string}
 */
export const inferContentType = (fileName, overrides = {}) => {
  const ext = extensionOf(fileName);
  if (ext === '') {
    return DEFAULT_CONTENT_TYPE;
  }
  const override = overrides[ext];
  if (typeof override === 'string' && override !== '') {
    return override;
  }
  const known =
    DEFAULT_MIME_TYPES[/** @type {keyof typeof DEFAULT_MIME_TYPES} */ (ext)];
  return known ?? DEFAULT_CONTENT_TYPE;
};
harden(inferContentType);
