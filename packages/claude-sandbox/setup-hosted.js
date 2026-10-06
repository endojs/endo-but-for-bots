// @ts-check
/* global process */
// endo run --UNCONFINED setup-hosted.js --powers @agent
//
// Single-machine hosted provisioning: mint the managed Anthropic credential,
// the daemon-owned session services (the Anthropic provider broker and the
// session storage owner), and the `claude-backend` hosted backend factory
// that records one native Claude session per Floot session (with its Endo
// tools bridged in over MCP), without inbox forms. Intended for ENDO_EXTRA
// alongside setup-host.js, after floot-factory-setup.js.
//
// Reads (ENDO_-prefixed only: a hosted daemon forwards nothing else to its
// ENDO_EXTRA subprocesses, and a developer shell's own CLAUDE_CODE_OAUTH_TOKEN
// or ANTHROPIC_API_KEY must never seed the daemon's secret by accident):
//   ENDO_CLAUDE_OAUTH_TOKEN — seed Claude subscription token from
//     `claude setup-token`. The CLI runtime then bills against a Pro/Max
//     subscription instead of API credits, and takes precedence over the API
//     key below.
//   ENDO_FLOOT_AUTH_TOKEN — seed API key. Either seed enters the Endo secrets
//     manager only when no SecretBlob exists yet; a stale variable never
//     overwrites an existing (possibly rotated) secret.
//   ENDO_CLAUDE_CREDS_KIND — `apiKey` or `oauthToken`. Required when a broker
//     is minted and no seed names the kind (a subscription token, or an
//     `sk-ant-oat`/`sk-ant-api` prefix, names it); a retained broker's
//     persisted kind applies otherwise and must not be contradicted
//   ENDO_CLAUDE_CREDS_NAME (default claude-creds) — the secret name
//   ENDO_FLOOT_DIR / FLOOT_DIR (default floot) — Floot's host directory, whose
//     controller-profile the backend is bound into; not a seed, so the bare
//     spelling is still honored
//   ENDO_CLAUDE_BACKEND_NAME (default claude-backend) — the name Floot's
//     factory discovers the backend under, in its controller profile
//   ENDO_CLAUDE_WORKSPACE_DIR — base host path for per-session workspaces
//   ENDO_CLAUDE_MCP_DIR — base host path for per-session private directories
//   ENDO_CLAUDE_SANDBOX_IMAGE — OCI rootfs (`oci:<image>` name); pinned to
//     its digest through Podman when a broker is minted, ignored when one is
//     retained
//   ENDO_NINEP_SUDO=1, ENDO_NINEP_MOUNT_PROGRAM, ENDO_NINEP_UMOUNT_PROGRAM
//     (or their unprefixed spellings; the ENDO_ spelling wins) — rootless
//     mount settings recorded into every session plan for the session's own
//     9P mounter. An empty value is unset; a present program is checked with
//     the mounter's own program check, and a present NINEP_SUDO must be
//     exactly `1`
//   ENDO_CLAUDE_MAX_SESSIONS, ENDO_CLAUDE_PUBLIC_INTERNET=1,
//     ENDO_CLAUDE_DIAGNOSTICS=1 — the broker's operator settings: concurrent
//     session capacity (1–256; unset keeps the broker's), public egress, and
//     a log line per admission. Applied to a retained broker at every start,
//     no retirement; turning public egress off stops live public listeners.
//     Failures are logged regardless (the slice only ever sees a bare 502,
//     so the broker worker's log is where a cause is found)
//   ENDO_CLAUDE_BROKER_LISTENER_IMAGE — digest-pinned listener image;
//     required unless a broker service is retained
//   ENDO_CLAUDE_BROKER_DIR, ENDO_CLAUDE_BROKER_OWNER_ID,
//     ENDO_CLAUDE_ANTHROPIC_BETA — the broker's directory, owner label
//     (derived from the host identity by default), and the `anthropic-beta`
//     capabilities it sends (the OAuth default for subscription tokens when
//     unset); applied only when a broker service is minted, ignored when one
//     is retained
//
// Idempotent: the credential, the broker, the storage owner, and the session
// base directories are reused; the backend caplet — the one formula whose
// module path is tied to a release checkout — is re-created on every run and
// re-bound into the Floot profile. Everything a minted owner would refuse at
// construction is refused before the first mint: the daemon binds a formula
// before evaluating it, and a formula that cannot construct is still bound
// and retained.
//
// The sequence itself is `@endo/hosted-agent/hosted-backend-setup.js`, shared
// with the OpenCode adapter; what is Claude's own (the credential kinds and
// pool, the `anthropic-beta` profile, the state provider the storage owner is
// minted over) is the code between its steps here.

