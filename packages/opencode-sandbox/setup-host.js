// @ts-check
/* global process */
// endo run --UNCONFINED setup-host.js --powers @agent
//   [-E ENDO_OPENCODE_SANDBOX_OWNER_ID=operator-chosen-stable-id]
//   [-E ENDO_OPENCODE_STATE_DIR=/var/lib/endo/opencode-state]
//   -E ENDO_SANDBOX_RUNTIME_DIR=<existing-private-host-directory>
//   -E ENDO_SANDBOX_GENERATED_MAX_BYTES=<decimal-byte-budget>
//   -E ENDO_SANDBOX_GENERATED_MAX_ENTRIES=<positive-decimal-entry-budget>
//
// HOST-side provisioning for the opencode sandbox stack. Run this on the
// machine that runs the containers (Linux + podman). Idempotent. Mints,
// nested under `opencode-sandbox/` so the host root stays clean:
//
//   native-sandbox   — the owned `@endo/sandbox` native Podman runtime that
//                      daemon-owned session controllers acquire scopes from.
//                      It is the primary runtime: it claims the exclusive
//                      ownership marker of `ENDO_SANDBOX_RUNTIME_DIR`, stages
//                      generated files there, and reconciles Podman orphans
//                      under its owner label.
//   state-provider   — host-backed durable per-session state. opencode forces
//                      SQLite WAL, which needs same-host shared memory and
//                      cannot run over the 9P workspace, so each session gets
//                      a 0700 directory under `ENDO_OPENCODE_STATE_DIR`
//                      (default `/var/lib/endo/opencode-state`) exposed to the
//                      slice through a daemon-minted mount.
//
// The capability-based `sandbox-factory` and the shared `fs-mounter` are no
// longer minted: each session mounts its workspace through its controller's
// own 9P mounter, and the native runtime no longer derives its directory and
// owner label from the factory's. A deployment that still binds either name
// keeps it untouched. A new native mint is refused while `sandbox-factory` is
// bound, and separately while the runtime directory still holds an ownership
// marker or generated-files root under the native owner label — the paths the
// retired factory held under the same label, which survive `endo restart` and
// failed cleanup. Neither condition implies the other, and a formula the
// daemon binds before construction would otherwise be retained unusable. The
// rootless mount settings the shared mounter took (`NINEP_SUDO`,
// `NINEP_MOUNT_PROGRAM`, `NINEP_UMOUNT_PROGRAM`) are not read here any more;
// nothing routes them to a session's own mounter yet.
//
// The hosted backend itself (credentials + `opencode-backend`) belongs on the
// same machine — see setup-hosted.js.

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { Fail, q } from '@endo/errors';

import {
  assertRuntimePlacement,
  getHostedStorageRoots,
  nativeSandboxSpecifier,
  prepareRuntimeEnv,
  readNativeSandbox,
  readStateProvider,
  stateProviderSpecifier,
} from './src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */

// Kept in sync with setup-hosted.js and the backend's session records directory.
const SANDBOX_DIR = 'opencode-sandbox';

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
  const existingState = await E(hostAgent).has(SANDBOX_DIR, 'state-provider');
  const requestedRoots = getHostedStorageRoots(env);
  const stateDir = assertStateDir(
    existingState
      ? (await readStateProvider(hostAgent)).stateDir
      : requestedRoots.stateDir,
  );
  const roots = harden({ ...requestedRoots, stateDir });
  const legacyFactory = await E(hostAgent).has(SANDBOX_DIR, 'sandbox-factory');
  const legacyMounter = await E(hostAgent).has(SANDBOX_DIR, 'fs-mounter');

  // 1. Native sandbox service — the host-only primary runtime that
  //    daemon-owned session controllers acquire scopes from. It is
  //    constructed with a slot-free null value as powers: it imports no host
  //    or scratch authority, and `@none` would be a denied-method guest
  //    capability, not null. The stored value is a marshal formula the minted
  //    service retains as its exact powers dependency; the temporary name is
  //    not, and its dot keeps it outside the managed-credential name charset.
  /** @type {Record<string, string> | undefined} */
  let nativeEnv;
  if (await E(hostAgent).has(SANDBOX_DIR, 'native-sandbox')) {
    const native = await readNativeSandbox(hostAgent);
    await assertRuntimePlacement(native.config.directory, roots);
    console.log(
      'Retaining owned native sandbox service with its persisted configuration; current runtime environment is not reapplied.',
    );
  } else {
    // A bound name says nothing about the marker (a cleanly closed factory
    // released it; one that failed construction never held it), but the
    // daemon can revive a bound formula at any lookup or restart, and a
    // revived factory would compete with the native runtime for the same
    // label and marker. Refuse before any mint; the marker probe below is
    // the separate check.
    if (legacyFactory) {
      throw Fail`${SANDBOX_DIR}/sandbox-factory is still bound: retire the old runtime (establish that its processes have stopped, then remove the name) before the native runtime takes the primary runtime directory.`;
    }
    // Podman crash reconciliation must only touch this host's opencode
    // slices. Persist the identity with the runtime so every incarnation uses
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
    nativeEnv = await prepareRuntimeEnv(env, ownerId, roots);
    // The runtime claims `<owner>.owner` and `<owner>.files` in its directory
    // at construction and refuses either if present; a retired runtime under
    // the same label leaves both behind across restart or failed cleanup.
    // Neither is adopted or removed here: the operator establishes that the
    // holder has stopped, then reconciles them, before setup mints anything.
    for (const suffix of ['owner', 'files']) {
      const leftover = path.join(
        nativeEnv.ENDO_SANDBOX_RUNTIME_DIR,
        `${nativeEnv.ENDO_SANDBOX_OWNER_ID}.${suffix}`,
      );
      // eslint-disable-next-line no-await-in-loop
      const info = await lstat(leftover).catch(error => {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
          return undefined;
        throw error;
      });
      if (info !== undefined) {
        throw Fail`Runtime directory still holds ${q(leftover)}: the native runtime would claim it and be refused at construction. Establish that the runtime that held it has stopped, then reconcile it, before rerunning setup.`;
      }
    }
  }

  if (!(await E(hostAgent).has(SANDBOX_DIR))) {
    await E(hostAgent).makeDirectory([SANDBOX_DIR]);
  }
  if (nativeEnv) {
    const powersName = 'opencode.null-powers';
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
  for (const [name, bound] of [
    ['sandbox-factory', legacyFactory],
    ['fs-mounter', legacyMounter],
  ]) {
    if (bound) {
      console.warn(
        `${SANDBOX_DIR}/${name} is bound but no longer minted or used by sessions; remove it once its processes have stopped.`,
      );
    }
  }

  // 2. State provider — `@agent` powers grant `provideMount`, used only by
  //    the legacy client's Mount facade (`provideSessionMount`); a native
  //    session controller takes `prepareSessionDirectory`'s host path and
  //    binds it directly.
  if (!existingState) {
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
      (await stat(stateDir)).uid === process.getuid?.() ||
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
