// @ts-check

/**
 * The persistent heap: boots from a store (restoring roots-outward) or
 * spawns fresh roots, assigns integer slots to persistent instances as
 * they become reachable, serializes portraits with `@endo/marshal`,
 * flushes dirty state as deltas at turn boundaries, and revives
 * sturdyref-bound instances through an ocapn-compatible locator.
 *
 * Soundness invariants (design doc §3.9):
 * - P1: portraits of the dirty set are captured synchronously at the
 *   commit point; only store I/O is deferred, and store writes are
 *   atomic and ordered.
 * - P2 (partial, pending an ocapn dispatch hook): `provideBinding`
 *   callers are expected to `await flush()` before releasing a minted
 *   sturdyref; see `./ocapn.js`.
 * - P3 (opt-in): `turn(fn)` gives copy-on-write rollback of persistent
 *   state when `fn` throws.
 */

import harden from '@endo/harden';
import { makeMarshal } from '@endo/marshal';
import { passStyleOf } from '@endo/pass-style';
import { encodeHex } from '@endo/hex';
import { Fail, X, makeError, q } from '@endo/errors';

import { getInstanceBinding } from './class.js';
import {
  BROKEN_DESIGNATOR,
  formatNearDesignator,
  isNearDesignator,
  parseNearDesignator,
  encodeSpecials,
  decodeSpecials,
} from './codec.js';

/**
 * @import { HeapOptions, PersistentHeap, Cell, StoredGraph, StoredDelta, StoredPortrait } from './types.js'
 * @import { Passable } from '@endo/pass-style'
 */

const asciiEncoder = new TextEncoder();

/** @param {string | Uint8Array} secret */
const bindingKeyFor = secret => {
  const bytes =
    typeof secret === 'string' ? asciiEncoder.encode(secret) : secret;
  return encodeHex(bytes);
};

/**
 * A promise standing in for one that did not survive persistence,
 * pre-"handled" so it does not trip unhandled-rejection reporting
 * before anyone looks at it.
 */
const makeBrokenPromise = () => {
  const broken = Promise.reject(
    makeError(X`this promise did not survive persistence`),
  );
  broken.catch(() => {});
  return harden(broken);
};

/**
 * @param {HeapOptions} options
 * @returns {Promise<PersistentHeap>}
 */
