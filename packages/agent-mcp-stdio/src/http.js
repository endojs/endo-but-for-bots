// @ts-check
/// <reference types="ses"/>

// The streamable-HTTP MCP termination (designs/endo-gateway-mcp.md): one
// listener that serves many guests, each selected per request by its bearer.
//
// `Authorization: Bearer <formula id>` names the guest. Knowledge of the
// formula identifier is the authorization; the bearer is the same 64-hex
// formula number the stdio server takes from `ENDO_GUEST_FORMULA_ID`
// (optionally `:<64-hex node>`). The bearer resolves through `resolveGuest`,
// so a formula that is not a guest facet (a host, in particular) is refused
// exactly as a formula that does not exist, and the reply does not tell them
// apart. Failed authentications advance a per-client rate limiter of this
// listener's own, built from the daemon gateway's `makeRateLimiter`. The
// client is the socket's peer address, or, behind a trusted reverse proxy,
// the address the proxy appended to `X-Forwarded-For`.
//
// The transport is stateless (design § Decision 8): `POST /mcp` carries one
// JSON-RPC message and is answered with `application/json`; no
// `Mcp-Session-Id` is issued, and `GET /mcp` (the server-initiated event
// stream) is refused with 405, which the 2025-06-18 transport permits.
//
// The listener speaks plaintext HTTP. Confidentiality of the bearer on the
// wire is the job of the TLS-terminating reverse proxy in front of it.

import { Buffer } from 'node:buffer';
import http from 'node:http';

import { makeRateLimiter } from '@endo/daemon/rate-limiter.js';

import { makeAgentTools } from './agent-interface.js';
import {
  isFormulaIdentifier,
  makeGuestMcpServer,
  resolveGuest,
} from './server.js';

/** @import { ToolDeclaration } from '@endo/agent-tools/adapters/mcp.js' */
/** @import { IncomingMessage, ServerResponse } from 'node:http' */
/** @import { DaemonConnection } from './types.js' */

/** The well-known path of the MCP endpoint. */
export const MCP_HTTP_PATH = '/mcp';

/** The default listening port: the daemon gateway's 8920, plus one. */
export const MCP_HTTP_DEFAULT_PORT = 8921;

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_PENALTY_MS = 1000;

/**
 * Extract the bearer from an `Authorization` header, or `undefined` when the
 * header is absent or is not a well-formed formula identifier.
 *
 * @param {string | undefined} header
 * @returns {string | undefined}
 */
export const parseBearer = header => {
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  if (match === null || !isFormulaIdentifier(match[1])) {
    return undefined;
  }
  return match[1];
};
harden(parseBearer);

/**
 * @param {ServerResponse} response
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {string} [body]
 */
const send = (response, status, headers, body) => {
  response.writeHead(status, headers);
  response.end(body);
};

/**
 * @param {ServerResponse} response
 * @param {number} status
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
const sendError = (response, status, message, headers = {}) =>
  send(
    response,
    status,
    { 'Content-Type': 'application/json', ...headers },
    JSON.stringify({ error: message }),
  );

/**
 * Read a request body as text, refusing one longer than `maxBytes`.
 *
 * @param {IncomingMessage} request
 * @param {number} maxBytes
 * @returns {Promise<string | undefined>} `undefined` when over the limit.
 */
const readBody = async (request, maxBytes) => {
  /** @type {Buffer[]} */
  const chunks = [];
  let length = 0;
  // Leaving the loop early would destroy the socket before the 413 is
  // written, so an oversize body is read to its end and discarded.
  for await (const chunk of request) {
    length += chunk.length;
    if (length <= maxBytes) {
      chunks.push(chunk);
    }
  }
  if (length > maxBytes) {
    return undefined;
  }
  return Buffer.concat(chunks).toString('utf-8');
};

/**
 * The rate-limiter key for a request: the socket's peer address, or, when the
 * listener trusts a reverse proxy, the last `X-Forwarded-For` entry (the one
 * that proxy appended; a client can forge every entry before it).
 *
 * @param {IncomingMessage} request
 * @param {boolean} trustProxy
 * @returns {string}
 */
const clientAddress = (request, trustProxy) => {
  const peer = request.socket.remoteAddress || '';
  if (!trustProxy) {
    return peer;
  }
  const header = request.headers['x-forwarded-for'];
  const forwarded = Array.isArray(header) ? header.join(',') : header;
  const last = (forwarded || '').split(',').pop()?.trim();
  return last || peer;
};

