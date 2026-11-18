// @ts-check
/**
 * The gateway's key vocabulary (M3 W3.2; designs/m3-interfaces.md 4.4 rule
 * 4 and 6.3): the record keys a browser may send through the bridge.
 *
 * `collectRecordKeys(patterns)` walks patterns and interface guards and
 * collects every record key they name: copyRecords (keys collected, values
 * walked), copyArrays and tagged values (`match:*` payloads walked like any
 * value). An interface guard contributes its method guards only (its own
 * payload keys and its method names are not collected); a method guard its
 * argument, optional, rest and return guards (an `M.await` wrapper is walked
 * through, a raw guard adds nothing).
 *
 * `collectNames(patterns)` also answers the method names of every interface
 * guard (the keys of its `methodGuards`): the bridge's method-name set
 * (M3-FIX; guard.js rule 4a). `harnessNames` answers both sets for one
 * incarnation.
 *
 * `harnessNames({ tables? })` is the gateway's names for one adapter
 * incarnation: the patterns of every entry of `guest/lib/vocabulary-tables.js`
 * `vocabularyTables`, the explicit list of interface tables (HR-SYN-7; it
 * replaced the `interfaces-m*.js` glob). A table module that fails to load
 * fails this module's import; an entry whose `patterns()` throws or answers
 * no array throws here, naming the entry's file, so the gateway's bind fails
 * rather than serving with a narrower vocabulary.
 *
 * Node module (agent-host adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { vocabularyTables } from '../../../../guest/lib/vocabulary-tables.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { passStyleOf } = /** @type {GuestGlobals} */ (globalThis);

/**
 * Collect the record keys and the method names named by `patterns`
 * (m3-interfaces.md 4.4): `keys` as `collectRecordKeys` describes; `methods`
 * the keys of every interface guard's `methodGuards` (M3-FIX: the bridge
 * refuses any other method name, or passable symbol, to a vat target, so a
 * page cannot make a vat register symbols outside this fixed set).
 * @param {any[]} patterns
 * @returns {{ keys: Set<string>, methods: Set<string> }}
 */
export const collectNames = patterns => {
  /** @type {Set<string>} */
  const keys = new Set();
  /** @type {Set<string>} */
  const methods = new Set();
  /** @type {WeakSet<object>} */
  const seen = new WeakSet();
  /** @type {any[]} */
  const stack = [...patterns];
  while (stack.length > 0) {
    const value = stack.pop();
    let style;
    if (value !== null && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      try {
        style = passStyleOf(value);
      } catch {
        style = undefined;
      }
    }
    if (style === 'copyArray') {
      stack.push(...value);
    } else if (style === 'copyRecord') {
      for (const [key, inner] of Object.entries(value)) {
        keys.add(key);
        stack.push(inner);
      }
    } else if (style === 'tagged') {
      const tag = value[Symbol.toStringTag];
      const { payload } = value;
      if (tag === 'guard:interfaceGuard') {
        const methodGuards = payload?.methodGuards;
        if (methodGuards !== undefined && methodGuards !== null) {
          for (const name of Object.keys(methodGuards)) methods.add(name);
          stack.push(...Object.values(methodGuards));
        }
      } else if (tag === 'guard:methodGuard') {
        const { argGuards, optionalArgGuards, restArgGuard, returnGuard } =
          payload;
        stack.push(argGuards, optionalArgGuards, restArgGuard, returnGuard);
      } else if (tag === 'guard:awaitArgGuard') {
        stack.push(payload?.argGuard);
      } else if (tag === 'guard:rawGuard') {
        // A raw guard names no pattern.
      } else {
        stack.push(payload);
      }
    }
  }
  return { keys, methods };
};
harden(collectNames);

/**
 * Collect the record keys named by `patterns` (m3-interfaces.md 4.4).
 * @param {any[]} patterns
 * @returns {Set<string>}
 */
export const collectRecordKeys = patterns => collectNames(patterns).keys;
harden(collectRecordKeys);

/**
 * The names of one adapter incarnation (m3-interfaces.md 4.4, 6.3): the
 * record-key vocabulary and the method names of every interface guard the
 * listed tables answer.
 * @param {object} [options]
 * @param {readonly import('../../../../guest/lib/vocabulary-tables.js').VocabularyTable[]} [options.tables]
 *   default `vocabularyTables`
 * @returns {{ keys: Set<string>, methods: Set<string> }}
 */
export const harnessNames = ({ tables = vocabularyTables } = {}) => {
  /** @type {any[]} */
  const patterns = [];
  for (const { file, patterns: patternsOf } of tables) {
    /** @type {unknown} */
    let more;
    try {
      more = patternsOf();
    } catch (error) {
      throw Error(`gateway vocabulary: ${file} patterns() threw`, {
        cause: error,
      });
    }
    if (!Array.isArray(more)) {
      throw Error(`gateway vocabulary: ${file} patterns() answered no array`);
    }
    patterns.push(...more);
  }
  return collectNames(patterns);
};
harden(harnessNames);

/**
 * The vocabulary of one adapter incarnation (m3-interfaces.md 4.4, 6.3).
 * @param {Parameters<typeof harnessNames>[0]} [options]
 * @returns {Set<string>}
 */
export const harnessVocabulary = options => harnessNames(options).keys;
harden(harnessVocabulary);
