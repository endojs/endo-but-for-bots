// @ts-check
/** @import { HttpHeaders, HttpListenerOptions, HttpListenerPowers } from '../http-listeners.js' */
import { Fail } from '@endo/errors';
import harden from '@endo/harden';

/**
 * Node's `http` server, holding the socket bookkeeping, header and body
 * limits, deadlines, and the reject responses that enforce them.
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
      // The cap and the deadline are applied before admission, not after,
      // because admission may be asynchronous — a guest can hold it — and an
      // unadmitted request that is neither counted nor timed is a connection
      // anyone can open and nobody will close.
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

      /**
       * Body listeners attach only once the request is admitted. An
       * `IncomingMessage` is paused until something reads it, so the bytes
       * wait in the socket while the decision is outstanding, and a refusal
       * drains them without ever assembling them.
       */
      const readBody = () => {
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

      void (async () => {
        let admission;
        try {
          admission = await admit({ method, path, headers });
        } catch (_error) {
          finish(500, 'Admission failed');
          return;
        }
        if (finished) return;
        if (!admission.allowed) {
          finish(admission.status, admission.body);
          return;
        }
        readBody();
      })();
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
