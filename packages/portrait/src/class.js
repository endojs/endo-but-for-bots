// @ts-check

/**
 * Persistent exo classes.
 *
 * `definePersistentExoClass` wraps `defineExoClass` so that instance
 * state lives in a backing cell owned by this layer rather than in the
 * exo contextMap: methods still read and write `this.state`, but the
 * state record is a sealed accessor record delegating to the cell, so
 * a heap can observe writes (dirty tracking, copy-on-write turns) and
 * can create instances hollow — without running `init` — during
 * restore, filling state afterward. `init` runs exactly once, ever, at
 * first creation; on every later revival the instance is rebuilt from
 * its portrait.
 */

import harden from '@endo/harden';
import { objectMap } from '@endo/common/object-map.js';
import { defineExoClass, defineExoClassKit, initEmpty } from '@endo/exo';
import { Fail, q } from '@endo/errors';
import { mustMatch } from '@endo/patterns';

/**
 * @import { PersistenceEnv, PersistentClassOptions, ClassBinder, Cell, InstanceBinding, BehaviorName } from './types.js'
 * @import { Passable } from '@endo/pass-style'
 */

const { apply, ownKeys } = Reflect;
const { defineProperty, seal, freeze, keys: objectKeys } = Object;

/** @type {WeakMap<any, InstanceBinding>} */
const instanceBindings = new WeakMap();

/**
 * Look up the persistence binding for a value, if it is an instance
 * (or kit facet) of a persistent exo class.
 *
 * @param {unknown} value
 * @returns {InstanceBinding | undefined}
 */
export const getInstanceBinding = value => instanceBindings.get(value);
harden(getInstanceBinding);

/**
 * @param {BehaviorName} name
 * @returns {string} the exo tag: the export-name segment of the
 *   behavior name, for friendlier debug output.
 */
const tagFromName = name => {
  const hash = name.lastIndexOf('#');
  return hash >= 0 ? name.slice(hash + 1) : name;
};

/**
 * Build the sealed accessor record that methods see as `this.state`,
 * delegating reads and writes to `cell.data` so the owning heap can
 * interpose.
 *
 * @param {Cell} cell
 */
const makeStateRecord = cell => {
  const { data } = cell;
  if (data === undefined) {
    throw Fail`internal: cannot make state record for hollow cell`;
  }
  /** @type {Record<string, unknown>} */
  const record = {};
  for (const key of objectKeys(data)) {
    defineProperty(record, key, {
      get: () => /** @type {Record<string, unknown>} */ (cell.data)[key],
      set: value => {
        if (cell.heapHooks) {
          cell.heapHooks.beforeWrite(cell);
        }
        /** @type {Record<string, unknown>} */ (cell.data)[key] = value;
        if (cell.heapHooks) {
          cell.heapHooks.markDirty(cell);
        }
      },
      enumerable: true,
      configurable: false,
    });
  }
  seal(record);
  cell.stateRecord = record;
  return record;
};

/**
 * @param {Record<string, unknown>} data
 * @param {unknown} [stateShape]
 * @param {BehaviorName} [name]
 */
const checkStateShape = (data, stateShape, name) => {
  if (stateShape !== undefined) {
    mustMatch(
      harden({ ...data }),
      /** @type {any} */ (stateShape),
      `state of ${name}`,
    );
  }
};

/**
 * Shared portrait/restore/upgrade logic for both the single-facet and
 * kit definers.
 *
 * @param {BehaviorName} name
 * @param {PersistentClassOptions} options
 */
