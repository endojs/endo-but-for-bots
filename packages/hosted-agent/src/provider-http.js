// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { createServer } from 'node:http';

/** @import { Socket } from 'node:net' */
/** @import { IncomingMessage, ServerResponse } from 'node:http' */

/**
 * @typedef {object} ProviderHttpDiagnostic
 * @property {'headers' | 'length' | 'upload' | 'endpoint' | 'response' | 'stream'} stage
 * @property {{ method: boolean, path: boolean, host: boolean, origin: boolean, cookie: boolean, authorization: boolean, encoding: boolean, contentType: boolean }} [checks]
 */

/**
 * Credential-free HTTP adapter for a single inference capability. Run this
 * inside the operator's isolated broker namespace, with the endpoint supplied
 * over a private capability transport. Loopback binding alone is NOT process
 * isolation and this module issues no confinement attestation.
 *
 * Each connection serves one request. Deadlines include uploads, upstream
 * inference, and slow consumers. An unresponsive endpoint retains its admission
 * slot after disconnect, so repeated timeouts cannot accumulate unbounded work.
 * No request headers or upstream errors cross the capability boundary.
 *
 * @param {object} options
 * @param {any} options.endpoint - ProviderInferenceLease, never a SecretBlob
 * @param {number} [options.port] - TCP port (0 asks the OS to allocate one)
 * @param {number} options.maxConnections - Bound by Node's socket-count API
 * @param {bigint} options.maxRequestBytes
 * @param {bigint} options.maxResponseBytes
 * @param {number} options.timeoutMs - Signed 32-bit host timer duration
 * @param {(diagnostic: ProviderHttpDiagnostic) => void | Promise<void>} [options.onDiagnostic] Host-only fixed metadata; never request values.
 */
