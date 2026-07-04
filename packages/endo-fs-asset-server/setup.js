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
//
// Once provisioned, mount a directory and serve it:
//   E(assetServer).serve(filesystemCap) -> { path, url, revoke }

import { E } from '@endo/far';

const moduleSpecifier = new URL('src/asset-server-module.js', import.meta.url)
  .href;

/**
 * @param {import('@endo/far').ERef<any>} agent
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
    },
  });

  console.log(
    `Asset server provisioned (base: ${
      env.ENDO_FS_ASSET_SERVER_PUBLIC_BASE || '(none)'
    }).`,
  );
};
harden(main);
