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
 * `harnessVocabulary({ guestLibDir?, log })` is the gateway's vocabulary for
 * one adapter incarnation: the `shapes`, `interfaces` and (while it exists,
 * until the W2.9 fold) `m2Interfaces` tables of `guest/lib/interfaces.js`,
 * then every `interfaces-m*.js` of `guestLibDir` in name order through its
 * `vocabularyShapes()` export. A file without the export, or whose load or
 * call throws, is logged `{ event: 'vocabulary-skip', file, error }` and
 * skipped. Files are loaded with `require` (synchronous ES module loading),
 * so a file with top-level await is skipped too.
 *
 * Node module (agent-host adapter); the guest prelude is on `globalThis`.
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import * as interfacesModule from '../../../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { passStyleOf } = /** @type {GuestGlobals} */ (globalThis);

const require = createRequire(import.meta.url);

/** The harness's guest library directory (default `guestLibDir`). */
export const defaultGuestLibDir = fileURLToPath(
  new URL('../../../../guest/lib/', import.meta.url),
);

/** Contract files the vocabulary reads, besides `interfaces.js`. */
const contractFilePattern = /^interfaces-m[^/]*\.js$/;

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
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error instanceof Error ? error.message : String(error);

/**
 * The names of one adapter incarnation (m3-interfaces.md 4.4, 6.3): the
 * record-key vocabulary and the method names of every interface guard.
 * @param {object} options
 * @param {string} [options.guestLibDir] where `interfaces-m*.js` are read
 *   (default: the harness's `guest/lib/`)
 * @param {(event: Record<string, unknown>) => void} options.log
 * @returns {{ keys: Set<string>, methods: Set<string> }}
 */
export const harnessNames = ({ guestLibDir = defaultGuestLibDir, log }) => {
  /** @type {any} */
  const base = interfacesModule;
  /** @type {any[]} */
  const patterns = [
    ...Object.values(base.shapes),
    ...Object.values(base.interfaces),
  ];
  if (base.m2Interfaces !== undefined) {
    patterns.push(...Object.values(base.m2Interfaces));
  }
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(guestLibDir)
      .filter(name => contractFilePattern.test(name))
      .sort();
  } catch (error) {
    log({
      event: 'vocabulary-skip',
      file: basename(guestLibDir),
      error: messageOf(error),
    });
  }
  for (const name of names) {
    try {
      // The contract files are found by glob (m3-interfaces.md 6.3).
      // eslint-disable-next-line import/no-dynamic-require
      const contract = require(join(guestLibDir, name));
      if (typeof contract.vocabularyShapes !== 'function') {
        throw Error('no vocabularyShapes() export');
      }
      const more = contract.vocabularyShapes();
      if (!Array.isArray(more)) {
        throw Error('vocabularyShapes() did not answer an array');
      }
      patterns.push(...more);
    } catch (error) {
      log({ event: 'vocabulary-skip', file: name, error: messageOf(error) });
    }
  }
  return collectNames(patterns);
};
harden(harnessNames);

/**
 * The vocabulary of one adapter incarnation (m3-interfaces.md 4.4, 6.3).
 * @param {Parameters<typeof harnessNames>[0]} options
 * @returns {Set<string>}
 */
export const harnessVocabulary = options => harnessNames(options).keys;
harden(harnessVocabulary);