export const makePersistentHeap = async options => {
  const {
    env,
    store,
    version = 0,
    spawnRoots,
    upgradeRoots = undefined,
    persistOn = 'auto',
    specials = undefined,
    entropy = undefined,
  } = options;

  /** @type {Map<number, Cell>} */
  const slotEntries = new Map();
  let nextSlot = 0;
  /** @type {Set<Cell>} */
  const dirty = new Set();
  /** @type {Map<string, string>} secret-key hex -> near designator */
  const bindings = new Map();
  let bindingsDirty = false;
  /** @type {any} */
  let rootsValue;
  /** @type {string} */
  let heapId = 'unbooted';
  let closed = false;
  /** @type {Error | undefined} */
  let storeFailure;
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();
  let flushScheduled = false;

  // Copy-on-write turn support: a stack of stashes, one per active
  // turn. Every active turn captures a cell's baseline at the first
  // write it observes (see beforeWrite).
  /** @type {Map<Cell, Record<string, unknown>>[]} */
  const stashStack = [];

  /**
   * During portrait capture, cells to visit next. In 'full' capture
   * every referenced persistent instance is enqueued; in 'delta'
   * capture only newly adopted ones are (already-adopted referents are
   * already in the store).
   * @type {Cell[] | undefined}
   */
  let captureQueue;
  /** @type {'full' | 'delta' | undefined} */
  let captureMode;

  const assertOpen = () => {
    !closed || Fail`portrait heap is closed`;
    if (storeFailure !== undefined) {
      throw storeFailure;
    }
  };

  const heapHooks = harden({
    /** @param {Cell} cell */
    beforeWrite: cell => {
      for (const stash of stashStack) {
        if (!stash.has(cell)) {
          stash.set(cell, {
            .../** @type {Record<string, unknown>} */ (cell.data),
          });
        }
      }
    },
    /** @param {Cell} cell */
    markDirty: cell => {
      dirty.add(cell);
      // eslint-disable-next-line no-use-before-define
      scheduleFlush();
    },
  });

  /** @param {Cell} cell */
  const adoptCell = cell => {
    if (cell.slot !== undefined) {
      return false;
    }
    const registered = env.lookup(cell.binder.name);
    registered === cell.binder ||
      Fail`instance of ${q(
        cell.binder.name,
      )} is not from a class registered in this heap's env`;
    nextSlot += 1;
    cell.slot = nextSlot;
    cell.heapHooks = heapHooks;
    slotEntries.set(cell.slot, cell);
    return true;
  };

  // #region marshalling

  /** @param {any} val */
  const convertValToSlot = val => {
    const binding = getInstanceBinding(val);
    if (binding !== undefined) {
      const { cell, facetName } = binding;
      const newlyAdopted = adoptCell(cell);
      if (captureQueue !== undefined) {
        if (captureMode === 'full' || newlyAdopted) {
          captureQueue.push(cell);
        }
      } else if (newlyAdopted) {
        throw Fail`internal: adoption outside portrait capture for ${q(
          cell.binder.name,
        )}`;
      }
      return formatNearDesignator(
        /** @type {number} */ (cell.slot),
        facetName,
      );
    }
    if (passStyleOf(val) === 'promise') {
      return BROKEN_DESIGNATOR;
    }
    throw Fail`cannot persist a reference to a non-persistent remotable ${val}; the durable form of a remote capability is a sturdyref`;
  };

  /** @param {string} slotText */
  const convertSlotToVal = slotText => {
    if (slotText === BROKEN_DESIGNATOR) {
      return makeBrokenPromise();
    }
    const { slot, facetName } = parseNearDesignator(slotText);
    const cell = slotEntries.get(slot);
    cell !== undefined || Fail`no portrait for slot ${q(slotText)}`;
    if (facetName !== undefined) {
      const facets = /** @type {Record<string, unknown>} */ (
        /** @type {Cell} */ (cell).facets
      );
      (facets && facetName in facets) ||
        Fail`no facet ${q(facetName)} for slot ${q(slotText)}`;
      return facets[facetName];
    }
    return /** @type {Cell} */ (cell).self;
  };

  const marshal = makeMarshal(convertValToSlot, convertSlotToVal, {
    serializeBodyFormat: 'smallcaps',
    errorTagging: 'off',
    marshalName: 'portrait',
  });

  /** @param {Passable} value */
  const toStoredCapData = value => {
    const { body, slots } = marshal.toCapData(
      harden(encodeSpecials(value, specials)),
    );
    return harden({ body, slots });
  };

  /** @param {{ body: string, slots: string[] }} capData */
  const fromStoredCapData = capData =>
    decodeSpecials(marshal.fromCapData(harden(capData)), specials);

  /**
   * @param {Cell} cell
   * @returns {StoredPortrait}
   */
  const serializeCell = cell => {
    const { version: portraitVersion, depiction } =
      cell.binder.takePortrait(cell);
    const { body, slots } = toStoredCapData(/** @type {any} */ (depiction));
    return harden({
      name: cell.binder.name,
      version: portraitVersion,
      body,
      slots: [...slots],
    });
  };

  // #endregion

  // #region capture (synchronous — invariant P1)

  /**
   * Serialize every cell transitively enqueued, starting from `seeds`.
   *
   * @param {Iterable<Cell>} seeds
   * @param {'full' | 'delta'} mode
   * @returns {{ portraits: Record<string, StoredPortrait>, visited: Set<Cell> }}
   */
  const capturePortraits = (seeds, mode) => {
    /** @type {Record<string, StoredPortrait>} */
    const portraits = {};
    /** @type {Set<Cell>} */
    const done = new Set();
    const queue = [...seeds];
    captureMode = mode;
    while (queue.length > 0) {
      const cell = /** @type {Cell} */ (queue.shift());
      if (done.has(cell)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      done.add(cell);
      captureQueue = [];
      portraits[String(cell.slot)] = serializeCell(cell);
      queue.push(...captureQueue);
    }
    captureQueue = undefined;
    captureMode = undefined;
    return { portraits, visited: done };
  };

  /** @returns {Record<string, string>} */
  const snapshotBindings = () => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, designator] of bindings) {
      out[key] = designator;
    }
    return out;
  };

  /** @param {string} designator */
  const cellForDesignator = designator => {
    const { slot } = parseNearDesignator(designator);
    const cell = slotEntries.get(slot);
    cell !== undefined || Fail`no cell for designator ${q(designator)}`;
    return /** @type {Cell} */ (cell);
  };

  /**
   * Full reachable-graph capture from roots and bindings; unreached
   * (orphaned) instances are evicted from the slot table so a later
   * re-reference re-adopts them under a fresh slot.
   *
   * @returns {StoredGraph}
   */
  const captureGraph = () => {
    captureMode = 'full';
    captureQueue = [];
    const roots = toStoredCapData(rootsValue);
    const seeds = [...captureQueue];
    for (const designator of bindings.values()) {
      seeds.push(cellForDesignator(designator));
    }
    const { portraits, visited } = capturePortraits(seeds, 'full');
    // Sweep orphans: adopted cells that the capture did not reach.
    for (const [slot, cell] of [...slotEntries]) {
      if (!visited.has(cell)) {
        slotEntries.delete(slot);
        cell.slot = undefined;
        cell.heapHooks = undefined;
        dirty.delete(cell);
      }
    }
    dirty.clear();
    bindingsDirty = false;
    return harden({
      formatVersion: 1,
      heapId,
      rootsVersion: version,
      roots,
      portraits,
      bindings: snapshotBindings(),
    });
  };

  /**
   * Delta capture of the dirty set (invariant P1: synchronous).
   *
   * @returns {StoredDelta | undefined}
   */
  const captureDelta = () => {
    const seeds = [...dirty].filter(cell => cell.slot !== undefined);
    dirty.clear();
    const haveBindings = bindingsDirty;
    bindingsDirty = false;
    if (seeds.length === 0 && !haveBindings) {
      return undefined;
    }
    const { portraits } = capturePortraits(seeds, 'delta');
    return harden({
      portraits,
      ...(haveBindings ? { bindings: snapshotBindings() } : {}),
    });
  };

  // #endregion

  // #region write scheduling

  /** @param {() => Promise<void>} write */
  const enqueueWrite = write => {
    writeChain = writeChain.then(async () => {
      await null;
      if (storeFailure !== undefined) {
        throw storeFailure;
      }
      try {
        await write();
      } catch (err) {
        storeFailure = /** @type {Error} */ (err);
        throw err;
      }
    });
    return writeChain;
  };

  const flush = () => {
    assertOpen();
    stashStack.length === 0 ||
      Fail`cannot flush during a turn; flush after the turn commits`;
    const delta = captureDelta();
    if (delta === undefined) {
      return writeChain;
    }
    return enqueueWrite(() => store.saveDelta(delta));
  };

  const scheduleFlush = () => {
    if (persistOn !== 'auto' || flushScheduled || closed) {
      return;
    }
    flushScheduled = true;
    // Microtask boundary: after the current synchronous turn.
    void Promise.resolve().then(() => {
      flushScheduled = false;
      if (closed || storeFailure !== undefined) {
        return;
      }
      if (stashStack.length > 0) {
        // Mid-turn: the turn's commit path reschedules.
        return;
      }
      flush().catch(() => {
        // Recorded in storeFailure; surfaced on the next explicit
        // flush/close. Libraries are silent by default.
      });
    });
  };

  // #endregion

  // #region turn (invariant P3, opt-in)

  /**
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  const turn = fn => {
    assertOpen();
    /** @type {Map<Cell, Record<string, unknown>>} */
    const stash = new Map();
    stashStack.push(stash);
    try {
      const result = fn();
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof (/** @type {any} */ (result).then) === 'function'
      ) {
        // Thrown inside the try so the turn's mutations roll back: a
        // thenable means fn kicked off async work whose later
        // mutations no stash could cover.
        throw makeError(
          X`turn(fn) requires a synchronous fn; rollback across await points is unsound`,
        );
      }
      stashStack.pop();
      if (dirty.size > 0 && stashStack.length === 0) {
        scheduleFlush();
      }
      return result;
    } catch (err) {
      stashStack.pop();
      for (const [cell, data] of stash) {
        cell.data = data;
      }
      throw err;
    }
  };

  // #endregion

  // #region restore

  /** @param {StoredGraph} graph */
  const restoreFromGraph = graph => {
    heapId = graph.heapId;
    const { portraits } = graph;
    // 1. Reachability from roots and bindings, over stored designators.
    /** @type {Set<number>} */
    const reachable = new Set();
    /** @type {number[]} */
    const queue = [];
    for (const designator of graph.roots.slots) {
      if (isNearDesignator(designator)) {
        queue.push(parseNearDesignator(designator).slot);
      }
    }
    for (const designator of Object.values(graph.bindings)) {
      queue.push(parseNearDesignator(designator).slot);
    }
    while (queue.length > 0) {
      const slot = /** @type {number} */ (queue.shift());
      if (reachable.has(slot)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      reachable.add(slot);
      const portrait = portraits[String(slot)];
      portrait !== undefined ||
        Fail`store is missing the portrait for slot ${q(slot)}`;
      for (const designator of portrait.slots) {
        if (isNearDesignator(designator)) {
          queue.push(parseNearDesignator(designator).slot);
        }
      }
    }
    // 2. Hollow-create every reachable instance so near designators
    //    (including cycles) resolve before any state is decoded.
    for (const slot of reachable) {
      const portrait = portraits[String(slot)];
      const binder = env.lookup(portrait.name);
      binder !== undefined ||
        Fail`no class registered for ${q(
          portrait.name,
        )}; register it in the persistence env before restoring`;
      const cell = /** @type {import('./types.js').ClassBinder} */ (
        binder
      ).makeHollowInstance();
      cell.slot = slot;
      cell.heapHooks = heapHooks;
      slotEntries.set(slot, cell);
    }
    // Recover the slot counter past every stored slot — including
    // orphans a delta-merged store may still carry — so fresh
    // adoptions never collide with stale portraits.
    for (const slotText of Object.keys(portraits)) {
      const slot = Number(slotText);
      if (Number.isSafeInteger(slot) && slot > nextSlot) {
        nextSlot = slot;
      }
    }
    // 3. Decode, upgrade, and fill.
    for (const slot of reachable) {
      const portrait = portraits[String(slot)];
      const cell = /** @type {Cell} */ (slotEntries.get(slot));
      const depiction = fromStoredCapData({
        body: portrait.body,
        slots: portrait.slots,
      });
      const data = cell.binder.restoreData(portrait.version, depiction);
      cell.binder.fillCell(cell, data);
    }
    // 4. Roots and bindings.
    rootsValue = fromStoredCapData(graph.roots);
    for (const [key, designator] of Object.entries(graph.bindings)) {
      bindings.set(key, designator);
    }
    // Restoration side effects (fills) are not dirty.
    dirty.clear();
    bindingsDirty = false;
  };

  // #endregion

  // #region bindings and locator

  /**
   * @param {unknown} obj
   * @param {{ secret?: string | Uint8Array }} [bindingOptions]
   */
  const provideBinding = (obj, bindingOptions = {}) => {
    assertOpen();
    const binding = getInstanceBinding(obj);
    binding !== undefined ||
      Fail`only instances of persistent exo classes can be bound to sturdyref secrets`;
    let { secret } = bindingOptions;
    if (secret === undefined) {
      entropy !== undefined ||
        Fail`provideBinding needs an explicit secret or an entropy power`;
      // Goblins-compatible 24-byte random secret.
      secret = /** @type {(n: number) => Uint8Array} */ (entropy)(24);
    }
    const key = bindingKeyFor(secret);
    const { cell, facetName } = /** @type {NonNullable<typeof binding>} */ (
      binding
    );
    const existing = bindings.get(key);
    if (existing !== undefined) {
      (cell.slot !== undefined &&
        existing === formatNearDesignator(cell.slot, facetName)) ||
        Fail`binding secret already in use for a different object`;
      return secret;
    }
    if (cell.slot === undefined) {
      adoptCell(cell);
      // Ensure the newly adopted instance's portrait (and its
      // referents) land in the next delta.
      dirty.add(cell);
    }
    bindings.set(
      key,
      formatNearDesignator(/** @type {number} */ (cell.slot), facetName),
    );
    bindingsDirty = true;
    scheduleFlush();
    return secret;
  };

  /** @param {string | Uint8Array} secret */
  const lookupBinding = secret => {
    const designator = bindings.get(bindingKeyFor(secret));
    if (designator === undefined) {
      return undefined;
    }
    return convertSlotToVal(designator);
  };

  const locator = harden({
    /** @param {string | Uint8Array} secret */
    get: secret => lookupBinding(secret),
  });

  // #endregion

  // #region boot

  const graph = await store.graphAndSlots();
  if (graph !== undefined) {
    graph.formatVersion === 1 ||
      Fail`unsupported stored graph format ${q(graph.formatVersion)}`;
    graph.rootsVersion <= version ||
      Fail`stored roots version ${q(
        graph.rootsVersion,
      )} is newer than heap version ${q(version)}`;
    graph.rootsVersion === version ||
      upgradeRoots !== undefined ||
      Fail`stored roots version ${q(graph.rootsVersion)} needs ${q(
        'upgradeRoots',
      )} to reach version ${q(version)}`;
    restoreFromGraph(graph);
    if (graph.rootsVersion !== version) {
      rootsValue = harden(
        /** @type {NonNullable<typeof upgradeRoots>} */ (upgradeRoots)(
          graph.rootsVersion,
          rootsValue,
        ),
      );
      const upgraded = captureGraph();
      await enqueueWrite(() => store.saveGraph(upgraded));
    }
  } else {
    heapId = entropy !== undefined ? encodeHex(entropy(16)) : 'local';
    rootsValue = harden(spawnRoots());
    const initial = captureGraph();
    await enqueueWrite(() => store.saveGraph(initial));
  }

  // #endregion

  const takeSnapshot = () => {
    assertOpen();
    stashStack.length === 0 || Fail`cannot snapshot during a turn`;
    const full = captureGraph();
    return enqueueWrite(() => store.saveGraph(full));
  };

  const close = async () => {
    await null;
    if (closed) {
      return;
    }
    /** @type {Promise<void>} */
    let final = writeChain;
    if (storeFailure === undefined) {
      try {
        final = flush();
      } catch (_err) {
        final = writeChain;
      }
    }
    closed = true;
    try {
      await final;
    } finally {
      await store.close();
    }
  };

  /** @type {PersistentHeap} */
  const heap = harden({
    roots: rootsValue,
    heapId,
    flush,
    takeSnapshot,
    turn,
    provideBinding,
    lookupBinding,
    locator,
    close,
  });
  return heap;
};
harden(makePersistentHeap);
