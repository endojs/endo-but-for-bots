// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { createServer } from 'node:http';
import { isIP } from 'node:net';

/** @import { IncomingMessage } from 'node:http' */
/** @import { Socket } from 'node:net' */

const CHUNK_BYTES = 48 * 1024;
const CHUNK_TEXT = 64 * 1024;
const { atob, btoa } = globalThis;
const excludedHeaders = harden(
  new Set([
    'host',
    'connection',
    'proxy-connection',
    'proxy-authorization',
    'proxy-authenticate',
    'keep-alive',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'expect',
    'content-length',
  ]),
);

/**
 * Credential-free HTTP forward/HTTPS CONNECT proxy. Its only outbound power
 * is the bounded public-egress capability received over private pipes. The
 * trusted bind address can be a namespace-local synthetic address; it is not
 * a routing grant. The caller must prove process and namespace confinement.
 * HTTP targets use port 80; CONNECT is limited to 443. CONNECT transparently
 * carries bytes and does not inspect TLS or prove the application protocol.
 * @param {object} options
 * @param {any} options.endpoint
 * @param {string} [options.host] Trusted literal bind address, not session input.
 * @param {number} [options.port]
 * @param {number} [options.maxConnections]
 * @param {number} [options.timeoutMs]
 * @param {bigint} [options.maxUploadBytes]
 * @param {bigint} [options.maxDownloadBytes]
 */
