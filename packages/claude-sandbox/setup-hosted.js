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
//   ENDO_CLAUDE_NATIVE_PROFILE — the deployment resource profile (JSON)
//     recorded into every session plan; required, no default
//   ENDO_NINEP_SUDO=1, ENDO_NINEP_MOUNT_PROGRAM, ENDO_NINEP_UMOUNT_PROGRAM
//     (or their unprefixed spellings; the ENDO_ spelling wins) — rootless
//     mount settings recorded into every session plan for the session's own
//     9P mounter. An empty value is unset; a present program is checked with
//     the mounter's own program check, and a present NINEP_SUDO must be
//     exactly `1`
//   ENDO_CLAUDE_DIAGNOSTICS=1 — log host-side broker upstream failures
//     and admission events. Off by default. The slice only ever sees a
//     bare 502, so this is the only way to learn why one happened;
//     applied only when a broker service is minted
//   ENDO_CLAUDE_BROKER_LISTENER_IMAGE — digest-pinned listener image;
//     required unless a broker service is retained
//   ENDO_CLAUDE_BROKER_DIR, ENDO_CLAUDE_BROKER_OWNER_ID,
//     ENDO_CLAUDE_PUBLIC_INTERNET, ENDO_CLAUDE_ANTHROPIC_BETA — the broker's
//     directory, owner label (derived from the host identity by default),
//     public egress flag, and the `anthropic-beta` capabilities it sends
//     (the OAuth default for subscription tokens when unset); applied only
//     when a broker service is minted, ignored when one is retained
//
// Idempotent: the credential, the broker, the storage owner, and the session
// base directories are reused; the backend caplet — the one formula whose
// module path is tied to a release checkout — is re-created on every run and
// re-bound into the Floot profile. Everything a minted owner would refuse at
// construction is refused before the first mint: the daemon binds a formula
// before evaluating it, and a formula that cannot construct is still bound
// and retained.

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import {
  mintWithPowersPath,
  providePrivateDirectory,
} from '@endo/hosted-agent/hosted-setup.js';
import { provideManagedCredentials } from '@endo/hosted-agent/managed-credentials.js';
import { BROKER_OWNER_PATTERN } from '@endo/hosted-agent/provider-broker-service.js';
import {
  isNormalizedAbsolutePath,
  readMounterEnv,
  readNativeProfile,
} from '@endo/hosted-agent/session-plan.js';

import { CLAUDE_CLI_MODELS } from './src/claude-backend-factory.js';
import { ANTHROPIC_BETA_PATTERN } from './src/claude-broker.js';
import { readClaudeBrokerConfig } from './src/claude-broker-service-agent.js';
import { assertCredentialKind } from './src/claude-credential-kinds.js';
import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './src/current-specifier.js';
import {
  SANDBOX_DIR,
  assertRuntimePlacement,
  brokerServiceSpecifier,
  getHostedStorageRoots,
  readBrokerService,
  readNativeSandbox,
  readSessionStorage,
  readSliceImageReference,
  readStateProvider,
  resolvePinnedImageRef,
  sessionStorageSpecifier,
} from './src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */
/** @import { CredentialKind } from './src/claude-credential-kinds.js' */

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
 * @param {{ exec?: Parameters<typeof resolvePinnedImageRef>[1] }} [powers]
 */
