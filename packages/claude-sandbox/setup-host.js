// @ts-check
/* global process */
// endo run --UNCONFINED setup-host.js --powers @agent
//   [-E NINEP_SUDO=1]
//   [-E CLAUDE_SANDBOX_IMAGE=oci.example/claude:latest]
//   [-E CLAUDE_SANDBOX_MOUNT_DIR=/var/lib/endo/claude-mounts]
//   [-E ENDO_CLAUDE_SANDBOX_OWNER_ID=operator-chosen-stable-id]
//
// HOST-side provisioning for the Claude sandbox stack. Run this on the
// machine that runs the containers (Linux + podman). Idempotent. Mints,
// nested under `claude-sandbox/` so the host root stays clean:
//
//   sandbox-factory  — the `@endo/sandbox` plugin (podman/bwrap).
//   fs-mounter       — the `@endo/9p-server` mount caplet. `mount(2)` needs
//                      `CAP_SYS_ADMIN`; pass `-E NINEP_SUDO=1` to route
//                      mount/umount through `sudo` on an unprivileged daemon.
//   service          — the factory caplet (mailbox/form loops; help() only).
//   profile, handle  — the factory guest (agent + handle).
//   readme           — describes the objects + sharing security
//                      (`endo show claude-sandbox/readme`).
//
// The credentials factory belongs on the PEER machine (the credential
// holder) — see setup-peer.js. For single-machine dev, run both.

import { createHash } from 'node:crypto';

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';

import { main as provisionSandboxFactory } from './factory.js';
import { toCurrentSpecifier } from './src/current-specifier.js';

/** @import { EndoHost } from '@endo/daemon' */

const sandboxSpecifier = toCurrentSpecifier(
  new URL('../sandbox/src/agent.js', import.meta.url).href,
);
const mountCapletSpecifier = toCurrentSpecifier(
  new URL('../9p-server/mount-caplet.js', import.meta.url).href,
);

// Kept in sync with factory.js's default and the caplet's SANDBOX_NAMESPACE.
const SANDBOX_DIR = 'claude-sandbox';

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
    // Podman crash reconciliation must only touch this host's Claude slices.
    // Persist the identity with the factory so every incarnation uses the
    // same exact owner label, independently of release paths and process IDs.
    let ownerId = env.ENDO_CLAUDE_SANDBOX_OWNER_ID;
    if (!ownerId) {
      // Peer identity is daemon-wide: separate hosts in the same daemon must
      // not sweep each other's containers. Hash the stable host formula ID
      // into a label-safe value without exposing that ID in Podman metadata.
      const hostId = await E(hostAgent).identify('@agent');
      if (typeof hostId !== 'string' || hostId.length === 0) {
        throw Fail`Cannot identify Claude sandbox host`;
      }
      ownerId = `claude-${createHash('sha256').update(hostId).digest('hex')}`;
    }
    await E(hostAgent).makeUnconfined('@main', sandboxSpecifier, {
      powersName: '@agent',
      resultName: [SANDBOX_DIR, 'sandbox-factory'],
      env: harden({ ENDO_SANDBOX_OWNER_ID: ownerId }),
    });
    console.log(`Minted ${SANDBOX_DIR}/sandbox-factory`);
  }

  // 2. 9P mounter — unconfined; ambient Node authority (no Endo powers).
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'fs-mounter'))) {
    /** @type {Record<string, string>} */
    const mounterEnv = {};
    // A hosted daemon forwards only ENDO_-prefixed variables to its ENDO_EXTRA
    // subprocesses, so the mount/umount program overrides a rootless deploy
    // needs are also accepted under their ENDO_ spelling.
    /** @type {Array<[string, string | undefined]>} */
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

  // 3. Claude sandbox factory (service/profile/handle + readme). Pass
  //    SANDBOX_DIR explicitly so setup and the factory agree on the dir name.
  await provisionSandboxFactory(hostAgent, SANDBOX_DIR);

  console.log('Claude sandbox HOST setup complete.');
  console.log(
    'Next: `endo inbox`, then submit the "Create Claude Sandbox" form with `endo submit`.',
  );
};
harden(main);
