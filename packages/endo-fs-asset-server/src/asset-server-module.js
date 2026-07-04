// @ts-check
/* global globalThis */
/**
 * Entry point for instantiating a static asset server as a formulated
 * Endo caplet via `host.makeUnconfined`.
 *
 * The server runs in an unconfined Node worker so it can hold a real
 * `node:http` listening socket. The formula value is an `AssetServer`
 * exo; call `E(server).serve(filesystem)` to mount an endo-fs
 * Filesystem under a fresh capability path. The mount serves
 * persistently until you call `revoke()` on the handle `serve`
 * returns.
 *
 * Configuration is via environment variables passed through
 * `makeUnconfined({ env: [...] })`:
 *
 *   ENDO_FS_ASSET_SERVER_PORT         Optional. Port to listen on.
 *                                     `0` / unset asks the OS to
 *                                     assign one (read it back with
 *                                     `E(server).getAddress()`).
 *
 *   ENDO_FS_ASSET_SERVER_HOST         Optional. Interface to bind.
 *                                     Defaults to `127.0.0.1`
 *                                     (loopback only). Set to
 *                                     `0.0.0.0` to expose on all
 *                                     interfaces.
 *
 *   ENDO_FS_ASSET_SERVER_PUBLIC_BASE  Optional. Origin to advertise
 *                                     in returned URLs when the
 *                                     server sits behind a proxy,
 *                                     e.g. `https://assets.example`.
 *
 * End-to-end recipe:
 *
 *   # 1. Mount a host directory as a Filesystem cap.
 *   endo make --UNCONFINED \
 *     packages/platform/src/fs/extended/node-fs-module.js \
 *     --name site-fs --workerName \@node \
 *     --env ENDO_FS_ROOT=/path/to/site --env ENDO_FS_READ_ONLY=1
 *
 *   # 2. Start the asset server.
 *   endo make --UNCONFINED \
 *     packages/endo-fs-asset-server/src/asset-server-module.js \
 *     --name assets --workerName \@node \
 *     --env ENDO_FS_ASSET_SERVER_PORT=8080
 *
 *   # 3. Serve the Filesystem and learn its capability URL.
 *   #    (from a guest script: `E(assets).serve(siteFs)` ->
 *   #     { path, url, revoke }.)
 */

import http from 'node:http';

import { makeNodeHttpBackend } from '@endo/platform/http/node';

import { makeAssetServer } from './asset-server.js';

/**
 * @param {unknown} _powers  unused; the server needs no host powers
 *   beyond the unconfined Node builtins.
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [opts]
 * @returns {Promise<object>} an `AssetServer` exo.
 */
export const make = async (_powers, _context, opts = {}) => {
  const env = opts.env || {};

  const portStr = env.ENDO_FS_ASSET_SERVER_PORT;
  // Port 0 (OS-assigned) is falsy, so test the empty string rather
  // than truthiness.
  const port = portStr !== undefined && portStr !== '' ? Number(portStr) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `asset-server-module: env.ENDO_FS_ASSET_SERVER_PORT must be an integer in 0..65535, got ${JSON.stringify(
        portStr,
      )}`,
    );
  }

  const host = env.ENDO_FS_ASSET_SERVER_HOST || '127.0.0.1';
  const publicBase = env.ENDO_FS_ASSET_SERVER_PUBLIC_BASE;

  const getRandomValues = bytes => globalThis.crypto.getRandomValues(bytes);

  // Wire the platform-agnostic asset server onto the Node HTTP backend.
  const backend = makeNodeHttpBackend({ http });

  return makeAssetServer({ backend, getRandomValues, port, host, publicBase });
};
harden(make);
