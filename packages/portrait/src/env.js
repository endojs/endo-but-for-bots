// @ts-check

/**
 * Persistence environments: the host-controlled registry mapping stable
 * behavior names to persistent-class binders, and the sole authority
 * consulted when a heap restores portraits back into live instances.
 *
 * Modeled on Spritely Goblins' `make-persistence-env` /
 * `persistence-env-compose`: only constructors the host explicitly
 * registered can ever run at restore time, and environments compose so
 * library packages can ship their own (see `../src/cell.js`).
 */

import harden from '@endo/harden';
import { Fail, q } from '@endo/errors';

/**
 * @import { PersistenceEnv, ClassBinder } from './types.js'
 */

/**
 * @param {object} [options]
 * @param {PersistenceEnv[]} [options.extend] Environments to inherit
 *   from. Local registrations shadow extended ones; among the extended
 *   environments, later entries win, matching Goblins'
 *   `persistence-env-compose`.
 * @returns {PersistenceEnv}
 */
export const makePersistenceEnv = ({ extend = [] } = {}) => {
  /** @type {Map<string, ClassBinder>} */
  const local = new Map();
  const extended = harden([...extend]);

  /** @param {string} name */
  const lookup = name => {
    const binder = local.get(name);
    if (binder !== undefined) {
      return binder;
    }
    for (let i = extended.length - 1; i >= 0; i -= 1) {
      const found = extended[i].lookup(name);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };

  /** @type {PersistenceEnv} */
  const env = harden({
    /** @param {string} name */
    has: name => lookup(name) !== undefined,
    lookup,
    /**
     * @param {string} name
     * @param {ClassBinder} binder
     */
    registerBinder: (name, binder) => {
      !local.has(name) ||
        Fail`persistence env already has a class named ${q(name)}`;
      local.set(name, binder);
    },
    names: () => {
      const names = new Set(local.keys());
      for (const parent of extended) {
        for (const name of parent.names()) {
          names.add(name);
        }
      }
      return harden([...names]);
    },
  });
  return env;
};
harden(makePersistenceEnv);

/**
 * Compose environments into one; later environments win on collision.
 *
 * @param {...PersistenceEnv} envs
 * @returns {PersistenceEnv}
 */
export const persistenceEnvCompose = (...envs) =>
  makePersistenceEnv({ extend: envs });
harden(persistenceEnvCompose);