const makePortraitKit = (name, options) => {
  const {
    version = 0,
    portrait = undefined,
    restore = undefined,
    upgrade = harden({}),
    stateShape = undefined,
  } = options;

  /** @param {Cell} cell */
  const takePortrait = cell => {
    const depiction = portrait
      ? portrait(/** @type {Record<string, unknown>} */ (cell.stateRecord))
      : harden({ .../** @type {Record<string, unknown>} */ (cell.data) });
    return harden({ version, depiction });
  };

  /**
   * @param {number} storedVersion
   * @param {unknown} depiction
   * @returns {Record<string, unknown>}
   */
  const restoreData = (storedVersion, depiction) => {
    let v = storedVersion;
    let d = depiction;
    v <= version ||
      Fail`stored portrait of ${q(name)} has version ${q(
        storedVersion,
      )}, newer than class version ${q(version)}`;
    while (v < version) {
      const step = upgrade[v];
      step !== undefined ||
        Fail`no upgrade step from version ${q(v)} for ${q(name)}`;
      d = step(d);
      v += 1;
    }
    const data = restore
      ? restore(v, d)
      : /** @type {Record<string, unknown>} */ (d);
    (data !== null && typeof data === 'object' && !Array.isArray(data)) ||
      Fail`restored state of ${q(name)} must be a record`;
    checkStateShape(
      /** @type {Record<string, unknown>} */ (data),
      stateShape,
      name,
    );
    return /** @type {Record<string, unknown>} */ (data);
  };

  return { version, stateShape, takePortrait, restoreData };
};

/**
 * Define a persistent exo class registered in `env` under `name`.
 *
 * The default portrait is a shallow snapshot of the state record and
 * the default restore treats the (upgraded) depiction as the state
 * record, so classes whose state is Passable data plus persistent
 * references need no custom options.
 *
 * @template {(...args: any[]) => Record<string, unknown>} I
 * @template {Record<string, (...args: any[]) => any>} M
 * @param {PersistenceEnv} env
 * @param {BehaviorName} name
 * @param {any} interfaceGuard
 * @param {I} init
 * @param {M & ThisType<{ self: any, state: any }>} methods
 * @param {PersistentClassOptions} [options]
 * @returns {(...args: Parameters<I>) => any}
 */
export const definePersistentExoClass = (
  env,
  name,
  interfaceGuard,
  init,
  methods,
  options = {},
) => {
  const { finish = undefined } = options;
  const { version, stateShape, takePortrait, restoreData } = makePortraitKit(
    name,
    options,
  );

  const wrappedMethods = objectMap(
    /** @type {Record<string, (...args: any[]) => any>} */ (methods),
    method =>
      /** @type {any} */ (
        /** @this {{ self: any }} */
        function wrapped(...args) {
          const binding = instanceBindings.get(this.self);
          if (!binding || binding.cell.stateRecord === undefined) {
            throw Fail`internal: no state for ${q(name)} instance`;
          }
          const context = freeze({
            self: this.self,
            state: binding.cell.stateRecord,
          });
          return apply(method, context, args);
        }
      ),
  );

  const makeInternal = defineExoClass(
    tagFromName(name),
    interfaceGuard,
    initEmpty,
    wrappedMethods,
  );

  /** @type {ClassBinder} */
  let binder;

  /** @param {Record<string, unknown> | undefined} data */
  const makeCell = data => {
    /** @type {Cell} */
    const cell = {
      binder,
      data,
      stateRecord: undefined,
      self: undefined,
      facets: undefined,
      slot: undefined,
      heapHooks: undefined,
    };
    return cell;
  };

  binder = harden({
    name,
    version,
    makeHollowInstance: () => {
      const self = makeInternal();
      const cell = makeCell(undefined);
      cell.self = self;
      instanceBindings.set(self, freeze({ binder, cell }));
      return cell;
    },
    /**
     * @param {Cell} cell
     * @param {Record<string, unknown>} data
     */
    fillCell: (cell, data) => {
      cell.data = { ...data };
      makeStateRecord(cell);
    },
    takePortrait,
    restoreData,
  });

  env.registerBinder(name, binder);

  /** @param {Parameters<I>} args */
  const make = (...args) => {
    const data = { ...init(...args) };
    checkStateShape(data, stateShape, name);
    const self = makeInternal();
    const cell = makeCell(data);
    cell.self = self;
    instanceBindings.set(self, freeze({ binder, cell }));
    makeStateRecord(cell);
    if (finish) {
      finish(
        freeze({
          self,
          state: /** @type {Record<string, unknown>} */ (cell.stateRecord),
        }),
      );
    }
    return self;
  };
  return harden(make);
};
harden(definePersistentExoClass);

