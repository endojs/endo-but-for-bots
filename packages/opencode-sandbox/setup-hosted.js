// @ts-check
/* global process */
// endo run --UNCONFINED setup-hosted.js --powers @agent
//
// Single-machine hosted provisioning: mint the managed OpenRouter credential,
// the daemon-owned session services, and the `opencode-backend` hosted backend
// factory that records one native OpenCode session per Floot session (with
// its Endo tools bridged in over MCP), without inbox forms. Intended for
// ENDO_EXTRA alongside setup-host.js, after floot-factory-setup.js.
//
// Reads (first match wins):
//   ENDO_OPENROUTER_API_KEY — initial OpenRouter API key. Seeds the secret in
//     the Endo secrets manager only when no SecretBlob exists yet; a stale
//     variable never overwrites an existing (possibly rotated) secret.
//   ENDO_OPENCODE_CREDS_NAME (default openrouter-auth) — the OpenCode secret
//     name. Deliberately NOT derived from Floot's provider variables: those
//     may name a provider credential of another kind (e.g. an Anthropic key),
//     which must never be injected into the slice as OPENROUTER_API_KEY. The
//     deployment points this at the same secret Floot's OpenRouter provider
//     uses.
//   ENDO_OPENCODE_BACKEND_NAME (default opencode-backend) — the name Floot's
//     factory discovers the backend under, in its controller profile
//   ENDO_OPENCODE_WORKSPACE_DIR — base host path for per-session workspaces
//   ENDO_OPENCODE_MCP_DIR — base host path for per-session MCP sockets
//   ENDO_OPENCODE_SANDBOX_IMAGE — OCI rootfs (`oci:<image>` name); pinned to
//     its digest through Podman when a broker is minted, ignored when one is
//     retained
//   ENDO_NINEP_SUDO=1, ENDO_NINEP_MOUNT_PROGRAM, ENDO_NINEP_UMOUNT_PROGRAM
//     (or their unprefixed spellings; the ENDO_ spelling wins) — rootless
//     mount settings recorded into every session plan for the session's own
//     9P mounter. An empty value is unset, like the other optional
//     variables here;
//     a present program is checked with the mounter's own program check, and
//     a present NINEP_SUDO must be exactly `1` (the mounter would silently
//     treat anything else as off)
//   ENDO_OPENCODE_MAX_SESSIONS, ENDO_OPENCODE_PUBLIC_INTERNET=1,
//     ENDO_OPENCODE_DIAGNOSTICS=1 — the broker's operator settings: concurrent
//     session capacity (1–256; unset keeps the broker's), public egress, and
//     a log line per admission. Applied to a retained broker at every start,
//     no retirement; turning public egress off stops live public listeners.
//     Failures are logged regardless (the slice only ever sees a bare 502,
//     so the broker worker's log is where a cause is found)
//   ENDO_OPENCODE_BROKER_LISTENER_IMAGE — digest-pinned listener image;
//     required unless a broker service is retained
//   ENDO_OPENCODE_BROKER_DIR, ENDO_OPENCODE_BROKER_OWNER_ID — the broker's
//     directory and owner label (derived from the host identity by default);
//     applied only when a broker service is minted, ignored when one is
//     retained
//
// Idempotent: the credential and the session base directories are reused; the
// backend caplet — the one formula whose module path is tied to a release
// checkout — is re-created on every run and re-bound into the Floot profile.
//
// The sequence itself is `@endo/hosted-agent/hosted-backend-setup.js`, shared
// with the Claude adapter; what is OpenCode's own (the OpenRouter API key, the
// storage owner minted over null powers) is the code between its steps here.

import { E } from '@endo/eventual-send';
import {
  assertGuestRootsDisjoint,
  bindFlootBackend,
  provideBackendCaplet,
  provideBrokerService,
  provideSessionRoots,
  publishHostedAccount,
  readHostedBackendEnvironment,
  readRetainedBroker,
  requireProvisioned,
  resolveMintedBrokerIdentity,
  resolveSessionStorageRoots,
} from '@endo/hosted-agent/hosted-backend-setup.js';
import { assertRetainedBrokerImages } from '@endo/hosted-agent/hosted-setup.js';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from '@endo/hosted-agent/current-specifier.js';
import { provideManagedCredentials } from './src/managed-credentials.js';
import {
  SANDBOX_DIR,
  assertRuntimePlacement,
  brokerServiceSpecifier,
  getHostedStorageRoots,
  readBrokerService,
  readNativeSandbox,
  readSessionStorage,
  sessionStorageSpecifier,
} from './src/hosted-runtime-setup.js';
import { readOpencodeBrokerConfig } from './src/opencode-broker-service-agent.js';

/** @import { EndoHost } from '@endo/daemon' */

const LABEL = 'OpenCode';
const PREFIX = 'ENDO_OPENCODE';

const backendModuleSpecifier = toCurrentSpecifier(
  new URL('./src/opencode-backend-module.js', import.meta.url).href,
);

/**
 * @param {EndoHost} hostAgent
 * @param {{ exec?: (file: string, args: string[]) => Promise<{ stdout: string }> }} [powers]
 */
