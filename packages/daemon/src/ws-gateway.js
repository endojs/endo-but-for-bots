// @ts-check

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { E } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';
import { makePipe, mapWriter, mapReader } from '@endo/stream';

/** @import { FarRef } from '@endo/eventual-send' */
/** @import { EndoBootstrap } from './types.js' */

import {
  makeMessageCapTP,
  messageToBytes,
  bytesToMessage,
} from './connection.js';

const GatewayBootstrapInterface = M.interface('GatewayBootstrap', {
  fetch: M.call(M.string()).returns(M.promise()),
});
harden(GatewayBootstrapInterface);

/**
 * Per-key rate limiter. Each failed attempt delays the next allowed
 * attempt by `penaltyMs`.
 *
 * @param {number} penaltyMs
 */
const makeRateLimiter = penaltyMs => {
  /** @type {Map<string, number>} */
  const nextAllowed = new Map();
  const collectionThreshold = penaltyMs * 10;

  return harden({
    /**
     * @param {string} key
     * @returns {number} 0 if allowed, otherwise ms until allowed
     */
    check: key => {
      const now = Date.now();
      const deadline = nextAllowed.get(key);
      if (deadline !== undefined && now < deadline) {
        return deadline - now;
      }
      for (const [k, t] of nextAllowed) {
        if (now >= t + collectionThreshold) {
          nextAllowed.delete(k);
        }
      }
      return 0;
    },
    /** @param {string} key */
    recordFailure: key => {
      const now = Date.now();
      const current = nextAllowed.get(key);
      const base = current !== undefined && current > now ? current : now;
      nextAllowed.set(key, base + penaltyMs);
    },
  });
};
harden(makeRateLimiter);

/**
 * Start a WebSocket gateway that allows the Chat app (and other
 * browser clients) to reach the daemon via CapTP.
 *
 * @param {object} opts
 * @param {FarRef<EndoBootstrap> | EndoBootstrap} opts.endoBootstrap
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {Promise<never>} opts.cancelled
 * @param {((addr: string) => boolean)} [opts.addressChecker] - Optional
 *   predicate that returns true if a remote address is allowed to connect.
 *   Defaults to allowing all connections.
 * @param {string} [opts.staticDir] - Optional directory of static files
 *   to serve for HTTP requests (e.g., the Chat UI bundle).
 * @returns {{ started: Promise<string>, stopped: Promise<void> }}
 */
export const startWsGateway = ({
  endoBootstrap,
  host,
  port,
  cancelled,
  addressChecker = _addr => true,
  staticDir = undefined,
}) => {
  const fetchLimiter = makeRateLimiter(1000);
  const gatewayP = E(endoBootstrap).gateway();

  /** @type {Set<Promise<void>>} */
  const connectionClosedPromises = new Set();

  const connectionNumbers = (function* generateNumbers() {
    let n = 0;
    for (;;) {
      yield n;
      n += 1;
    }
  })();

  /** @type {Record<string, string>} */
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  const server = http.createServer((req, res) => {
    if (!staticDir) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Endo Gateway');
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    let filePath = path.join(staticDir, url.pathname);

    // Default to index.html for directory requests.
    if (filePath.endsWith('/') || filePath === staticDir) {
      filePath = path.join(filePath, 'index.html');
    }

    // Prevent path traversal: resolved path must be inside staticDir.
    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(staticDir);
    if (!resolved.startsWith(`${resolvedDir}/`) && resolved !== resolvedDir) {
      // Also allow resolvedDir/index.html
      if (!resolved.startsWith(resolvedDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    }

    const ext = path.extname(resolved);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(resolved, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          // SPA fallback: serve index.html for missing files.
          const indexPath = path.join(staticDir, 'index.html');
          fs.readFile(indexPath, (indexErr, indexData) => {
            if (indexErr) {
              res.writeHead(404);
              res.end('Not Found');
            } else {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(indexData);
            }
          });
        } else {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket, req) => {
    const remoteAddress = req.socket.remoteAddress || '';

    if (!addressChecker(remoteAddress)) {
      console.warn(
        `[Gateway] Rejected connection from ${remoteAddress} (address not allowed)`,
      );
      socket.close(1008, 'Address not allowed');
      return;
    }

    const { promise: closed, resolve: close, reject: abort } = makePromiseKit();

    closed.finally(() => socket.close());

    const [reader, sink] = makePipe();

    socket.on('message', (bytes, isBinary) => {
      if (!isBinary) {
        abort(new Error('expected binary WebSocket frames'));
        return;
      }
      sink.next(bytes);
    });

    socket.on('close', () => {
      sink.return(undefined);
      close(undefined);
    });

    socket.on('error', error => {
      console.error(`[Gateway] WebSocket error:`, error.message);
      abort(error);
    });

    const writer = harden({
      /** @param {Uint8Array} bytes */
      async next(bytes) {
        socket.send(bytes, { binary: true });
        return harden({ done: false, value: undefined });
      },
      async return() {
        socket.close();
        return harden({ done: true, value: undefined });
      },
      /** @param {Error} error */
      async throw(error) {
        socket.close();
        abort(error);
        return harden({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    });

    const clientBootstrap = makeExo(
      'GatewayBootstrap',
      GatewayBootstrapInterface,
      /** @type {any} */ ({
        /** @param {string} token */
        async fetch(token) {
          const addr = remoteAddress;
          const retryIn = fetchLimiter.check(addr);
          if (retryIn > 0) {
            throw new Error(`Rate limit exceeded, try in ${retryIn}ms`);
          }
          try {
            return await E(gatewayP).provide(token);
          } catch (e) {
            fetchLimiter.recordFailure(addr);
            throw e;
          }
        },
      }),
    );

    const { value: connectionNumber } = connectionNumbers.next();
    const messageWriter = mapWriter(writer, messageToBytes);
    const messageReader = mapReader(reader, bytesToMessage);
    const { closed: capTpClosed, getBootstrap } = makeMessageCapTP(
      'Gateway',
      messageWriter,
      messageReader,
      cancelled,
      clientBootstrap,
    );
    const remoteBootstrap = getBootstrap();
    E.sendOnly(remoteBootstrap).ping();

    console.log(
      `[Gateway] Connection ${connectionNumber} from ${remoteAddress}`,
    );

    const connectionClosed = Promise.race([closed.then(() => {}), capTpClosed]);
    connectionClosedPromises.add(connectionClosed);
    connectionClosed.finally(() => {
      connectionClosedPromises.delete(connectionClosed);
      console.log(`[Gateway] Closed connection ${connectionNumber}`);
    });
  });

  /** @type {import('@endo/promise-kit').PromiseKit<string>} */
  const {
    promise: started,
    resolve: resolveStarted,
    reject: rejectStarted,
  } = makePromiseKit();

  server.on('error', rejectStarted);
  server.listen(port, host, () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      rejectStarted(new Error('expected listener to be assigned a port'));
    } else {
      const addr = `http://${host}:${address.port}`;
      console.log(`Endo gateway listening on ${addr}`);
      resolveStarted(addr);
    }
  });

  cancelled.catch(() => {
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
    server.close();
  });

  const stopped = cancelled
    .catch(() => Promise.all(Array.from(connectionClosedPromises)))
    .then(() => {});

  return { started, stopped };
};
harden(startWsGateway);
