// @ts-check
/* global harden, process */
// endo run --UNCONFINED setup.js --powers @agent
//
// Provisions the static asset server and stores it in the agent's inventory as
// `asset-server`. Intended to be listed in the daemon's ENDO_EXTRA so it
// auto-provisions on start (see the endo-host repo). Configure via ENDO_-
// prefixed env (the daemon only forwards ENDO_* into its subprocess):
//
//   ENDO_FS_ASSET_SERVER_PORT         loopback port to listen on
//   ENDO_FS_ASSET_SERVER_HOST         bind address (default 127.0.0.1)
//   ENDO_FS_ASSET_SERVER_PUBLIC_BASE  origin advertised in returned URLs,
//                                     e.g. https://assets.example (Caddy proxies
//                                     that origin to the loopback port).
//   ENDO_FS_ASSET_SERVER_STATIC_DIR   optional host dir hosted persistently
//                                     (read-only) on every start, so it survives
//                                     daemon restarts and deploys.
//   ENDO_FS_ASSET_SERVER_STATIC_TOKEN_FILE
//                                     file the durable mount's capability token
//                                     is minted into and re-read from, so the
//                                     same unguessable URL comes back each start.
//   ENDO_FS_ASSET_SERVER_STATIC_PATH  opt-in: pin the mount at a chosen (public)
//                                     path instead of a capability token.
//   ENDO_FS_ASSET_SERVER_STATIC_INDEX directory index file (default index.html)
//
// Once provisioned, you can also mount ad-hoc capability URLs:
//   E(assetServer).serve(filesystemCap) -> { path, url, revoke }

import { E } from '@endo/eventual-send';

const moduleSpecifier = new URL('src/asset-server-module.js', import.meta.url)
  .href;

/**
 * @param {import('@endo/eventual-send').ERef<any>} agent
 */
export const main = async agent => {
  // Re-bind on every start. `moduleSpecifier` resolves relative to this file,
  // which the daemon loads through the atomically-swapped release checkout, so
  // re-creating rebinds to the CURRENT release's module (surviving release
  // pruning). The server's mounts live only in memory and are dropped on daemon
  // restart regardless, so nothing durable is lost by re-creating.
  if (await E(agent).has('asset-server')) {
    await E(agent).remove('asset-server');
  }

  const { env } = process;
  await E(agent).makeUnconfined('@main', moduleSpecifier, {
    resultName: 'asset-server',
    env: {
      ENDO_FS_ASSET_SERVER_PORT: env.ENDO_FS_ASSET_SERVER_PORT || '',
      ENDO_FS_ASSET_SERVER_HOST: env.ENDO_FS_ASSET_SERVER_HOST || '127.0.0.1',
      ENDO_FS_ASSET_SERVER_PUBLIC_BASE:
        env.ENDO_FS_ASSET_SERVER_PUBLIC_BASE || '',
      ENDO_FS_ASSET_SERVER_STATIC_DIR:
        env.ENDO_FS_ASSET_SERVER_STATIC_DIR || '',
      ENDO_FS_ASSET_SERVER_STATIC_TOKEN_FILE:
        env.ENDO_FS_ASSET_SERVER_STATIC_TOKEN_FILE || '',
      ENDO_FS_ASSET_SERVER_STATIC_PATH:
        env.ENDO_FS_ASSET_SERVER_STATIC_PATH || '',
      ENDO_FS_ASSET_SERVER_STATIC_INDEX:
        env.ENDO_FS_ASSET_SERVER_STATIC_INDEX || '',
    },
  });

  console.log(
    `Asset server provisioned (base: ${
      env.ENDO_FS_ASSET_SERVER_PUBLIC_BASE || '(none)'
    }).`,
  );
};
harden(main);