export const main = async (hostAgent, { exec = undefined } = {}) => {
  await null;
  const { env } = process;

  const credsName = env.ENDO_OPENCODE_CREDS_NAME || 'openrouter-auth';
  // The account authority this broker serves, the OpenRouter account's id
  // as the operator declared it. Every plan records it.
  const {
    accountAuthority,
    backendName,
    rootfs,
    listenerImageRef,
    brokerDir,
    brokerOwnerId: requestedOwnerId,
    brokerSettings,
    mounterEnvText,
    flootDir,
  } = readHostedBackendEnvironment(env, {
    label: LABEL,
    prefix: PREFIX,
    defaultBackendName: 'opencode-backend',
    defaultRootfs: 'oci:localhost/opencode-sandbox:latest',
    brokerDirName: 'opencode-broker',
  });
  const requestedRoots = getHostedStorageRoots(env);
  // A seed value is used only on first setup, when the secrets catalog has no
  // entry for `credsName`; provideManagedCredentials never overwrites an
  // existing secret from a possibly stale environment variable.
  const seedApiKey = env.ENDO_OPENROUTER_API_KEY || '';

  // The native sandbox service is what session controllers acquire scopes from.
  await requireProvisioned(hostAgent, SANDBOX_DIR, ['native-sandbox']);
  const runtime = await readNativeSandbox(hostAgent);
  const { existingStorage, workspaceDir, mcpDir } =
    await resolveSessionStorageRoots(hostAgent, {
      prefix: PREFIX,
      sandboxDir: SANDBOX_DIR,
      requestedRoots,
      readSessionStorage: () => readSessionStorage(hostAgent),
    });
  await assertRuntimePlacement(runtime.config.directory, {
    workspaceDir,
    mcpDir,
  });

  // A retained broker keeps its pins; a changed image is refused, not
  // silently discarded (a live broker cannot be re-pinned in place).
  const retained = await readRetainedBroker(hostAgent, {
    sandboxDir: SANDBOX_DIR,
    accountAuthority,
    readBrokerService: () => readBrokerService(hostAgent),
  });
  let brokerOwnerId = '';
  if (retained) {
    await assertRetainedBrokerImages({
      label: LABEL,
      serviceName: `${SANDBOX_DIR}/broker-service`,
      retained,
      rootfs,
      listenerImageRef,
      exec,
    });
  } else {
    brokerOwnerId = await resolveMintedBrokerIdentity(hostAgent, {
      label: LABEL,
      prefix: PREFIX,
      ownerPrefix: 'opencode',
      brokerDir,
      brokerOwnerId: requestedOwnerId,
      rootfs,
      listenerImageRef,
    });
  }
  // The broker's directory, like the runtime directory, is protected storage
  // the backend refuses to let any guest root resolve into at every
  // provision; a retained broker's persisted directory is the effective one.
  const effectiveBrokerDir = retained ? retained.directory : brokerDir;

  // Assert before the first mint so a failure cannot leave a half-bound
  // profile behind (the credential mint would otherwise commit first).
  assertCurrentSpecifier(backendModuleSpecifier, 'opencode-backend');
  await provideManagedCredentials(hostAgent, {
    name: credsName,
    ...(seedApiKey ? { apiKey: seedApiKey } : {}),
    kind: 'apiKey',
  });

  await provideSessionRoots({ prefix: PREFIX, workspaceDir, mcpDir });
  await assertGuestRootsDisjoint({
    label: LABEL,
    prefix: PREFIX,
    workspaceDir,
    mcpDir,
    effectiveBrokerDir,
    protectedRoots: [effectiveBrokerDir, runtime.config.directory],
    protectedDescription: 'the broker directory and the runtime directory',
  });

  // The broker's one exact powers dependency is the managed credential's
  // SecretBlob.
  await provideBrokerService(hostAgent, {
    label: LABEL,
    prefix: PREFIX,
    sandboxDir: SANDBOX_DIR,
    existingBroker: retained !== undefined,
    rootfs,
    exec,
    brokerDir,
    brokerOwnerId,
    listenerImageRef,
    identity: { accountAuthority },
    brokerSettings,
    configEnvName: 'OPENCODE_BROKER_CONFIG',
    readBrokerConfig: readOpencodeBrokerConfig,
    specifier: brokerServiceSpecifier,
    powersPath: ['secrets', credsName],
    temporary: `${credsName}.broker-read`,
  });

  // Session storage owner — the `storage` role the daemon owner records with
  // each session and invokes inside record removal. It has null powers:
  // OpenCode's CLI database is ephemeral; the stack retains the transcript.
  if (existingStorage) {
    console.log(
      'Retaining OpenCode session storage with its persisted roots; current workspace and MCP roots are not reapplied.',
    );
  } else {
    const powersName = 'opencode.storage-null-powers';
    if (await E(hostAgent).has(powersName))
      await E(hostAgent).remove(powersName);
    await E(hostAgent).storeValue(null, powersName);
    try {
      await E(hostAgent).makeUnconfined('@main', sessionStorageSpecifier, {
        powersName,
        resultName: [SANDBOX_DIR, 'session-storage'],
        env: harden({
          OPENCODE_WORKSPACE_BASE_DIR: workspaceDir,
          OPENCODE_MCP_DIR: mcpDir,
        }),
      });
    } finally {
      await E(hostAgent).remove(powersName);
    }
    console.log(`Minted ${SANDBOX_DIR}/session-storage`);
  }

  // Sessions are records under `opencode-sandbox/session-records`, owned by
  // the daemon; the factory itself holds nothing durable.
  const backendPath = await provideBackendCaplet(hostAgent, {
    label: LABEL,
    sandboxDir: SANDBOX_DIR,
    specifier: backendModuleSpecifier,
    envPrefix: 'OPENCODE',
    workspaceDir,
    mcpDir,
    mounterEnvText,
  });
  await bindFlootBackend(hostAgent, { flootDir, backendName, backendPath });
  await publishHostedAccount(hostAgent, {
    label: LABEL,
    sandboxDir: SANDBOX_DIR,
    providerId: 'openrouter',
    flootDir,
    backendId: 'opencode',
    accountAuthority,
  });
};
harden(main);