import { Fail, q } from '@endo/errors';
import { readBrokerWorkloadEnv } from '@endo/hosted-agent/provider-broker-service.js';
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
import {
  assertRetainedBrokerImages,
  mintWithPowersPath,
} from '@endo/hosted-agent/hosted-setup.js';
import { provideManagedCredentials } from '@endo/hosted-agent/managed-credentials.js';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from '@endo/hosted-agent/current-specifier.js';
import { ANTHROPIC_BETA_PATTERN } from './src/claude-broker.js';
import { readClaudeBrokerConfig } from './src/claude-broker-service-agent.js';
import { assertCredentialKind } from './src/claude-credential-kinds.js';
import { prepareClaudePool, readClaudePool } from './src/claude-pool-setup.js';
import {
  SANDBOX_DIR,
  assertRuntimePlacement,
  brokerServiceSpecifier,
  getHostedStorageRoots,
  readBrokerService,
  readNativeSandbox,
  readSessionStorage,
  readStateProvider,
  sessionStorageSpecifier,
} from './src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */
/** @import { CredentialKind } from './src/claude-credential-kinds.js' */

const LABEL = 'Claude';
const PREFIX = 'ENDO_CLAUDE';

const backendModuleSpecifier = toCurrentSpecifier(
  new URL('./src/claude-backend-module.js', import.meta.url).href,
);

/**
 * Tokens minted by `claude setup-token` (a Pro/Max subscription grant) carry an
 * `sk-ant-oat` prefix; raw console API keys carry `sk-ant-api`. The prefix is
 * the only signal available here; an unrecognised seed needs the kind named
 * explicitly or a retained broker to take it from.
 *
 * @param {string} token
 * @returns {CredentialKind | undefined}
 */
export const inferCredentialKind = token => {
  if (token.startsWith('sk-ant-oat')) return 'oauthToken';
  if (token.startsWith('sk-ant-api')) return 'apiKey';
  return undefined;
};
harden(inferCredentialKind);

/**
 * @param {EndoHost} hostAgent
 * @param {{ exec?: (file: string, args: string[]) => Promise<{ stdout: string }> }} [powers]
 */
