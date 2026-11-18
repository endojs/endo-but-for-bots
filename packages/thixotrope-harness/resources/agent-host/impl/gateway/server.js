// @ts-check
/**
 * The gateway's HTTP server and WebSocket upgrade (M3 W3.1;
 * m3-interfaces.md 4.1, 4.2, 8; R2-12 with the `/ws` deviation, R2-14,
 * R6-8, R6-10, R6-11, R7-46..R7-48; W-1, W-15).
 *
 * HTTP, in this order:
 * - path over `maxPathUnits`: 414; headers over `maxHeaderBytes`: 431
 *   (Node's parser); a request target that is not a path: 400;
 * - a query string carrying a `gateway` or `agent` parameter: 400
 *   `gatewayTexts.queryConfig` (the query is never logged);
 * - an extension `http` route (exact path);
 * - `staticHandler` (assets and the app shell for every other GET/HEAD);
 * - anything else: 405.
 * Every response carries the CSP, `X-Content-Type-Options: nosniff` and
 * `Referrer-Policy: no-referrer`.
 *
 * WebSocket: an upgrade on `WS_PATH` (or an extension `upgrade` route) whose
 * `Origin` is the configured origin (`publicOrigin`, or without one
 * `http://127.0.0.1:<port>` / `http://localhost:<port>`); another Origin:
 * 403, another path: 404; over `maxConnections` in all or
 * `connectionsPerAddress` from one client address: 503 before the upgrade.
 *
 * The WebSocket protocol (RFC 6455, server side) is implemented here rather
 * than with the `ws` package, which this package does not depend on (H6 is
 * W3.4's request): no extensions, no subprotocol; client frames must be
 * masked; binary frames only, a text frame closes with
 * `closeCodes.protocol`; a message over `wsMessageBytes` closes with 1009;
 * pings are answered. A slow reader that lets more than `sendBufferBytes`
 * pile up in the send buffer is closed with 1008 (bounds retained state).
 *
 * Logs (never a body, a query, a fragment or a secret): refusals with their
 * rule and status, connection open and close with the client address and
 * close code.
 *
 * Node only (adapter).
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { clearTimeout, setTimeout } from 'node:timers';

import { cspHeader } from './csp.js';
import {
  WS_PATH,
  closeCodes,
  gatewayLimits,
  gatewayTexts,
} from './protocol.js';
import { clientAddress } from './limiter.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Bytes a connection may have waiting in its send buffer before closing. */
export const sendBufferBytes = 8 * gatewayLimits.wsMessageBytes;
/** After sending a close frame, the peer has this long to close the TCP. */
const CLOSE_GRACE_MS = 1000;
const KEEPALIVE_MS = 30_000;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** RFC 6455 close codes this module sends itself. */
export const wsCloseCodes = harden({
  normal: 1000,
  protocolError: 1002,
  policy: 1008,
  tooBig: 1009,
  internal: 1011,
});

const STATUS_TEXT = harden({
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  414: 'URI Too Long',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
});

/**
 * @typedef {object} GatewaySocket what `onSocket` receives
 * @property {string} address the client address (W-8)
 * @property {(bytes: Uint8Array) => void} send one binary message; dropped
 *   once the socket is closing
 * @property {(code: number, reason?: string) => void} close
 * @property {(fn: (bytes: Buffer) => void) => void} onMessage
 * @property {(fn: (code: number, reason: string) => void) => void} onClose
 *   called once, with the code the closing side gave (1006: no close frame)
 *
 * @typedef {object} GatewayServer
 * @property {number} port
 * @property {string} origin
 * @property {(code?: number, reason?: string) => Promise<void>} close
 * @property {() => number} connections
 */

