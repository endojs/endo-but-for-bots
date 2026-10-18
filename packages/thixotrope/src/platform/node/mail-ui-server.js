// @ts-check
import harden from '@endo/harden';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { clearInterval, setInterval } from 'node:timers';

/** @import { MailUiService } from '../../web/mail-ui-service.js' */
/** @import { MailSnapshot } from '../../web/mail-ui.js' */

/**
 * A local browser bridge. The socket client and administration never cross
 * this boundary. Every API request needs the launch secret, and cross-origin
 * requests and rebinding hostnames are refused before touching mail.
 * @param {object} options
 * @param {MailUiService} options.mail
 * @param {Map<string, {type: string, body: string}>} options.assets
 * @param {number} [options.port]
 */
export const serveMailUi = async ({ mail, assets, port = 8123 }) => {
  const token = randomBytes(32).toString('hex');
  let origin = '';
  /** @type {Set<() => Promise<void>>} */
  const streams = new Set();
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
      if (request.method === 'GET' && url === '/api/events') {
        response.writeHead(200, {
          ...headers,
          'content-type': 'text/event-stream',
          'x-accel-buffering': 'no',
        });
        response.flushHeaders();
        let closed = false;
        let blocked = false;
        /** @type {MailSnapshot | undefined} */
        let pending;
        /** @type {Promise<() => Promise<void>> | undefined} */
        let opening;
        const close = async () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          streams.delete(close);
          response.end();
          try {
            await (
              await opening
            )?.();
          } catch (_error) {
            /* Failed setup has already released its subscriptions. */
          }
        };
        const flush = () => {
          if (closed || blocked || pending === undefined) return;
          const state = pending;
          pending = undefined;
          blocked = !response.write(`data: ${JSON.stringify(state)}\n\n`);
        };
        response.on('drain', () => {
          blocked = false;
          flush();
        });
        response.once('close', () => {
          void close();
        });
        // Keep intermediaries from timing out idle streams. This carries no
        // state and performs no reads: state arrives only from subscriptions.
        const heartbeat = setInterval(() => {
          if (!closed && !blocked) blocked = !response.write(': keepalive\n\n');
        }, 20_000);
        streams.add(close);
        opening = mail.subscribe(
          state => {
            pending = state;
            flush();
          },
          error => {
            if (!closed)
              response.write(
                `event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`,
              );
            void close();
          },
        );
        try {
          await opening;
        } catch (error) {
          if (!closed)
            response.write(
              `event: error\ndata: ${JSON.stringify({ error: /** @type {Error} */ (error).message })}\n\n`,
            );
          void close();
        }
      } else if (request.method === 'GET' && url === '/api/mail') {
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
      await Promise.all([...streams].map(close => close()));
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve(undefined))),
      );
    },
  });
};
harden(serveMailUi);