export const makePublicEgressListener = async ({
  endpoint,
  host = '127.0.0.1',
  port = 0,
  maxConnections = 8,
  timeoutMs = 600_000,
  maxUploadBytes = 256n * 1024n ** 2n,
  maxDownloadBytes = 512n * 1024n ** 2n,
}) => {
  (isIP(host) !== 0 &&
    Number.isInteger(port) &&
    port >= 0 &&
    port <= 65_535 &&
    Number.isInteger(maxConnections) &&
    maxConnections > 0 &&
    maxConnections <= 64 &&
    Number.isInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= 600_000 &&
    typeof maxUploadBytes === 'bigint' &&
    maxUploadBytes > 0n &&
    typeof maxDownloadBytes === 'bigint' &&
    maxDownloadBytes > 0n) ||
    Fail`Invalid public proxy configuration`;
  /** @type {Set<Socket>} */
  const sockets = new Set();
  const consumed = new WeakSet();
  const cleanups = new Set();
  let disposed = false;
  let pending = 0;
  const server = createServer({
    maxHeaderSize: 8192,
    insecureHTTPParser: false,
  });
  server.maxConnections = maxConnections;
  server.headersTimeout = timeoutMs;
  server.requestTimeout = timeoutMs;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    const timer = globalThis.setTimeout(() => socket.destroy(), timeoutMs);
    socket.once('close', () => {
      globalThis.clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('checkContinue', (_request, response) => {
    response.writeHead(417, { connection: 'close' });
    response.end();
  });
  server.on('checkExpectation', (_request, response) => {
    response.writeHead(417, { connection: 'close' });
    response.end();
  });

  /**
   * @param {IncomingMessage} request
   * @param {Socket} socket
   * @param {boolean} connect
   * @param {Uint8Array} head
   */
  const handle = async (request, socket, connect, head) => {
    if (disposed || pending >= maxConnections || consumed.has(socket)) {
      socket.destroy();
      return;
    }
    consumed.add(socket);
    pending += 1;
    let stopped = false;
    let tunnel;
    let accepted = false;
    let uploaded = 0n;
    let downloaded = 0n;
    /** @type {Set<() => void>} */
    const stopWaiters = new Set();
    const close = () => {
      if (stopped) return;
      stopped = true;
      for (const stop of [...stopWaiters]) stop();
      socket.destroy();
      if (tunnel)
        void E(tunnel)
          .close()
          .catch(() => {});
    };
    cleanups.add(close);
    socket.once('close', close);
    const bounded = operation =>
      new Promise((resolve, reject) => {
        const stop = () => {
          stopWaiters.delete(stop);
          reject(Error('Public proxy client closed'));
        };
        stopWaiters.add(stop);
        Promise.resolve(operation).then(
          value => {
            stopWaiters.delete(stop);
            resolve(value);
          },
          error => {
            stopWaiters.delete(stop);
            reject(error);
          },
        );
        if (stopped) stop();
      });
    const writeClient = async bytes =>
      bounded(
        new Promise((resolve, reject) => {
          socket.write(bytes, error =>
            error ? reject(error) : resolve(undefined),
          );
        }),
      );
    /** @param {Uint8Array} bytes */
    const writeRemote = async bytes => {
      uploaded += BigInt(bytes.byteLength);
      uploaded <= maxUploadBytes || Fail`Public proxy upload limit exceeded`;
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        // eslint-disable-next-line no-await-in-loop
        await bounded(E(tunnel).write(btoa(String.fromCharCode(...chunk))));
      }
    };
    try {
      const url = new URL(
        connect ? `http://${request.url}` : request.url || '',
      );
      (!url.username &&
        !url.password &&
        !url.hash &&
        url.protocol === 'http:' &&
        (connect
          ? url.port === '443' && url.pathname === '/' && !url.search
          : !url.port || url.port === '80')) ||
        Fail`Invalid public proxy target`;
      const hostname = url.hostname.startsWith('[')
        ? url.hostname.slice(1, -1)
        : url.hostname;
      const opening = E(endpoint).open(hostname, connect ? 443 : 80);
      // A client may disappear while host DNS is still resolving. Never leave
      // a subsequently acquired socket without an owner in that case.
      void opening.then(
        value => {
          if (stopped)
            void E(value)
              .close()
              .catch(() => {});
        },
        () => {},
      );
      tunnel = await bounded(opening);
      !stopped || Fail`Public proxy client closed`;
      if (connect) {
        await writeClient(
          new TextEncoder().encode(
            'HTTP/1.1 200 Connection Established\r\n\r\n',
          ),
        );
        accepted = true;
      } else {
        // Rebuild framing instead of forwarding proxy headers. URL authority
        // owns Host; connection-nominated and hop-by-hop headers are removed.
        const skip = new Set(excludedHeaders);
        for (const name of (request.headers.connection || '').split(','))
          skip.add(name.trim().toLowerCase());
        const headers = [
          `${request.method} ${url.pathname}${url.search} HTTP/1.1`,
          `Host: ${url.host}`,
          'Connection: close',
          'Transfer-Encoding: chunked',
        ];
        for (const [name, value] of Object.entries(request.headers)) {
          if (!skip.has(name) && value !== undefined) {
            for (const item of Array.isArray(value) ? value : [value])
              headers.push(`${name}: ${item}`);
          }
        }
        await writeRemote(
          new TextEncoder().encode(`${headers.join('\r\n')}\r\n\r\n`),
        );
      }
      const upload = async () => {
        if (connect && head.byteLength) await writeRemote(head);
        for await (const chunk of connect ? socket : request) {
          if (!connect)
            await writeRemote(
              new TextEncoder().encode(`${chunk.byteLength.toString(16)}\r\n`),
            );
          await writeRemote(chunk);
          if (!connect) await writeRemote(new TextEncoder().encode('\r\n'));
        }
        if (!connect) await writeRemote(new TextEncoder().encode('0\r\n\r\n'));
        await bounded(E(tunnel).end());
      };
      const download = async () => {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const text = await bounded(E(tunnel).read());
          if (text === null) return;
          (typeof text === 'string' &&
            text.length > 0 &&
            text.length <= CHUNK_TEXT &&
            text.length % 4 === 0 &&
            /^[A-Za-z0-9+/=]+$/.test(text)) ||
            Fail`Invalid public proxy response chunk`;
          const raw = atob(text);
          btoa(raw) === text || Fail`Invalid public proxy response encoding`;
          downloaded += BigInt(raw.length);
          downloaded <= maxDownloadBytes ||
            Fail`Public proxy download limit exceeded`;
          accepted = true;
          // eslint-disable-next-line no-await-in-loop
          await writeClient(Uint8Array.from(raw, char => char.charCodeAt(0)));
        }
      };
      const uploading = upload();
      // A server can answer before reading a whole request. Let the response
      // complete without waiting forever for a client upload; close both ends.
      void uploading.catch(close);
      await download();
      await new Promise(resolve => socket.end(() => resolve(undefined)));
    } catch (_error) {
      // Never reflect DNS, upstream responses, request values or credentials
      // into diagnostics. The caller sees a generic refusal.
      if (!stopped && !accepted && !socket.destroyed) {
        await writeClient(
          new TextEncoder().encode(
            'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          ),
        ).catch(() => {});
      }
    } finally {
      close();
      socket.off('close', close);
      cleanups.delete(close);
      pending -= 1;
    }
  };
  server.on('request', request => {
    void handle(request, request.socket, false, new Uint8Array()).catch(() =>
      request.socket.destroy(),
    );
  });
  server.on('connect', (request, socket, head) => {
    void handle(request, /** @type {Socket} */ (socket), true, head).catch(() =>
      socket.destroy(),
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  server.on('error', () => {
    for (const close of cleanups) close();
  });
  const address = server.address();
  if (!address || typeof address !== 'object')
    throw Error('Public proxy did not bind');
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  let disposing;
  const dispose = () => {
    if (disposing) return disposing;
    disposed = true;
    for (const close of cleanups) close();
    for (const socket of sockets) socket.destroy();
    disposing = new Promise(resolve => server.close(() => resolve(undefined)));
    return disposing;
  };
  return harden({ url, dispose });
};
harden(makePublicEgressListener);