/**
 * Kit sibling of `definePersistentExoClass`: one shared state cell,
 * multiple facets. Facets are individually persistable references;
 * their designators record both the shared slot and the facet name.
 *
 * @template {(...args: any[]) => Record<string, unknown>} I
 * @template {Record<string, Record<string, (...args: any[]) => any>>} F
 * @param {PersistenceEnv} env
 * @param {BehaviorName} name
 * @param {any} interfaceGuardKit
 * @param {I} init
 * @param {F & ThisType<{ facets: any, state: any }>} methodsKit
 * @param {PersistentClassOptions} [options]
 * @returns {(...args: Parameters<I>) => any}
 */
export const definePersistentExoClassKit = (
  env,
  name,
  interfaceGuardKit,
  init,
  methodsKit,
  options = {},
) => {
  const { finish = undefined } = options;
  const { version, stateShape, takePortrait, restoreData } = makePortraitKit(
    name,
    options,
  );
  const facetNames = /** @type {string[]} */ (ownKeys(methodsKit));
  facetNames.length > 0 || Fail`kit ${q(name)} must have at least one facet`;
  const firstFacet = facetNames[0];

  const wrappedMethodsKit = objectMap(
    /** @type {Record<string, Record<string, (...args: any[]) => any>>} */ (
      methodsKit
    ),
    facetMethods =>
      objectMap(
        facetMethods,
        method =>
          /** @type {any} */ (
            /** @this {{ facets: Record<string, any> }} */
            function wrapped(...args) {
              const binding = instanceBindings.get(this.facets[firstFacet]);
              if (!binding || binding.cell.stateRecord === undefined) {
                throw Fail`internal: no state for ${q(name)} kit`;
              }
              const context = freeze({
                facets: this.facets,
                state: binding.cell.stateRecord,
              });
              return apply(method, context, args);
            }
          ),
      ),
  );

  const makeInternalKit = defineExoClassKit(
    tagFromName(name),
    interfaceGuardKit,
    initEmpty,
    wrappedMethodsKit,
  );

  /** @type {ClassBinder} */
  let binder;

  /** @param {Record<string, unknown> | undefined} data */
  const makeKitCell = data => {
    /** @type {Cell} */
    const cell = {
      binder,
      data,
      stateRecord: undefined,
      self: undefined,
      facets: undefined,
      slot: undefined,
      heapHooks: undefined,
    };
    const facets = makeInternalKit();
    cell.facets = facets;
    for (const facetName of facetNames) {
      instanceBindings.set(
        facets[facetName],
        freeze({ binder, cell, facetName }),
      );
    }
    return cell;
  };

  binder = harden({
    name,
    version,
    makeHollowInstance: () => makeKitCell(undefined),
    /**
     * @param {Cell} cell
     * @param {Record<string, unknown>} data
     */
    fillCell: (cell, data) => {
      cell.data = { ...data };
      makeStateRecord(cell);
    },
    takePortrait,
    restoreData,
  });

  env.registerBinder(name, binder);

  /** @param {Parameters<I>} args */
  const makeKit = (...args) => {
    const data = { ...init(...args) };
    checkStateShape(data, stateShape, name);
    const cell = makeKitCell(data);
    makeStateRecord(cell);
    if (finish) {
      finish(
        freeze({
          facets: /** @type {Record<string, unknown>} */ (cell.facets),
          state: /** @type {Record<string, unknown>} */ (cell.stateRecord),
        }),
      );
    }
    return cell.facets;
  };
  return harden(makeKit);
};
harden(definePersistentExoClassKit);
