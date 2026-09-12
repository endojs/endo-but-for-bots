// @ts-check
import { Fail } from '@endo/errors';
import harden from '@endo/harden';

/**
 * @typedef {Record<string, string | string[] | undefined>} HttpHeaders
 *
 * @typedef {object} HttpRequestDescription
 * @property {string} method
 * @property {string} path
 * @property {HttpHeaders} headers
 *
 * @typedef {object} HttpRequest
 * @property {string} method
 * @property {string} path
 * @property {HttpHeaders} headers
 * @property {string} body already decoded, and no larger than `maxBodyBytes`
 *
 * @typedef {object} HttpResponse
 * @property {number} status
 * @property {string} body
 *
 * @typedef {{ allowed: true } | { allowed: false, status: number, body: string }} HttpAdmission
 *
 * The power tells core when a request is finished (deadline, disconnect, or
 * listener close) through this signal, so core can release the resources the
 * request acquired even though its handler promise may never settle.
 *
 * @typedef {object} HttpAbortSignal
 * @property {() => boolean} aborted
 * @property {(listener: () => void) => void} onAbort
 *
 * @typedef {object} HttpListenerOptions
 * @property {number} port
 * @property {string} host
 * @property {number} maxBodyBytes
 * @property {number} maxResponseBytes
 * @property {number} maxHeaderBytes
 * @property {number} maxRequests concurrent requests before 503
 * @property {number} requestDeadlineMs
 * @property {number} keepAliveTimeoutMs
 * @property {(request: HttpRequestDescription) => HttpAdmission} admit
 *   runs before any body is read, so a denied request costs no guest work
 * @property {(request: HttpRequest, abort: HttpAbortSignal) => Promise<HttpResponse>} handle
 * @property {(error: unknown) => void} onError
 *
 * @typedef {object} HttpListener
 * @property {() => Promise<void>} close
 *
 * The transport half of an HTTP listener: socket tracking, header and
 * body limits, deadlines, and the reject responses that enforce them.
 * Core supplies only admission policy and the guest invocation, so no
 * `IncomingMessage`, `ServerResponse`, or `Server` crosses the boundary.
 *
 * @typedef {object} HttpListenerPowers
 * @property {(options: HttpListenerOptions) => Promise<HttpListener>} listen
 *
 * @param {object} host
 * @param {import('http')} host.http
 * @param {(callback: () => void, delayMs: number) => unknown} host.setTimeout
 * @param {(handle: unknown) => void} host.clearTimeout
 * @returns {HttpListenerPowers}
 */
export const makeHttpListenerPowers = ({ http, setTimeout, clearTimeout }) => {
  /** @param {HttpListenerOptions} options */
  const listen = async options => {
    const {
      port,
      host,
      maxBodyBytes,
      maxResponseBytes,
      maxHeaderBytes,
      maxRequests,
      requestDeadlineMs,
      keepAliveTimeoutMs,
      admit,
      handle,
      onError,
    } = options;
    /** @type {Set<import('net').Socket>} */
    const sockets = new Set();
    /** @type {Set<() => void>} */
    const aborts = new Set();
    let closed = false;

    /**
     * @param {import('http').ServerResponse} response
     * @param {import('http').IncomingMessage} request
     * @param {number} status
     * @param {string} body
     */
    const reject = (response, request, status, body) => {
      response.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        connection: 'close',
      });
      response.end(body);
      request.resume();
    };

    /**
     * @param {import('http').IncomingMessage} request
     * @param {import('http').ServerResponse} response
     */
    const respond = (request, response) => {
      const method = request.method ?? 'GET';
      const path = request.url ?? '/';
      const headers = /** @type {HttpHeaders} */ (
        /** @type {unknown} */ (request.headers)
      );
      const admission = admit({ method, path, headers });
      if (!admission.allowed) {
        reject(response, request, admission.status, admission.body);
        return;
      }
      if (aborts.size >= maxRequests) {
        reject(response, request, 503, 'Too many requests');
        return;
      }
      let finished = false;
      /** @type {Uint8Array[]} */
      let chunks = [];
      let length = 0;
      /** @type {Set<() => void>} */
      const abortListeners = new Set();
      /** @type {unknown} */
      let timer;
      /**
       * @param {number} [status]
       * @param {string} [body]
       */
      const finish = (status = undefined, body = '') => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        aborts.delete(abort);
        chunks = [];
        for (const listener of abortListeners) listener();
        abortListeners.clear();
        if (status !== undefined && !response.destroyed) {
          reject(response, request, status, body);
        }
      };
      const signal = harden({
        aborted: () => finished,
        onAbort: listener => {
          if (finished) listener();
          else abortListeners.add(listener);
        },
      });
      const abort = () => finish();
      timer = setTimeout(
        () => finish(504, 'Request deadline exceeded'),
        requestDeadlineMs,
      );
      aborts.add(abort);
      response.once('close', abort);
      request.once('error', abort);
      request.on('data', chunk => {
        if (finished) return;
        length += chunk.length;
        if (length > maxBodyBytes) {
          finish(413, 'Request body too large');
          return;
        }
        chunks.push(new Uint8Array(chunk));
      });
      request.once('end', () => {
        void (async () => {
          await null;
          if (finished) return;
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          chunks = [];
          let body;
          try {
            body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch (_error) {
            finish(400, 'Invalid UTF-8 body');
            return;
          }
          try {
            const result = await handle(
              { method, path, headers, body },
              signal,
            );
            if (finished) return;
            (result &&
              Number.isInteger(result.status) &&
              result.status >= 200 &&
              result.status <= 599 &&
              typeof result.body === 'string') ||
              Fail`Invalid HTTP handler response`;
            (result.body.length <= maxResponseBytes &&
              new TextEncoder().encode(result.body).length <=
                maxResponseBytes) ||
              Fail`HTTP response body too large`;
            finish(result.status, result.body);
          } catch (_error) {
            finish(500, 'Handler failed');
          }
        })();
      });
    };

    const server = http.createServer(
      { maxHeaderSize: maxHeaderBytes },
      respond,
    );
    server.headersTimeout = requestDeadlineMs;
    server.requestTimeout = requestDeadlineMs;
    server.keepAliveTimeout = keepAliveTimeoutMs;
    server.timeout = requestDeadlineMs * 2;
    server.maxHeadersCount = 100;
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (_request, socket) => socket.destroy());
    server.on('connect', (_request, socket) => socket.destroy());
    await new Promise((resolve, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, host, () => {
        server.removeListener('error', rejectListen);
        resolve(undefined);
      });
    });
    server.on('error', error => {
      if (!closed) onError(error);
    });

    return harden({
      close: async () => {
        if (closed) return;
        closed = true;
        for (const abort of [...aborts]) abort();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(() => resolve(undefined)));
      },
    });
  };

  return harden({ listen });
};
harden(makeHttpListenerPowers);