export const main = async (hostAgent, { exec = undefined } = {}) => {
  await null;
  const { env } = process;

  const credsName = env.ENDO_CLAUDE_CREDS_NAME || 'claude-creds';
  const backendName = env.ENDO_CLAUDE_BACKEND_NAME || 'claude-backend';
  if (backendName !== 'claude-backend') {
    console.warn(
      `Claude backend name is "${backendName}"; Floot's factory only discovers "claude-backend" unless its own configuration is changed to match.`,
    );
  }
  const requestedRoots = getHostedStorageRoots(env);
  const rootfs =
    env.ENDO_CLAUDE_SANDBOX_IMAGE || 'oci:localhost/claude-sandbox:latest';
  // Daemon-owned sessions require the provider broker, so the listener image
  // is required whenever one is minted; there is no session path without one.
  const listenerImageRef = env.ENDO_CLAUDE_BROKER_LISTENER_IMAGE || '';
  const brokerDir =
    env.ENDO_CLAUDE_BROKER_DIR || path.join(os.homedir(), 'claude-broker');
  const publicInternet = env.ENDO_CLAUDE_PUBLIC_INTERNET === '1';
  // Host-side broker diagnostics. Off by default: the hooks log every
  // upstream failure and admission event, which is operator-visible detail
  // about a credentialed request path.
  const diagnostics = env.ENDO_CLAUDE_DIAGNOSTICS === '1';
  const anthropicBeta = env.ENDO_CLAUDE_ANTHROPIC_BETA || '';
  // The deployment resource profile is recorded into each session plan by the
  // backend. It has no defaults; validate the operator's value before any
  // mint so a malformed profile cannot reach a formula environment.
  const nativeProfileText = env.ENDO_CLAUDE_NATIVE_PROFILE;
  if (typeof nativeProfileText !== 'string') {
    throw Fail`ENDO_CLAUDE_NATIVE_PROFILE is required: the backend records it into every session plan`;
  }
  readNativeProfile(JSON.parse(nativeProfileText));
  // The rootless mount settings a session's own 9P mounter needs, recorded
  // into every plan through the backend. A hosted daemon forwards only
  // ENDO_-prefixed variables to its ENDO_EXTRA subprocesses, so the mounter's
  // own names are also accepted under their ENDO_ spelling.
  /** @type {Record<string, string>} */
  const mounterSettings = {};
  for (const name of [
    'NINEP_SUDO',
    'NINEP_MOUNT_PROGRAM',
    'NINEP_UMOUNT_PROGRAM',
  ]) {
    const value = env[`ENDO_${name}`] || env[name];
    if (value) mounterSettings[name] = value;
  }
  const mounterEnvText =
    Object.keys(mounterSettings).length === 0
      ? undefined
      : JSON.stringify(readMounterEnv(mounterSettings));

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
    (oauthToken ? 'oauthToken' : undefined) ||
    (seedApiKey ? inferCredentialKind(seedApiKey) : undefined);

  // Every session's persistent config directory comes from this provider and
  // every session's slice from this runtime; a backend minted without either
  // would fail on first provision.
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'state-provider'))) {
    throw Fail`${q(`${SANDBOX_DIR}/state-provider`)} is missing — run setup-host.js first.`;
  }
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'native-sandbox'))) {
    throw Fail`${q(`${SANDBOX_DIR}/native-sandbox`)} is missing — run setup-host.js first.`;
  }
  const runtime = await readNativeSandbox(hostAgent);
  const state = await readStateProvider(hostAgent);
  // Like the state root, a retained storage owner's roots are the effective
  // ones: the backend must record sessions where that owner can remove them.
  // The current environment's roots apply only when the owner is minted now.
  const existingStorage = await E(hostAgent).has(
    SANDBOX_DIR,
    'session-storage',
  );
  const { workspaceDir, mcpDir } = existingStorage
    ? (await readSessionStorage(hostAgent)).roots
    : requestedRoots;
  // Refuse before any mint what the storage owner would refuse at
  // construction; a formula that cannot construct is still bound and would be
  // retained by every later run.
  isNormalizedAbsolutePath(workspaceDir) ||
    Fail`ENDO_CLAUDE_WORKSPACE_DIR (or the retained storage owner's root) must be a normalized absolute path: ${q(workspaceDir)}`;
  isNormalizedAbsolutePath(mcpDir) ||
    Fail`ENDO_CLAUDE_MCP_DIR (or the retained storage owner's root) must be a normalized absolute path: ${q(mcpDir)}`;
  await assertRuntimePlacement(runtime.config.directory, {
    stateDir: state.stateDir,
    workspaceDir,
    mcpDir,
  });

  // Provider broker service — an owned native service whose one exact powers
  // dependency is the managed credential's SecretBlob. Its operator profile
  // (the pinned slice image, the credential kind, the models it admits) is
  // persisted in the formula environment; sessions never resolve a mutable
  // credential name. An existing service is retained with its configuration
  // and its credential: the kind is then the persisted one, and a run naming
  // another kind is refused rather than silently re-credentialed (switching
  // means removing the broker and the credential caplet and rotating the
  // secret, since the caplet reports its minted kind and the secret's bytes
  // are never re-seeded). A minted broker needs the kind named: a token whose
  // prefix says nothing, or a secret created in Secrets with no seed here,
  // must not default to a header the credential may not accept. Otherwise
  // everything the broker kit would refuse of the operator's values is
  // refused here first; only asking Podman for an unpinned slice image's
  // digest and creating the broker directory wait for the mint.
  const existingBroker = await E(hostAgent).has(SANDBOX_DIR, 'broker-service');
  /** @type {CredentialKind} */
  let credsKind;
  let brokerOwnerId = '';
  if (existingBroker) {
    const broker = await readBrokerService(hostAgent);
    credsKind = broker.config.credentialKind;
    if (requestedKind !== undefined && requestedKind !== credsKind) {
      throw Fail`The retained ${q(`${SANDBOX_DIR}/broker-service`)} reads a ${q(credsKind)} credential and cannot switch to ${q(requestedKind)}: remove it, then either remove the ${q(credsName)} credential and rotate or delete its secret in Secrets, or configure a new ENDO_CLAUDE_CREDS_NAME; then rerun setup`;
    }
  } else {
    if (requestedKind === undefined) {
      throw seedApiKey
        ? Fail`ENDO_CLAUDE_CREDS_KIND is required: the seed token's prefix does not name a credential kind`
        : Fail`ENDO_CLAUDE_CREDS_KIND is required when no seed token names the kind of a secret created in Secrets`;
    }
    credsKind = requestedKind;
    if (listenerImageRef === '') {
      throw Fail`ENDO_CLAUDE_BROKER_LISTENER_IMAGE is required: the backend records the broker service into every session plan`;
    }
    isNormalizedAbsolutePath(brokerDir) ||
      Fail`ENDO_CLAUDE_BROKER_DIR must be a normalized absolute path: ${q(brokerDir)}`;
    // The broker grant checks this list at every admission; a bad value must
    // not reach a persisted profile every session would then fail against.
    anthropicBeta === '' ||
      ANTHROPIC_BETA_PATTERN.test(anthropicBeta) ||
      Fail`ENDO_CLAUDE_ANTHROPIC_BETA must be a comma-separated capability list: ${q(anthropicBeta)}`;
    brokerOwnerId = env.ENDO_CLAUDE_BROKER_OWNER_ID || '';
    if (brokerOwnerId === '') {
      const hostId = await E(hostAgent).identify('@agent');
      if (typeof hostId !== 'string' || hostId.length === 0) {
        throw Fail`Cannot identify the Claude broker host`;
      }
      brokerOwnerId = `claude-${createHash('sha256').update(hostId).digest('hex').slice(0, 48)}`;
    }
    BROKER_OWNER_PATTERN.test(brokerOwnerId) ||
      Fail`ENDO_CLAUDE_BROKER_OWNER_ID must match ${q(BROKER_OWNER_PATTERN)}: ${q(brokerOwnerId)}`;
    // Mirrors the listener runtime's identity check; setup pins the slice
    // image itself but never rewrites the listener reference.
    /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(listenerImageRef) ||
      Fail`ENDO_CLAUDE_BROKER_LISTENER_IMAGE must be a lowercase, digest-pinned image reference: ${q(listenerImageRef)}`;
    readSliceImageReference(rootfs);
  }

  // Assert before the first mint so a failure cannot leave a half-bound
  // profile behind (the credential mint would otherwise commit first).
  assertCurrentSpecifier(backendModuleSpecifier, 'claude-backend');
  await provideManagedCredentials(hostAgent, {
    name: credsName,
    ...(seedApiKey ? { apiKey: seedApiKey } : {}),
    kind: credsKind,
    label: 'Anthropic',
  });

  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  // The MCP socket base must be private and symlink-free: a planted link here
  // would redirect the per-session sockets another process can then squat.
  await providePrivateDirectory('ENDO_CLAUDE_MCP_DIR', mcpDir);

  if (existingBroker) {
    console.log(
      'Retaining Claude broker service with its persisted configuration.',
    );
  } else {
    const { imageRef, imageDigest } = await resolvePinnedImageRef(rootfs, exec);
    await providePrivateDirectory('ENDO_CLAUDE_BROKER_DIR', brokerDir);
    const brokerConfig = JSON.stringify({
      ownerId: brokerOwnerId,
      directory: brokerDir,
      imageRef,
      imageDigest,
      listenerImageRef,
      // The broker admits the catalog's Anthropic model ids, which the CLI
      // sends verbatim in its request bodies.
      models: CLAUDE_CLI_MODELS.map(model => model.id),
      credentialKind: credsKind,
      ...(anthropicBeta ? { anthropicBeta } : {}),
      ...(publicInternet ? { publicInternet: true } : {}),
      ...(diagnostics ? { diagnostics: true } : {}),
    });
    readClaudeBrokerConfig({ CLAUDE_BROKER_CONFIG: brokerConfig });
    await mintWithPowersPath(hostAgent, {
      powersPath: ['secrets', credsName],
      temporary: `${credsName}.broker-read`,
      specifier: brokerServiceSpecifier,
      resultName: [SANDBOX_DIR, 'broker-service'],
      env: { CLAUDE_BROKER_CONFIG: brokerConfig },
    });
    console.log(`Minted ${SANDBOX_DIR}/broker-service`);
  }

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

  // The hosted backend factory. It runs with `@agent` host powers (it records
  // sessions with the daemon session owner and reprovides that owner), but
  // Floot only ever receives the guarded factory facet. Re-created on every
  // run: it is a pinned unconfined caplet whose module path is tied to a
  // release checkout, and it holds no durable state of its own — sessions are
  // records under `claude-sandbox/session-records`, owned by the daemon.
  //
  // Mint the replacement under a temporary name *before* touching the live
  // one: if the mint fails, the existing backend (and the Floot binding to
  // it) keeps working.
  const backendPath = [SANDBOX_DIR, 'backend'];
  const backendNextPath = [SANDBOX_DIR, 'backend-next'];
  if (await E(hostAgent).has(...backendNextPath)) {
    await E(hostAgent).remove(...backendNextPath);
  }
  await E(hostAgent).makeUnconfined('@main', backendModuleSpecifier, {
    powersName: '@agent',
    resultName: backendNextPath,
    env: harden({
      CLAUDE_WORKSPACE_BASE_DIR: workspaceDir,
      CLAUDE_MCP_DIR: mcpDir,
      CLAUDE_NATIVE_PROFILE: nativeProfileText,
      ...(mounterEnvText === undefined
        ? {}
        : { CLAUDE_MOUNTER_ENV: mounterEnvText }),
    }),
  });
  if (await E(hostAgent).has(...backendPath)) {
    await E(hostAgent).remove(...backendPath);
  }
  await E(hostAgent).copy(backendNextPath, backendPath);
  await E(hostAgent).remove(...backendNextPath);
  console.log(
    `Minted the Claude hosted backend at "${backendPath.join('/')}".`,
  );

  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  if (await E(hostAgent).has(flootDir, 'controller-profile')) {
    // Floot's factory discovers hosted backends by name in its own profile
    // (controller-profile), not at the host root, so the factory facet must be
    // copied in. Re-copying keeps it pointed at the backend minted above
    // across restarts and release pruning; copy overwrites an existing
    // binding, so no remove is needed — and removing first would open a
    // window in which Floot cannot discover the backend if the copy fails.
    const flootBackendPath = [flootDir, 'controller-profile', backendName];
    await E(hostAgent).copy(backendPath, flootBackendPath);
    console.log(
      `Bound "${backendName}" into "${flootDir}/controller-profile".`,
    );

    // Bind the host-global static asset server into the factory's own profile
    // so its bounded per-session `publishWorkspace` tool can serve new-project
    // workspaces. Like the backend above, the factory resolves it from its own
    // powers. We run after the asset server's setup in ENDO_EXTRA, which
    // re-mints `asset-server` against the current release each start, so
    // re-copying here keeps the factory pointed at the fresh capability.
    const assetServerName = env.ENDO_FLOOT_ASSET_SERVER || 'asset-server';
    if (await E(hostAgent).has(assetServerName)) {
      const flootAssetPath = [flootDir, 'controller-profile', assetServerName];
      await E(hostAgent).copy([assetServerName], flootAssetPath);
      console.log(
        `Bound "${assetServerName}" into "${flootDir}/controller-profile".`,
      );
    } else {
      console.log(
        `Asset server "${assetServerName}" is absent; new-project publishing stays disabled.`,
      );
    }
  } else {
    console.warn(
      `Floot controller profile "${flootDir}/controller-profile" is absent; skipping the "${backendName}" binding.`,
    );
  }

  console.log(
    `Hosted Claude sandbox ready. Floot sessions on backend "claude" are recorded under "${SANDBOX_DIR}/session-records" and owned by the daemon.`,
  );
};
harden(main);
