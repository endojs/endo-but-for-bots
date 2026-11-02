// @ts-check
/* global process */
// Host-side setup of the common scoped Podman service and Codex state provider.
// ENDO_SANDBOX_RUNTIME_DIR and generated-file limits configure the native
// service. ENDO_CODEX_STATE_DIR holds separate host records and CLI homes.
// Both formulas retain slot-free null powers. Quota and volume configuration
// are obsolete; the session owner records placement and owns native cleanup.

import { createHash } from 'node:crypto';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { assertNoRuntimeLeftovers } from '@endo/hosted-agent/hosted-setup.js';

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
 * Stable native reconciliation identity, also pinned by the broker service.
 * Keep the prior derivation so old exact-owner resources remain identifiable
 * during explicit retirement; changing a label is not evidence of cleanup.
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
    await assertRuntimePlacement(native.config.directory, {
      stateDir,
    });
    console.log(
      'Retaining owned native sandbox service with its persisted configuration; current runtime environment is not reapplied.',
    );
  } else {
    const ownerId =
      env.ENDO_CODEX_SANDBOX_OWNER_ID || (await deriveCodexOwnerId(hostAgent));
    nativeEnv = await prepareRuntimeEnv(env, ownerId, {
      stateDir,
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
