// @ts-check
/**
 * The agent-host manager (M1a W1a.2): the durable half of the agent-host
 * native resource, run in its manager vat (architecture 3.3, D-7, D-14;
 * `designs/m1a-interfaces.md` section 3.3). Thin on purpose (D-14): it
 * holds the durable identities (Backends with their specs, session host
 * facets and their bindings, start listeners) and forwards everything
 * else to the adapter's ops facet; the implementation lives in `impl/`,
 * loaded by the adapter at run time.
 *
 * The attach pattern is spike S2's (`test/spikes/fixtures/attach/`):
 * one registration under `SERVICE_KEY` whose spec carries a manager-owned
 * sink; the adapter's `bind` awaits `E(sink).attach(ops)`, so a reconcile
 * that returns leaves a fresh ops facet here; a call that finds its ops
 * facet retired (the adapter restarted) reconciles once through
 * `manager.register` (`same: () => true`) and calls again.
 *
 * Runs in a vat: prelude globals only (no clock, timers or randomness),
 * closed records, bounded retained state (architecture 12).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  interfaces,
  m1bInterfaces,
  m1bShapes,
  texts,
} from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { fitsFrame } from '../../guest/lib/bounded.js';
import { isRetiredBreak } from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */

const { E, Far, M, defineExoClass, makeExo, makePromiseKit } =
  /** @type {any} */ (globalThis);

/** The one registration key; `impl/attach.js` binds it. */
export const SERVICE_KEY = 'agent-host';
/** Start listeners kept at once (the factory registers one). */
const MAX_START_LISTENERS = 16;

/**
 * @param {{ makeManager: (options: any) => any }} powers
 */
