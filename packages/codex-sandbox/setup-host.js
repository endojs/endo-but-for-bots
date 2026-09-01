// @ts-check
/* global process */
// endo run --UNCONFINED setup-host.js --powers @agent
//   [-E NINEP_SUDO=1]
//   [-E CODEX_SANDBOX_IMAGE=oci.example/codex:latest]
//   [-E CODEX_SANDBOX_MOUNT_DIR=/var/lib/endo/codex-mounts]
//
// HOST-side provisioning for the Codex sandbox stack. Run this on the
// machine that runs the containers (Linux + podman). Idempotent. Mints,
// nested under `codex-sandbox/` so the host root stays clean:
//
//   sandbox-factory  — the `@endo/sandbox` plugin (podman/bwrap).
//   fs-mounter       — the `@endo/9p-server` mount caplet. `mount(2)` needs
//                      `CAP_SYS_ADMIN`; pass `-E NINEP_SUDO=1` to route
//                      mount/umount through `sudo` on an unprivileged daemon.
// Floot's bounded hosted provisioner is installed separately by
// setup-hosted.js. Codex authentication is a host-managed read/write directory,
// not a credential cap and not a daemon-start environment variable.

import { E } from '@endo/eventual-send';

import { toCurrentSpecifier } from './src/current-specifier.js';

/** @import { EndoHost } from '@endo/daemon' */

const sandboxSpecifier = toCurrentSpecifier(
  new URL('../sandbox/src/agent.js', import.meta.url).href,
);
const mountCapletSpecifier = toCurrentSpecifier(
  new URL('../9p-server/mount-caplet.js', import.meta.url).href,
);

const SANDBOX_DIR = 'codex-sandbox';

/**
 * @param {EndoHost} hostAgent
 */
export const main = async hostAgent => {
  const { env } = process;

  if (!(await E(hostAgent).has(SANDBOX_DIR))) {
    await E(hostAgent).makeDirectory([SANDBOX_DIR]);
  }

  // 1. Sandbox factory — `@agent` powers grant the privileged
  //    `provideHostPath` / `provideScratchMount` surface the factory needs
  //    to bridge granted Mount caps into the kernel's bind-mount surface.
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'sandbox-factory'))) {
    await E(hostAgent).makeUnconfined('@main', sandboxSpecifier, {
      powersName: '@agent',
      resultName: [SANDBOX_DIR, 'sandbox-factory'],
    });
    console.log(`Minted ${SANDBOX_DIR}/sandbox-factory`);
  }

  // 2. 9P mounter — unconfined; ambient Node authority (no Endo powers).
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'fs-mounter'))) {
    /** @type {Record<string, string>} */
    const mounterEnv = {};
    /** @type {[string, string | undefined][]} */
    const envSources = [
      ['NINEP_SUDO', env.NINEP_SUDO ?? process.env.NINEP_SUDO],
      [
        'NINEP_LAZY_UMOUNT',
        env.NINEP_LAZY_UMOUNT ?? process.env.NINEP_LAZY_UMOUNT,
      ],
      [
        'NINEP_SOCKET_DIR',
        env.NINEP_SOCKET_DIR ?? process.env.NINEP_SOCKET_DIR,
      ],
      [
        'NINEP_MOUNT_PROGRAM',
        env.NINEP_MOUNT_PROGRAM ??
          process.env.NINEP_MOUNT_PROGRAM ??
          process.env.ENDO_NINEP_MOUNT_PROGRAM,
      ],
      [
        'NINEP_UMOUNT_PROGRAM',
        env.NINEP_UMOUNT_PROGRAM ??
          process.env.NINEP_UMOUNT_PROGRAM ??
          process.env.ENDO_NINEP_UMOUNT_PROGRAM,
      ],
    ];
    for (const [key, value] of envSources) {
      if (value !== undefined) {
        mounterEnv[key] = /** @type {string} */ (value);
      }
    }
    await E(hostAgent).makeUnconfined('@main', mountCapletSpecifier, {
      powersName: '@none',
      resultName: [SANDBOX_DIR, 'fs-mounter'],
      env: harden(mounterEnv),
    });
    console.log(`Minted ${SANDBOX_DIR}/fs-mounter`);
  }

  console.log('Codex sandbox HOST setup complete.');
  console.log('Next: run setup-hosted.js after Floot is provisioned.');
};
harden(main);
