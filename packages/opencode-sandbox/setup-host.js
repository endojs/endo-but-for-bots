// @ts-check
/* global process */
// endo run --UNCONFINED setup-host.js --powers @agent
//   [-E NINEP_SUDO=1]
//   [-E ENDO_OPENCODE_SANDBOX_OWNER_ID=operator-chosen-stable-id]
//   [-E ENDO_OPENCODE_STATE_DIR=/var/lib/endo/opencode-state]
//
// HOST-side provisioning for the opencode sandbox stack. Run this on the
// machine that runs the containers (Linux + podman). Idempotent. Mints,
// nested under `opencode-sandbox/` so the host root stays clean:
//
//   sandbox-factory  — the `@endo/sandbox` plugin (podman/bwrap).
//   fs-mounter       — the `@endo/9p-server` mount caplet. `mount(2)` needs
//                      `CAP_SYS_ADMIN`; pass `-E NINEP_SUDO=1` to route
//                      mount/umount through `sudo` on an unprivileged daemon.
//   state-provider   — host-backed durable per-session state. opencode forces
//                      SQLite WAL, which needs same-host shared memory and
//                      cannot run over the 9P workspace, so each session gets
//                      a 0700 directory under `ENDO_OPENCODE_STATE_DIR`
//                      (default `/var/lib/endo/opencode-state`) exposed to the
//                      slice through a daemon-minted mount.
//
// The hosted backend itself (credentials + `opencode-backend`) belongs on the
// same machine — see setup-hosted.js.

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './src/current-specifier.js';

/** @import { EndoHost } from '@endo/daemon' */

const sandboxSpecifier = toCurrentSpecifier(
  new URL('../sandbox/src/agent.js', import.meta.url).href,
);
const mountCapletSpecifier = toCurrentSpecifier(
  new URL('../9p-server/mount-caplet.js', import.meta.url).href,
);
const stateProviderSpecifier = toCurrentSpecifier(
  new URL('./src/opencode-state-provider-module.js', import.meta.url).href,
);

// Fail closed before minting anything if a release-pinned path could not be
// rerouted through <stateDir>/current: a formula stored with a
// `releases/<id>/` specifier dangles as soon as that release is pruned.
assertCurrentSpecifier(sandboxSpecifier, 'sandbox');
assertCurrentSpecifier(mountCapletSpecifier, '9p mount caplet');
assertCurrentSpecifier(stateProviderSpecifier, 'state provider');

// Kept in sync with the backend's provisioner defaults and setup-hosted.js.
const SANDBOX_DIR = 'opencode-sandbox';

// A HOME-independent root: the daemon's install layout owns `/var/lib/endo`,
// and NixOS provisioning creates (and owns) this directory for the Endo user.
const DEFAULT_STATE_DIR = '/var/lib/endo/opencode-state';

/**
 * The state root holds per-session SQLite databases and ownership markers and
 * is handed to the provider as ambient Node authority. Require an absolute,
 * normalized, non-root path so a typo or hostile env cannot chmod/overwrite
 * outside the deploy's own tree, and refuse a symlinked root so writes through
 * it cannot be redirected elsewhere (DESIGN § State provider).
 *
 * @param {string} value
 * @returns {string}
 */
const assertStateDir = value => {
  if (!path.isAbsolute(value)) {
    throw Fail`ENDO_OPENCODE_STATE_DIR must be absolute, got ${value}`;
  }
  if (path.normalize(value) !== value || value === '/') {
    throw Fail`ENDO_OPENCODE_STATE_DIR must be a normalized, non-root path, got ${value}`;
  }
  return value;
};

/**
 * @param {EndoHost} hostAgent
 */
export const main = async hostAgent => {
  await null;
  const { env } = process;

  // Validate the state root before any mint, so a bad value cannot strand a
  // profile that later writes through it.
  const stateDir = assertStateDir(
    env.ENDO_OPENCODE_STATE_DIR || DEFAULT_STATE_DIR,
  );

  if (!(await E(hostAgent).has(SANDBOX_DIR))) {
    await E(hostAgent).makeDirectory([SANDBOX_DIR]);
  }

  // 1. Sandbox factory — `@agent` powers grant the privileged
  //    `provideHostPath` / `provideScratchMount` surface the factory needs
  //    to bridge granted Mount caps into the kernel's bind-mount surface.
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'sandbox-factory'))) {
    // Podman crash reconciliation must only touch this host's opencode
    // slices. Persist the identity with the factory so every incarnation uses
    // the same exact owner label, independently of release paths and process
    // IDs.
    let ownerId = env.ENDO_OPENCODE_SANDBOX_OWNER_ID;
    if (!ownerId) {
      // Peer identity is daemon-wide: separate hosts in the same daemon must
      // not sweep each other's containers. Hash the stable host formula ID
      // into a label-safe value without exposing that ID in Podman metadata.
      const hostId = await E(hostAgent).identify('@agent');
      if (typeof hostId !== 'string' || hostId.length === 0) {
        throw Fail`Cannot identify OpenCode sandbox host`;
      }
      ownerId = `opencode-${createHash('sha256').update(hostId).digest('hex')}`;
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

  // 3. State provider — `@agent` powers grant `provideMount`, which is the
  //    only way a Mount cap the sandbox factory will accept is minted.
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'state-provider'))) {
    // Prepare the root only when this run actually mints the provider: an
    // already-minted provider keeps the root baked into its formula, so
    // creating (or chmodding) a new one from a changed env would be a stray
    // directory, not a rebind.
    const info = await lstat(stateDir).catch(() => undefined);
    if (info?.isSymbolicLink()) {
      throw Fail`ENDO_OPENCODE_STATE_DIR must not be a symlink: ${stateDir}`;
    }
    if (info && !info.isDirectory()) {
      throw Fail`ENDO_OPENCODE_STATE_DIR must be a directory: ${stateDir}`;
    }
    if (info) {
      (await stat(stateDir)).uid === process.getuid() ||
        Fail`ENDO_OPENCODE_STATE_DIR must be owned by the daemon user: ${stateDir}`;
      // Owned by us: normalize permissions rather than trusting the mode the
      // operator (or a stale deploy) left behind.
      await chmod(stateDir, 0o700);
    } else {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
    }
    await E(hostAgent).makeUnconfined('@main', stateProviderSpecifier, {
      powersName: '@agent',
      resultName: [SANDBOX_DIR, 'state-provider'],
      env: harden({ ENDO_OPENCODE_STATE_DIR: stateDir }),
    });
    console.log(
      `Minted ${SANDBOX_DIR}/state-provider (state under ${stateDir})`,
    );
  }

  console.log('OpenCode sandbox HOST setup complete.');
  console.log(
    'Next: run setup-hosted.js to mint the credential and the Floot backend.',
  );
};
harden(main);