/** @param {string} text */
const originOf = text => {
  try {
    const { origin } = new URL(text);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
};

/**
 * @param {string} reason
 * @returns {Buffer} at most 123 bytes of UTF-8, cut on a character boundary
 */
const reasonBytes = reason => {
  let bytes = Buffer.from(reason, 'utf8');
  if (bytes.length <= 123) return bytes;
  let end = 123;
  // eslint-disable-next-line no-bitwise
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  bytes = bytes.subarray(0, end);
  return bytes;
};

/**
 * @param {number} opcode
 * @param {Uint8Array} payload
 */
const frameHeader = (opcode, payload) => {
  const length = payload.byteLength;
  /** @type {Buffer} */
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  // eslint-disable-next-line no-bitwise
  header[0] = 0x80 | opcode;
  return header;
};

/**
 * One accepted WebSocket over a raw socket (server side).
 *
 * @param {object} options
 * @param {import('node:stream').Duplex} options.raw
 * @param {string} options.address
 * @param {number} options.maxMessageBytes
 * @param {(code: number, reason: string) => void} options.gone
 * @returns {{ socket: GatewaySocket, receive: (data: Buffer) => void }}
 */
const makeWebSocket = ({ raw, address, maxMessageBytes, gone }) => {
  /** @type {Array<(bytes: Buffer) => void>} */
  const messageHandlers = [];
  /** @type {Array<(code: number, reason: string) => void>} */
  const closeHandlers = [];
  let closing = false;
  let finished = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let graceTimer;

  /** @type {Buffer[]} */
  let chunks = [];
  let buffered = 0;
  /** @type {Buffer[]} */
  let fragments = [];
  let fragmentBytes = 0;
  let fragmented = false;

  /** @param {number} n bytes, `buffered >= n` */
  const take = n => {
    if (n === 0) return Buffer.alloc(0);
    if (chunks[0].length < n) {
      chunks = [Buffer.concat(chunks, buffered)];
    }
    const first = chunks[0];
    const out = first.subarray(0, n);
    if (first.length === n) chunks.shift();
    else chunks[0] = first.subarray(n);
    buffered -= n;
    return out;
  };

  /**
   * @param {number} code
   * @param {string} reason
   */
  const finish = (code, reason) => {
    if (finished) return;
    finished = true;
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    gone(code, reason);
    for (const handler of closeHandlers) {
      try {
        handler(code, reason);
      } catch {
        // A close handler's failure must not stop the others.
      }
    }
  };

  /**
   * @param {number} opcode
   * @param {Uint8Array} payload
   */
  const writeFrame = (opcode, payload) => {
    raw.cork();
    raw.write(frameHeader(opcode, payload));
    if (payload.byteLength > 0) raw.write(payload);
    raw.uncork();
  };

  /**
   * @param {number} code
   * @param {string} [reason]
   */
  const close = (code, reason = '') => {
    if (closing) return;
    closing = true;
    const body = Buffer.concat([Buffer.alloc(2), reasonBytes(reason)]);
    body.writeUInt16BE(code, 0);
    if (!raw.destroyed && raw.writable) {
      writeFrame(OP_CLOSE, body);
      raw.end();
    }
    graceTimer = setTimeout(() => raw.destroy(), CLOSE_GRACE_MS);
    graceTimer.unref?.();
    finish(code, reason);
  };

  /** @param {Uint8Array} bytes */
  const send = bytes => {
    if (closing || raw.destroyed) return;
    if (bytes.byteLength > maxMessageBytes) {
      throw RangeError('message over wsMessageBytes');
    }
    writeFrame(OP_BINARY, bytes);
    if (raw.writableLength > sendBufferBytes) {
      close(wsCloseCodes.policy, 'slow consumer');
    }
  };

  /** @param {Buffer} message */
  const deliver = message => {
    for (const handler of messageHandlers) handler(message);
  };

  /** One parsed frame; false to stop parsing. */
  const parseOne = () => {
    if (buffered < 2) return false;
    const head = chunks[0].length >= 2 ? chunks[0] : Buffer.concat(chunks);
    const b0 = head[0];
    const b1 = head[1];
    // eslint-disable-next-line no-bitwise
    const fin = (b0 & 0x80) !== 0;
    // eslint-disable-next-line no-bitwise
    const rsv = b0 & 0x70;
    // eslint-disable-next-line no-bitwise
    const opcode = b0 & 0x0f;
    // eslint-disable-next-line no-bitwise
    const masked = (b1 & 0x80) !== 0;
    // eslint-disable-next-line no-bitwise
    const short = b1 & 0x7f;
    const extra = short === 126 ? 2 : short === 127 ? 8 : 0;
    const headerBytes = 2 + extra + 4;
    if (rsv !== 0 || !masked) {
      close(wsCloseCodes.protocolError, 'protocol error');
      return false;
    }
    const control = opcode >= OP_CLOSE;
    if (
      (opcode > OP_BINARY && opcode < OP_CLOSE) ||
      opcode > OP_PONG ||
      (control && (!fin || short > 125))
    ) {
      close(wsCloseCodes.protocolError, 'protocol error');
      return false;
    }
    if (buffered < headerBytes) return false;
    const whole =
      chunks[0].length >= headerBytes ? chunks[0] : Buffer.concat(chunks);
    let length = short;
    if (short === 126) length = whole.readUInt16BE(2);
    else if (short === 127) {
      const big = whole.readBigUInt64BE(2);
      length = big > BigInt(maxMessageBytes) ? Infinity : Number(big);
    }
    if (!control && fragmentBytes + length > maxMessageBytes) {
      close(wsCloseCodes.tooBig, 'message too big');
      return false;
    }
    if (buffered < headerBytes + length) return false;
    const mask = Buffer.from(take(headerBytes).subarray(2 + extra));
    // The received chunks are this socket's own: unmask in place.
    const payload = take(length);
    for (let i = 0; i < payload.length; i += 1) {
      // eslint-disable-next-line no-bitwise
      payload[i] ^= mask[i & 3];
    }
    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason =
        payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      if (!closing) {
        closing = true;
        const echo = Buffer.alloc(2);
        echo.writeUInt16BE(code === 1005 ? wsCloseCodes.normal : code, 0);
        writeFrame(OP_CLOSE, echo);
        raw.end();
        graceTimer = setTimeout(() => raw.destroy(), CLOSE_GRACE_MS);
        graceTimer.unref?.();
      }
      finish(code, reason);
      return false;
    }
    if (opcode === OP_PING) {
      if (!closing) writeFrame(OP_PONG, payload);
      return true;
    }
    if (opcode === OP_PONG) return true;
    if (opcode === OP_TEXT) {
      close(closeCodes.protocol, 'binary frames only');
      return false;
    }
    if (opcode === OP_CONTINUATION ? !fragmented : fragmented) {
      close(wsCloseCodes.protocolError, 'protocol error');
      return false;
    }
    if (fin && !fragmented) {
      deliver(payload);
      return true;
    }
    fragmented = true;
    fragments.push(payload);
    fragmentBytes += payload.length;
    if (fin) {
      const message = Buffer.concat(fragments, fragmentBytes);
      fragments = [];
      fragmentBytes = 0;
      fragmented = false;
      deliver(message);
    }
    return true;
  };

  /** @param {Buffer} data */
  const receive = data => {
    if (closing || data.length === 0) return;
    chunks.push(data);
    buffered += data.length;
    try {
      while (!closing && parseOne()) {
        // parse every complete frame
      }
    } catch {
      // A message handler's failure, or a parser defect: never the process.
      close(wsCloseCodes.internal, 'internal error');
    }
  };

  raw.on('data', receive);
  raw.on('error', () => raw.destroy());
  // The HTTP server's sockets allow half-open: a peer that ends without a
  // close frame would otherwise hold its place until the keepalive fails.
  raw.on('end', () => {
    finish(1006, '');
    raw.destroy();
  });
  raw.on('close', () => finish(1006, ''));

  const socket = harden({
    address,
    send,
    close,
    /** @param {(bytes: Buffer) => void} fn */
    onMessage: fn => {
      messageHandlers.push(fn);
    },
    /** @param {(code: number, reason: string) => void} fn */
    onClose: fn => {
      closeHandlers.push(fn);
    },
  });
  return { socket, receive };
};

