// @ts-check

/**
 * Node-side entry point for `daemon-database.js`.  Bundles the
 * `better-sqlite3` Database constructor as the default backend so
 * callers in the Node-supervised daemon path can use the
 * synchronous prepared-statement surface without thinking about
 * which engine implements it.  The XS-on-Rust supervisor passes
 * its own `./better-sqlite3-xs.js` constructor and therefore
 * imports `daemon-database.js` directly, which keeps
 * `better-sqlite3`'s native binding out of the XS bundle.
 */

import Database from 'better-sqlite3';
import { makeManagerDatabase as makeManagerDatabaseImpl } from './manager-database.js';

/** @import { Config } from './types.js' */
/** @import { ManagerDatabase } from './manager-database.js' */

/**
 * @param {Config} config
 * @returns {ManagerDatabase}
 */
export const makeManagerDatabase = config =>
  makeManagerDatabaseImpl(config, { Database });
