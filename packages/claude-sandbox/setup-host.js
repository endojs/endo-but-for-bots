// @ts-check
/* global process */
// endo run --UNCONFINED setup-host.js --powers @agent
//   [-E NINEP_SUDO=1]
//   [-E CLAUDE_SANDBOX_IMAGE=oci.example/claude:latest]
//   [-E CLAUDE_SANDBOX_MOUNT_DIR=/var/lib/endo/claude-mounts]
//   [-E ENDO_CLAUDE_SANDBOX_OWNER_ID=operator-chosen-stable-id]
//   [-E ENDO_CLAUDE_STATE_DIR=/var/lib/endo/claude-state]
//   -E ENDO_SANDBOX_RUNTIME_DIR=<existing-private-host-directory>
//   -E ENDO_SANDBOX_GENERATED_MAX_BYTES=<decimal-byte-budget>
//   -E ENDO_SANDBOX_GENERATED_MAX_ENTRIES=<positive-decimal-entry-budget>
//
// HOST-side provisioning for the Claude sandbox stack. Run this on the
// machine that runs the containers (Linux + podman). Idempotent. Mints,
// nested under `claude-sandbox/` so the host root stays clean:
//
//   native-sandbox   — the owned `@endo/sandbox` native Podman runtime that
//                      daemon-owned Floot session controllers acquire scopes
//                      from. It owns `ENDO_SANDBOX_RUNTIME_DIR` itself under
//                      a derived owner label; the inbox-form factory below
//                      keeps no runtime directory of its own.
//   state-provider   — host-backed durable per-session state: each Floot
//                      session's persistent Claude config directory (its
//                      transcript) as a 0700 directory under
//                      `ENDO_CLAUDE_STATE_DIR`, bound directly into the slice.
//   sandbox-factory  — the `@endo/sandbox` plugin (podman/bwrap) the
//                      inbox-form factory below still uses.
//   fs-mounter       — the `@endo/9p-server` mount caplet for that factory.
//                      `mount(2)` needs `CAP_SYS_ADMIN`; pass `-E NINEP_SUDO=1`
//                      to route mount/umount through `sudo` on an unprivileged
//                      daemon. Floot sessions use their own mounter instead.
//   service          — the factory caplet (mailbox/form loops; help() only).
//   profile, handle  — the factory guest (agent + handle).
//   readme           — describes the objects + sharing security
//                      (`endo show claude-sandbox/readme`).
//
// Everything a minted owner would refuse at construction is refused here
// first: the daemon binds a formula before evaluating it, and a formula that
// cannot construct is still bound and retained by every later run.
//
// Hosted sessions take their credential from the Anthropic provider broker
// setup-hosted.js mints; the inbox-form credentials factory of setup-peer.js
// serves only the legacy peer topology.

import { createHash } from 'node:crypto';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { Fail, q } from '@endo/errors';
import { providePrivateDirectory } from '@endo/hosted-agent/hosted-setup.js';

import { main as provisionSandboxFactory } from './factory.js';
import { toCurrentSpecifier } from './src/current-specifier.js';
import {
  SANDBOX_DIR,
  assertRuntimePlacement,
  getHostedStorageRoots,
  nativeSandboxSpecifier,
  prepareNativeRuntimeEnv,
  readNativeSandbox,
  readStateProvider,
  stateProviderSpecifier,
} from './src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */

const sandboxSpecifier = toCurrentSpecifier(
  new URL('../sandbox/src/agent.js', import.meta.url).href,
);
const mountCapletSpecifier = toCurrentSpecifier(
  new URL('../9p-server/mount-caplet.js', import.meta.url).href,
);

/**
 * The state root holds per-session transcripts and ownership markers and is
 * handed to the provider as ambient Node authority. Require an absolute,
 * normalized, non-root path so a typo or hostile env cannot chmod/overwrite
 * outside the deploy's own tree.
 * @param {string} value
 */
const assertStateDir = value => {
  if (!path.isAbsolute(value)) {
    throw Fail`ENDO_CLAUDE_STATE_DIR must be absolute, got ${q(value)}`;
  }
  if (path.normalize(value) !== value || value === '/') {
    throw Fail`ENDO_CLAUDE_STATE_DIR must be a normalized, non-root path, got ${q(value)}`;
  }
  return value;
};

/**
 * @param {EndoHost} hostAgent
 */
