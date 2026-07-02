// @ts-check

/**
 * @file HTTP listener wire-up for the gateway (design Phase 11a).
 *
 * Phases 4 / 5 / 6 / 9 / 10 each landed a semantic-core handler
 * (`OcapnWebSocketHandler`, `GitHttpHandler`, the X-Forwarded
 * parser, the Familiar publisher, the `AppsNameHub`) and noted
 * that the HTTP listener wiring would land in a follow-on PR.
 * This module is that follow-on. It is the platform-bound seam
 * that turns the gateway from a library of handlers into a
 * runnable service.
 *
 * The listener:
 *
 *   - Binds a `node:http` server on the gateway's configured
 *     `BindAddress` (the gateway never terminates TLS itself; see
 *     Feature 9 and Design Decision 5).
 *   - On each request, runs `parseForwardedRequest` under the
 *     gateway's `trustedProxyCidrs` configuration to recover the
 *     original client IP and scheme. The recovered shape is
 *     threaded into each handler's args so a downstream daemon
 *     implementation can key per-caller rate limits or audit logs
 *     by the original client IP.
 *   - Routes by URL path:
 *       `/git/<rest>` -> `GitHttpHandler.handleRequest`.
 *       Anything else -> 404 (after the `AppsNameHub` host-
 *       header lookup, see below).
 *   - On every non-`/git` request, consults the `AppsNameHub` by
 *     the request's `Host` header. When a weblet formula is
 *     bound, the listener surfaces a `501 Not Implemented` whose
 *     body carries the resolved formula identifier. The content
 *     fetch from the daemon's CAS is out of scope for Phase 11a
 *     (it requires a daemon-side `UserDaemon.fetchContentTree`
 *     wire that does not exist yet); Phase 11b lands the static-
 *     CAS resolution path. The `501` carries a discoverable shape
 *     so a daemon-side prototype can observe routing without
 *     pretending to serve content yet.
 *   - On `upgrade`, when the URL path matches the OCapN WS
 *     endpoint, delegates to an embedder-supplied `wsUpgrade`
 *     adapter that returns a `{ reader, writer }` byte-stream
 *     pair the `OcapnWebSocketHandler.handleConnection` exo
 *     consumes. The Node-side adapter using the `ws` package
 *     lives in `./node-ws-upgrade.js` (a separate module so the
 *     listener itself does not pull `ws` into the gateway's
 *     dependency graph).
 *
 * ### Why a separate module
 *
 * The portable core of `@endo/gateway` (the handlers, the
 * config parser, the X-Forwarded parser) never imports
 * `node:http`. This module does, so embedders running the gateway
 * under a non-Node host (Endor, a browser-side bundle) can
 * substitute their own listener. The `@endo/platform/http`
 * factoring named in `designs/gateway-package.md` § Planned
 * factoring is a forward-pointer; today's listener targets Node
 * directly and the platform-agnostic interface lands in a
 * follow-on.
 *
 * ### Fail-closed posture
 *
 * The listener's `start()` rejects on a bind failure; the
 * gateway's outer `start()` propagates the rejection so a
 * supervisor's restart loop discovers the failure. The
 * `whenBound` promise resolves to the `AddressInfo` only after
 * the OS has assigned a port (relevant for the `0.0.0.0:0`
 * case); a publisher (Feature 5) reads the resolved port from
 * this promise rather than the configured one.
 *
 * `stop()` closes the server (refusing new connections) and
 * awaits in-flight requests to drain. Concurrent `start()` and
 * `stop()` calls are idempotent.
 */

/* global Buffer */

import { createServer } from 'node:http';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';
import { Far } from '@endo/far';

import { isGitHttpPath, GIT_HTTP_PATH_PREFIX } from './git-http.js';
import {
  OCAPN_WEBSOCKET_PATH,
  OCAPN_WEBSOCKET_LEGACY_PATH,
} from './ocapn-ws.js';
import { parseForwardedRequest } from './x-forwarded.js';
import { fetchWebletResponse } from './weblet-fetch.js';