/**
 * Make the `/mcp` request handler. It answers only requests for `path` and
 * returns `false` for any other, so a caller can mount it beside other routes.
 *
 * @param {object} options
 * @param {(formulaId: string) => Promise<{ handleLine: (line: string) => Promise<string | undefined> }>} options.resolveServer
 *   - the MCP server bound to the guest the bearer names; rejects when the
 *   bearer names no guest.
 * @param {{ check: (key: string) => number, recordFailure: (key: string) => void }} [options.rateLimiter]
 * @param {ReadonlyArray<string>} [options.allowedOrigins] - the `Origin`
 *   values accepted from a browser. A request with any other `Origin` is
 *   refused (the transport's DNS-rebinding guard); a request with none, as
 *   from every non-browser MCP client, is accepted.
 * @param {boolean} [options.trustProxy] - key the rate limiter on the last
 *   `X-Forwarded-For` entry rather than the socket's peer. Set it only when
 *   every request arrives through a reverse proxy that appends that header;
 *   without it, every client behind one proxy shares one limiter key.
 * @param {string} [options.path]
 * @param {number} [options.maxBodyBytes]
 * @returns {(request: IncomingMessage, response: ServerResponse) => Promise<boolean>}
 */
export const makeMcpHttpHandler = ({
  resolveServer,
  rateLimiter = makeRateLimiter(DEFAULT_PENALTY_MS),
  allowedOrigins = [],
  trustProxy = false,
  path = MCP_HTTP_PATH,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}) => {
  const origins = new Set(allowedOrigins);
  return async (request, response) => {
    const { pathname } = new URL(request.url || '/', 'http://gateway.invalid');
    if (pathname !== path) {
      return false;
    }
    const { origin } = request.headers;
    if (origin !== undefined && !origins.has(origin)) {
      sendError(response, 403, 'Origin not allowed');
      return true;
    }
    if (request.method !== 'POST') {
      sendError(response, 405, 'Method not allowed', { Allow: 'POST' });
      return true;
    }

    const address = clientAddress(request, trustProxy);
    const retryIn = rateLimiter.check(address);
    if (retryIn > 0) {
      sendError(response, 429, 'Too many failed authentications', {
        'Retry-After': String(Math.ceil(retryIn / 1000)),
      });
      return true;
    }
    const unauthorized = () => {
      rateLimiter.recordFailure(address);
      // A malformed bearer, an unknown formula, and a formula that is not a
      // guest are deliberately indistinguishable.
      sendError(response, 401, 'Unauthorized', {
        'WWW-Authenticate': 'Bearer',
      });
    };
    const formulaId = parseBearer(request.headers.authorization);
    if (formulaId === undefined) {
      unauthorized();
      return true;
    }
    let server;
    try {
      server = await resolveServer(formulaId);
    } catch {
      unauthorized();
      return true;
    }

    const contentType = request.headers['content-type'] || '';
    if (!/^application\/json\s*(;|$)/i.test(contentType)) {
      sendError(response, 415, 'Content-Type must be application/json');
      return true;
    }
    const tooLarge = () =>
      sendError(response, 413, 'Request body too large', {
        Connection: 'close',
      });
    const declared = Number(request.headers['content-length']);
    if (declared > maxBodyBytes) {
      // Drain what the client still sends, so it reads the 413 rather than
      // a reset.
      request.resume();
      tooLarge();
      return true;
    }
    const body = await readBody(request, maxBodyBytes);
    if (body === undefined) {
      tooLarge();
      return true;
    }

    const reply = await server.handleLine(body);
    if (reply === undefined) {
      // A notification or a response: accepted, no body (the 2025-06-18
      // MCP streamable-HTTP transport, § Sending Messages to the Server).
      send(response, 202, {});
      return true;
    }
    // A reply that names no request (a parse error or an invalid request) is
    // a client error; every other reply, including a JSON-RPC error for a
    // valid request, is a successful exchange.
    const { id } = JSON.parse(reply);
    send(
      response,
      id === null ? 400 : 200,
      { 'Content-Type': 'application/json' },
      reply,
    );
    return true;
  };
};
harden(makeMcpHttpHandler);

/**
 * Bind guests to MCP servers on demand, once per formula identifier. A failed
 * resolution is not remembered, so a guest created later is served.
 *
 * @param {object} options
 * @param {DaemonConnection} options.connection
 * @param {string} options.version
 * @param {ReadonlyArray<ToolDeclaration<any>>} [options.tools]
 */
export const makeGuestServerResolver = ({
  connection,
  version,
  tools = makeAgentTools(),
}) => {
  /** @type {Map<string, Promise<ReturnType<typeof makeGuestMcpServer>>>} */
  const servers = new Map();
  /** @param {string} formulaId */
  return formulaId => {
    let serverP = servers.get(formulaId);
    if (serverP === undefined) {
      serverP = resolveGuest(connection.host, formulaId).then(guest =>
        makeGuestMcpServer({
          guest,
          version,
          tools,
          connectionClosed: connection.closed,
        }),
      );
      servers.set(formulaId, serverP);
      serverP.catch(() => servers.delete(formulaId));
    }
    return serverP;
  };
};
harden(makeGuestServerResolver);

