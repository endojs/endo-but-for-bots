// @ts-check
/* global process */
// endo run --UNCONFINED setup-host.js --powers @agent
//   [-E ENDO_OPENCODE_SANDBOX_OWNER_ID=operator-chosen-stable-id]
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

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { assertNoRuntimeLeftovers } from '@endo/hosted-agent/hosted-setup.js';

import {
  assertRuntimePlacement,
  getHostedStorageRoots,
  nativeSandboxSpecifier,
  prepareRuntimeEnv,
  readNativeSandbox,
} from './src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */

// Kept in sync with setup-hosted.js and the backend's session records directory.
const SANDBOX_DIR = 'opencode-sandbox';

/**
 * @param {EndoHost} hostAgent
 */
export const main = async hostAgent => {
  await null;
  const { env } = process;

  // `has` on a path resolves its parent, so probing a name inside SANDBOX_DIR
  // throws `Unknown pet name` on a daemon that has no sandbox state yet — the
  // first probe below died there, and neither stack could bootstrap. An absent
  // directory means an absent name. Answering that here, rather than creating
  // the directory up front, keeps every validation below ahead of the first
  // provisioning mutation.
  /** @param {string} name */
  const hasInSandbox = async name => {
    await null;
    try {
      return await E(hostAgent).has(SANDBOX_DIR, name);
    } catch (error) {
      // Only an absent directory excuses the failure; anything else is real.
      if (await E(hostAgent).has(SANDBOX_DIR)) throw error;
      return false;
    }
  };

  const roots = getHostedStorageRoots(env);
  const legacyFactory = await hasInSandbox('sandbox-factory');
  const legacyMounter = await hasInSandbox('fs-mounter');

  // 1. Native sandbox service — the host-only primary runtime that
  //    daemon-owned session controllers acquire scopes from. It is
  //    constructed with a slot-free null value as powers: it imports no host
  //    or scratch authority, and `@none` would be a denied-method guest
  //    capability, not null. The stored value is a marshal formula the minted
  //    service retains as its exact powers dependency; the temporary name is
  //    not, and its dot keeps it outside the managed-credential name charset.
  /** @type {Record<string, string> | undefined} */
  let nativeEnv;
  if (await hasInSandbox('native-sandbox')) {
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
    await assertNoRuntimeLeftovers(
      nativeEnv.ENDO_SANDBOX_RUNTIME_DIR,
      nativeEnv.ENDO_SANDBOX_OWNER_ID,
    );
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

  console.log('OpenCode sandbox HOST setup complete.');
  console.log(
    'Next: run setup-hosted.js to mint the credential and the Floot backend.',
  );
};
harden(main);
