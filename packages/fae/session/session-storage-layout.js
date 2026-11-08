// @ts-check
/* eslint-disable no-await-in-loop -- Identity-checked migration is ordered. */
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

export const SESSION_STORAGE_ROOT = 'floot-private-sessions';
harden(SESSION_STORAGE_ROOT);
export const SESSION_CONTROL_NAMES = harden([
  'handle',
  'guest',
  'environment-admin',
  'environment-shell',
  'pending',
  'scratch-temp',
  'git-temp',
  'code-mount-temp',
]);
harden(SESSION_CONTROL_NAMES);

/** @param {string} id @param {string} [leaf] */
export const sessionStoragePath = (id, leaf = undefined) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw Error('Invalid session identity');
  return harden([
    SESSION_STORAGE_ROOT,
    id,
    ...(leaf === undefined ? [] : [leaf]),
  ]);
};
harden(sessionStoragePath);

/** @param {string} id */
const oldBindings = id => [
  [`session-${id}`, 'handle'],
  [`session-agent-${id}`, 'guest'],
  [`floot-environment-admin-${id}`, 'environment-admin'],
  [`floot-environment-shell-${id}`, 'environment-shell'],
  [`floot-pending-${id.length}-${id}`, 'pending'],
  [`_floot-scratch-${id}`, 'scratch-temp'],
  [`_floot-git-${id}`, 'git-temp'],
  [`_floot-codemount-${id}`, 'code-mount-temp'],
];

/** @type {WeakMap<object, Map<string, Promise<boolean>>>} */
const migrations = new WeakMap();

/** Drop a completed layout barrier only when its owned directory is retired.
 * @param {any} host @param {string} id
 */
export const forgetSessionStorage = (host, id) =>
  migrations.get(host)?.delete(id);
harden(forgetSessionStorage);

/**
 * One barrier for guest revival, environment administration, and queue recovery.
 * Adopt only exact legacy bindings into an already-owned schema-checked session
 * directory. All collisions are checked before any removal. Copy acknowledgments
 * may be lost; matching aliases are safe to retry, differing aliases never merge.
 * A missing retired directory is allowed only when no legacy resources remain.
 * @param {any} host @param {string} id
 * @returns {Promise<boolean>} whether the owned directory still exists
 */
export const prepareSessionStorage = (host, id) => {
  const root = sessionStoragePath(id);
  let sessions = migrations.get(host);
  if (!sessions) {
    sessions = new Map();
    migrations.set(host, sessions);
  }
  let pending = sessions.get(id);
  if (!pending) {
    pending = (async () => {
      const legacy = oldBindings(id);
      const exists =
        (await E(host).has(SESSION_STORAGE_ROOT)) &&
        (await E(host).has(...root));
      if (!exists) {
        for (const [name] of legacy) {
          if (await E(host).has(name))
            throw Error(
              'Private journal schema missing; session reset required; retain legacy resources for recovery',
            );
        }
        return false;
      }
      const schema = await E(host).lookup([...root, 'schema']);
      if (
        schema?.version !== 2 ||
        schema.sessionId !== id ||
        Reflect.ownKeys(schema).length !== 2
      )
        throw Error('Invalid private journal schema; session reset required');
      const moves = [];
      for (const [from, leaf] of legacy) {
        if (await E(host).has(from)) {
          const to = sessionStoragePath(id, leaf);
          const source = await E(host).identify(from);
          const target = (await E(host).has(...to))
            ? await E(host).identify(...to)
            : undefined;
          if (!source || (target && target !== source))
            throw Error('Conflicting session storage bindings');
          moves.push({ from, to, source });
        }
      }
      for (const { from, to, source } of moves) {
        if ((await E(host).identify(from)) !== source)
          throw Error('Session storage source changed');
        if (!(await E(host).has(...to))) await E(host).copy([from], to);
        if (
          (await E(host).identify(from)) !== source ||
          (await E(host).identify(...to)) !== source
        )
          throw Error('Session storage changed during migration');
        await E(host).remove(from);
      }
      return true;
    })();
    sessions.set(id, pending);
    const map = sessions;
    void pending.then(
      exists => {
        if (!exists) map.delete(id);
      },
      () => map.delete(id),
    );
  }
  return pending;
};
harden(prepareSessionStorage);

/** A restricted name adapter keeps queue logic and its recovery format intact.
 * @param {any} host @param {string} id
 */
export const makeSessionQueueStorage = (host, id) => {
  const path = sessionStoragePath(id, 'pending');
  const expected = `floot-pending-${id.length}-${id}`;
  const check = name => {
    if (name !== expected) throw Error('Invalid session queue record');
  };
  return Far('SessionQueueStorage', {
    has: async name => {
      check(name);
      return (await prepareSessionStorage(host, id)) && E(host).has(...path);
    },
    lookup: async name => {
      check(name);
      if (!(await prepareSessionStorage(host, id)))
        throw Error('Session storage is retired');
      return E(host).lookup(path);
    },
    storeValue: async (value, name) => {
      check(name);
      if (!(await prepareSessionStorage(host, id)))
        throw Error('Session storage is retired');
      await E(host).storeValue(value, path);
    },
    remove: async name => {
      check(name);
      if (await prepareSessionStorage(host, id)) await E(host).remove(...path);
    },
  });
};
harden(makeSessionQueueStorage);
