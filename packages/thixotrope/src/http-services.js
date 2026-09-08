// @ts-check
/* global setTimeout, clearTimeout */
import { E, Far } from '@endo/far';
import { Fail } from '@endo/errors';
import harden from '@endo/harden';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { makeServiceState } from './service-state.js';

/** @import { Server, IncomingMessage, ServerResponse } from 'node:http' */
/** @import { Socket } from 'node:net' */
/** @typedef {{id: string, port: number, state: 'allocated'|'preparing'|'open'|'closed', secret?: string}} Recipe */
/** @typedef {{lookup: (secret: string) => any, close: () => void | Promise<void>}} RequestClient */
/** @typedef {{server?: Server, sockets: Set<Socket>, aborts: Set<() => void>, chain: Promise<void>, status: string, error?: string}} Runtime */
const limit = 64 * 1024;
const maxRequests = 16;
const deadlineMs = 5000;
const randomId = () =>
  Array.from(randomBytes(16), byte => byte.toString(16).padStart(2, '0')).join(
    '',
  );

/**
 * Persistent HTTP listener recipes; all sockets, request clients and deadlines
 * are ephemeral. The caller owns the engine lease for this manager's lifetime.
 * Ports are explicit, loopback-only, and each allocation is a single-use lease.
 * Repeated listen rejects; inspect status after an uncertain configuration call.
 * @param {object} options
 * @param {string} options.statePath
 * @param {(handler: any, secret: string) => void} options.publish
 * @param {(secret: string) => void} options.unpublish
 * @param {() => Promise<RequestClient>} options.openClient
 */
