// @ts-check
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

// One host binding, regardless of the number of sessions or journal records.
const ROOT = 'floot-private-sessions';
const roots = new WeakMap();

/** @param {string} sessionId */
const assertSessionId = sessionId => {
  (typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) ||
    Fail`Invalid journal session ID`;
};

/** @param {any} host */
const createRoot = host => {
  // Concurrent session creation must not replace a newly published directory.
  if (!roots.has(host)) {
    const pending = (async () => {
      if (!(await E(host).has(ROOT))) await E(host).createDirectory(ROOT);
    })();
    roots.set(host, pending);
    void pending.catch(() => roots.delete(host));
  }
  return roots.get(host);
};

/**
 * Create a new private session directory. Never adopt or overwrite existing
 * data. The factory reserves the ID before calling this; one factory owns the
 * root. A failed publication retains its directory for operator inspection.
 * @param {any} host
 * @param {string} sessionId
 */
export const createPrivateTurnStorage = async (host, sessionId) => {
  assertSessionId(sessionId);
  await createRoot(host);
  !(await E(host).has(ROOT, sessionId)) ||
    Fail`Private journal namespace already exists`;
  await E(host).createDirectory(harden([ROOT, sessionId]));
  await E(host).storeValue(
    harden({ version: 2, sessionId }),
    harden([ROOT, sessionId, 'schema']),
  );
};
harden(createPrivateTurnStorage);

/**
 * @param {any} host @param {string} sessionId
 * @param sessionId
 */
const openDirectory = async (host, sessionId) => {
  assertSessionId(sessionId);
  (await E(host).has(ROOT)) ||
    Fail`Private journal schema missing; session reset required`;
  (await E(host).has(ROOT, sessionId)) ||
    Fail`Private journal schema missing; session reset required`;
  (await E(host).has(ROOT, sessionId, 'schema')) ||
    Fail`Private journal schema missing; session reset required`;
  assertSchema(
    await E(host).lookup(harden([ROOT, sessionId, 'schema'])),
    sessionId,
  );
};

/**
 * @param {string} sessionId @param {unknown} name
 * @param name
 */
const assertNetworkName = (sessionId, name) => {
  const prefix = `floot-network-${sessionId.length}-${sessionId}-`;
  (typeof name === 'string' &&
    name.startsWith(prefix) &&
    /^\d{20}$/.test(name.slice(prefix.length))) ||
    Fail`Invalid private network value name`;
  return /** @type {string} */ (name);
};

/** @param {unknown} name */
const assertJournalName = name => {
  (typeof name === 'string' &&
    /^floot-turn-(event-\d{20}|content-\d{20}-[a-z]+|snapshot-\d{20}|archive-\d{20})$/.test(
      name,
    )) ||
    Fail`Invalid private journal value name`;
  return /** @type {string} */ (name);
};

/**
 * @param {any} schema
 * @param {string} sessionId
 */
const assertSchema = (schema, sessionId) => {
  (schema !== null &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    Reflect.ownKeys(schema).length === 2 &&
    Object.hasOwn(schema, 'version') &&
    Object.hasOwn(schema, 'sessionId') &&
    schema.version === 2 &&
    schema.sessionId === sessionId) ||
    Fail`Invalid private journal schema; session reset required`;
};

/**
 * Terminal deletion only, after the factory has durably recorded deletion
 * intent and stopped all writers/backends and closed their storage facets.
 * Unlink the whole owned directory in one operation. A lost acknowledgement
 * is retryable; no partial journal can be exposed by a crash mid-deletion.
 * The daemon can collect its contents once the closed facets are released.
 * Unknown or ownerless data is retained for operator inspection.
 * @param {any} host
 * @param {string} sessionId
 */
export const retirePrivateTurnStorage = async (host, sessionId) => {
  assertSessionId(sessionId);
  if (!(await E(host).has(ROOT))) return;
  if (!(await E(host).has(ROOT, sessionId))) return;
  await openDirectory(host, sessionId);
  for (const name of await E(host).list(ROOT, sessionId)) {
    if (
      name !== 'schema' &&
      !/^floot-attachment-(?:[0-9]|[12][0-9]|3[01])$/.test(name)
    ) {
      if (name.startsWith('floot-network-')) assertNetworkName(sessionId, name);
      else assertJournalName(name);
    }
  }
  await E(host).remove(ROOT, sessionId);
};
harden(retirePrivateTurnStorage);

/**
 * Open factory-owned journal storage. Never introduce this facet into a guest.
 * Full-control administrators holding the factory host remain trusted: this
 * separates ordinary guests, not principals deliberately granted that host.
 * Opening never imports guest history or creates missing schema.
 * One factory writer per session is required.
 *
 * @param {any} host
 * @param {string} sessionId
 * @param {(name: unknown) => string} assertName
 */
const provideStorage = async (host, sessionId, assertName) => {
  await openDirectory(host, sessionId);
  let poisoned = false;
  let closed = false;
  let queue = Promise.resolve();
  /** @param {() => Promise<any>} operation */
  const serialized = operation => {
    !closed || Fail`Private journal incarnation is closed`;
    const result = queue.then(async () => {
      !poisoned || Fail`Private journal unavailable after uncertain storage`;
      return operation();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return Far('FactoryPrivateTurnStorage', {
    close: async () => {
      closed = true;
      await queue;
      !poisoned || Fail`Private journal unavailable after uncertain storage`;
    },
    list: () =>
      serialized(async () =>
        harden(
          (await E(host).list(ROOT, sessionId)).filter(name => {
            if (name === 'schema') return false;
            // The two journals share ownership, not their record inventories.
            try {
              assertName(name);
              return true;
            } catch {
              return false;
            }
          }),
        ),
      ),
    lookup: name =>
      serialized(async () =>
        E(host).lookup(harden([ROOT, sessionId, assertName(name)])),
      ),
    storeValue: (value, name) =>
      serialized(async () => {
        const target = assertName(name);
        !(await E(host).has(ROOT, sessionId, target)) ||
          Fail`Private journal values are immutable`;
        try {
          await E(host).storeValue(value, harden([ROOT, sessionId, target]));
        } catch (error) {
          poisoned = true;
          throw error;
        }
      }),
    // The journal removes only what a durable snapshot already covers. A
    // failure costs a stray value, not ambiguous history, and does not poison.
    remove: name =>
      serialized(async () => {
        const target = assertName(name);
        (await E(host).has(ROOT, sessionId, target)) ||
          Fail`Unknown private journal value`;
        await E(host).remove(ROOT, sessionId, target);
      }),
  });
};
/**
 * @param {any} host @param {string} sessionId
 * @param sessionId
 */
export const providePrivateTurnStorage = (host, sessionId) =>
  provideStorage(host, sessionId, assertJournalName);
harden(providePrivateTurnStorage);

/**
 * @param {any} host @param {string} sessionId
 * @param sessionId
 */
export const providePrivateNetworkStorage = (host, sessionId) =>
  provideStorage(host, sessionId, name => assertNetworkName(sessionId, name));
harden(providePrivateNetworkStorage);
