// @ts-check

/** @import { DynamoControl, GrantStore, Result, Derived, RootRestriction } from '../types.js' */

import { makeDynamoControl } from './control.js';

/**
 * An in-memory grant store, for tests and for hosts that wrap it in their own
 * durable persistence. Recipes and tombstones are the only state; it never
 * holds credentials or cursors.
 *
 * @returns {GrantStore & { snapshot: () => { recipes: [string, RootRestriction][], tombstones: string[] } }}
 */
export const makeMemoryGrantStore = () => {
  /** @type {Map<string, RootRestriction>} */
  const recipes = new Map();
  /** @type {Set<string>} */
  const tombstones = new Set();
  return harden({
    putRecipe(name, restriction) {
      recipes.set(name, harden(restriction));
    },
    putTombstone(name) {
      tombstones.add(name);
    },
    listRecipes() {
      return harden([...recipes.entries()]);
    },
    listTombstones() {
      return harden([...tombstones]);
    },
    snapshot() {
      return harden({
        recipes: [...recipes.entries()],
        tombstones: [...tombstones],
      });
    },
  });
};
harden(makeMemoryGrantStore);

/**
 * Start a new broker generation from durable state, in the order section 6 of
 * the design requires: read every tombstone before the generation exists,
 * then rebuild only live named grants. The caller binds the returned facets
 * into powers directories before it starts any confined caplet.
 *
 * @param {Parameters<typeof makeDynamoControl>[0] & { grantStore: GrantStore, previous?: DynamoControl }} powers
 * @returns {Promise<{ control: DynamoControl, named: Readonly<Record<string, Result<Derived>>> }>}
 */
export const reincarnateDynamoControl = async powers => {
  const { grantStore, previous, ...rest } = powers;
  if (previous !== undefined) await previous.retire();
  const tombstones = new Set(await grantStore.listTombstones());
  const recipes = [...(await grantStore.listRecipes())];
  const control = makeDynamoControl({ ...rest, grantStore, tombstones });
  /** @type {Record<string, Result<Derived>>} */
  const named = {};
  for (const [name, restriction] of recipes) {
    if (!tombstones.has(name)) {
      // eslint-disable-next-line no-await-in-loop
      named[name] = await control.derive(restriction, harden({ name }));
    }
  }
  return harden({ control, named: harden(named) });
};
harden(reincarnateDynamoControl);