/** @import { Server, IncomingMessage, ServerResponse } from 'node:http' */
/** @import { Socket } from 'node:net' */
/** @import { Reader, Writer } from '@endo/stream' */
/**
 * @import {
 *   BindAddress,
 *   GitHttpHandler,
 *   OcapnWebSocketHandler,
 *   AppsNameHub,
 *   ForwardedRequest,
 *   HttpListener,
 *   HttpListenerBoundAddress,
 *   ServeWeblet,
 *   WsUpgradeAdapter,
 *   WsUpgradeContext,
 * } from './types.d.ts'
 */

const HttpListenerInterface = M.interface('HttpListener', {
  start: M.call().returns(M.promise()),
  stop: M.call().returns(M.promise()),
  whenBound: M.call().returns(M.promise()),
  getBoundAddress: M.call().returns(M.any()),
});
harden(HttpListenerInterface);

/**
 * Render a `BindAddress` to the `(host, port)` pair `server.listen`
 * accepts. `0.0.0.0` and `::` are wildcard binds; the hostname
 * variant is delegated to Node's resolver.
 *
 * @param {BindAddress} bind
 * @returns {{ host: string, port: number }}
 */
const renderListenArgs = bind => {
  if (bind === null || typeof bind !== 'object') {
    throw makeError(X`renderListenArgs requires a BindAddress, got ${q(bind)}`);
  }
  return { host: bind.host, port: bind.port };
};

/**
 * Read a Node `IncomingMessage` body into a single `Uint8Array`.
 * The Git smart-HTTP handler takes a buffered body; the gateway
 * does not stream because the daemon-side repo capability
 * receives the request body verbatim and the protocol does not
 * benefit from streaming on the gateway side (the daemon's
 * `git-http-backend` reads its stdin synchronously).
 *
 * @param {IncomingMessage} req
 * @returns {Promise<Uint8Array>}
 */
const readRequestBody = req =>
  new Promise((resolve, reject) => {
    /** @type {Array<Buffer>} */
    const chunks = [];
    req.on('data', chunk => {
      chunks.push(/** @type {Buffer} */ (chunk));
    });
    req.on('end', () => {
      const total = Buffer.concat(chunks);
      resolve(new Uint8Array(total.buffer, total.byteOffset, total.byteLength));
    });
    req.on('error', reject);
  });

/**
 * Extract the raw `(name, value)` pairs from an `IncomingMessage`.
 * Mirrors the shape the `GitHttpHandler` consumes.
 *
 * @param {IncomingMessage} req
 * @returns {ReadonlyArray<readonly [string, string]>}
 */
const collectHeaders = req => {
  /** @type {Array<[string, string]>} */
  const headers = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
  }
  return harden(
    headers.map(([k, v]) => /** @type {[string, string]} */ ([k, v])),
  );
};

/**
 * Strip the optional `:<port>` suffix from a `Host` header value
 * and lowercase the host portion. The `AppsNameHub`'s
 * `normalizeVirtualHostName` already lowercases internally, but
 * the listener strips the port first so a `Host: chat.example:8080`
 * matches a binding registered under `chat.example`.
 *
 * @param {string | undefined} hostHeader
 * @returns {string | undefined}
 */
const hostHeaderName = hostHeader => {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) {
    return undefined;
  }
  // Strip an IPv6 bracket form `[::1]:port` first.
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']');
    if (close < 0) return undefined;
    return hostHeader.slice(1, close);
  }
  const colon = hostHeader.lastIndexOf(':');
  if (colon < 0) return hostHeader;
  return hostHeader.slice(0, colon);
};

/**
 * Render a plain-text response (used for 404 / 501 / 500 paths).
 *
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} body
 */
const writePlain = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(body);
};