export const makeProviderHttpListener = async ({
  endpoint,
  port = 0,
  maxConnections,
  maxRequestBytes,
  maxResponseBytes,
  timeoutMs,
  onDiagnostic = () => {},
}) => {
  (Number.isInteger(port) && port >= 0 && port <= 65_535) || Fail`Invalid port`;
  (Number.isInteger(maxConnections) &&
    maxConnections > 0 &&
    maxConnections <= 0xffff_ffff) ||
    Fail`Invalid connection limit`;
  (typeof maxRequestBytes === 'bigint' &&
    maxRequestBytes > 0n &&
    typeof maxResponseBytes === 'bigint' &&
    maxResponseBytes > 0n) ||
    Fail`Invalid HTTP byte limits`;
  (Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 0x7fff_ffff) ||
    Fail`Invalid HTTP deadline`;
  /** @type {Set<Socket>} */
  const sockets = new Set();
  /** @type {Set<() => void>} */
  const pending = new Set();
  let disposed = false;
  let authority = '';
  const server = createServer({
    maxHeaderSize: 8192,
    insecureHTTPParser: false,
  });
  server.maxConnections = maxConnections;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = timeoutMs;
  server.requestTimeout = timeoutMs;
  server.on('connection', socket => {
    sockets.add(socket);
    // Absolute deadline, including incomplete headers, not an idle timer.
    const timer = globalThis.setTimeout(() => socket.destroy(), timeoutMs);
    socket.once('close', () => {
      globalThis.clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  // Do not implicitly accept Expect: 100-continue before admission.
  server.on('checkContinue', (_request, response) => {
    response.writeHead(417, { connection: 'close' });
    response.end();
  });

  /**
   * @param {IncomingMessage} request
   * @param {ServerResponse} response
   */
  const handle = async (request, response) => {
    if (disposed || pending.size >= maxConnections) {
      response.writeHead(503, { connection: 'close' });
      response.end();
      return;
    }
    let stopped = false;
    let reader;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (reader)
        void E(reader)
          .return()
          .catch(() => {});
    };
    pending.add(stop);
    response.once('close', stop);
    /** @type {ProviderHttpDiagnostic['stage']} */
    let stage = 'headers';
    const checks = harden({
      method: request.method === 'POST',
      path: ['/v1/responses', '/v1/messages', '/v1/chat/completions'].includes(
        request.url || '',
      ),
      host: request.headers.host === authority,
      origin: request.headers.origin === undefined,
      cookie: request.headers.cookie === undefined,
      authorization: request.headers.authorization === undefined,
      encoding: request.headers['content-encoding'] === undefined,
      contentType: /^application\/json(?:;\s*charset=utf-8)?$/i.test(
        request.headers['content-type'] || '',
      ),
    });
    try {
      Object.values(checks).every(Boolean) || Fail`Invalid inference request`;
      stage = 'length';
      const length = request.headers['content-length'];
      length === undefined ||
        (/^\d+$/.test(length) && BigInt(length) <= maxRequestBytes) ||
        Fail`Request too large`;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      stage = 'upload';
      let bytes = 0n;
      const parts = [];
      for await (const chunk of request) {
        bytes += BigInt(chunk.byteLength);
        bytes <= maxRequestBytes || Fail`Request too large`;
        parts.push(decoder.decode(chunk, { stream: true }));
      }
      parts.push(decoder.decode());
      !stopped || Fail`HTTP consumer disconnected`;
      stage = 'endpoint';
      const result = await E(endpoint).requestStream(
        harden({
          method: 'POST',
          path: request.url,
          body: parts.join(''),
        }),
      );
      reader = result.reader;
      stage = 'response';
      if (stopped) {
        void E(reader)
          .return()
          .catch(() => {});
        return;
      }
      /** @type {unknown} */
      const status = result.status;
      if (typeof status !== 'number') throw Fail`Invalid inference status`;
      (Number.isInteger(status) &&
        status >= 200 &&
        status < 300 &&
        ['application/json', 'text/event-stream'].includes(
          result.contentType,
        )) ||
        Fail`Invalid inference response`;
      response.writeHead(status, {
        'content-type': result.contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // An interrupted response must not look like a successful EOF body.
        'transfer-encoding': 'chunked',
        connection: 'close',
      });
      response.flushHeaders();
      stage = 'stream';
      let responseBytes = 0n;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const chunk = await E(reader).next();
        !stopped || Fail`HTTP consumer disconnected`;
        if (chunk.done) break;
        typeof chunk.value === 'string' || Fail`Invalid inference chunk`;
        responseBytes += BigInt(new TextEncoder().encode(chunk.value).length);
        responseBytes <= maxResponseBytes || Fail`Response too large`;
        if (!response.write(chunk.value)) {
          // Stop pulling upstream while TCP applies backpressure.
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              response.off('drain', drain);
              response.off('close', close);
            };
            const drain = () => {
              cleanup();
              resolve(undefined);
            };
            const close = () => {
              cleanup();
              reject(Error('HTTP consumer disconnected'));
            };
            response.once('drain', drain);
            response.once('close', close);
          });
        }
      }
      response.end();
    } catch (_error) {
      try {
        void Promise.resolve(
          onDiagnostic(
            harden({ stage, ...(stage === 'headers' ? { checks } : {}) }),
          ),
        ).catch(() => {});
      } catch (_diagnosticError) {
        // Host diagnostics must not change HTTP settlement or echo errors.
      }
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, {
          connection: 'close',
          'content-type': 'text/plain',
        });
        response.end('Inference request failed');
      } else response.destroy();
    } finally {
      stop();
      pending.delete(stop);
    }
  };
  server.on('request', (request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw Fail`Listener address unavailable`;
  }
  authority = `127.0.0.1:${address.port}`;
  let disposal;
  return harden({
    url: `http://${authority}`,
    dispose: () => {
      if (disposal) return disposal;
      disposed = true;
      for (const stop of pending) stop();
      disposal = new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve(undefined)));
        for (const socket of sockets) socket.destroy();
      });
      return disposal;
    },
  });
};
harden(makeProviderHttpListener);
