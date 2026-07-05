// @ts-check
/* global globalThis, Buffer */
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
 *   ENDO_FS_ASSET_SERVER_STATIC_DIR   Optional. Host directory hosted
 *                                     persistently (read-only) on every
 *                                     start. Enables the durable mount
 *                                     below.
 *
 *   ENDO_FS_ASSET_SERVER_STATIC_TOKEN_FILE
 *                                     File the durable mount's
 *                                     capability token is minted into
 *                                     (0600) and re-read from, so the
 *                                     same unguessable URL survives
 *                                     restarts/deploys. Default channel
 *                                     for STATIC_DIR.
 *
 *   ENDO_FS_ASSET_SERVER_STATIC_PATH  Optional. Pin the durable mount at
 *                                     a chosen (public, guessable) path
 *                                     instead of a capability token.
 *
 *   ENDO_FS_ASSET_SERVER_STATIC_INDEX Optional. Directory index file for
 *                                     the durable mount (default
 *                                     `index.html`).
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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { makeExo } from '@endo/exo';

import { makeNodeHttpBackend } from '@endo/platform/http/node';
import { makeNodeFilesystem } from '@endo/platform/fs/extended/node-fs.js';
import { readOnly } from '@endo/platform/fs/extended/readonly.js';

import { makeAssetServer } from './asset-server.js';
import { AssetServerPublicInterface } from './type-guards.js';

/**
 * Load a persisted capability token from `tokenFile`, or mint a fresh
 * one (192 bits, URL-safe base64) and persist it `0600` on first use.
 * Because the token is stored outside any release checkout, the same
 * unguessable capability path is re-used on every process start — the
 * basis for a *durable* capability URL that survives daemon restarts
 * and deploys, without weakening it to a guessable name.
 *
 * @param {string} tokenFile
 * @param {(bytes: Uint8Array) => Uint8Array} getRandomValues
 * @returns {string}
 */
const loadOrMintToken = (tokenFile, getRandomValues) => {
  try {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (existing !== '') {
      return existing;
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
      throw err;
    }
  }
  const token = Buffer.from(getRandomValues(new Uint8Array(24))).toString(
    'base64url',
  );
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
};

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

  const server = await makeAssetServer({
    backend,
    getRandomValues,
    port,
    host,
    publicBase,
  });

  // Durable static mount. When ENDO_FS_ASSET_SERVER_STATIC_DIR is set, wrap that
  // host directory as an in-process read-only Filesystem and serve it on every
  // process start, so the directory is hosted persistently across daemon
  // restarts and deploys. The mount's path is, by default, a *capability token*
  // (the URL path is the authorization) that is minted once and persisted in
  // ENDO_FS_ASSET_SERVER_STATIC_TOKEN_FILE, so the same unguessable URL comes
  // back after every restart. Set ENDO_FS_ASSET_SERVER_STATIC_PATH instead to
  // pin a chosen (public, guessable) path — an opt-in departure from the
  // capability model.
  const staticDir = env.ENDO_FS_ASSET_SERVER_STATIC_DIR;
  if (staticDir) {
    const staticIndex = env.ENDO_FS_ASSET_SERVER_STATIC_INDEX || 'index.html';
    const chosenPath = env.ENDO_FS_ASSET_SERVER_STATIC_PATH;
    const tokenFile = env.ENDO_FS_ASSET_SERVER_STATIC_TOKEN_FILE;
    let token;
    let kind;
    if (chosenPath) {
      token = chosenPath;
      kind = 'public path';
    } else if (tokenFile) {
      token = loadOrMintToken(tokenFile, getRandomValues);
      kind = 'capability token';
    } else {
      throw new Error(
        'asset-server-module: ENDO_FS_ASSET_SERVER_STATIC_DIR requires ENDO_FS_ASSET_SERVER_STATIC_TOKEN_FILE (durable capability URL) or ENDO_FS_ASSET_SERVER_STATIC_PATH (chosen public path)',
      );
    }
    const fs = readOnly(makeNodeFilesystem({ rootPath: staticDir }));
    await server.serveAt(token, fs, { index: staticIndex });
    // Log where the URL lives, not the capability itself.
    console.log(
      `asset-server: hosting ${staticDir} at a ${kind}${
        kind === 'capability token' ? ` (see ${tokenFile})` : ` /${token}/`
      }`,
    );
  }

  // Hand callers an attenuated facet WITHOUT `stop()`. This is a shared
  // singleton on a fixed loopback port; letting any guest stop it would tear
  // the listener out from under everyone and can wedge the caplet (the daemon
  // reincarnates the formula into a new worker that then collides on the still
  // held port with EADDRINUSE). The durable static mount above is already wired
  // via the full `server`; the facet only forwards the safe methods. `server`
  // is a local exo in this worker, so forwarding is an in-process call.
  return makeExo('AssetServer', AssetServerPublicInterface, {
    serve: (filesystem, serveOpts) => server.serve(filesystem, serveOpts),
    serveAt: (pathSegment, filesystem, serveOpts) =>
      server.serveAt(pathSegment, filesystem, serveOpts),
    getAddress: () => server.getAddress(),
    help: () => server.help(),
  });
};
harden(make);
