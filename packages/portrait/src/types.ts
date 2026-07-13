/* eslint-disable no-use-before-define, @typescript-eslint/no-explicit-any */
import type { CopyTagged } from '@endo/pass-style';

/**
 * A stable, fully qualified behavior name: module specifier + '#' +
 * export name, e.g. `'@endo/portrait/cell.js#makeValueCell'`.
 */
export type BehaviorName = string;

/**
 * The mutable backing cell behind one persistent instance. The sealed
 * accessor state record read/written by exo methods delegates here, so
 * the heap can observe writes (dirty tracking, copy-on-write turns)
 * and fill state after hollow creation during restore.
 */
export interface Cell {
  binder: ClassBinder;
  /** Backing state data; undefined while hollow during restore. */
  data: Record<string, unknown> | undefined;
  /** Sealed accessor record exposed to methods as `this.state`. */
  stateRecord: Record<string, unknown> | undefined;
  /** Single-facet instance, if not a kit. */
  self: unknown;
  /** Facet record, if a kit. */
  facets: Record<string, unknown> | undefined;
  /** Portrait-graph slot; undefined until adopted by a heap. */
  slot: number | undefined;
  /** Hooks installed at adoption by the owning heap. */
  heapHooks: HeapHooks | undefined;
}

export interface HeapHooks {
  /** Called before a state-record property assignment lands. */
  beforeWrite: (cell: Cell) => void;
  /** Called after a state-record property assignment lands. */
  markDirty: (cell: Cell) => void;
}

export interface InstanceBinding {
  binder: ClassBinder;
  cell: Cell;
  /** Present when the bound value is one facet of a kit. */
  facetName?: string;
}

/**
 * Internal per-class handle registered in a persistence env. Produced
 * by `definePersistentExoClass` and consumed by heaps; not part of the
 * public API surface beyond identity checks.
 */
export interface ClassBinder {
  name: BehaviorName;
  version: number;
  /** Create an instance without running init; state filled later. */
  makeHollowInstance: () => Cell;
  /** Install restored state data into a hollow cell. */
  fillCell: (cell: Cell, data: Record<string, unknown>) => void;
  /** Snapshot a cell's durable depiction. */
  takePortrait: (cell: Cell) => { version: number; depiction: unknown };
  /**
   * Convert a decoded stored depiction (possibly older-versioned)
   * into current state data, applying stepwise upgrades.
   */
  restoreData: (
    storedVersion: number,
    depiction: unknown,
  ) => Record<string, unknown>;
}

export interface PersistenceEnv {
  has: (name: BehaviorName) => boolean;
  lookup: (name: BehaviorName) => ClassBinder | undefined;
  registerBinder: (name: BehaviorName, binder: ClassBinder) => void;
  names: () => BehaviorName[];
}

export interface PersistentClassOptions {
  /** Portrait format version for this class; default 0. */
  version?: number;
  /** Custom depiction: receives the live state record. */
  portrait?: (state: any) => unknown;
  /**
   * Custom rehydrator from an (already upgraded) depiction to state
   * data. Default: the depiction is the state record.
   */
  restore?: (version: number, depiction: any) => Record<string, unknown>;
  /** Stepwise migrations keyed by the version they upgrade FROM. */
  upgrade?: Record<number, (depiction: any) => unknown>;
  /** Pattern checked against the state data at portrait and fill. */
  stateShape?: unknown;
  /**
   * Called after creation, as with exo classes: receives
   * `{ self, state }` (single facet) or `{ facets, state }` (kit).
   */
  finish?: (context: any) => void;
}

/** Serialized form of one instance's state. */
export interface StoredPortrait {
  name: BehaviorName;
  version: number;
  body: string;
  slots: string[];
}

export interface StoredGraph {
  formatVersion: 1;
  heapId: string;
  rootsVersion: number;
  roots: { body: string; slots: string[] };
  portraits: Record<string, StoredPortrait>;
  /** Sturdyref bindings: hex(secret bytes) -> near designator. */
  bindings: Record<string, string>;
}

export interface StoredDelta {
  portraits: Record<string, StoredPortrait>;
  bindings?: Record<string, string>;
}

export interface PortraitStore {
  /** The last committed graph (deltas applied), or undefined. */
  graphAndSlots: () => Promise<StoredGraph | undefined>;
  /** One stored portrait, for lazy wake. */
  objectPortrait: (slot: number) => Promise<StoredPortrait | undefined>;
  saveGraph: (graph: StoredGraph) => Promise<void>;
  saveDelta: (delta: StoredDelta) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Hooks for durably encoding tagged values the portrait layer does not
 * itself understand — today, OCapN sturdyrefs (see `./ocapn.js`).
 */
export interface SpecialsCodec {
  /** Return a durable replacement tagged, or undefined to pass through. */
  encodeTagged: (tagged: CopyTagged) => CopyTagged | undefined;
  /** Invert encodeTagged; undefined to pass through. */
  decodeTagged: (tagged: CopyTagged) => unknown | undefined;
}

export interface HeapOptions {
  env: PersistenceEnv;
  store: PortraitStore;
  /** Roots-graph version; default 0. */
  version?: number;
  /** Runs only on first boot (empty store). */
  spawnRoots: () => unknown;
  /** Reshapes restored roots when stored rootsVersion < version. */
  upgradeRoots?: (storedVersion: number, roots: any) => unknown;
  /** 'auto': flush at a microtask boundary after any write. */
  persistOn?: 'auto' | 'manual';
  specials?: SpecialsCodec;
  /** Entropy for minting binding secrets and the heap id. */
  entropy?: (byteLength: number) => Uint8Array;
}

export interface PersistentHeap {
  roots: any;
  heapId: string;
  /** Serialize dirty state now; resolves when durably written. */
  flush: () => Promise<void>;
  /** Full compacting snapshot; drops orphaned portraits. */
  takeSnapshot: () => Promise<void>;
  /** Run fn as a rollback turn: on throw, persistent state reverts. */
  turn: <T>(fn: () => T) => T;
  /** Mint (or accept) a sturdyref secret bound to a persistent obj. */
  provideBinding: (
    obj: unknown,
    options?: { secret?: string | Uint8Array },
  ) => string | Uint8Array;
  /** Resolve a binding secret to its live instance, if bound. */
  lookupBinding: (secret: string | Uint8Array) => unknown;
  /** An ocapn-compatible locator facade over lookupBinding. */
  locator: { get: (secret: string | Uint8Array) => unknown };
  close: () => Promise<void>;
}