/**
 * Build a Far-tagged Writer over a Node WebSocket-style sink. The
 * `ws` adapter and a test stub both produce a `{ send, close, on }`
 * shape; we keep the shape here for symmetry with how
 * `node-crypto-powers.js` and `node-familiar-publish-powers.js`
 * sit alongside their portable cores.
 *
 * The listener does not import `ws` directly; this helper is for
 * the embedder-supplied adapter to construct the writer half. We
 * export it so the Node-side adapter can use it without
 * re-implementing the Far-wrap.
 *
 * @param {object} sink
 * @param {(bytes: Uint8Array) => void} sink.send
 * @param {() => void} sink.close
 * @returns {Writer<Uint8Array>}
 */
export const makeWsWriter = sink => {
  if (sink === null || typeof sink !== 'object') {
    throw makeError(X`makeWsWriter expects a { send, close } sink`);
  }
  if (typeof sink.send !== 'function' || typeof sink.close !== 'function') {
    throw makeError(X`makeWsWriter sink must have send and close functions`);
  }
  let closed = false;
  return /** @type {Writer<Uint8Array>} */ (
    /** @type {unknown} */ (
      Far('GatewayWsWriter', {
        /** @param {Uint8Array} bytes */
        next: async bytes => {
          if (closed) {
            return harden({ done: true, value: undefined });
          }
          if (!(bytes instanceof Uint8Array)) {
            throw makeError(
              X`WsWriter.next expects a Uint8Array, got ${q(typeof bytes)}`,
            );
          }
          sink.send(bytes);
          return harden({ done: false, value: undefined });
        },
        return: async () => {
          if (!closed) {
            closed = true;
            sink.close();
          }
          return harden({ done: true, value: undefined });
        },
        /** @param {Error} err */
        throw: async err => {
          if (!closed) {
            closed = true;
            sink.close();
          }
          throw err;
        },
      })
    )
  );
};
harden(makeWsWriter);

/**
 * @typedef {object} HttpListenerDeps Inputs to {@link makeHttpListener}.
 * @property {BindAddress} bindAddress The gateway's resolved
 *   `BindAddress`. Defaults are applied upstream; the listener
 *   does not consult the env.
 * @property {AppsNameHub} apps The gateway's virtual-host name
 *   hub. The listener consults `apps.has(host)` / `apps.lookup(host)`
 *   on every non-`/git` request.
 * @property {GitHttpHandler} [gitHttpHandler] The Git smart-HTTP
 *   handler (Feature 3). When omitted, `/git/...` requests return
 *   a 404; this matches the `gitHttp` feature toggle's off shape.
 * @property {OcapnWebSocketHandler} [ocapnHandler] The OCapN-WS
 *   handler (Feature 8). When omitted, every `upgrade` request
 *   ends with the socket destroyed; this matches the
 *   `ocapnWebSocket` toggle off shape.
 * @property {WsUpgradeAdapter} [wsUpgrade] The embedder-supplied
 *   adapter that converts a raw `(request, socket, head)`
 *   upgrade event into a `{ reader, writer }` byte-stream pair
 *   the `OcapnWebSocketHandler` consumes. Required when
 *   `ocapnHandler` is supplied; otherwise upgrade requests cannot
 *   be served. The Node-side adapter using the `ws` package
 *   lives at `./node-ws-upgrade.js`.
 * @property {ServeWeblet} [serveWeblet] Phase 11b: the
 *   embedder-supplied weblet-content adapter the listener calls
 *   per Host-header-matched HTTP request. When omitted, the
 *   listener surfaces a 501 carrying `X-Endo-Weblet-Formula` so
 *   the Phase-11a host-header routing posture stays observable
 *   until a daemon-side adapter lands.
 * @property {ReadonlyArray<string>} [trustedProxyCidrs] Feature 9
 *   CIDR allowlist. Defaults to empty (no proxy trusted).
 * @property {number} [maxProxyHops] Feature 9 hop budget.
 *   Defaults to 1.
 * @property {(message: string) => void} [logWarning] Diagnostic
 *   sink. The listener falls back to `console.error` when
 *   omitted.
 */

