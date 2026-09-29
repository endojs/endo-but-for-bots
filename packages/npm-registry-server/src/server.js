// @ts-check

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeFileCas } from './cas.js';
import { makeRegistryStore } from './store.js';
import { makeGrants } from './grants.js';
import { makeRegistry } from './registry.js';
import { makeRequestHandler } from './http.js';

/** @import { SqlDatabase } from './store.js' */
/** @import { RequestLog } from './http.js' */
/** @import { UpstreamFetch } from './node-fetch.js' */
/** @import { AddressInfo } from 'node:net' */

/**
 * @typedef {object} ServerConfig
 * @property {string} stateDirectory Holds `registry.sqlite` and `cas/`.
 * @property {(file: string) => SqlDatabase} openDatabase
 * @property {string} publicOrigin
 * @property {string} [upstreamOrigin]
 * @property {string} [host]
 * @property {number} [port] 0 picks a free port.
 * @property {UpstreamFetch} [fetch]
 * @property {number} [upstreamTtlMs]
 * @property {(entry: RequestLog) => void} [log]
 */

/**
 * Open the registry state, verify it, and listen. Verification runs before
 * the socket binds: a materialized version whose tarball or tree is absent
 * from the CAS keeps the server from ever becoming ready.
 *
 * @param {ServerConfig} config
 */
export const openRegistry = config => {
  fs.mkdirSync(config.stateDirectory, { recursive: true, mode: 0o750 });
  const database = config.openDatabase(
    path.join(config.stateDirectory, 'registry.sqlite'),
  );
  const store = makeRegistryStore(database);
  const cas = makeFileCas(path.join(config.stateDirectory, 'cas'));
  const grants = makeGrants({ store });
  const registry = makeRegistry({
    store,
    cas,
    publicOrigin: config.publicOrigin,
    upstreamOrigin: config.upstreamOrigin,
    fetch: config.fetch,
    upstreamTtlMs: config.upstreamTtlMs,
  });
  // Not hardened: a deep freeze would reach into the native better-sqlite3
  // database and statement objects.
  return Object.freeze({ database, store, cas, grants, registry });
};
harden(openRegistry);

/**
 * @param {ServerConfig} config
 */
export const startRegistryServer = async config => {
  const opened = openRegistry(config);
  const missing = opened.registry.verifyStore();
  if (missing.length > 0) {
    throw Error(
      `Registry store is missing content for ${missing.length} version(s): ${missing.slice(0, 10).join(', ')}`,
    );
  }
  const handler = makeRequestHandler({
    registry: opened.registry,
    grants: { authenticate: opened.grants.authenticate },
    log: config.log,
  });
  const server = http.createServer((request, response) => {
    handler(request, response).catch(error => {
      console.error(error);
      response.destroy();
    });
  });
  server.requestTimeout = 120_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port ?? 0, config.host ?? '127.0.0.1', () =>
      resolve(undefined),
    );
  });
  const address = /** @type {AddressInfo} */ (server.address());

  const close = async () => {
    await new Promise(resolve => {
      server.close(() => resolve(undefined));
      server.closeIdleConnections();
    });
    opened.store.checkpoint();
    /** @type {any} */ (opened.database).close?.();
  };

  // Not hardened: a deep freeze would reach into the native database and
  // the Node `http.Server`.
  return Object.freeze({
    ...opened,
    server,
    port: address.port,
    url: `http://${address.address}:${address.port}`,
    close,
  });
};
harden(startRegistryServer);
