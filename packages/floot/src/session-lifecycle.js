// @ts-check

import { E } from '@endo/eventual-send';

/** @import { EndoHost } from '@endo/daemon' */

const SESSION_GUESTS_NAME = 'floot-session-guests';
const SESSION_HANDLE_NAME = 'handle';
const SESSION_AGENT_NAME = 'agent';

/**
 * @param {string} id
 * @param {string} sessionGuestsName
 */
const sessionPath = (id, sessionGuestsName) => [sessionGuestsName, id];

/** @param {string} id */
const legacyHandleName = id => `session-${id}`;

/** @param {string} id */
const legacyAgentName = id => `session-agent-${id}`;

/**
 * Manage the daemon namespace that owns each Floot session guest.
 *
 * A session gets one directory containing both of the external roots created by
 * `provideGuest`: its handle and controlling agent facets.
 * Removing that one directory drops both roots in one petstore operation,
 * after which the daemon's formula graph collects the guest cohort and
 * everything named by its petstore.
 *
 * The legacy top-level handle and agent names are moved into the directory
 * before a session is used or dropped.
 * This preserves existing conversations
 * while converging every session on the single-root layout.
 *
 * @param {EndoHost} host
 * @param {{
 *   sessionGuestsName?: string,
 *   sessionHandleName?: string,
 *   sessionAgentName?: string,
 * }} [options]
 */
const makeSessionGuestManager = (
  host,
  {
    sessionGuestsName = SESSION_GUESTS_NAME,
    sessionHandleName = SESSION_HANDLE_NAME,
    sessionAgentName = SESSION_AGENT_NAME,
  } = {},
) => {
  /** @type {Promise<void> | undefined} */
  let rootP;
  const ensureRoot = () => {
    if (rootP === undefined) {
      rootP = (async () => {
        await null;
        if (!(await E(host).has(sessionGuestsName))) {
          await E(host).makeDirectory(sessionGuestsName);
        }
      })().catch(error => {
        rootP = undefined;
        throw error;
      });
    }
    return rootP;
  };

  /** @type {Map<string, Promise<void>>} */
  const operations = new Map();

  /**
   * Serialize provisioning, migration, and collection for one session so a
   * deletion cannot race a partially-created guest back into existence.
   *
   * @template T
   * @param {string} id
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const runForSession = (id, operation) => {
    const previous = operations.get(id) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.then(
      () => {},
      () => {},
    );
    operations.set(id, tail);
    tail.then(() => {
      if (operations.get(id) === tail) {
        operations.delete(id);
      }
    });
    return result;
  };

  /** @param {string} id */
  const ensureSessionDirectory = async id => {
    await ensureRoot();
    const path = sessionPath(id, sessionGuestsName);
    if (!(await E(host).has(...path))) {
      await E(host).makeDirectory(path);
    }
  };

  /**
   * @param {string} fromName
   * @param {string[]} toPath
   */
  const moveLegacyName = async (fromName, toPath) => {
    await null;
    if (!(await E(host).has(fromName))) return;
    if (await E(host).has(...toPath)) {
      // The daemon implements cross-directory moves as copy then remove.
      // If the process dies between those operations, the destination is
      // already durable, so finish that interrupted move by removing the
      // source name.
      await E(host).remove(fromName);
    } else {
      await E(host).move([fromName], toPath);
    }
  };

  /** @param {string} id */
  const migrateLegacySession = async id => {
    const path = sessionPath(id, sessionGuestsName);
    await moveLegacyName(legacyHandleName(id), [...path, sessionHandleName]);
    await moveLegacyName(legacyAgentName(id), [...path, sessionAgentName]);
  };

  /** @param {string} id */
  const provideSessionGuest = id =>
    runForSession(id, async () => {
      await ensureSessionDirectory(id);
      await migrateLegacySession(id);
      const path = sessionPath(id, sessionGuestsName);
      const handlePath = [...path, sessionHandleName];
      const agentPath = [...path, sessionAgentName];
      await E(host).provideGuest(handlePath, { agentName: agentPath });
      const guest = await E(host).lookup(agentPath);
      return harden({ guest, agentName: harden(agentPath) });
    });

  /** @param {string} id */
  const dropSessionGuest = id =>
    runForSession(id, async () => {
      const path = sessionPath(id, sessionGuestsName);
      const hasRoot = await E(host).has(sessionGuestsName);
      const hasDirectory = hasRoot && (await E(host).has(...path));
      const hasLegacyHandle = await E(host).has(legacyHandleName(id));
      const hasLegacyAgent = await E(host).has(legacyAgentName(id));
      if (!hasDirectory && !hasLegacyHandle && !hasLegacyAgent) return;

      if (!hasDirectory) {
        await ensureSessionDirectory(id);
      }
      await migrateLegacySession(id);
      if (await E(host).has(...path)) {
        // This is the one durable edge whose removal collects the directory,
        // both guest facets, the guest petstore, and all session bindings.
        await E(host).remove(...path);
      }
    });

  const listSessionGuestIds = async () => {
    await null;
    if (!(await E(host).has(sessionGuestsName))) return [];
    const names = await E(host).list(sessionGuestsName);
    return Array.isArray(names)
      ? names.filter(name => typeof name === 'string')
      : [];
  };

  return harden({
    provideSessionGuest,
    dropSessionGuest,
    listSessionGuestIds,
  });
};

