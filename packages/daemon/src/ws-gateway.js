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
import { makeAddressChecker } from './cidr.js';

const defaultContentType = 'application/octet-stream';

const contentTypes = harden({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
});

/**
 * @param {string} filePath
 * @returns {string}
 */
const contentTypeFor = filePath => {
  return contentTypes[path.extname(filePath)] || defaultContentType;
};
harden(contentTypeFor);

/**
 * @param {string} chatDist
 * @returns {string | undefined}
 */
const chatRootFrom = chatDist => {
  if (chatDist === '') {
    return undefined;
  }
  try {
    const stat = fs.statSync(chatDist);
    if (stat.isDirectory()) {
      return chatDist;
    }
    if (stat.isFile()) {
      return path.dirname(chatDist);
    }
  } catch {
    // Fall through: the plain gateway response is better than crashing the
    // daemon if an operator points ENDO_CHAT_DIST at a missing path.
  }
  return undefined;
};
harden(chatRootFrom);

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string | undefined} chatRoot
 */
const serveChat = (req, res, chatRoot) => {
  if (chatRoot === undefined) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Endo Gateway');
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  /** @type {string} */
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  const relativePath =
    decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/u, '');
  const resolvedRoot = path.resolve(chatRoot);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (
    candidate !== resolvedRoot &&
    !candidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const fallback = path.join(resolvedRoot, 'index.html');
  const filePath = fs.existsSync(candidate)
    ? candidate
    : path.extname(candidate) === ''
      ? fallback
      : '';

  if (filePath === '' || !fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
  fs.createReadStream(filePath)
    .on('error', error => {
      console.error(`[Gateway] Failed to serve ${filePath}:`, error.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal server error');
    })
    .pipe(res);
};
harden(serveChat);

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
 * @param {string} [opts.chatDist]
 * @param {(addr: string) => boolean} [opts.allowAddress]
 * @returns {{ started: Promise<string>, stopped: Promise<void> }}
 */
export const startWsGateway = ({
  endoBootstrap,
  host,
  port,
  cancelled,
  chatDist = '',
  allowAddress = makeAddressChecker(),
}) => {
  const fetchLimiter = makeRateLimiter(1000);
  const gatewayP = E(endoBootstrap).gateway();
  const chatRoot = chatRootFrom(chatDist);

  /** @type {Set<Promise<void>>} */
  const connectionClosedPromises = new Set();

  const connectionNumbers = (function* generateNumbers() {
    let n = 0;
    for (;;) {
      yield n;
      n += 1;
    }
  })();

  const server = http.createServer((req, res) => {
    serveChat(req, res, chatRoot);
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket, req) => {
    const remoteAddress = req.socket.remoteAddress || '';
    if (!allowAddress(remoteAddress)) {
      socket.close(1008, 'Only local connections allowed');
      console.error(`[Gateway] Rejected connection from ${remoteAddress}`);
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
