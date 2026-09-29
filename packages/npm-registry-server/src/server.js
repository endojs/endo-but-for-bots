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

/**
 * @typedef {object} ServerConfig
 * @property {string} stateDir Holds `registry.sqlite` and `cas/`.
 * @property {(file: string) => SqlDatabase} openDatabase
 * @property {string} publicOrigin
 * @property {string} [upstreamOrigin]
 * @property {string} [host]
 * @property {number} [port] 0 picks a free port.
 * @property {typeof globalThis.fetch} [fetch]
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
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o750 });
  const db = config.openDatabase(path.join(config.stateDir, 'registry.sqlite'));
  const store = makeRegistryStore(db);
  const cas = makeFileCas(path.join(config.stateDir, 'cas'));
  const grants = makeGrants({ store });
  const registry = makeRegistry({
    store,
    cas,
    grants,
    publicOrigin: config.publicOrigin,
    upstreamOrigin: config.upstreamOrigin,
    fetch: config.fetch,
    upstreamTtlMs: config.upstreamTtlMs,
  });
  return { db, store, cas, grants, registry };
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
    grants: opened.grants,
    log: config.log,
  });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(error => {
      console.error(error);
      res.destroy();
    });
  });
  server.requestTimeout = 120_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port ?? 0, config.host ?? '127.0.0.1', () =>
      resolve(undefined),
    );
  });
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );

  const close = async () => {
    await new Promise(resolve => {
      server.close(() => resolve(undefined));
      server.closeIdleConnections();
    });
    opened.store.checkpoint();
    /** @type {any} */ (opened.db).close?.();
  };

  return {
    ...opened,
    server,
    port: address.port,
    url: `http://${address.address}:${address.port}`,
    close,
  };
};
harden(startRegistryServer);
