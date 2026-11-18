// @ts-check
/**
 * The operator inventory (M5 W5.1; `designs/m5-interfaces.md` section 2.2;
 * P-52 mapping rows, R3-274).
 *
 * One per factory, in the factory vat's heap: the objects the operator has
 * chosen to keep under labels (human text, F.2 a), at most
 * `maxInventoryEntries`. It is never given to a session (section 6); a
 * preset's endowments and a message's attachments are values the operator
 * read from it.
 *
 * `entries: Map<InventoryEntry, { label, value }>` keeps insertion order;
 * `byLabel` keeps labels unique. A page's cursor is the position `i<n>`
 * (F.2 d); `rev` rises with every change (M12's Home feed reads it).
 * Removing an entry does not revoke its object anywhere it was given
 * (R3-274); afterwards the entry's methods throw `texts.entryRemoved`.
 *
 * Guest rules: prelude globals only; no sends.
 */
import { limits } from '../lib/limits.js';
import {
  m5FactoryInterfaces,
  texts,
  textOf,
} from '../lib/interfaces-m5-factory.js';
import { isEdgeLabel } from '../lib/preset-catalog.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * An inventory cursor the inventory did not issue (a harness text; the
 * contract's texts name none).
 */
export const UNKNOWN_CURSOR_TEXT = 'Unknown inventory cursor';

/**
 * The cursor of the page that starts at `position` (F.2 d).
 * @param {number} position
 */
const cursorAt = position => `i${position}`;

/**
 * @param {string | undefined} cursor
 * @returns {number}
 */
const positionOf = cursor => {
  if (cursor === undefined) return 0;
  const digits = cursor.slice(1);
  if (cursor[0] !== 'i' || !/^(0|[1-9][0-9]{0,5})$/.test(digits))
    throw Error(UNKNOWN_CURSOR_TEXT);
  return Number(digits);
};

export const makeInventory = () => {
  /** @type {Map<any, { label: string, value: any }>} */
  const entries = new Map();
  /** @type {Map<string, any>} */
  const byLabel = new Map();
  let rev = 0;

  /** @param {string} label */
  const assertLabel = label => {
    if (!isEdgeLabel(label)) throw Error(textOf.reservedEndowment(label));
  };

  /** @param {any} entry */
  const liveOf = entry => {
    const state = entries.get(entry);
    if (state === undefined) throw Error(texts.entryRemoved);
    return state;
  };

  /**
   * @param {string} label
   * @param {any} value
   */
  const makeEntry = (label, value) => {
    const entry = makeExo(
      'InventoryEntry',
      m5FactoryInterfaces.InventoryEntry,
      {
        describe: () => harden({ label: liveOf(entry).label }),
        value: () => liveOf(entry).value,
        /** @param {string} next */
        relabel: next => {
          const state = liveOf(entry);
          if (next === state.label) return undefined;
          assertLabel(next);
          if (byLabel.has(next)) throw Error(textOf.inventoryLabelTaken(next));
          byLabel.delete(state.label);
          byLabel.set(next, entry);
          state.label = next;
          rev += 1;
          return undefined;
        },
        remove: () => {
          const state = liveOf(entry);
          entries.delete(entry);
          byLabel.delete(state.label);
          rev += 1;
          return undefined;
        },
      },
    );
    entries.set(entry, { label, value });
    byLabel.set(label, entry);
    return entry;
  };

  /**
   * @param {string} label
   * @param {any} value
   */
  const add = (label, value) => {
    assertLabel(label);
    if (byLabel.has(label)) throw Error(textOf.inventoryLabelTaken(label));
    if (entries.size >= limits.maxInventoryEntries)
      throw Error(texts.inventoryFull);
    const entry = makeEntry(label, value);
    rev += 1;
    return entry;
  };

  /**
   * All or nothing: every label is checked (valid, free, distinct) and the
   * room counted before the first entry is made.
   * @param {readonly { label: string, value: any }[]} items
   */
  const addAll = items => {
    /** @type {Set<string>} */
    const seen = new Set();
    for (const { label } of items) {
      assertLabel(label);
      if (byLabel.has(label) || seen.has(label))
        throw Error(textOf.inventoryLabelTaken(label));
      seen.add(label);
    }
    if (entries.size + items.length > limits.maxInventoryEntries)
      throw Error(texts.inventoryFull);
    const made = items.map(({ label, value }) => makeEntry(label, value));
    if (made.length > 0) rev += 1;
    return harden(made);
  };

  /** @param {string} [cursor] */
  const list = cursor => {
    const start = positionOf(cursor);
    const pageSize = limits.inventoryPageEntries;
    /** @type {any[]} */
    const rows = [];
    let position = 0;
    for (const [entry, { label, value }] of entries) {
      if (position >= start + pageSize) break;
      if (position >= start) rows.push(harden({ entry, label, value }));
      position += 1;
    }
    /** @type {Record<string, any>} */
    const page = { rows, rev };
    if (start + pageSize < entries.size) page.next = cursorAt(start + pageSize);
    return harden(page);
  };

  const facet = makeExo('Inventory', m5FactoryInterfaces.Inventory, {
    list,
    add,
    addAll,
    rev: () => rev,
  });

  return harden({ facet, size: () => entries.size });
};
harden(makeInventory);

/** @typedef {ReturnType<typeof makeInventory>} InventoryKit */
