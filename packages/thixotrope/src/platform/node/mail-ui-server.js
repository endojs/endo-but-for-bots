// @ts-check
import harden from '@endo/harden';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

/** @import { MailUiApi } from '../../web/mail-ui.js' */

/**
 * A local browser bridge. The socket client and administration never cross
 * this boundary. Every API request needs the launch secret, and cross-origin
 * requests and rebinding hostnames are refused before touching mail.
 * @param {object} options
 * @param {MailUiApi} options.mail
 * @param {Map<string, {type: string, body: string}>} options.assets
 * @param {number} [options.port]
 */
export const serveMailUi = async ({ mail, assets, port = 8123 }) => {
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const server = createServer(async (request, response) => {
    const headers = {
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    };
    /** @param {number} status @param {string} type @param {string} body */
    const reply = (status, type, body) => {
      response.writeHead(status, { ...headers, 'content-type': type });
      response.end(body);
    };
    /** @param {number} status @param {unknown} value */
    const json = (status, value) =>
      reply(status, 'application/json', JSON.stringify(value));
    const url = request.url ?? '/';
    if (
      `http://${request.headers.host}` !== origin ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin)
    ) {
      json(403, { error: 'Origin refused' });
      request.resume();
      return;
    }
    if (!url.startsWith('/api/')) {
      const asset = assets.get(url);
      if (request.method === 'GET' && asset) reply(200, asset.type, asset.body);
      else json(404, { error: 'Not found' });
      request.resume();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      json(403, { error: 'Open the private URL printed by mail-ui' });
      request.resume();
      return;
    }
    try {
      if (request.method === 'GET' && url === '/api/mail') {
        json(200, await mail.snapshot());
      } else if (
        request.method === 'POST' &&
        (url === '/api/send' || url === '/api/adopt')
      ) {
        if (request.headers['content-type'] !== 'application/json') {
          json(415, { error: 'Expected application/json' });
          request.resume();
          return;
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 32 * 1024) {
            json(413, { error: 'Message request too large' });
            request.resume();
            return;
          }
          chunks.push(new Uint8Array(chunk));
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        let input;
        try {
          input = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          );
        } catch (_error) {
          json(400, { error: 'Invalid JSON' });
          return;
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          json(400, { error: 'Expected a message record' });
          return;
        }
        const result =
          url === '/api/adopt'
            ? await mail.adopt(input.token, input.name)
            : await mail.send(input.name, input.content);
        json(200, result);
      } else {
        json(404, { error: 'Not found' });
        request.resume();
      }
    } catch (error) {
      json(400, { error: /** @type {Error} */ (error).message });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('Expected a local TCP listener');
  origin = `http://127.0.0.1:${address.port}`;
  return harden({
    url: `${origin}/#${token}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve(undefined))),
      );
    },
  });
};
harden(serveMailUi);