export const make = ({ makeManager }) => {
  /** The ops facet of the adapter incarnation that attached last. */
  let ops;
  let attaches = 0;
  /**
   * True while a daemon start runs `lifecycle.started()`: an attach then is
   * the start's own, and listeners hear `started()` after it (J-9362).
   */
  let starting = false;

  const manager = makeManager({
    label: 'AgentHost',
    // The key is registered again only to reconcile it; nothing replaces it.
    same: () => true,
  });

  // ---- blobs (M1b W1b.1; designs/m1b-interfaces.md section 4) ----
  // Handles are minted here in batches for the adapter's stock; the file
  // key of each is kept only in this WeakMap (and in the adapter's memory):
  // a handle nobody holds any more is collected with its entry. Keys come
  // from a counter in this vat's durable heap, so they never repeat.
  let blobSerial = 0;
  /** @type {WeakMap<any, string>} */
  const blobKeys = new WeakMap();
  const makeBlob = defineExoClass(
    'Blob',
    m1bInterfaces.Blob,
    () => harden({}),
    {},
  );

  const sink = makeExo(
    'AgentHostSink',
    M.interface('AgentHostSink', {
      attach: M.call(
        M.remotable('AgentHostOps'),
        M.string({ stringLengthLimit: 128 }),
      ).returns(M.number()),
      mintBlobs: M.call().returns(m1bShapes.BlobStock),
      resolveBlobs: M.call(
        M.arrayOf(M.remotable('Blob'), {
          arrayLengthLimit: limits.blobResolveBatch,
        }),
      ).returns(m1bShapes.BlobKeys),
    }),
    {
      /** A stock batch for the adapter (one crank; section 4.1). */
      mintBlobs: () => {
        /** @type {any[]} */
        const entries = [];
        for (let i = 0; i < limits.blobStockBatch; i += 1) {
          blobSerial += 1;
          const key = `b${blobSerial}`;
          const blob = makeBlob();
          blobKeys.set(blob, key);
          entries.push(harden({ blob, key }));
        }
        return harden(entries);
      },
      /**
       * The file keys of handles a new adapter incarnation met (section 4.6);
       * `null` for a handle this manager did not mint.
       * @param {any[]} blobs
       */
      resolveBlobs: blobs =>
        harden(blobs.map(blob => blobKeys.get(blob) ?? null)),
      /**
       * @param {any} opsFacet
       * @param {string} _incarnation
       */
      attach: (opsFacet, _incarnation) => {
        ops = opsFacet;
        attaches += 1;
        // An incarnation that replaces another outside a daemon start (the
        // adapter process exited and was rebuilt, or a call found the ops
        // facet retired): what listeners fetched from the old one, such as
        // the factory's list publisher, is a tombstone now (M1b follow-ups,
        // J-9362; it stayed stale until the next daemon start).
        if (attaches > 1 && !starting) {
          for (const listener of listeners) E.sendOnly(listener).attached();
        }
        return attaches;
      },
    },
  );

  /**
   * Desire the service registration and reconcile it: on a fresh manager
   * this builds the adapter (which attaches); after a restart it waits
   * behind the restore that re-attaches.
   */
  const reconcile = async () => {
    const { status } = await manager.register(SERVICE_KEY, harden({ sink }));
    if (status.status !== 'bound')
      throw Error(`agent host not bound: ${status.error ?? status.status}`);
  };

  /**
   * Call the current ops facet; a retired one is replaced by reconciling
   * once and the call is made again.
   * @template T
   * @param {(current: any) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const withOps = async fn => {
    if (ops === undefined) await reconcile();
    try {
      return await fn(ops);
    } catch (error) {
      if (!isRetiredBreak(error)) throw error;
      await reconcile();
      return fn(ops);
    }
  };

  /**
   * Host facet -> its Session, or `undefined` while minted and unbound.
   * @type {WeakMap<any, any>}
   */
  const sessionOfHost = new WeakMap();
  /**
   * Session -> its host facet.
   * @type {WeakMap<any, any>}
   */
  const hostOfSession = new WeakMap();

  /** @param {any} host */
  const boundSession = host => {
    const session = sessionOfHost.get(host);
    if (session === undefined) throw Error(texts.unknownSessionHost);
    return session;
  };

  /**
   * Host facet minted but not bound yet -> the bind it waits for. A session
   * opens its ports in `make`, before the factory binds its facet (contract
   * 6.1, J-9151); weak, so a creation rolled back leaves nothing here.
   * @type {WeakMap<any, any>}
   */
  const bindWaits = new WeakMap();

  /**
   * The Session bound to `host`, once it is bound. A facet this manager did
   * not mint is refused at once.
   * @param {any} host
   */
  const whenBound = async host => {
    if (!sessionOfHost.has(host)) throw Error(texts.unknownSessionHost);
    const session = sessionOfHost.get(host);
    if (session !== undefined) return session;
    let wait = bindWaits.get(host);
    if (wait === undefined) {
      wait = makePromiseKit();
      bindWaits.set(host, wait);
    }
    return wait.promise;
  };

  const forSession = () => {
    const host = makeExo('SessionHostFacet', interfaces.SessionHostFacet, {
      liveChannel: async () => {
        const session = boundSession(host);
        return withOps(current => E(current).liveChannel(session));
      },
    });
    sessionOfHost.set(host, undefined);
    return host;
  };

  /**
   * @param {any} host
   * @param {any} session
   */
  const bindSession = (host, session) => {
    if (!sessionOfHost.has(host)) throw Error(texts.unknownSessionHost);
    const bound = sessionOfHost.get(host);
    if (bound === session) return undefined;
    if (bound !== undefined)
      throw Error('This session host is bound to another session');
    if (hostOfSession.has(session))
      throw Error('This session already has a session host');
    sessionOfHost.set(host, session);
    hostOfSession.set(session, host);
    bindWaits.get(host)?.resolve(session);
    bindWaits.delete(host);
    return undefined;
  };

  /** @param {any} spec a `shapes.BackendSpec` (checked by the guard) */
  const makeBackend = async spec => {
    if (!fitsFrame(spec)) throw Error(texts.frameLimit);
    const info = harden({ kind: spec.kind, label: spec.label });
    const backend = makeExo('Backend', interfaces.Backend, {
      describe: () => info,
      /**
       * Once per adapter incarnation per session (contract 6.1); waits for
       * the bind of a minted, unbound facet.
       * @param {any} host
       */
      open: async host => {
        const session = await whenBound(host);
        return withOps(current =>
          E(current).open(harden({ backend, spec, session })),
        );
      },
    });
    return backend;
  };

  /** @type {Set<any>} */
  const listeners = new Set();

  /** @param {any} listener */
  const onStart = listener => {
    if (!listeners.has(listener) && listeners.size >= MAX_START_LISTENERS)
      throw Error(`at most ${MAX_START_LISTENERS} start listeners`);
    listeners.add(listener);
    return makeExo('Registration', interfaces.Registration, {
      cancel: () => {
        listeners.delete(listener);
        return undefined;
      },
    });
  };

  const facet = makeExo('AgentHostAdmin', m1bInterfaces.AgentHostAdmin, {
    makeBackend,
    forSession,
    bindSession,
    onStart,
    live: async () => withOps(current => E(current).live()),
    composer: async () => withOps(current => E(current).composer()),
    // M1b W1b.1: the incarnation's Content; the list publisher (W1b.5's
    // channel, answered by the ops facet once it has one).
    content: async () => withOps(current => E(current).content()),
    listPublisher: async () => withOps(current => E(current).listPublisher()),
  });

  const lifecycle = Far('AgentHostLifecycle', {
    /**
     * Every daemon start: the manager restores the service registration
     * (which re-attaches a fresh ops facet), then each start listener is
     * told, sendOnly.
     */
    started: async () => {
      starting = true;
      try {
        await manager.lifecycle.started();
      } finally {
        starting = false;
        for (const listener of listeners) E.sendOnly(listener).started();
      }
    },
    exited: () => manager.lifecycle.exited(),
  });

  return harden({ facet, lifecycle });
};
harden(make);
