// @ts-check
/* global process */
// endo run --UNCONFINED setup-host.js --powers @agent
//   [-E ENDO_CODEX_SANDBOX_OWNER_ID=operator-chosen-stable-id]
//   [-E ENDO_CODEX_STATE_DIR=/var/lib/endo/codex-state]
//   -E ENDO_SANDBOX_RUNTIME_DIR=<existing-private-host-directory>
//   -E ENDO_SANDBOX_GENERATED_MAX_BYTES=<decimal-byte-budget>
//   -E ENDO_SANDBOX_GENERATED_MAX_ENTRIES=<positive-decimal-entry-budget>
//   -E ENDO_CODEX_VOLUME_ROOT=<podman volume root>
//   -E ENDO_CODEX_FILESYSTEM=<XFS filesystem holding it>
//   -E ENDO_CODEX_QUOTA_COMMAND=<operator-installed quota bridge>
//   [-E ENDO_CODEX_SUDO_PATH=/run/wrappers/bin/sudo]
//
// HOST-side provisioning for the Codex sandbox stack. Run this on the machine
// that runs the containers (Linux + podman + XFS project quotas). Idempotent.
// Mints, nested under `codex-sandbox/` so the host root stays clean:
//
//   native-sandbox  — the owned `@endo/sandbox` Podman runtime. It claims the
//                     exclusive ownership marker of ENDO_SANDBOX_RUNTIME_DIR,
//                     stages generated files there, reconciles Podman orphans
//                     under its owner label, and builds the kernel-quota
//                     observer the driver requires before admitting a durable
//                     volume mount.
//   state-provider  — one 0700 host directory per session under
//                     ENDO_CODEX_STATE_DIR (default /var/lib/endo/codex-state)
//                     holding the audit journal, its anchors, and the thread
//                     checkpoint, with ownership markers in a provider-owned
//                     `.owners/` beside them.
//
// Both are constructed with slot-free `null` powers: neither imports daemon
// host authority. They live apart from the backend because the backend caplet
// is pinned to a release checkout and is re-minted on every setup run, and
// neither an ownership marker nor durable session state may be re-created each
// time it is.
//
// The credential, broker and backend belong on the same machine — see
// setup-hosted.js.

import { createHash } from 'node:crypto';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { assertNoRuntimeLeftovers } from '@endo/hosted-agent/hosted-setup.js';

import { readCodexNativeConfig } from './src/codex-native-agent.js';
import { assertCodexStateRoot } from './src/codex-state-provider.js';
import {
  SANDBOX_DIR,
  assertRuntimePlacement,
  nativeSandboxSpecifier,
  prepareRuntimeEnv,
  readNativeSandbox,
  readStateProvider,
  stateProviderSpecifier,
} from './src/hosted-runtime-setup.js';

/**
 * The Podman reconciliation label, the volume registry's recorded owner and the
 * broker listener's lock name are one identity in this adapter, and the
 * registry refuses a change outright once it has recorded one. This derivation
 * is therefore not free to change: it reproduces what the backend caplet
 * computed for itself while it still held `@agent` to ask the daemon for a host
 * identity.
 *
 * @param {any} hostAgent
 */
export const deriveCodexOwnerId = async hostAgent => {
  const hostId = await E(hostAgent).identify('@agent');
  (typeof hostId === 'string' && hostId.length > 0) ||
    Fail`Cannot identify Codex sandbox host`;
  return `codex-${createHash('sha256').update(hostId).digest('hex').slice(0, 56)}`;
};
harden(deriveCodexOwnerId);

