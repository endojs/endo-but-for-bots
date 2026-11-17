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
  m2Interfaces,
  texts,
  textOf,
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
 * Secrets the manager keeps at once (M2 W2.3): `SecretsAdmin.list` pages
 * this list and `Secret.delete` shortens it; it grows with what the
 * operator creates, never with turns.
 */
const MAX_SECRETS = 1024;

/** @param {string} code a `secretCodes` entry */
const secretError = code => Error(textOf.secretFailed(code));

/**
 * R7-25: 1-200 characters, no newline (the guard bounds the length).
 * @param {string} description
 */
const assertDescription = description => {
  if (
    description.length === 0 ||
    description.includes('\n') ||
    description.includes('\r')
  )
    throw secretError('INVALID_DESCRIPTION');
};

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
      // M2 (m2-interfaces 3.3): keys by amplification, at most 64 a call.
      resolveSessions: M.call(
        M.arrayOf(M.remotable('Session'), {
          arrayLengthLimit: limits.blobResolveBatch,
        }),
      ).returns(m1bShapes.BlobKeys),
      resolveSecrets: M.call(
        M.arrayOf(M.remotable('Secret'), {
          arrayLengthLimit: limits.blobResolveBatch,
        }),
      ).returns(m1bShapes.BlobKeys),
      resolveGrants: M.call(
        M.arrayOf(M.remotable('ReadGrant'), {
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
       * The archive key of each session's host facet, assigned on first
       * use (W2.8's archive directory); `null` for a session no facet of
       * this manager is bound to.
       * @param {any[]} sessions
       */
      // eslint-disable-next-line no-use-before-define
      resolveSessions: sessions => harden(sessions.map(archiveKeyOf)),
      /**
       * The store key of each Secret (the writer's amplification);
       * `null` for one this manager did not mint or has deleted.
       * @param {any[]} secrets
       */
      resolveSecrets: secrets =>
        // eslint-disable-next-line no-use-before-define
        harden(secrets.map(secret => secretRecords.get(secret)?.key ?? null)),
      /**
       * The store key behind each read grant (a provider's read path).
       * @param {any[]} grants
       */
      resolveGrants: grants =>
        // eslint-disable-next-line no-use-before-define
        harden(grants.map(grant => grantRecords.get(grant)?.key ?? null)),
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

  // ---- archive keys (M2; W2.8's per-session archive directory) ----
  let archiveSerial = 0;
  /** Host facet -> its archive key `h<n>`. @type {WeakMap<any, string>} */
  const archiveKeys = new WeakMap();
  /**
   * @param {any} session
   * @returns {string | null}
   */
  const archiveKeyOf = session => {
    const host = hostOfSession.get(session);
    if (host === undefined) return null;
    let key = archiveKeys.get(host);
    if (key === undefined) {
      archiveSerial += 1;
      key = `h${archiveSerial}`;
      archiveKeys.set(host, key);
    }
    return key;
  };

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

  // ---- secrets (M2 W2.3; D-6; m2-interfaces 3.3, 9) ----
  // The manager holds the identities: the one SecretsAdmin, each Secret
  // with its label and description, each ReadGrant. The store key `k<n>`
  // of a Secret is kept only in these WeakMaps (as blob keys) and given
  // only to the adapter's sink calls. No value ever reaches this vat.
  let secretSerial = 0;
  /**
   * @typedef {{ key: string, label: string, description: string }} SecretRecord
   */
  /** Secret -> its record. @type {WeakMap<any, SecretRecord>} */
  const secretRecords = new WeakMap();
  /** ReadGrant -> the record of its Secret. @type {WeakMap<any, SecretRecord>} */
  const grantRecords = new WeakMap();
  /** The live Secrets in creation order (`list`). @type {any[]} */
  let secretList = [];

  /**
   * @param {any} secret
   * @returns {SecretRecord}
   */
  const recordOf = secret => {
    const record = secretRecords.get(secret);
    if (record === undefined) throw secretError('UNKNOWN_SECRET');
    return record;
  };

  const makeSecret = defineExoClass(
    'Secret',
    interfaces.Secret,
    () => harden({}),
    {
      async describe() {
        const record = recordOf(this.self);
        const { generation, state, bytes } = await withOps(current =>
          E(current).secretDescribe(record.key),
        );
        return harden({
          label: record.label,
          description: record.description,
          generation,
          state,
          bytes,
        });
      },
      makeReadGrant() {
        const record = recordOf(this.self);
        // eslint-disable-next-line no-use-before-define
        const grant = makeReadGrantExo();
        grantRecords.set(grant, record);
        return grant;
      },
      async revoke() {
        const record = recordOf(this.self);
        await withOps(current => E(current).secretRevoke(record.key));
        return undefined;
      },
      async delete() {
        const record = recordOf(this.self);
        // The store refuses an active secret (`NOT_REVOKED`).
        await withOps(current => E(current).secretDelete(record.key));
        secretRecords.delete(this.self);
        secretList = secretList.filter(secret => secret !== this.self);
        return undefined;
      },
      /** @param {number} [limit] */
      async audit(limit = limits.auditPageEvents) {
        const record = recordOf(this.self);
        return withOps(current =>
          E(current).secretAudit(harden({ key: record.key, limit })),
        );
      },
    },
  );

  const makeReadGrantExo = defineExoClass(
    'ReadGrant',
    interfaces.ReadGrant,
    () => harden({}),
    {
      describe() {
        const record = grantRecords.get(this.self);
        if (record === undefined) throw secretError('UNKNOWN_GRANT');
        return harden({ label: record.label, description: record.description });
      },
    },
  );

  const secretsAdmin = makeExo('SecretsAdmin', interfaces.SecretsAdmin, {
    /** @param {string} [cursor] a position in creation order */
    list: cursor => {
      const from = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(from) || from < 0)
        throw Error('not a secrets cursor');
      const secrets = secretList.slice(from, from + limits.secretPageEntries);
      const next = from + secrets.length;
      return harden(
        next < secretList.length ? { secrets, next: `${next}` } : { secrets },
      );
    },
    /** @param {{ label: string, description: string }} request */
    create: async ({ label, description }) => {
      assertDescription(description);
      if (secretList.length >= MAX_SECRETS) throw secretError('CREATE_FAILED');
      secretSerial += 1;
      const record = harden({ key: `k${secretSerial}`, label, description });
      await withOps(current =>
        E(current).secretCreate(
          harden({ key: record.key, label, description }),
        ),
      );
      const secret = makeSecret();
      secretRecords.set(secret, record);
      secretList = [...secretList, secret];
      return secret;
    },
    openWriter: async () => withOps(current => E(current).secretWriter()),
    /** @param {number} [limit] */
    audit: async (limit = limits.auditPageEvents) =>
      withOps(current => E(current).secretAudit(harden({ limit }))),
  });

  /** @param {any} spec a `shapes.BackendSpec` (checked by the guard) */
  const makeBackend = async spec => {
    if (!fitsFrame(spec)) throw Error(texts.frameLimit);
    // M2: an API backend reads its key through a grant this manager
    // minted (D-6, R7-28); never key text.
    if (spec.kind !== 'scripted' && !grantRecords.has(spec.keyGrant))
      throw secretError('UNKNOWN_GRANT');
    const info = harden(
      spec.modelId === undefined
        ? { kind: spec.kind, label: spec.label }
        : { kind: spec.kind, label: spec.label, modelId: spec.modelId },
    );
    const backend = makeExo('Backend', m2Interfaces.Backend, {
      describe: () => info,
      /** @param {any} [request] a `shapes.ModelRequest` */
      listModels: async request =>
        withOps(current =>
          E(current).listModels(
            harden(
              request === undefined
                ? { backend, spec }
                : { backend, spec, request },
            ),
          ),
        ),
      /** @param {string} [modelId] */
      resolveModel: async modelId =>
        withOps(current =>
          E(current).resolveModel(
            harden(
              modelId === undefined
                ? { backend, spec }
                : { backend, spec, modelId },
            ),
          ),
        ),
      /**
       * Once per adapter incarnation per session (contract 6.1); waits for
       * the bind of a minted, unbound facet.
       * @param {any} host
       */
      open: async host => {
        const session = await whenBound(host);
        // M2 (W2.7 for W2.8, J-0494): the session's archive key travels with
        // the open, so the adapter needs no resolveSessions crank for it.
        const archiveKey = archiveKeyOf(session);
        return withOps(current =>
          E(current).open(
            harden(
              archiveKey === null
                ? { backend, spec, session }
                : { backend, spec, session, archiveKey },
            ),
          ),
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

  /**
   * M2 (m1b-interfaces 4.8): the file keys of the handles this manager
   * minted (others skipped) are released by the adapter, then forgotten.
   * @param {any[]} blobs
   */
  const releaseBlobs = async blobs => {
    const known = blobs.filter(blob => blobKeys.has(blob));
    if (known.length === 0) return undefined;
    const keys = harden(known.map(blob => blobKeys.get(blob)));
    await withOps(current => E(current).releaseBlobs(keys));
    for (const blob of known) blobKeys.delete(blob);
    return undefined;
  };

  /**
   * M2: the session's archive (W2.8), if it ever had a key.
   * @param {any} session
   */
  const releaseArchive = async session => {
    const host = hostOfSession.get(session);
    const key = host === undefined ? undefined : archiveKeys.get(host);
    if (key === undefined) return undefined;
    await withOps(current => E(current).releaseArchive(key));
    return undefined;
  };

  const facet = makeExo('AgentHostAdmin', m2Interfaces.AgentHostAdmin, {
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
    // M2 (m2-interfaces 3.3)
    getSecrets: () => secretsAdmin,
    releaseBlobs,
    releaseArchive,
    history: async () => withOps(current => E(current).history()),
    /** @param {any} [session] */
    writersFor: async session =>
      withOps(current =>
        session === undefined
          ? E(current).writersFor()
          : E(current).writersFor(session),
      ),
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