/**
 * Coordinate explicit session end, expiry, and restart recovery through one
 * cleanup operation.
 *
 * `sweep()` treats a guest directory without a registry entry as an interrupted
 * deletion: the prior factory process persisted the registry removal but died
 * before it could drop the guest.
 * Expired registry entries and these crash
 * orphans both flow through `endSession()`, exactly like an explicit deletion.
 *
 * @param {object} options
 * @param {EndoHost} options.host
 * @param {() => Promise<Array<{ id: string, expiresAt?: number }>>} options.getRegistry
 * @param {(ids: string[]) => Promise<void>} options.removeRegistryEntries
 * @param {(id: string) => void | Promise<void>} [options.onCleanup]
 * @param {{ now: () => number }} options.clock
 * @param {string} [options.sessionGuestsName]
 * @param {string} [options.sessionHandleName]
 * @param {string} [options.sessionAgentName]
 */
export const makeSessionLifecycle = ({
  host,
  getRegistry,
  removeRegistryEntries,
  onCleanup = () => {},
  clock,
  sessionGuestsName,
  sessionHandleName,
  sessionAgentName,
}) => {
  const guestManager = makeSessionGuestManager(host, {
    sessionGuestsName,
    sessionHandleName,
    sessionAgentName,
  });
  /** @type {Map<string, Promise<void>>} */
  const cleanups = new Map();

  /** @param {string} id */
  const endSession = id => {
    let cleanupP = cleanups.get(id);
    if (cleanupP === undefined) {
      cleanupP = (async () => {
        await null;
        // Persist the end first.
        // If the process dies after this point, the next sweep sees the
        // now-unregistered guest directory as a crash orphan.
        await removeRegistryEntries([id]);
        await onCleanup(id);
        await guestManager.dropSessionGuest(id);
      })();
      cleanups.set(id, cleanupP);
      cleanupP.then(
        () => cleanups.delete(id),
        () => cleanups.delete(id),
      );
    }
    return cleanupP;
  };

  /** @param {number} [now] */
  const sweep = async (now = clock.now()) => {
    // List ownership before taking the registry snapshot.
    // A concurrently-created session can then appear in neither snapshot or
    // both, but never only in the owned-directory snapshot (which would
    // misclassify it as a crash orphan).
    const ownedIds = await guestManager.listSessionGuestIds();
    const registry = await getRegistry();
    const registeredIds = new Set(registry.map(entry => entry.id));
    const candidates = registry
      .filter(
        entry => typeof entry.expiresAt === 'number' && entry.expiresAt <= now,
      )
      .map(entry => entry.id);
    const candidateIds = new Set(candidates);

    for (const id of ownedIds) {
      if (!registeredIds.has(id) && !candidateIds.has(id)) {
        candidateIds.add(id);
        candidates.push(id);
      }
    }

    const results = await Promise.allSettled(candidates.map(endSession));
    const failures = results
      .filter(result => result.status === 'rejected')
      .map(result => /** @type {PromiseRejectedResult} */ (result).reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Could not reap all Floot sessions');
    }
    return harden(candidates);
  };

  return harden({
    provideSessionGuest: guestManager.provideSessionGuest,
    endSession,
    sweep,
  });
};
harden(makeSessionLifecycle);
