// @ts-check
/**
 * The asset server's durable store, over the pet store of an Endo host agent
 * that belongs to the server alone.
 *
 * This is what makes the server a retention root. A served item is two names
 * in that pet store: `asset-target-<id>`, the retained read-only facet, and
 * `asset-mount-<id>`, the record of its route. While the names stand, the
 * daemon keeps the facet's formula and everything it depends on, and revives
 * it for the next incarnation of the server, which restores the route from
 * the record without anyone publishing again. Removing the names is the only
 * way an item ends.
 *
 * Taking the read-only facet is the daemon's job where the daemon can do it:
 * a Mount (or the worktree of a Git workspace) becomes a read-only sub-mount
 * formula minted by `provideSubMount`, which is durable and which the daemon
 * will not let widen. A Filesystem has no daemon-side attenuator, so the
 * capability is retained as given and only ever reached through the
 * read-only attenuator; hand the server a Filesystem that is already
 * read-only when that distinction matters.
 *
 * A capability the daemon did not mint has no formula, cannot be named, and
 * is refused: serving it would work until the next restart and then silently
 * stop, which is the failure this store exists to end.
 */

import { E } from '@endo/eventual-send';
import { makeError, X, q } from '@endo/errors';
import { readOnly as readOnlyFilesystem } from '@endo/platform/fs/extended/readonly.js';

/** @import { AssetStore, AssetRecord, AssetKind } from './asset-server.js' */

const RECORD_PREFIX = 'asset-mount-';
const TARGET_PREFIX = 'asset-target-';
const ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * @param {object} powers  an Endo host agent: `provideSubMount`, `storeValue`,
 *   `lookup`, `list`, `has`, `remove`.
 * @returns {AssetStore}
 */
export const makeEndoAssetStore = powers => {
  /** @param {string} id */
  const assertId = id => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw makeError(X`invalid asset id ${q(id)}`);
    }
  };

  /** @param {string} name */
  const removeIfPresent = async name => {
    if (await E(powers).has(name)) {
      await E(powers).remove(name);
    }
  };

  /**
   * @param {object} facet
   * @param {AssetKind} kind
   */
  const attenuate = (facet, kind) =>
    kind === 'filesystem' ? readOnlyFilesystem(facet) : facet;

  return harden({
    retain: async (id, target, kind) => {
      assertId(id);
      const name = `${TARGET_PREFIX}${id}`;
      try {
        if (kind === 'filesystem') {
          await E(powers).storeValue(target, name);
          return attenuate(target, kind);
        }
        const mount = kind === 'git' ? await E(target).worktree() : target;
        // The empty sub-path is the whole tree; `readOnly` is what is asked
        // for. The daemon names the new formula in the same critical section
        // that creates it, so there is no moment at which it is unretained.
        return await E(powers).provideSubMount(mount, [], name, {
          readOnly: true,
        });
      } catch (cause) {
        await removeIfPresent(name).catch(() => {});
        throw makeError(
          X`the asset server can only serve a capability it can retain, and it could not retain this ${q(kind)}: ${q(/** @type {Error} */ (cause)?.message || String(cause))}. Pass the daemon-minted capability itself, not a view derived from it; the server takes its own read-only facet.`,
        );
      }
    },
    record: async record => {
      assertId(record.id);
      await E(powers).storeValue(record, `${RECORD_PREFIX}${record.id}`);
    },
    load: async () => {
      const names = /** @type {string[]} */ (await E(powers).list());
      /** @type {AssetRecord[]} */
      const records = [];
      for (const name of names) {
        if (
          typeof name === 'string' &&
          name.startsWith(RECORD_PREFIX) &&
          ID_PATTERN.test(name.slice(RECORD_PREFIX.length))
        ) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const record = await E(powers).lookup(name);
            // A record that does not name itself is not trusted to name a
            // route either.
            if (record?.id === name.slice(RECORD_PREFIX.length)) {
              records.push(record);
            }
          } catch (_cause) {
            // An unreadable record restores nothing; it stays in the store
            // for the operator to look at.
          }
        }
      }
      return records;
    },
    recall: async (id, kind) => {
      assertId(id);
      return attenuate(await E(powers).lookup(`${TARGET_PREFIX}${id}`), kind);
    },
    release: async id => {
      assertId(id);
      // The record first: a half-released item must not come back as a route.
      await removeIfPresent(`${RECORD_PREFIX}${id}`);
      await removeIfPresent(`${TARGET_PREFIX}${id}`);
    },
  });
};
harden(makeEndoAssetStore);