export const main = async (hostAgent, { exec = undefined } = {}) => {
  await null;
  const { env } = process;
  const workloadEnv = readBrokerWorkloadEnv(env);
  // The account authority this broker serves: the pool's id, or the single
  // account's, as the operator declared it. Every plan records it, and a
  // pool's set carries it as its id.
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
    defaultBackendName: 'claude-backend',
    defaultRootfs: 'oci:localhost/claude-sandbox:latest',
    brokerDirName: 'claude-broker',
  });
  const pool = readClaudePool(env);
  const credsName = env.ENDO_CLAUDE_CREDS_NAME || 'claude-creds';
  const requestedRoots = getHostedStorageRoots(env);
  const anthropicBeta = env.ENDO_CLAUDE_ANTHROPIC_BETA || '';

  // A subscription token wins over an API key: the CLI runtime then bills
  // against the Pro/Max plan rather than API credits. ENDO_FLOOT_AUTH_TOKEN is
  // deliberately not overloaded for this — Floot's `claude-api` runtime talks
  // to the Anthropic API directly and still needs a real API key. Either seed
  // is used only on first setup, when the secrets catalog has no entry for
  // `credsName`; provideManagedCredentials never overwrites an existing
  // secret from a possibly stale environment variable.
  const oauthToken = env.ENDO_CLAUDE_OAUTH_TOKEN || '';
  const seedApiKey = oauthToken || env.ENDO_FLOOT_AUTH_TOKEN || '';
  const namedKind = env.ENDO_CLAUDE_CREDS_KIND || '';
  /** @type {CredentialKind | undefined} */
  const requestedKind =
    (namedKind && assertCredentialKind(namedKind)) ||
    (pool ? 'oauthToken' : undefined) ||
    (oauthToken ? 'oauthToken' : undefined) ||
    (seedApiKey ? inferCredentialKind(seedApiKey) : undefined);

  // Every session's persistent config directory comes from this provider and
  // every session's slice from this runtime; a backend minted without either
  // would fail on first provision.
  await requireProvisioned(hostAgent, SANDBOX_DIR, [
    'state-provider',
    'native-sandbox',
  ]);
  const runtime = await readNativeSandbox(hostAgent);
  const state = await readStateProvider(hostAgent);
  // Like the state root, a retained storage owner's roots are the effective
  // ones; the current environment's roots apply only when the owner is
  // minted now.
  const { existingStorage, workspaceDir, mcpDir } =
    await resolveSessionStorageRoots(hostAgent, {
      prefix: PREFIX,
      sandboxDir: SANDBOX_DIR,
      requestedRoots,
      readSessionStorage: () => readSessionStorage(hostAgent, state.identifier),
    });
  await assertRuntimePlacement(runtime.config.directory, {
    stateDir: state.stateDir,
    workspaceDir,
    mcpDir,
  });

  // The broker's operator profile (the pinned slice image, the credential
  // kind, the models it admits) is persisted in the formula environment;
  // sessions never resolve a mutable credential name. An existing service is
  // retained with its configuration and its credential: the kind is then the
  // persisted one, and a run naming another kind is refused rather than
  // silently re-credentialed (switching means removing the broker and the
  // credential caplet and rotating the secret, since the caplet reports its
  // minted kind and the secret's bytes are never re-seeded). A minted broker
  // needs the kind named: a token whose prefix says nothing, or a secret
  // created in Secrets with no seed here, must not default to a header the
  // credential may not accept.
  const retained = await readRetainedBroker(hostAgent, {
    sandboxDir: SANDBOX_DIR,
    accountAuthority,
    readBrokerService: () => readBrokerService(hostAgent),
  });
  /** @type {CredentialKind} */
  let credentialKind;
  let brokerOwnerId = '';
  if (retained) {
    (retained.pool === true) === (pool !== undefined) ||
      Fail`Changing Claude pool mode requires retiring the broker and its sessions first`;
    credentialKind = retained.credentialKind;
    if (requestedKind !== undefined && requestedKind !== credentialKind) {
      throw Fail`The retained ${q(`${SANDBOX_DIR}/broker-service`)} reads a ${q(credentialKind)} credential and cannot switch to ${q(requestedKind)}: remove it, then either remove the ${q(credsName)} credential and rotate or delete its secret in Secrets, or configure a new ENDO_CLAUDE_CREDS_NAME; then rerun setup`;
    }
    // Likewise its pins: a changed image is refused here, not silently
    // discarded (a live broker cannot be re-pinned in place).
    await assertRetainedBrokerImages({
      label: LABEL,
      serviceName: `${SANDBOX_DIR}/broker-service`,
      retained,
      rootfs,
      listenerImageRef,
      exec,
    });
  } else {
    if (requestedKind === undefined) {
      throw seedApiKey
        ? Fail`ENDO_CLAUDE_CREDS_KIND is required: the seed token's prefix does not name a credential kind`
        : Fail`ENDO_CLAUDE_CREDS_KIND is required when no seed token names the kind of a secret created in Secrets`;
    }
    credentialKind = requestedKind;
    // The broker grant checks this list at every admission; a bad value must
    // not reach a persisted profile every session would then fail against.
    anthropicBeta === '' ||
      ANTHROPIC_BETA_PATTERN.test(anthropicBeta) ||
      Fail`ENDO_CLAUDE_ANTHROPIC_BETA must be a comma-separated capability list: ${q(anthropicBeta)}`;
    brokerOwnerId = await resolveMintedBrokerIdentity(hostAgent, {
      label: LABEL,
      prefix: PREFIX,
      ownerPrefix: 'claude',
      brokerDir,
      brokerOwnerId: requestedOwnerId,
      rootfs,
      listenerImageRef,
    });
  }
  // The broker's directory, like the state and runtime directories, is
  // protected storage the backend refuses to let any guest root resolve into
  // at every provision; a retained broker's persisted directory is the
  // effective one.
  const effectiveBrokerDir = retained ? retained.directory : brokerDir;

  // Assert before the first mint so a failure cannot leave a half-bound
  // profile behind (the credential mint would otherwise commit first).
  assertCurrentSpecifier(backendModuleSpecifier, 'claude-backend');
  if (pool) {
    credentialKind === 'oauthToken' ||
      Fail`Claude pools require oauthToken credentials`;
    const prepared = await prepareClaudePool(hostAgent, pool);
    await prepared.publish();
  } else {
    await provideManagedCredentials(hostAgent, {
      name: credsName,
      ...(seedApiKey ? { apiKey: seedApiKey } : {}),
      kind: credentialKind,
      label: 'Anthropic',
    });
  }

  await provideSessionRoots({ prefix: PREFIX, workspaceDir, mcpDir });
  await assertGuestRootsDisjoint({
    label: LABEL,
    prefix: PREFIX,
    workspaceDir,
    mcpDir,
    effectiveBrokerDir,
    protectedRoots: [
      state.stateDir,
      effectiveBrokerDir,
      runtime.config.directory,
    ],
    protectedDescription:
      'the state directory, the broker directory and the runtime directory',
  });

  // The broker's one exact powers dependency is the managed credential's
  // SecretBlob, or the pool's namespace powers.
  await provideBrokerService(hostAgent, {
    workloadEnv,
    label: LABEL,
    prefix: PREFIX,
    sandboxDir: SANDBOX_DIR,
    existingBroker: retained !== undefined,
    rootfs,
    exec,
    brokerDir,
    brokerOwnerId,
    listenerImageRef,
    identity: {
      credentialKind,
      accountAuthority,
      ...(pool ? { pool: true } : {}),
      ...(anthropicBeta ? { anthropicBeta } : {}),
    },
    brokerSettings,
    configEnvName: 'CLAUDE_BROKER_CONFIG',
    readBrokerConfig: readClaudeBrokerConfig,
    specifier: brokerServiceSpecifier,
    powersPath: pool ? [SANDBOX_DIR, 'broker-powers'] : ['secrets', credsName],
    temporary: `${credsName}.broker-read`,
  });

  // Session storage owner — the `storage` role the daemon owner records with
  // each session and invokes inside record removal. Its powers is the state
  // provider, so removal of the session's persistent config directory keeps
  // that provider's marker checks.
  if (existingStorage) {
    console.log(
      'Retaining Claude session storage with its persisted roots; current workspace and MCP roots are not reapplied.',
    );
  } else {
    await mintWithPowersPath(hostAgent, {
      powersPath: [SANDBOX_DIR, 'state-provider'],
      temporary: 'claude.state-provider-powers',
      specifier: sessionStorageSpecifier,
      resultName: [SANDBOX_DIR, 'session-storage'],
      env: {
        CLAUDE_WORKSPACE_BASE_DIR: workspaceDir,
        CLAUDE_MCP_DIR: mcpDir,
      },
    });
    console.log(`Minted ${SANDBOX_DIR}/session-storage`);
  }

  // Sessions are records under `claude-sandbox/session-records`, owned by
  // the daemon; the factory itself holds nothing durable.
  const backendPath = await provideBackendCaplet(hostAgent, {
    label: LABEL,
    sandboxDir: SANDBOX_DIR,
    specifier: backendModuleSpecifier,
    envPrefix: 'CLAUDE',
    workspaceDir,
    mcpDir,
    mounterEnvText,
  });
  // The factory's bounded per-session `publishWorkspace` tool serves
  // new-project workspaces through the host-global static asset server.
  await bindFlootBackend(hostAgent, {
    flootDir,
    backendName,
    backendPath,
    assetServerName: env.ENDO_FLOOT_ASSET_SERVER || 'asset-server',
  });
  await publishHostedAccount(hostAgent, {
    label: LABEL,
    sandboxDir: SANDBOX_DIR,
    providerId: 'anthropic',
    flootDir,
    backendId: 'claude',
    accountAuthority,
    ...(pool
      ? { subscriptionIds: pool.set.members.map(member => member.id) }
      : {}),
  });
};
harden(main);