export const makeHttpServices = ({
  statePath,
  publish,
  unpublish,
  openClient,
}) => {
  const storage = makeServiceState(join(statePath, 'http-services.json'));
  /** @type {{version: number, listeners: Recipe[]}} */
  let state = storage.read() ?? { version: 1, listeners: [] };
  (state.version === 1 && Array.isArray(state.listeners)) ||
    Fail`Invalid HTTP service state`;
  const ids = new Set();
  for (const recipe of state.listeners) {
    (recipe &&
      /^[0-9a-f]{32}$/.test(recipe.id) &&
      !ids.has(recipe.id) &&
      Number.isInteger(recipe.port) &&
      recipe.port >= 1024 &&
      recipe.port <= 65_535 &&
      ['allocated', 'preparing', 'open', 'closed'].includes(recipe.state) &&
      (recipe.secret === undefined || /^[0-9a-f]{32}$/.test(recipe.secret)) &&
      (!['preparing', 'open'].includes(recipe.state) ||
        recipe.secret !== undefined)) ||
      Fail`Invalid HTTP listener recipe`;
    ids.add(recipe.id);
  }
  /** @type {Map<string, Runtime>} */
  const runtimes = new Map();
  /** @type {Set<Promise<void>>} */
  const closingClients = new Set();
  /** @type {Set<Promise<RequestClient>>} */
  const openingClients = new Set();
  /** @type {unknown} */
  let clientCloseFailure;
  /** @param {RequestClient} client */
  const closeClient = client => {
    const closing = Promise.resolve()
      .then(() => client.close())
      .catch(error => {
        clientCloseFailure = error;
      });
    closingClients.add(closing);
    void closing.then(() => closingClients.delete(closing));
    return closing;
  };
  let lifecycle = 'restoring';
  /** @type {() => void} */
  let resolveReady = () => {};
  /** @type {(reason: Error) => void} */
  let rejectReady = () => {};
  const ready = new Promise((resolve, reject) => {
    resolveReady = () => resolve(undefined);
    rejectReady = reject;
  });
  void ready.catch(() => {});
  let failedStorage = false;
  /** @param {Recipe[]} listeners */
  const save = listeners => {
    !failedStorage || Fail`HTTP service storage requires restart`;
    try {
      storage.write({ version: 1, listeners });
    } catch (error) {
      failedStorage = true;
      throw error;
    }
    state = { version: 1, listeners };
  };
  /** @param {string} id */
  const recipeFor = id => {
    const recipe = state.listeners.find(item => item.id === id);
    recipe || Fail`Unknown HTTP listener`;
    return /** @type {Recipe} */ (recipe);
  };
  /** @param {Recipe} recipe */
  const put = recipe =>
    save(state.listeners.map(item => (item.id === recipe.id ? recipe : item)));
  /** @param {string} id */
  const runtimeFor = id => {
    let runtime = runtimes.get(id);
    if (!runtime) {
      runtime = {
        sockets: new Set(),
        aborts: new Set(),
        chain: Promise.resolve(),
        status: 'inactive',
      };
      runtimes.set(id, runtime);
    }
    return runtime;
  };
  /** @param {string} id */
  const status = id => {
    const recipe = recipeFor(id);
    const runtime = runtimeFor(id);
    return harden({
      id,
      port: recipe.port,
      desired: recipe.state,
      status: runtime.status,
      error: runtime.error,
      url:
        runtime.status === 'listening'
          ? `http://127.0.0.1:${recipe.port}/`
          : undefined,
    });
  };
  /**
   * @param {Runtime} runtime
   * @param {() => Promise<void>} operation
   */
  const enqueue = (runtime, operation) => {
    const result = runtime.chain.then(operation);
    runtime.chain = result.catch(() => {});
    return result;
  };

  /**
   * @param {Runtime} runtime
   * @param {Recipe} recipe
   * @param {IncomingMessage} request
   * @param {ServerResponse} response
   */
  const handle = (runtime, recipe, request, response) => {
    /**
     * @param {number} code
     * @param {string} body
     */
    const reject = (code, body) => {
      response.writeHead(code, {
        'content-type': 'text/plain; charset=utf-8',
        connection: 'close',
      });
      response.end(body);
      request.resume();
    };
    // Loopback is reachable by browsers too. Require the intended authority
    // and deny cross-site browser requests before opening any guest capability.
    const authority = `127.0.0.1:${recipe.port}`;
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    if (
      request.headers.host !== authority ||
      (origin !== undefined && origin !== `http://${authority}`) ||
      (site !== undefined && site !== 'same-origin' && site !== 'none')
    ) {
      reject(403, 'Request origin is not permitted');
      return;
    }
    if (runtime.aborts.size >= maxRequests) {
      reject(503, 'Too many requests');
      return;
    }
    let finished = false;
    /** @type {RequestClient | undefined} */
    let client;
    /** @type {Uint8Array[]} */
    let chunks = [];
    let length = 0;
    /**
     * @param {number} [code]
     * @param {string} [body]
     */
    const finish = (code, body = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      runtime.aborts.delete(abort);
      chunks = [];
      if (client) {
        const closing = client;
        client = undefined;
        void closeClient(closing);
      }
      if (code !== undefined && !response.destroyed) reject(code, body);
    };
    const abort = () => finish();
    const timer = setTimeout(
      () => finish(504, 'Request deadline exceeded'),
      deadlineMs,
    );
    runtime.aborts.add(abort);
    response.once('close', abort);
    request.once('error', abort);
    request.on('data', chunk => {
      if (finished) return;
      if (typeof chunk === 'string') {
        finish(400, 'Expected UTF-8 bytes');
        return;
      }
      length += chunk.length;
      if (length > limit) {
        finish(413, 'Request body too large');
        return;
      }
      chunks.push(new Uint8Array(chunk));
    });
    const dispatch = async () => {
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
        const opening = openClient();
        openingClients.add(opening);
        let opened;
        try {
          opened = await opening;
        } finally {
          openingClients.delete(opening);
        }
        if (finished) {
          await closeClient(opened);
          return;
        }
        client = opened;
        const handler = await opened.lookup(
          /** @type {string} */ (recipe.secret),
        );
        if (finished) return;
        /** @type {{status?: unknown, body?: unknown}} */
        const result = await E(handler).handle(
          harden({
            method: request.method ?? 'GET',
            path: request.url ?? '/',
            body,
          }),
        );
        if (finished) return;
        if (
          !result ||
          typeof result.status !== 'number' ||
          !Number.isInteger(result.status) ||
          result.status < 200 ||
          result.status > 599 ||
          typeof result.body !== 'string'
        ) {
          throw Fail`Invalid HTTP handler response`;
        }
        (result.body.length <= limit &&
          new TextEncoder().encode(result.body).length <= limit) ||
          Fail`HTTP response body too large`;
        finish(result.status, result.body);
      } catch (_error) {
        finish(500, 'Handler failed');
      }
    };
    request.once('end', () => {
      void dispatch();
    });
  };

  /** @param {Runtime} runtime */
  const stop = async runtime => {
    for (const abort of runtime.aborts) abort();
    const server = runtime.server;
    runtime.server = undefined;
    runtime.status = 'inactive';
    if (!server) return;
    const closed = new Promise(resolve =>
      server.close(() => resolve(undefined)),
    );
    for (const socket of runtime.sockets) socket.destroy();
    await closed;
  };
  /** @param {string} id */
  const bind = id => {
    const runtime = runtimeFor(id);
    return enqueue(runtime, async () => {
      await null;
      const recipe = recipeFor(id);
      if (lifecycle !== 'running' || recipe.state !== 'open' || runtime.server)
        return;
      const server = createServer(
        { maxHeaderSize: 16 * 1024 },
        (request, response) => handle(runtime, recipe, request, response),
      );
      runtime.server = server;
      server.headersTimeout = deadlineMs;
      server.requestTimeout = deadlineMs;
      server.keepAliveTimeout = 1;
      server.timeout = deadlineMs * 2;
      server.maxHeadersCount = 100;
      server.on('connection', socket => {
        runtime.sockets.add(socket);
        socket.once('close', () => runtime.sockets.delete(socket));
      });
      server.on('upgrade', (_request, socket) => socket.destroy());
      server.on('connect', (_request, socket) => socket.destroy());
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(recipe.port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve(undefined);
          });
        });
        server.on('error', error => {
          runtime.status = 'failed';
          runtime.error = String(error);
        });
        runtime.status = 'listening';
        runtime.error = undefined;
      } catch (error) {
        runtime.server = undefined;
        runtime.status = 'failed';
        runtime.error = String(error);
        server.close();
      }
    });
  };

  return harden({
    /** @param {number} port */
    allocate: port => {
      lifecycle !== 'stopped' || Fail`HTTP services are shut down`;
      (Number.isInteger(port) && port >= 1024 && port <= 65_535) ||
        Fail`Expected HTTP port 1024–65535`;
      !state.listeners.some(
        item => item.port === port && item.state !== 'closed',
      ) || Fail`HTTP port already allocated`;
      const id = randomId();
      save([...state.listeners, { id, port, state: 'allocated' }]);
      return harden({ id });
    },
    /** @param {unknown} description */
    resource: description => {
      if (
        !description ||
        typeof description !== 'object' ||
        !('id' in description) ||
        typeof description.id !== 'string'
      ) {
        throw Fail`Invalid HTTP listener description`;
      }
      const { id } = description;
      recipeFor(id);
      return Far('HttpListener', {
        help: () =>
          'listen(handler) configures this listener once; status() inspects it; close() permanently releases it. handle({method,path,body}) must return {status,body}.',
        /** @param {any} handler */
        listen: async handler => {
          lifecycle !== 'stopped' || Fail`HTTP services are shut down`;
          (handler && handler[Symbol.for('passStyle')] === 'remotable') ||
            Fail`Expected a remotable HTTP handler`;
          await ready;
          lifecycle === 'running' || Fail`HTTP services are shut down`;
          const recipe = recipeFor(id);
          recipe.state === 'allocated' ||
            Fail`HTTP listener already configured`;
          const secret = randomId();
          put({ ...recipe, state: 'preparing', secret });
          publish(handler, secret);
          put({ ...recipe, state: 'open', secret });
          if (lifecycle === 'running') await bind(id);
          return status(id);
        },
        status: () => status(id),
        close: async () => {
          await ready;
          lifecycle !== 'stopped' || Fail`HTTP services are shut down`;
          const recipe = recipeFor(id);
          if (recipe.state !== 'closed') put({ ...recipe, state: 'closed' });
          await enqueue(runtimeFor(id), () => stop(runtimeFor(id)));
          if (recipe.secret) unpublish(recipe.secret);
          return status(id);
        },
      });
    },
    start: async () => {
      lifecycle === 'restoring' || Fail`HTTP services already started`;
      lifecycle = 'running';
      await null;
      if (lifecycle !== 'running') return;
      try {
        for (const recipe of state.listeners) {
          if (recipe.state === 'preparing') put({ ...recipe, state: 'closed' });
          if (
            (recipe.state === 'closed' || recipe.state === 'preparing') &&
            recipe.secret
          )
            unpublish(recipe.secret);
        }
        await Promise.all(
          state.listeners
            .filter(item => item.state === 'open')
            .map(item => bind(item.id)),
        );
        resolveReady();
      } catch (error) {
        rejectReady(/** @type {Error} */ (error));
        throw error;
      }
    },
    shutdown: async () => {
      lifecycle = 'stopped';
      rejectReady(Error('HTTP services are shut down'));
      await Promise.all(
        [...runtimes.values()].map(runtime =>
          enqueue(runtime, () => stop(runtime)),
        ),
      );
      await Promise.allSettled([...openingClients]);
      await Promise.all([...closingClients]);
      if (clientCloseFailure) throw clientCloseFailure;
    },
    list: () => harden(state.listeners.map(recipe => status(recipe.id))),
  });
};
harden(makeHttpServices);
