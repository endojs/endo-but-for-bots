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
//   ENDO_OPENCODE_NATIVE_PROFILE — the deployment resource profile (JSON)
//     recorded into every session plan; required, no default
//   ENDO_OPENCODE_BROKER_LISTENER_IMAGE — digest-pinned listener image;
//     required unless a broker service is retained
//   ENDO_OPENCODE_BROKER_DIR, ENDO_OPENCODE_BROKER_OWNER_ID,
//     ENDO_OPENCODE_PUBLIC_INTERNET — the broker's directory, owner label
//     (derived from the host identity by default), and public egress flag;
//     applied only when a broker service is minted, ignored when one is
//     retained
//
// Idempotent: the credential and the session base directories are reused; the
// backend caplet — the one formula whose module path is tied to a release
// checkout — is re-created on every run and re-bound into the Floot profile.

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { Fail, q } from '@endo/errors';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './src/current-specifier.js';
import { provideManagedCredentials } from './src/managed-credentials.js';
import {
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
import { parseModelRef } from './src/opencode-agent-config.js';
import { OPENCODE_MODELS } from './src/opencode-backend-factory.js';
import { BROKER_OWNER_PATTERN } from './src/opencode-broker.js';
import { readOpencodeBrokerConfig } from './src/opencode-broker-service-agent.js';
import {
  isNormalizedAbsolutePath,
  readNativeProfile,
} from './src/opencode-session-plan.js';

/** @import { EndoHost } from '@endo/daemon' */

const backendModuleSpecifier = toCurrentSpecifier(
  new URL('./src/opencode-backend-module.js', import.meta.url).href,
);

// Kept in sync with setup-host.js and the backend's session records directory.
const SANDBOX_DIR = 'opencode-sandbox';

/**
 * Ensure a private, symlink-free, daemon-owned directory at `directory`.
 * @param {string} label
 * @param {string} directory
 */
const providePrivateDirectory = async (label, directory) => {
  const info = await lstat(directory).catch(() => undefined);
  !info?.isSymbolicLink() || Fail`${label} must not be a symlink: ${directory}`;
  if (info && !info.isDirectory()) {
    throw Fail`${label} must be a directory: ${directory}`;
  }
  if (info) {
    (await stat(directory)).uid === process.getuid?.() ||
      Fail`${label} must be owned by the daemon user: ${directory}`;
    await chmod(directory, 0o700);
  } else {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
};

/**
 * Mint an unconfined formula whose sole powers is an existing capability
 * named by path. `powersName` takes one pet name, so alias the capability
 * under a temporary root name for the mint; the formula retains the
 * capability's identity, not the alias.
 * @param {EndoHost} hostAgent
 * @param {object} options
 * @param {string[]} options.powersPath
 * @param {string} options.temporary
 * @param {string} options.specifier
 * @param {string[]} options.resultName
 * @param {Record<string, string>} options.env
 */
const mintWithPowersPath = async (
  hostAgent,
  { powersPath, temporary, specifier, resultName, env },
) => {
  if (await E(hostAgent).has(temporary)) await E(hostAgent).remove(temporary);
  try {
    await E(hostAgent).copy(powersPath, [temporary]);
    await E(hostAgent).makeUnconfined('@main', specifier, {
      powersName: temporary,
      resultName,
      env: harden(env),
    });
  } finally {
    await E(hostAgent).remove(temporary);
  }
};

/**
 * @param {EndoHost} hostAgent
 * @param {{ exec?: Parameters<typeof resolvePinnedImageRef>[1] }} [powers]
 */
export const main = async (hostAgent, { exec = undefined } = {}) => {
  await null;
  const { env } = process;

  const credsName = env.ENDO_OPENCODE_CREDS_NAME || 'openrouter-auth';
  const backendName = env.ENDO_OPENCODE_BACKEND_NAME || 'opencode-backend';
  if (backendName !== 'opencode-backend') {
    console.warn(
      `OpenCode backend name is "${backendName}"; Floot's factory only discovers "opencode-backend" unless its own configuration is changed to match.`,
    );
  }
  const requestedRoots = getHostedStorageRoots(env);
  const rootfs =
    env.ENDO_OPENCODE_SANDBOX_IMAGE || 'oci:localhost/opencode-sandbox:latest';
  // Daemon-owned sessions require the provider broker, so the listener image
  // is required whenever one is minted; there is no session path without one.
  const listenerImageRef = env.ENDO_OPENCODE_BROKER_LISTENER_IMAGE || '';
  const brokerDir =
    env.ENDO_OPENCODE_BROKER_DIR || path.join(os.homedir(), 'opencode-broker');
  const publicInternet = env.ENDO_OPENCODE_PUBLIC_INTERNET === '1';
  // The deployment resource profile is recorded into each session plan by the
  // backend. It has no defaults; validate the operator's value before any
  // mint so a malformed profile cannot reach a formula environment.
  const nativeProfileText = env.ENDO_OPENCODE_NATIVE_PROFILE;
  if (typeof nativeProfileText !== 'string') {
    throw Fail`ENDO_OPENCODE_NATIVE_PROFILE is required: the backend records it into every session plan`;
  }
  readNativeProfile(JSON.parse(nativeProfileText));

  // A seed value is used only on first setup, when the secrets catalog has no
  // entry for `credsName`; provideManagedCredentials never overwrites an
  // existing secret from a possibly stale environment variable.
  const seedApiKey = env.ENDO_OPENROUTER_API_KEY || '';

  // Every session's durable state is mounted through this provider; a backend
  // minted without it would fail on first provision.
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'state-provider'))) {
    throw Fail`${SANDBOX_DIR}/state-provider is missing — run setup-host.js first.`;
  }
  // The native sandbox service is what session controllers acquire scopes from.
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'native-sandbox'))) {
    throw Fail`${SANDBOX_DIR}/native-sandbox is missing — run setup-host.js first.`;
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
    Fail`ENDO_OPENCODE_WORKSPACE_DIR (or the retained storage owner's root) must be a normalized absolute path: ${q(workspaceDir)}`;
  isNormalizedAbsolutePath(mcpDir) ||
    Fail`ENDO_OPENCODE_MCP_DIR (or the retained storage owner's root) must be a normalized absolute path: ${q(mcpDir)}`;
  await assertRuntimePlacement(runtime.config.directory, {
    stateDir: state.stateDir,
    workspaceDir,
    mcpDir,
  });
  // Provider broker service — an owned native service whose one exact powers
  // dependency is the managed credential's SecretBlob. Its operator profile is
  // persisted in the formula environment; sessions never resolve a mutable
  // credential name. An existing service is retained with its configuration
  // (its entrypoint and persisted shape are verified here, not the kit's
  // predicates); otherwise everything the broker kit would refuse of the
  // operator's configuration is refused here, before any mint or directory
  // creation, for the same reason as the storage roots and the profile
  // above. Only asking Podman for an unpinned slice image's digest and
  // creating the broker directory wait for the mint.
  const existingBroker = await E(hostAgent).has(SANDBOX_DIR, 'broker-service');
  let brokerOwnerId = '';
  if (existingBroker) {
    await readBrokerService(hostAgent);
  } else {
    if (listenerImageRef === '') {
      throw Fail`ENDO_OPENCODE_BROKER_LISTENER_IMAGE is required: the backend records the broker service into every session plan`;
    }
    isNormalizedAbsolutePath(brokerDir) ||
      Fail`ENDO_OPENCODE_BROKER_DIR must be a normalized absolute path: ${q(brokerDir)}`;
    brokerOwnerId = env.ENDO_OPENCODE_BROKER_OWNER_ID || '';
    if (brokerOwnerId === '') {
      const hostId = await E(hostAgent).identify('@agent');
      if (typeof hostId !== 'string' || hostId.length === 0) {
        throw Fail`Cannot identify the OpenCode broker host`;
      }
      brokerOwnerId = `opencode-${createHash('sha256').update(hostId).digest('hex').slice(0, 48)}`;
    }
    BROKER_OWNER_PATTERN.test(brokerOwnerId) ||
      Fail`ENDO_OPENCODE_BROKER_OWNER_ID must match ${q(BROKER_OWNER_PATTERN)}: ${q(brokerOwnerId)}`;
    // Mirrors the listener runtime's identity check; setup pins the slice
    // image itself but never rewrites the listener reference.
    /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(listenerImageRef) ||
      Fail`ENDO_OPENCODE_BROKER_LISTENER_IMAGE must be a lowercase, digest-pinned image reference: ${q(listenerImageRef)}`;
    readSliceImageReference(rootfs);
  }

  // Assert before the first mint so a failure cannot leave a half-bound
  // profile behind (the credential mint would otherwise commit first).
  assertCurrentSpecifier(backendModuleSpecifier, 'opencode-backend');
  await provideManagedCredentials(hostAgent, {
    name: credsName,
    ...(seedApiKey ? { apiKey: seedApiKey } : {}),
    kind: 'apiKey',
  });

  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  // The MCP socket base must be private and symlink-free: a planted link here
  // would redirect the per-session sockets another process can then squat.
  await providePrivateDirectory('ENDO_OPENCODE_MCP_DIR', mcpDir);

  if (existingBroker) {
    console.log(
      'Retaining OpenCode broker service with its persisted configuration.',
    );
  } else {
    const { imageRef, imageDigest } = await resolvePinnedImageRef(rootfs, exec);
    await providePrivateDirectory('ENDO_OPENCODE_BROKER_DIR', brokerDir);
    const brokerConfig = JSON.stringify({
      ownerId: brokerOwnerId,
      directory: brokerDir,
      imageRef,
      imageDigest,
      listenerImageRef,
      // The broker admits the provider-scoped ids opencode's request bodies
      // carry, not Floot's `openrouter/...` selection refs.
      models: OPENCODE_MODELS.map(model => parseModelRef(model.id)),
      ...(publicInternet ? { publicInternet: true } : {}),
    });
    readOpencodeBrokerConfig({ OPENCODE_BROKER_CONFIG: brokerConfig });
    await mintWithPowersPath(hostAgent, {
      powersPath: ['secrets', credsName],
      temporary: `${credsName}.broker-read`,
      specifier: brokerServiceSpecifier,
      resultName: [SANDBOX_DIR, 'broker-service'],
      env: { OPENCODE_BROKER_CONFIG: brokerConfig },
    });
    console.log(`Minted ${SANDBOX_DIR}/broker-service`);
  }

  // Session storage owner — the `storage` role the daemon owner records with
  // each session and invokes inside record removal. Its powers is the state
  // provider, so native state removal keeps that provider's marker checks.
  if (existingStorage) {
    console.log(
      'Retaining OpenCode session storage with its persisted roots; current workspace and MCP roots are not reapplied.',
    );
  } else {
    await mintWithPowersPath(hostAgent, {
      powersPath: [SANDBOX_DIR, 'state-provider'],
      temporary: 'opencode.state-provider-powers',
      specifier: sessionStorageSpecifier,
      resultName: [SANDBOX_DIR, 'session-storage'],
      env: {
        OPENCODE_WORKSPACE_BASE_DIR: workspaceDir,
        OPENCODE_MCP_DIR: mcpDir,
      },
    });
    console.log(`Minted ${SANDBOX_DIR}/session-storage`);
  }

  // The hosted backend factory. It runs with `@agent` host powers (it records
  // sessions with the daemon session owner and reprovides that owner), but
  // Floot only ever receives the guarded factory facet. Re-created on every
  // run: it is a pinned unconfined caplet whose module path is tied to a
  // release checkout, and it holds no durable state of its own — sessions are
  // records under `opencode-sandbox/session-records`, owned by the daemon.
  //
  // Mint the replacement under a temporary name *before* touching the live
  // one: if the mint fails, the existing backend (and the Floot binding to
  // it) keeps working. Minting is the step that can fail on a bad specifier,
  // a pruned release, or a missing dependency.
  const backendPath = [SANDBOX_DIR, 'backend'];
  const backendNextPath = [SANDBOX_DIR, 'backend-next'];
  if (await E(hostAgent).has(...backendNextPath)) {
    await E(hostAgent).remove(...backendNextPath);
  }
  await E(hostAgent).makeUnconfined('@main', backendModuleSpecifier, {
    powersName: '@agent',
    resultName: backendNextPath,
    env: harden({
      OPENCODE_WORKSPACE_BASE_DIR: workspaceDir,
      OPENCODE_MCP_DIR: mcpDir,
      OPENCODE_NATIVE_PROFILE: nativeProfileText,
    }),
  });
  if (await E(hostAgent).has(...backendPath)) {
    await E(hostAgent).remove(...backendPath);
  }
  await E(hostAgent).copy(backendNextPath, backendPath);
  await E(hostAgent).remove(...backendNextPath);
  console.log(
    `Minted the OpenCode hosted backend at "${backendPath.join('/')}".`,
  );

  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  if (await E(hostAgent).has(flootDir, 'controller-profile')) {
    // Floot's factory discovers hosted backends by name in its own profile
    // (controller-profile), not at the host root, so the factory facet must be
    // copied in. Re-copying (remove + copy) keeps it pointed at the backend
    // minted above across restarts and release pruning.
    // copy overwrites an existing binding, so no remove is needed here — and
    // removing first would open a window in which Floot cannot discover the
    // backend if the copy fails.
    const flootBackendPath = [flootDir, 'controller-profile', backendName];
    await E(hostAgent).copy(backendPath, flootBackendPath);
    console.log(
      `Bound "${backendName}" into "${flootDir}/controller-profile".`,
    );
  } else {
    console.warn(
      `Floot controller profile "${flootDir}/controller-profile" is absent; skipping the "${backendName}" binding.`,
    );
  }

  console.log(
    `Hosted OpenCode sandbox ready. Floot sessions on backend "opencode" are recorded under "${SANDBOX_DIR}/session-records" and owned by the daemon.`,
  );
};
harden(main);