export const main = async hostAgent => {
  const { env } = process;

  // Podman crash reconciliation must only touch this host's Claude slices.
  // Persist the identity with each runtime so every incarnation uses the same
  // exact owner label, independently of release paths and process IDs. The
  // native runtime derives its own label from this one.
  const resolveOwnerId = async () => {
    const explicit = env.ENDO_CLAUDE_SANDBOX_OWNER_ID;
    if (explicit) return explicit;
    // Peer identity is daemon-wide: separate hosts in the same daemon must
    // not sweep each other's containers. Hash the stable host formula ID
    // into a label-safe value without exposing that ID in Podman metadata.
    const hostId = await E(hostAgent).identify('@agent');
    if (typeof hostId !== 'string' || hostId.length === 0) {
      throw Fail`Cannot identify Claude sandbox host`;
    }
    return `claude-${createHash('sha256').update(hostId).digest('hex')}`;
  };

  // Validate the state root and the native runtime before any mint. Retained
  // formulas keep their persisted placement; missing ones use the requested
  // construction settings.
  const existingState = await E(hostAgent).has(SANDBOX_DIR, 'state-provider');
  const requestedRoots = getHostedStorageRoots(env);
  const stateDir = assertStateDir(
    existingState
      ? (await readStateProvider(hostAgent)).stateDir
      : requestedRoots.stateDir,
  );
  const roots = harden({ ...requestedRoots, stateDir });
  /** @type {Record<string, string> | undefined} */
  let nativeEnv;
  if (await E(hostAgent).has(SANDBOX_DIR, 'native-sandbox')) {
    const native = await readNativeSandbox(hostAgent);
    await assertRuntimePlacement(native.config.directory, roots);
    console.log(
      'Retaining owned native sandbox service with its persisted configuration; current runtime environment is not reapplied.',
    );
  } else {
    nativeEnv = await prepareNativeRuntimeEnv(
      env,
      await resolveOwnerId(),
      roots,
    );
  }

  if (!(await E(hostAgent).has(SANDBOX_DIR))) {
    await E(hostAgent).makeDirectory([SANDBOX_DIR]);
  }

  // 1. Sandbox factory — `@agent` powers grant the privileged
  //    `provideHostPath` / `provideScratchMount` surface the factory needs
  //    to bridge granted Mount caps into the kernel's bind-mount surface.
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'sandbox-factory'))) {
    const ownerId = await resolveOwnerId();
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

  // 4. Native sandbox service — the host-only runtime daemon-owned session
  //    controllers acquire scopes from. It is constructed with a slot-free
  //    null value as powers: it imports no host or scratch authority, and
  //    `@none` would be a denied-method guest capability, not null. The stored
  //    value is a marshal formula the minted service retains as its exact
  //    powers dependency; the temporary name is not, and its dot keeps it
  //    outside the managed-credential name charset.
  if (nativeEnv) {
    const powersName = 'claude.null-powers';
    if (await E(hostAgent).has(powersName)) {
      await E(hostAgent).remove(powersName);
    }
    await E(hostAgent).storeValue(null, powersName);
    try {
      await E(hostAgent).makeUnconfined('@main', nativeSandboxSpecifier, {
        powersName,
        resultName: [SANDBOX_DIR, 'native-sandbox'],
        env: nativeEnv,
      });
    } finally {
      await E(hostAgent).remove(powersName);
    }
    console.log(`Minted ${SANDBOX_DIR}/native-sandbox`);
  }

  // 5. State provider — `@none`; it ignores its powers and returns host paths
  //    only. The root is prepared only when this run mints the provider: a
  //    retained one keeps the root baked into its formula.
  if (!existingState) {
    await providePrivateDirectory('ENDO_CLAUDE_STATE_DIR', stateDir);
    await E(hostAgent).makeUnconfined('@main', stateProviderSpecifier, {
      powersName: '@none',
      resultName: [SANDBOX_DIR, 'state-provider'],
      env: harden({ ENDO_CLAUDE_STATE_DIR: stateDir }),
    });
    console.log(
      `Minted ${SANDBOX_DIR}/state-provider (state under ${stateDir})`,
    );
  }

  console.log('Claude sandbox HOST setup complete.');
  console.log(
    'Next: `endo inbox`, then submit the "Create Claude Sandbox" form with `endo submit`.',
  );
};
harden(main);
