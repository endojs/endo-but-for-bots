// @ts-check
import { E, Far } from '@endo/far';
import { Fail } from '@endo/errors';
import harden from '@endo/harden';

/** @import { SyncStringAtom } from '../store/sync-string-atom.js' */
/** @import { HttpAbortSignal, HttpListener, HttpListenerPowers, HttpRequest, HttpRequestDescription } from '../platform/http-listeners.js' */
/** @import { RandomPowers } from '../platform/random.js' */

/** @typedef {{id: string, port: number, state: 'allocated'|'preparing'|'open'|'closed', secret?: string}} Recipe */
/** @typedef {{lookup: (secret: string) => any, close: () => void | Promise<void>}} RequestClient */
/** @typedef {{listener?: HttpListener, chain: Promise<void>, status: string, error?: string}} Runtime */
const limit = 64 * 1024;
const maxRequests = 16;
const deadlineMs = 5000;

/** @param {Uint8Array} bytes */
const toHex = bytes =>
  [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * Persistent HTTP listener recipes; all sockets, request clients and deadlines
 * are ephemeral. The caller owns the engine lease for this manager's lifetime.
 * Ports are explicit, loopback-only, and each allocation is a single-use lease.
 * Repeated listen rejects; inspect status after an uncertain configuration call.
 * @param {object} powers
 * @param {HttpListenerPowers} powers.httpListeners
 * @param {RandomPowers} powers.random
 * @param {object} options
 * @param {SyncStringAtom} options.storage
 * @param {(handler: any, secret: string) => void} options.publish
 * @param {(secret: string) => void} options.unpublish
 * @param {() => Promise<RequestClient>} options.openClient
 */
export const makeHttpServices = (
  { httpListeners, random },
  { storage, publish, unpublish, openClient },
) => {
  const randomId = () => toHex(random.randomBytes(16));
  /** @type {{version: number, listeners: Recipe[]}} */
  let state = { version: 1, listeners: [] };
  const saved = storage.read();
  if (saved !== undefined) state = JSON.parse(saved);
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
      storage.write(JSON.stringify({ version: 1, listeners }));
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
      runtime = { chain: Promise.resolve(), status: 'inactive' };
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
   * Loopback is reachable by browsers too. Require the intended authority
   * and deny cross-site browser requests before opening any guest capability.
   * @param {Recipe} recipe
   * @param {HttpRequestDescription} request
   */
  const admit = (recipe, request) => {
    const authority = `127.0.0.1:${recipe.port}`;
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    if (
      request.headers.host !== authority ||
      (origin !== undefined && origin !== `http://${authority}`) ||
      (site !== undefined && site !== 'same-origin' && site !== 'none')
    ) {
      return /** @type {const} */ ({
        allowed: false,
        status: 403,
        body: 'Request origin is not permitted',
      });
    }
    return /** @type {const} */ ({ allowed: true });
  };

  /**
   * @param {Recipe} recipe
   * @param {HttpRequest} request
   * @param {HttpAbortSignal} abort
   */
  const dispatch = async (recipe, request, abort) => {
    const opening = openClient();
    openingClients.add(opening);
    let opened;
    try {
      opened = await opening;
    } finally {
      openingClients.delete(opening);
    }
    /** @type {RequestClient | undefined} */
    let client = opened;
    const release = () => {
      if (client === undefined) return;
      const closing = client;
      client = undefined;
      void closeClient(closing);
    };
    abort.onAbort(release);
    try {
      // The request may have been abandoned while the client was opening;
      // in that case the guest is never consulted.
      !abort.aborted() || Fail`HTTP request was aborted`;
      const handler = await opened.lookup(
        /** @type {string} */ (recipe.secret),
      );
      /** @type {{status?: unknown, body?: unknown}} */
      const result = await E(handler).handle(
        harden({
          method: request.method,
          path: request.path,
          body: request.body,
        }),
      );
      return harden({
        status: /** @type {number} */ (result.status),
        body: /** @type {string} */ (result.body),
      });
    } finally {
      release();
    }
  };

  /**
   * @param {Runtime} runtime
   * @param {Recipe} recipe
   */
  const bind = (runtime, recipe) =>
    enqueue(runtime, async () => {
      await null;
      if (
        lifecycle !== 'running' ||
        recipe.state !== 'open' ||
        runtime.listener
      )
        return;
      try {
        const listener = await httpListeners.listen({
          port: recipe.port,
          host: '127.0.0.1',
          maxBodyBytes: limit,
          maxResponseBytes: limit,
          maxHeaderBytes: 16 * 1024,
          maxRequests,
          requestDeadlineMs: deadlineMs,
          keepAliveTimeoutMs: 1,
          admit: request => admit(recipe, request),
          handle: (request, abort) => dispatch(recipe, request, abort),
          onError: error => {
            runtime.status = 'failed';
            runtime.error = String(error);
          },
        });
        runtime.listener = listener;
        runtime.status = 'listening';
        runtime.error = undefined;
      } catch (error) {
        runtime.listener = undefined;
        runtime.status = 'failed';
        runtime.error = String(error);
      }
    });

  /** @param {Runtime} runtime */
  const stop = async runtime => {
    const listener = runtime.listener;
    runtime.listener = undefined;
    runtime.status = 'inactive';
    if (!listener) return;
    await listener.close();
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
          if (lifecycle === 'running') await bind(runtimeFor(id), recipeFor(id));
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
            .map(item => bind(runtimeFor(item.id), item)),
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