/**
 * @param {object} options
 * @param {number} options.port 0: an ephemeral port
 * @param {string} [options.publicOrigin]
 * @param {string[]} [options.trustedProxies]
 * @param {import('./protocol.js').GatewayRoute[]} [options.routes]
 * @param {(request: import('node:http').IncomingMessage,
 *   response: import('node:http').ServerResponse) => boolean} options.staticHandler
 * @param {(socket: GatewaySocket) => void} options.onSocket
 * @param {(event: Record<string, unknown>) => void} [options.log]
 * @param {string} [options.csp] the header value (default `cspHeader()`)
 * @param {string} [options.host] the bind address (default loopback;
 *   tests only)
 * @param {Partial<Record<keyof typeof gatewayLimits, number>>} [options.limits]
 *   overrides (tests)
 * @returns {Promise<GatewayServer>}
 */
export const makeGatewayServer = async ({
  port,
  publicOrigin,
  trustedProxies = [],
  routes = [],
  staticHandler,
  onSocket,
  log = () => {},
  csp = cspHeader(),
  host = '127.0.0.1',
  limits: overrides = {},
}) => {
  const bounds = { ...gatewayLimits, ...overrides };
  const configuredOrigin =
    publicOrigin === undefined ? undefined : originOf(publicOrigin);
  if (publicOrigin !== undefined && configuredOrigin === undefined) {
    throw Error('publicOrigin must be an http(s) origin');
  }

  /** @type {Map<string, import('./protocol.js').GatewayRoute>} */
  const httpRoutes = new Map();
  /** @type {Map<string, import('./protocol.js').GatewayRoute>} */
  const upgradeRoutes = new Map();
  for (const route of routes) {
    const path = route?.path;
    const table =
      route?.kind === 'http'
        ? httpRoutes
        : route?.kind === 'upgrade'
          ? upgradeRoutes
          : undefined;
    const reserved =
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.length > bounds.maxPathUnits ||
      path.includes('?') ||
      path === '/' ||
      path === WS_PATH ||
      path === '/assets' ||
      path.startsWith('/assets/');
    if (
      table === undefined ||
      reserved ||
      typeof route.handle !== 'function' ||
      table.has(path)
    ) {
      log({ event: 'route-refused', kind: String(route?.kind) });
    } else {
      table.set(path, route);
    }
  }

  /** @type {Set<GatewaySocket>} */
  const sockets = new Set();
  /** @type {Map<string, number>} */
  const perAddress = new Map();
  let allowedOrigins = new Set();

  /** @param {import('node:http').ServerResponse} response */
  const securityHeaders = response => {
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
  };

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {string} body
   * @param {Record<string, string>} [headers]
   */
  const plain = (response, status, body, headers = {}) => {
    const bytes = Buffer.from(body, 'utf8');
    response.writeHead(status, {
      ...headers,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
    });
    response.end(bytes);
  };

  /**
   * A refusal on a socket that asked to upgrade (no `ServerResponse`).
   * @param {import('node:stream').Duplex} raw
   * @param {number} status
   * @param {string} body
   */
  const refuseUpgrade = (raw, status, body) => {
    const bytes = Buffer.from(body, 'utf8');
    const head = [
      `HTTP/1.1 ${status} ${/** @type {any} */ (STATUS_TEXT)[status]}`,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${bytes.length}`,
      'Cache-Control: no-store',
      `Content-Security-Policy: ${csp}`,
      'X-Content-Type-Options: nosniff',
      'Referrer-Policy: no-referrer',
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    raw.on('error', () => raw.destroy());
    raw.end(Buffer.concat([Buffer.from(head, 'latin1'), bytes]));
  };

  /**
   * Splits a request target; `undefined` path when it is not a path.
   * @param {string | undefined} target
   */
  const splitTarget = target => {
    const url = target ?? '';
    const mark = url.indexOf('?');
    const path = mark < 0 ? url : url.slice(0, mark);
    const query = mark < 0 ? undefined : url.slice(mark + 1);
    return { path: path.startsWith('/') ? path : undefined, query };
  };

  /**
   * The common refusals of a request or upgrade, as `[status, body]`.
   * @param {string | undefined} path
   * @param {string | undefined} query
   * @returns {[number, string] | undefined}
   */
  const refusalOf = (path, query) => {
    if (path !== undefined && path.length > bounds.maxPathUnits) {
      return [414, 'Path too long'];
    }
    if (path === undefined) return [400, 'Bad request target'];
    if (query !== undefined) {
      const params = new URLSearchParams(query);
      if (params.has('gateway') || params.has('agent')) {
        return [400, gatewayTexts.queryConfig];
      }
    }
    return undefined;
  };

  /** @param {import('node:http').IncomingMessage} request */
  const addressOf = request =>
    clientAddress({
      socketAddress: request.socket.remoteAddress,
      forwardedFor: request.headers['x-forwarded-for'],
      trustedProxies,
    });

  const server = createServer(
    {
      maxHeaderSize: bounds.maxHeaderBytes,
      requestTimeout: 30_000,
      headersTimeout: 10_000,
    },
    (request, response) => {
      securityHeaders(response);
      const { path, query } = splitTarget(request.url);
      const refusal = refusalOf(path, query);
      if (refusal) {
        log({ event: 'http-refused', status: refusal[0] });
        plain(response, refusal[0], refusal[1]);
        return;
      }
      const route = httpRoutes.get(/** @type {string} */ (path));
      if (route) {
        Promise.resolve()
          .then(() => route.handle(request, response))
          .catch(() => {
            log({ event: 'route-failed', kind: 'http' });
            if (!response.headersSent) plain(response, 500, 'Internal error');
            else response.destroy();
          });
        return;
      }
      if (staticHandler(request, response)) return;
      plain(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    },
  );

  server.on('clientError', (error, raw) => {
    const code = /** @type {any} */ (error).code;
    if (code === 'HPE_HEADER_OVERFLOW' && raw.writable) {
      raw.end(
        'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      log({ event: 'http-refused', status: 431 });
      return;
    }
    if (raw.writable) {
      raw.end(
        'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
    } else {
      raw.destroy();
    }
  });

  server.on('upgrade', (request, raw, head) => {
    const { path, query } = splitTarget(request.url);
    const refusal = refusalOf(path, query);
    const address = addressOf(request);
    /**
     * @param {string} rule
     * @param {number} status
     * @param {string} body
     */
    const refuse = (rule, status, body) => {
      log({ event: 'ws-refused', rule, status, address });
      refuseUpgrade(raw, status, body);
    };
    if (refusal) {
      refuse('request', refusal[0], refusal[1]);
      return;
    }
    const route = upgradeRoutes.get(/** @type {string} */ (path));
    if (path !== WS_PATH && route === undefined) {
      refuse('path', 404, gatewayTexts.notFound);
      return;
    }
    const origin = request.headers.origin;
    const given = typeof origin === 'string' ? originOf(origin) : undefined;
    if (given === undefined || !allowedOrigins.has(given)) {
      refuse('origin', 403, gatewayTexts.originRefused);
      return;
    }
    if (route) {
      Promise.resolve()
        .then(() => route.handle(request, raw, head))
        .catch(() => {
          log({ event: 'route-failed', kind: 'upgrade' });
          raw.destroy();
        });
      return;
    }
    const key = request.headers['sec-websocket-key'];
    const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
    if (
      request.method !== 'GET' ||
      upgrade !== 'websocket' ||
      request.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string' ||
      Buffer.from(key, 'base64').length !== 16
    ) {
      refuse('handshake', 400, 'Bad WebSocket handshake');
      return;
    }
    const fromAddress = perAddress.get(address) ?? 0;
    if (
      sockets.size >= bounds.maxConnections ||
      fromAddress >= bounds.connectionsPerAddress
    ) {
      refuse('connections', 503, 'Too many connections');
      return;
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    raw.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    const tcp = /** @type {import('node:net').Socket} */ (raw);
    tcp.setNoDelay?.(true);
    tcp.setKeepAlive?.(true, KEEPALIVE_MS);
    tcp.setTimeout?.(0);
    perAddress.set(address, fromAddress + 1);
    /** @type {GatewaySocket} */
    let socket;
    const made = makeWebSocket({
      raw,
      address,
      maxMessageBytes: bounds.wsMessageBytes,
      gone: code => {
        sockets.delete(socket);
        const left = (perAddress.get(address) ?? 1) - 1;
        if (left > 0) perAddress.set(address, left);
        else perAddress.delete(address);
        log({ event: 'ws-close', address, code });
      },
    });
    socket = made.socket;
    sockets.add(socket);
    log({ event: 'ws-open', address });
    try {
      onSocket(socket);
    } catch {
      log({ event: 'ws-handler-failed', address });
      socket.close(wsCloseCodes.internal, 'internal error');
      return;
    }
    if (head && head.length > 0) made.receive(head);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  const bound = /** @type {import('node:net').AddressInfo} */ (server.address())
    .port;
  allowedOrigins = new Set(
    configuredOrigin === undefined
      ? [`http://127.0.0.1:${bound}`, `http://localhost:${bound}`]
      : [configuredOrigin],
  );
  const origin = configuredOrigin ?? `http://127.0.0.1:${bound}`;

  let closed = false;
  /**
   * @param {number} [code]
   * @param {string} [reason]
   */
  const close = async (
    code = closeCodes.gatewayStopped,
    reason = gatewayTexts.gatewayStopped,
  ) => {
    if (closed) return;
    closed = true;
    const done = new Promise(resolve => server.close(() => resolve(undefined)));
    for (const socket of [...sockets]) socket.close(code, reason);
    server.closeAllConnections();
    await done;
  };

  return harden({
    port: bound,
    origin,
    close,
    connections: () => sockets.size,
  });
};
harden(makeGatewayServer);
