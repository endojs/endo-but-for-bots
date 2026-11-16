// @ts-check
import harden from '@endo/harden';
import { parseId } from '@endo/daemon/formula-identifier.js';
import { E } from '@endo/eventual-send';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { EndoHost } from '@endo/daemon' */

/** @type {WeakMap<object, Promise<string[]>>} */
const paths = new WeakMap();

/**
 * Hosts may inherit `@pins`, so saved configuration must also be scoped by the
 * host's stable self handle. `@host` can instead identify the parent host.
 * @param {ERef<EndoHost>} powers
 * @returns {Promise<string[]>}
 */
export const spacesStoragePath = powers => {
  let result = paths.get(powers);
  if (!result) {
    result = (async () => {
      const identifier = await E(powers).identify('@self');
      if (typeof identifier !== 'string')
        throw Error('Chat host has no self identity');
      const { number } = parseId(identifier);
      return harden(['@pins', 'installations', 'chat', number, 'spaces']);
    })();
    paths.set(powers, result);
    void result.catch(() => paths.delete(powers));
  }
  return result;
};
harden(spacesStoragePath);

/** @typedef {ReturnType<EndoHost['provideDirectory']>} StoragePromise */
/** @type {WeakMap<object, StoragePromise>} */
const pending = new WeakMap();

/**
 * Chat configuration belongs to its installation. The host serializes this
 * operation across clients and adopts the original directory without replacing
 * it. A conflicting legacy directory is an error, never an empty saved list.
 * @param {ERef<EndoHost>} powers
 * @returns {StoragePromise}
 */
export const provideSpacesStorage = powers => {
  let result = pending.get(powers);
  if (!result) {
    result = (async () => {
      const storagePath = await spacesStoragePath(powers);
      return E(powers).provideDirectory(storagePath, {
        adoptFrom: ['spaces'],
      });
    })();
    pending.set(powers, result);
    // Share only concurrent work. Recheck on later operations so a stale
    // browser recreating root spaces produces a visible conflict, not a split
    // configuration that a new client silently ignores.
    void result.then(
      () => pending.delete(powers),
      () => pending.delete(powers),
    );
  }
  return result;
};
harden(provideSpacesStorage);