/** @param {any} hostAgent */
export const main = async hostAgent => {
  await null;
  const { env } = process;

  // `has` on a path resolves its parent, so probing a name inside SANDBOX_DIR
  // throws `Unknown pet name` on a daemon that has no Codex state yet. An
  // absent directory means an absent name. Answering that here, rather than
  // creating the directory up front, keeps every validation below ahead of the
  // first provisioning mutation.
  /** @param {string} name */
  const hasInSandbox = async name => {
    await null;
    try {
      return await E(hostAgent).has(SANDBOX_DIR, name);
    } catch (error) {
      if (await E(hostAgent).has(SANDBOX_DIR)) throw error;
      return false;
    }
  };

  const existingState = await hasInSandbox('state-provider');
  // A retained provider's root is the effective one: its formula has the root
  // baked in, so creating a different one from a changed environment would be a
  // stray directory, not a rebind.
  const stateDir = existingState
    ? (await readStateProvider(hostAgent)).stateDir
    : assertCodexStateRoot(
        env.ENDO_CODEX_STATE_DIR || '/var/lib/endo/codex-state',
      );

  /** @type {Record<string, string> | undefined} */
  let nativeEnv;
  if (await hasInSandbox('native-sandbox')) {
    const native = await readNativeSandbox(hostAgent);
    // The persisted quota configuration names the effective volume root; the
    // current environment's is not what this runtime observes.
    await assertRuntimePlacement(native.config.directory, {
      stateDir,
      volumeRoot: native.quota.volumeRoot,
    });
    console.log(
      'Retaining owned native sandbox service with its persisted configuration; current runtime environment is not reapplied.',
    );
  } else {
    const ownerId =
      env.ENDO_CODEX_SANDBOX_OWNER_ID || (await deriveCodexOwnerId(hostAgent));
    // Validate the whole construction policy — the runtime's and the quota
    // bridge's — before any placement work, so a missing variable is reported
    // by name rather than as an unresolvable storage root. A runtime that could
    // not observe quotas would otherwise be refused at a session's first mount.
    const requested = readCodexNativeConfig({
      ...env,
      ENDO_SANDBOX_OWNER_ID: ownerId,
    });
    // Generated files and Podman's volumes must not share a tree: the runtime
    // stages host-writable content under its own directory, and a volume root
    // inside it would put guest-writable storage in the same place.
    const runtimeEnv = await prepareRuntimeEnv(env, ownerId, {
      stateDir,
      volumeRoot: requested.quota.volumeRoot,
    });
    // Persist what the runtime resolved, not what the operator typed: the
    // sudo path has a default, and a formula should record the value it will
    // actually use rather than re-deriving it on every revival.
    nativeEnv = harden({
      ...runtimeEnv,
      ENDO_CODEX_VOLUME_ROOT: requested.quota.volumeRoot,
      ENDO_CODEX_FILESYSTEM: requested.quota.filesystem,
      ENDO_CODEX_QUOTA_COMMAND: requested.quota.quotaCommand,
      ENDO_CODEX_SUDO_PATH: requested.quota.sudoPath,
    });
    await assertNoRuntimeLeftovers(
      nativeEnv.ENDO_SANDBOX_RUNTIME_DIR,
      nativeEnv.ENDO_SANDBOX_OWNER_ID,
    );
  }

  if (!(await E(hostAgent).has(SANDBOX_DIR))) {
    await E(hostAgent).makeDirectory([SANDBOX_DIR]);
  }

  if (nativeEnv) {
    // The stored value is a marshal formula the minted service retains as its
    // exact powers dependency; the temporary name is not, and its dot keeps it
    // outside the managed-credential name charset.
    const powersName = 'codex.null-powers';
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

  if (!existingState) {
    const powersName = 'codex.state-null-powers';
    if (await E(hostAgent).has(powersName)) {
      await E(hostAgent).remove(powersName);
    }
    await E(hostAgent).storeValue(null, powersName);
    try {
      await E(hostAgent).makeUnconfined('@main', stateProviderSpecifier, {
        powersName,
        resultName: [SANDBOX_DIR, 'state-provider'],
        env: harden({ ENDO_CODEX_STATE_DIR: stateDir }),
      });
    } finally {
      await E(hostAgent).remove(powersName);
    }
    console.log(
      `Minted ${SANDBOX_DIR}/state-provider (state under ${stateDir})`,
    );
  } else {
    console.log(
      'Retaining Codex session state provider with its persisted root; the current ENDO_CODEX_STATE_DIR is not reapplied.',
    );
  }

  console.log('Codex sandbox HOST setup complete.');
  console.log(
    'Next: run setup-hosted.js to mint the credential and the Floot backend.',
  );
};
harden(main);
