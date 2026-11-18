// @ts-check
/**
 * The gateway's static files (M3 W3.1; m3-interfaces.md 4.1; R6-8).
 *
 * - `GET`/`HEAD /assets/<name>`: a file of `assetsDir` (W3.4's build output,
 *   content-hashed names), its content type and
 *   `Cache-Control: public, max-age=31536000, immutable`; a name that is not
 *   a plain file name, the shell itself, or a missing file: 404
 *   `gatewayTexts.notFound`.
 * - Every other `GET`/`HEAD`: the app shell `assetsDir/index.html` with
 *   `Cache-Control: no-cache`; while it is not built: 503
 *   `gatewayTexts.uiNotBuilt`.
 * - Any other method: not answered (the server answers 405).
 *
 * Assets are immutable by name, so each is read once and kept in memory
 * (bounded by the build's own output); the shell is re-read when its mtime
 * changes, so a rebuild needs no restart. Paths are never decoded: a name
 * with `%`, `/` or a leading dot cannot match, so nothing outside
 * `assetsDir` is reachable.
 *
 * Node only (adapter).
 */
import { Buffer } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { gatewayTexts } from './contract-m3.js';

const ASSET_PREFIX = '/assets/';
const SHELL = 'index.html';
const ASSET_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/;

/** Content types by extension; anything else is `application/octet-stream`. */
export const contentTypes = harden({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
});

/** @param {string} name */
const typeOf = name =>
  /** @type {Record<string, string>} */ (contentTypes)[
    extname(name).toLowerCase()
  ] ?? 'application/octet-stream';

/**
 * @param {import('node:http').ServerResponse} response
 * @param {string} csp
 */
const securityHeaders = (response, csp) => {
  response.setHeader('Content-Security-Policy', csp);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
};

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {Uint8Array | string} body
 */
const answer = (request, response, status, headers, body) => {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  response.writeHead(status, {
    ...headers,
    'Content-Length': String(bytes.byteLength),
  });
  response.end(request.method === 'HEAD' ? undefined : bytes);
};

/**
 * @param {object} options
 * @param {string} options.assetsDir
 * @param {string} options.csp the `Content-Security-Policy` header value
 * @returns {(request: import('node:http').IncomingMessage,
 *   response: import('node:http').ServerResponse) => boolean}
 */
export const makeStaticHandler = ({ assetsDir, csp }) => {
  /** @type {Map<string, { type: string, bytes: Buffer }>} */
  const assets = new Map();
  /** @type {{ mtimeMs: number, bytes: Buffer } | undefined} */
  let shell;

  /** @param {string} path */
  const fileInfo = path => stat(path).catch(() => undefined);

  /** @param {string} name */
  const loadAsset = async name => {
    const kept = assets.get(name);
    if (kept) return kept;
    const path = join(assetsDir, name);
    const info = await fileInfo(path);
    if (info === undefined || !info.isFile()) return undefined;
    const bytes = await readFile(path).catch(() => undefined);
    if (bytes === undefined) return undefined;
    const entry = harden({ type: typeOf(name), bytes });
    assets.set(name, entry);
    return entry;
  };

  const loadShell = async () => {
    const path = join(assetsDir, SHELL);
    const info = await fileInfo(path);
    if (info === undefined || !info.isFile()) {
      shell = undefined;
      return undefined;
    }
    if (shell === undefined || shell.mtimeMs !== info.mtimeMs) {
      const bytes = await readFile(path).catch(() => undefined);
      if (bytes === undefined) return undefined;
      shell = { mtimeMs: info.mtimeMs, bytes };
    }
    return shell;
  };

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} path
   */
  const serve = async (request, response, path) => {
    await null;
    const text = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (path.startsWith(ASSET_PREFIX)) {
      const name = path.slice(ASSET_PREFIX.length);
      const wanted = ASSET_NAME.test(name) && name !== SHELL;
      const entry = await (wanted ? loadAsset(name) : undefined);
      if (entry === undefined) {
        answer(request, response, 404, text, gatewayTexts.notFound);
        return;
      }
      answer(
        request,
        response,
        200,
        {
          'Content-Type': entry.type,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
        entry.bytes,
      );
      return;
    }
    const page = await loadShell();
    if (page === undefined) {
      answer(
        request,
        response,
        503,
        { ...text, 'Cache-Control': 'no-store' },
        gatewayTexts.uiNotBuilt,
      );
      return;
    }
    answer(
      request,
      response,
      200,
      { 'Content-Type': contentTypes['.html'], 'Cache-Control': 'no-cache' },
      page.bytes,
    );
  };

  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    securityHeaders(response, csp);
    const url = request.url ?? '/';
    const query = url.indexOf('?');
    const path = query < 0 ? url : url.slice(0, query);
    serve(request, response, path).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    return true;
  };
};
harden(makeStaticHandler);