/**
 * Create the gateway's HTTP listener exo.
 *
 * @param {HttpListenerDeps} deps
 * @returns {HttpListener}
 */
export const makeHttpListener = ({
  bindAddress,
  apps,
  gitHttpHandler,
  ocapnHandler,
  wsUpgrade,
  serveWeblet,
  trustedProxyCidrs = harden([]),
  maxProxyHops = 1,
  logWarning,
}) => {
  if (bindAddress === undefined || bindAddress === null) {
    throw makeError(X`makeHttpListener requires bindAddress`);
  }
  if (apps === undefined || apps === null) {
    throw makeError(X`makeHttpListener requires apps (an AppsNameHub)`);
  }
  if (ocapnHandler !== undefined && typeof wsUpgrade !== 'function') {
    throw makeError(
      X`makeHttpListener: ocapnHandler requires a wsUpgrade adapter (see ./node-ws-upgrade.js)`,
    );
  }
  if (!Array.isArray(trustedProxyCidrs)) {
    throw makeError(
      X`makeHttpListener: trustedProxyCidrs must be an array, got ${q(typeof trustedProxyCidrs)}`,
    );
  }
  if (
    typeof maxProxyHops !== 'number' ||
    !Number.isInteger(maxProxyHops) ||
    maxProxyHops < 1
  ) {
    throw makeError(
      X`makeHttpListener: maxProxyHops must be a positive integer, got ${q(maxProxyHops)}`,
    );
  }
  const frozenCidrs = harden([...trustedProxyCidrs]);

  /** @type {Server | undefined} */
  let server;
  /** @type {'unstarted' | 'starting' | 'started' | 'stopping' | 'stopped'} */
  let lifecycle = 'unstarted';
  /** @type {Promise<HttpListenerBoundAddress> | undefined} */
  let boundPromise;
  /** @type {((value: HttpListenerBoundAddress) => void) | undefined} */
  let boundResolve;
  /** @type {((reason: unknown) => void) | undefined} */
  let boundReject;
  /** @type {HttpListenerBoundAddress | undefined} */
  let boundAddress;
  /** @type {Set<Promise<void>>} */
  const inflight = new Set();

  const warn = message => {
    if (typeof logWarning === 'function') {
      logWarning(message);
    } else {
      console.error(message);
    }
  };

  /**
   * Compute the parsed-forwarded shape for the request. The
   * X-Forwarded parser is total; we always run it so handlers
   * downstream see a consistent shape.
   *
   * @param {IncomingMessage} req
   * @returns {ForwardedRequest}
   */
  const forwardedFor = req => {
    const headers = collectHeaders(req);
    const peerAddress = req.socket.remoteAddress ?? '';
    return parseForwardedRequest({
      headers,
      peerAddress,
      trustedCidrs: frozenCidrs,
      maxHops: maxProxyHops,
    });
  };

  /**
   * Dispatch a `/git/...` request to the configured handler. The
   * handler is total: it returns a `GitHttpResponse` even on
   * error paths.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {URL} url
   * @returns {Promise<void>}
   */
  const handleGit = async (req, res, url) => {
    if (gitHttpHandler === undefined) {
      // gitHttp toggle is off; a 404 matches the disabled-feature
      // posture (the route is simply not served).
      writePlain(res, 404, 'Not Found\n');
      return;
    }
    const body = await readRequestBody(req);
    const headers = collectHeaders(req);
    const peerAddress = req.socket.remoteAddress ?? '';
    const request = harden({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
      headers,
      body,
      peerAddress,
    });
    const response = await gitHttpHandler.handleRequest(request);
    res.statusCode = response.status;
    for (const [name, value] of response.headers) {
      res.setHeader(name, value);
    }
    res.end(
      Buffer.from(
        response.body.buffer,
        response.body.byteOffset,
        response.body.byteLength,
      ),
    );
  };

  /**
   * Consult the `AppsNameHub` for the request's Host header. On a
   * hit, dispatch into the Phase-11b weblet-fetch path when a
   * `serveWeblet` power is configured; otherwise fall back to the
   * Phase-11a 501 placeholder carrying the resolved formula
   * identifier. On a miss, fall through to a 404.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {URL} url
   * @param {ForwardedRequest} forwarded
   * @returns {Promise<void>}
   */
  const handleApps = async (req, res, url, forwarded) => {
    const hostHeader = req.headers.host;
    const host = hostHeaderName(
      Array.isArray(hostHeader) ? hostHeader[0] : hostHeader,
    );
    if (host === undefined) {
      writePlain(res, 404, `Not Found: ${url.pathname}\n`);
      return;
    }
    let bound = false;
    try {
      bound = await apps.has(host);
    } catch (e) {
      warn(
        `[Gateway] apps.has(${q(host)}) threw: ${/** @type {Error} */ (e).message}`,
      );
      writePlain(res, 500, 'Internal Server Error\n');
      return;
    }
    if (!bound) {
      writePlain(res, 404, `Not Found: ${url.pathname}\n`);
      return;
    }
    /** @type {string} */
    let formulaId;
    try {
      formulaId = await apps.lookup(host);
    } catch (e) {
      warn(
        `[Gateway] apps.lookup(${q(host)}) threw: ${/** @type {Error} */ (e).message}`,
      );
      writePlain(res, 500, 'Internal Server Error\n');
      return;
    }
    if (serveWeblet === undefined) {
      // Phase-11a fallback posture. Embedders that have not wired
      // a daemon-side adapter still observe routing via the
      // X-Endo-Weblet-Formula header.
      res.statusCode = 501;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('x-endo-weblet-formula', formulaId);
      res.end(
        `Weblet content fetch not yet implemented (host=${host}, formula=${formulaId})\n`,
      );
      return;
    }
    const ifNoneMatchRaw = req.headers['if-none-match'];
    const ifNoneMatch = Array.isArray(ifNoneMatchRaw)
      ? ifNoneMatchRaw[0]
      : ifNoneMatchRaw;
    const response = await fetchWebletResponse({
      webletFormulaId: formulaId,
      pathSuffix: url.pathname,
      ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
      forwarded,
      serveWeblet,
      logWarning: warn,
    });
    res.statusCode = response.status;
    res.setHeader('x-endo-weblet-formula', formulaId);
    for (const [name, value] of response.headers) {
      res.setHeader(name, value);
    }
    if (response.body !== undefined) {
      // Pump the reader's chunks to the response. The adapter's
      // contract is total over its body iterator; an in-flight
      // throw is surfaced as a destroy() so the client sees the
      // connection drop rather than a partial body the gateway
      // could not reconcile with its already-sent headers.
      try {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const next = await response.body.next();
          if (next.done) break;
          const chunk = next.value;
          if (!(chunk instanceof Uint8Array)) {
            throw makeError(
              X`serveWeblet body yielded a non-Uint8Array chunk: ${q(typeof chunk)}`,
            );
          }
          if (chunk.byteLength > 0) {
            // Skip the zero-byte chunk; some streams emit them at
            // EOF as a sentinel and Node will happily write zero
            // bytes but the chunked encoding wastes a frame.
            res.write(
              Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
            );
          }
        }
        res.end();
      } catch (e) {
        warn(
          `[Gateway] weblet body stream threw mid-response: ${/** @type {Error} */ (e).message}`,
        );
        try {
          // The headers are already sent; the cleanest signal a
          // client can interpret is a connection drop.
          res.destroy(/** @type {Error} */ (e));
        } catch (_e2) {
          // ignore
        }
      }
      return;
    }
    if (response.textBody !== undefined) {
      res.end(response.textBody);
      return;
    }
    res.end();
  };

  /**
   * Per-request entrypoint. Routes by URL path, threads the
   * X-Forwarded parse through every code path, and tracks
   * in-flight requests so `stop()` can drain.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  const onRequest = (req, res) => {
    // The forwarded parse is total and side-effect-free; we run
    // it for the debug header but do not block on it.
    const forwarded = forwardedFor(req);
    // Expose the recovered caller IP and trust state to a
    // downstream observer (the response is consumed by the same
    // process in tests; the headers are stripped from production
    // responses by the trusted proxy when present).
    res.setHeader('x-endo-caller-ip', forwarded.callerIp);
    res.setHeader('x-endo-caller-trusted', forwarded.trusted ? '1' : '0');

    /** @type {URL} */
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://gateway.invalid/');
    } catch (_e) {
      writePlain(res, 400, 'Bad Request\n');
      return;
    }

    /** @type {Promise<void>} */
    let task;
    if (isGitHttpPath(url.pathname)) {
      task = handleGit(req, res, url);
    } else if (
      url.pathname === GIT_HTTP_PATH_PREFIX ||
      url.pathname === '/git'
    ) {
      // A bare `/git` (no operation) is a 400 from the handler's
      // own validator; route to it so the handler's error path
      // owns the response shape.
      task = handleGit(req, res, url);
    } else {
      task = handleApps(req, res, url, forwarded);
    }
    /** @type {Promise<void>} */
    const tracked = task.catch(e => {
      warn(
        `[Gateway] request handler threw: ${/** @type {Error} */ (e).message}`,
      );
      try {
        if (!res.headersSent) {
          writePlain(res, 500, 'Internal Server Error\n');
        } else {
          res.end();
        }
      } catch (_e2) {
        // ignore
      }
    });
    inflight.add(tracked);
    tracked.finally(() => {
      inflight.delete(tracked);
    });
  };

  /**
   * Per-upgrade entrypoint. Routes by URL path; only the
   * OCapN-WS endpoint is recognized. Anything else closes the
   * socket cleanly (a 400 status line followed by the FIN).
   *
   * @param {IncomingMessage} req
   * @param {Socket} socket
   * @param {Buffer} head
   */
  const onUpgrade = (req, socket, head) => {
    /** @type {URL} */
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://gateway.invalid/');
    } catch (_e) {
      socket.destroy();
      return;
    }
    if (
      url.pathname !== OCAPN_WEBSOCKET_PATH &&
      url.pathname !== OCAPN_WEBSOCKET_LEGACY_PATH
    ) {
      // Politely refuse the upgrade. The 400 status line matches
      // the `ws` package's own rejection shape; a curl or browser
      // observer sees a structured failure.
      socket.write(
        'HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUpgrade path not recognized\n',
      );
      socket.destroy();
      return;
    }
    if (ocapnHandler === undefined || wsUpgrade === undefined) {
      socket.write(
        'HTTP/1.1 501 Not Implemented\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nOCapN WebSocket disabled\n',
      );
      socket.destroy();
      return;
    }
    // Hand off to the embedder-supplied adapter. The adapter is
    // expected to perform the WS handshake and yield a stream
    // pair the `OcapnWebSocketHandler` consumes.
    //
    // Deliberately do NOT `harden` the context: `request` and
    // `socket` are live Node EventEmitter instances whose
    // internal state (the `_eventsCount` counter, the `Symbol(kState)`
    // socket state) gets written on every listener add/remove
    // call. A deep harden through SES would freeze those
    // mutation surfaces and trip a `TypeError` on the first
    // `socket.on(...)` or `socket.destroy()` call inside the
    // adapter. The context is a transient capability handed to
    // the adapter; the adapter's contract is total over its
    // contents and the bot has no reason to share the object
    // graph elsewhere.
    const forwarded = forwardedFor(req);
    /** @type {WsUpgradeContext} */
    const context = { request: req, socket, head, forwarded };
    const upgradeTask = Promise.resolve()
      .then(async () => {
        const stream = await wsUpgrade(context);
        if (stream === undefined) {
          // The adapter declined (handshake failure, policy
          // reject, etc.). It is responsible for closing the
          // socket; we do not double-destroy.
          return;
        }
        await ocapnHandler.handleConnection(stream);
      })
      .catch(e => {
        warn(
          `[Gateway] WS upgrade for ${url.pathname} threw: ${/** @type {Error} */ (e).message}`,
        );
        try {
          socket.destroy();
        } catch (_e2) {
          // ignore
        }
      });
    inflight.add(upgradeTask);
    upgradeTask.finally(() => {
      inflight.delete(upgradeTask);
    });
  };

  const exo = makeExo(
    'HttpListener',
    HttpListenerInterface,
    /** @type {any} */ ({
      async start() {
        if (lifecycle === 'started') {
          // Idempotent: a second start awaits the same bind.
          await boundPromise;
          return;
        }
        if (lifecycle === 'starting') {
          await boundPromise;
          return;
        }
        if (lifecycle === 'stopped' || lifecycle === 'stopping') {
          throw makeError(X`HttpListener has been stopped and cannot restart`);
        }
        lifecycle = 'starting';
        boundPromise = new Promise((resolve, reject) => {
          boundResolve = resolve;
          boundReject = reject;
        });
        // Silence the unhandled-rejection warning in the failure
        // path; callers that care await `whenBound` and surface
        // the rejection themselves.
        boundPromise.catch(() => {});

        const listenArgs = renderListenArgs(bindAddress);
        const httpServer = createServer();
        server = httpServer;
        httpServer.on('request', onRequest);
        httpServer.on('upgrade', onUpgrade);
        httpServer.on('error', err => {
          if (lifecycle === 'starting' && boundReject !== undefined) {
            boundReject(err);
          } else {
            warn(`[Gateway] HTTP server error: ${err.message}`);
          }
        });

        await new Promise((resolve, reject) => {
          httpServer.once('listening', () => {
            const addr = httpServer.address();
            if (addr === null || typeof addr === 'string') {
              const e = makeError(
                X`HttpListener: server.address() returned an unexpected shape: ${q(addr)}`,
              );
              if (boundReject !== undefined) boundReject(e);
              reject(e);
              return;
            }
            boundAddress = harden({
              host: addr.address,
              port: addr.port,
              family: addr.family,
            });
            lifecycle = 'started';
            if (boundResolve !== undefined) {
              boundResolve(boundAddress);
            }
            resolve(undefined);
          });
          httpServer.once('error', err => {
            if (lifecycle === 'starting') {
              lifecycle = 'unstarted';
            }
            reject(err);
          });
          try {
            httpServer.listen(listenArgs.port, listenArgs.host);
          } catch (e) {
            if (boundReject !== undefined) boundReject(e);
            reject(e);
          }
        });
      },
      async stop() {
        if (lifecycle === 'unstarted' || lifecycle === 'stopped') {
          lifecycle = 'stopped';
          return;
        }
        if (lifecycle === 'stopping') {
          // Concurrent stop; await the original.
          return;
        }
        lifecycle = 'stopping';
        const httpServer = server;
        if (httpServer === undefined) {
          lifecycle = 'stopped';
          return;
        }
        // Close the server first so new connections are refused;
        // then await in-flight requests to drain.
        await new Promise(resolve => {
          httpServer.close(() => resolve(undefined));
        });
        // Drain any tracked tasks. We collect a snapshot so an
        // in-flight task adding to the set during drain does not
        // change the iteration target.
        const pending = Array.from(inflight);
        await Promise.allSettled(pending);
        server = undefined;
        lifecycle = 'stopped';
      },
      async whenBound() {
        if (boundPromise === undefined) {
          throw makeError(X`HttpListener.whenBound called before start()`);
        }
        return boundPromise;
      },
      getBoundAddress() {
        return boundAddress;
      },
    }),
  );
  return /** @type {HttpListener} */ (/** @type {unknown} */ (exo));
};
harden(makeHttpListener);