/**
 * Listen for streamable-HTTP MCP requests at `/mcp`, serving every guest
 * reachable from `connection.host`.
 *
 * @param {object} options
 * @param {DaemonConnection} options.connection
 * @param {string} options.version
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {ReadonlyArray<string>} [options.allowedOrigins]
 * @param {boolean} [options.trustProxy]
 * @param {ReadonlyArray<ToolDeclaration<any>>} [options.tools]
 * @param {number} [options.penaltyMs]
 * @returns {{ started: Promise<string>, close: () => Promise<void> }}
 */
export const startMcpHttpGateway = ({
  connection,
  version,
  host = '127.0.0.1',
  port = MCP_HTTP_DEFAULT_PORT,
  allowedOrigins,
  trustProxy,
  tools,
  penaltyMs = DEFAULT_PENALTY_MS,
}) => {
  const handle = makeMcpHttpHandler({
    resolveServer: makeGuestServerResolver({ connection, version, tools }),
    rateLimiter: makeRateLimiter(penaltyMs),
    allowedOrigins,
    trustProxy,
  });
  const server = http.createServer((request, response) => {
    handle(request, response).then(
      handled => {
        if (!handled) {
          sendError(response, 404, 'Not found');
        }
      },
      () => {
        if (!response.headersSent) {
          sendError(response, 500, 'Internal error');
        } else {
          response.destroy();
        }
      },
    );
  });
  const started = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(Error('expected listener to be assigned a port'));
        return;
      }
      const hostPart = host.includes(':') ? `[${host}]` : host;
      resolve(`http://${hostPart}:${address.port}${MCP_HTTP_PATH}`);
    });
  });
  const close = () =>
    new Promise(resolve => {
      server.close(() => resolve(undefined));
      server.closeAllConnections();
    });
  return harden({ started, close });
};
harden(startMcpHttpGateway);

/**
 * @param {string} host
 */
const isLoopback = host =>
  host === 'localhost' || host === '::1' || /^127\./.test(host);

/**
 * Process entry for `endo-mcp-http`. Configuration is by environment:
 * `ENDO_MCP_HTTP_HOST` (default `127.0.0.1`), `ENDO_MCP_HTTP_PORT` (default
 * 8921), `ENDO_MCP_HTTP_ALLOWED_ORIGINS` (comma-separated), and
 * `ENDO_MCP_HTTP_TRUST_PROXY` (`1` to key the rate limiter on the last
 * `X-Forwarded-For` entry).
 *
 * @param {object} powers
 * @param {Record<string, string | undefined>} powers.env
 * @param {() => Promise<DaemonConnection>} powers.connect
 * @param {(line: string) => void} powers.log - diagnostics, one per line.
 * @param {string} powers.version
 * @param {Promise<unknown>} [powers.stop] - settles to request shutdown.
 * @returns {Promise<number>} the exit code.
 */
export const mainHttp = async ({ env, connect, log, version, stop }) => {
  const host = env.ENDO_MCP_HTTP_HOST || '127.0.0.1';
  const port =
    env.ENDO_MCP_HTTP_PORT === undefined || env.ENDO_MCP_HTTP_PORT === ''
      ? MCP_HTTP_DEFAULT_PORT
      : Number(env.ENDO_MCP_HTTP_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    log(`ENDO_MCP_HTTP_PORT must be a port number`);
    return 2;
  }
  const allowedOrigins = (env.ENDO_MCP_HTTP_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(origin => origin !== '');
  const trustProxy = env.ENDO_MCP_HTTP_TRUST_PROXY === '1';

  /** @type {DaemonConnection} */
  let connection;
  try {
    connection = await connect();
  } catch (error) {
    log(
      `Cannot open an Endo daemon session: ${/** @type {Error} */ (error)?.message ?? error}`,
    );
    return 1;
  }
  const gateway = startMcpHttpGateway({
    connection,
    version,
    host,
    port,
    allowedOrigins,
    trustProxy,
  });
  let url;
  try {
    url = await gateway.started;
  } catch (error) {
    connection.close();
    log(`Cannot listen: ${/** @type {Error} */ (error)?.message ?? error}`);
    return 1;
  }
  log(`Endo MCP gateway listening on ${url}`);
  if (!isLoopback(host)) {
    log(
      `WARNING: ${MCP_HTTP_PATH} is plaintext HTTP and every bearer is an agent's full authority; serve it only behind a TLS-terminating reverse proxy`,
    );
  }
  const dropped = Promise.resolve(connection.closed).then(
    () => 1,
    () => 1,
  );
  const stopped =
    stop === undefined ? new Promise(() => {}) : stop.then(() => 0);
  const code = await Promise.race([dropped, stopped]);
  if (code !== 0) {
    log('Endo daemon connection closed');
  }
  await gateway.close();
  connection.close();
  return code;
};
harden(mainHttp);
