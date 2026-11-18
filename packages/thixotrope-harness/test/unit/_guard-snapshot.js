// @ts-check
/**
 * A canonical description of every guard, shape, method list and fixed text
 * the interface contract files export (X1: the per-vat split of
 * `guest/lib/interfaces.js` and the M2 fold). `guardSnapshot()` answers one
 * SHA-256 digest per `table.name`, computed from a canonical JSON form of
 * the value (records keep their key order, so a method order change shows;
 * a text function is its source text), and the gateway's key and method
 * sets. `test/fixtures/guard-snapshot-before-x1.json` holds the snapshot of
 * the tree before X1 (`bd9a8ec070`); `guards-split.test.js` compares.
 *
 * Needs the guest prelude on globalThis (`_m1a-prelude.js` first).
 */
import { createHash } from 'node:crypto';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import * as base from '../../guest/lib/interfaces.js';
import * as m3 from '../../guest/lib/interfaces-m3.js';
import * as m4 from '../../guest/lib/interfaces-m4.js';
import * as m5 from '../../guest/lib/interfaces-m5.js';
import * as m5Factory from '../../guest/lib/interfaces-m5-factory.js';
/* eslint-enable import/no-relative-packages */
import { harnessNames } from '../../resources/agent-host/impl/gateway/vocabulary.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { passStyleOf } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export const canonical = value => {
  switch (typeof value) {
    case 'undefined':
      return { undefined: true };
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : { number: String(Object.is(value, -0) ? '-0' : value) };
    case 'bigint':
      return { bigint: String(value) };
    case 'symbol':
      return { symbol: String(value) };
    case 'function':
      return { function: String(value) };
    case 'string':
    case 'boolean':
      return value;
    default:
  }
  if (value === null) return null;
  let style;
  try {
    style = passStyleOf(value);
  } catch {
    style = 'unpassable';
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (style === 'tagged') {
    const tagged = /** @type {any} */ (value);
    return {
      tag: tagged[Symbol.toStringTag],
      payload: canonical(tagged.payload),
    };
  }
  if (style === 'remotable') return { remotable: String(value) };
  // copyRecord or a plain hardened record of functions (textOf)
  return {
    record: Object.entries(/** @type {object} */ (value)).map(([k, v]) => [
      k,
      canonical(v),
    ]),
  };
};

/** @param {unknown} value */
export const digestOf = value =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

/** The exported tables whose entries are snapshotted one by one. */
const tablesOf = () => ({
  shapes: base.shapes,
  interfaces: base.interfaces,
  m2Interfaces: base.m2Interfaces,
  m1bShapes: base.m1bShapes,
  m1bInterfaces: base.m1bInterfaces,
  methodNames: base.methodNames,
  m2MethodNames: base.m2MethodNames,
  m1bMethodNames: base.m1bMethodNames,
  texts: base.texts,
  textOf: base.textOf,
  m3Shapes: m3.m3Shapes,
  m3Interfaces: m3.m3Interfaces,
  m3MethodNames: m3.m3MethodNames,
  m4Shapes: m4.m4Shapes,
  m4Interfaces: m4.m4Interfaces,
  m4MethodNames: m4.m4MethodNames,
  m5Shapes: m5.m5Shapes,
  m5Interfaces: m5.m5Interfaces,
  m5MethodNames: m5.m5MethodNames,
  m5Widenings: m5.m5Widenings,
  m5FactoryShapes: m5Factory.m5FactoryShapes,
  m5FactoryInterfaces: m5Factory.m5FactoryInterfaces,
  m5FactoryMethodNames: m5Factory.m5FactoryMethodNames,
});

/** Exported values of `interfaces.js` snapshotted whole. */
const wholeOf = () => ({
  secretCodes: base.secretCodes,
  archiveKindLetters: base.archiveKindLetters,
  echoArgumentNames: base.echoArgumentNames,
  echoDescription: base.echoDescription,
  execArgumentNames: base.execArgumentNames,
  execDescription: base.execDescription,
  withGatewayAdmin: m3.withGatewayAdmin(base.m2Interfaces.AgentHostAdmin),
});

/**
 * @returns {{
 *   entries: Record<string, string>,
 *   order: Record<string, string[]>,
 *   exports: string[],
 *   vocabulary: { keys: string[], methods: string[], skipped: unknown[] },
 * }}
 */
export const guardSnapshot = () => {
  /** @type {Record<string, string>} */
  const entries = {};
  /** @type {Record<string, string[]>} */
  const order = {};
  for (const [tableName, table] of Object.entries(tablesOf())) {
    order[tableName] = Object.keys(table);
    for (const [name, value] of Object.entries(table)) {
      entries[`${tableName}.${name}`] = digestOf(value);
    }
  }
  for (const [name, value] of Object.entries(wholeOf())) {
    entries[name] = digestOf(value);
  }
  // A table that fails now throws (HR-SYN-7); nothing is skipped.
  /** @type {unknown[]} */
  const skipped = [];
  const { keys, methods } = harnessNames();
  return {
    entries,
    order,
    exports: Object.keys(base).sort(),
    vocabulary: {
      keys: [...keys].sort(),
      methods: [...methods].sort(),
      skipped,
    },
  };
};
