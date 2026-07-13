// @ts-check

/**
 * SQLite portrait store over an injected better-sqlite3-compatible
 * database handle (the daemon's `endo.sqlite` discipline: the same
 * schema works under Node's better-sqlite3 and the XS-on-Rust
 * `better-sqlite3-xs` shim). The package takes no dependency on any
 * SQLite driver; callers pass the opened database.
 *
 * Deltas are true row upserts inside one transaction — unlike the
 * file store, steady-state writes are O(dirty), not O(heap).
 */

import harden from '@endo/harden';
import { Fail, q } from '@endo/errors';

/**
 * @import { PortraitStore, StoredGraph, StoredDelta, StoredPortrait } from '../types.js'
 */

/**
 * @typedef {object} SqliteDatabase A better-sqlite3-compatible handle.
 * @property {(sql: string) => any} prepare
 * @property {(sql: string) => void} exec
 * @property {(fn: (...args: any[]) => void) => (...args: any[]) => void} transaction
 * @property {() => void} [close]
 */

/**
 * @param {SqliteDatabase} db
 * @param {object} [options]
 * @param {boolean} [options.ownsDatabase] Close the handle with the
 *   store; default false (caller may share the database).
 * @returns {PortraitStore}
 */
export const makeSqlitePortraitStore = (db, { ownsDatabase = false } = {}) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portraitMeta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portraits (
      slot INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      slots TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portraitBindings (
      key TEXT PRIMARY KEY,
      designator TEXT NOT NULL
    );
  `);

  const getMeta = db.prepare(`SELECT value FROM portraitMeta WHERE key = ?`);
  const setMeta = db.prepare(`
    INSERT INTO portraitMeta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `);
  const upsertPortrait = db.prepare(`
    INSERT INTO portraits (slot, name, version, body, slots)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (slot) DO UPDATE SET
      name = excluded.name,
      version = excluded.version,
      body = excluded.body,
      slots = excluded.slots
  `);
  const selectPortrait = db.prepare(`
    SELECT slot, name, version, body, slots FROM portraits WHERE slot = ?
  `);
  const selectAllPortraits = db.prepare(`
    SELECT slot, name, version, body, slots FROM portraits
  `);
  const deleteAllPortraits = db.prepare(`DELETE FROM portraits`);
  const upsertBinding = db.prepare(`
    INSERT INTO portraitBindings (key, designator) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET designator = excluded.designator
  `);
  const selectAllBindings = db.prepare(
    `SELECT key, designator FROM portraitBindings`,
  );
  const deleteAllBindings = db.prepare(`DELETE FROM portraitBindings`);

  /** @param {string} key */
  const readMeta = key => {
    const row = getMeta.get(key);
    return row === undefined ? undefined : row.value;
  };

  /**
   * @param {StoredPortrait} portrait
   * @param {string} slotText
   */
  const writePortraitRow = (portrait, slotText) => {
    upsertPortrait.run(
      Number(slotText),
      portrait.name,
      portrait.version,
      portrait.body,
      JSON.stringify(portrait.slots),
    );
  };

  const saveGraphTx = db.transaction(
    /** @param {StoredGraph} graph */ graph => {
      deleteAllPortraits.run();
      deleteAllBindings.run();
      setMeta.run('formatVersion', String(graph.formatVersion));
      setMeta.run('heapId', graph.heapId);
      setMeta.run('rootsVersion', String(graph.rootsVersion));
      setMeta.run('roots', JSON.stringify(graph.roots));
      for (const [slotText, portrait] of Object.entries(graph.portraits)) {
        writePortraitRow(portrait, slotText);
      }
      for (const [key, designator] of Object.entries(graph.bindings)) {
        upsertBinding.run(key, designator);
      }
    },
  );

  const saveDeltaTx = db.transaction(
    /** @param {StoredDelta} delta */ delta => {
      readMeta('formatVersion') !== undefined ||
        Fail`cannot apply a portrait delta before any full graph`;
      for (const [slotText, portrait] of Object.entries(delta.portraits)) {
        writePortraitRow(portrait, slotText);
      }
      if (delta.bindings !== undefined) {
        deleteAllBindings.run();
        for (const [key, designator] of Object.entries(delta.bindings)) {
          upsertBinding.run(key, designator);
        }
      }
    },
  );

  /** @param {any} row @returns {StoredPortrait} */
  const rowToPortrait = row =>
    harden({
      name: row.name,
      version: row.version,
      body: row.body,
      slots: JSON.parse(row.slots),
    });

  return harden({
    graphAndSlots: async () => {
      const formatVersion = readMeta('formatVersion');
      if (formatVersion === undefined) {
        return undefined;
      }
      formatVersion === '1' ||
        Fail`unsupported stored graph format ${q(formatVersion)}`;
      /** @type {Record<string, StoredPortrait>} */
      const portraits = {};
      for (const row of selectAllPortraits.all()) {
        portraits[String(row.slot)] = rowToPortrait(row);
      }
      /** @type {Record<string, string>} */
      const bindings = {};
      for (const row of selectAllBindings.all()) {
        bindings[row.key] = row.designator;
      }
      return harden({
        formatVersion: /** @type {1} */ (1),
        heapId: /** @type {string} */ (readMeta('heapId')),
        rootsVersion: Number(readMeta('rootsVersion')),
        roots: JSON.parse(/** @type {string} */ (readMeta('roots'))),
        portraits,
        bindings,
      });
    },
    /** @param {number} slot */
    objectPortrait: async slot => {
      const row = selectPortrait.get(slot);
      return row === undefined ? undefined : rowToPortrait(row);
    },
    /** @param {StoredGraph} graph */
    saveGraph: async graph => {
      saveGraphTx(graph);
    },
    /** @param {StoredDelta} delta */
    saveDelta: async delta => {
      saveDeltaTx(delta);
    },
    close: async () => {
      if (ownsDatabase && db.close) {
        db.close();
      }
    },
  });
};
harden(makeSqlitePortraitStore);
