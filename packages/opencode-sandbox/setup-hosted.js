// @ts-check
/* global process */
// endo run --UNCONFINED setup-hosted.js --powers @agent
//
// Single-machine hosted provisioning: mint the managed OpenRouter credential
// and the `opencode-backend` hosted backend factory that creates one isolated
// OpencodeClient per Floot session (with its Endo tools bridged in over MCP),
// without inbox forms. Intended for ENDO_EXTRA alongside setup-host.js, after
// floot-factory-setup.js.
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
//   ENDO_OPENCODE_CLIENT_NAME (default opencode-client)
//   ENDO_OPENCODE_BACKEND_NAME (default opencode-backend) — the name Floot's
//     factory discovers the backend under, in its controller profile
//   ENDO_OPENCODE_WORKSPACE_DIR — base host path for per-session workspaces
//   ENDO_OPENCODE_CONFIG_DIR — base host path for per-session config dirs
//   ENDO_OPENCODE_MCP_DIR — base host path for per-session MCP sockets
//   ENDO_OPENCODE_SANDBOX_IMAGE — OCI rootfs (`oci:<image>` name)
//
// Idempotent: the credential and the session base directories are reused; the
// backend caplet — the one formula whose module path is tied to a release
// checkout — is re-created on every run and re-bound into the Floot profile.

import { chmod, lstat, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './src/current-specifier.js';
import { provideManagedCredentials } from './src/managed-credentials.js';

/** @import { EndoHost } from '@endo/daemon' */

const backendModuleSpecifier = toCurrentSpecifier(
  new URL('./src/opencode-backend-module.js', import.meta.url).href,
);

// Kept in sync with setup-host.js and the provisioner's sessions directory.
const SANDBOX_DIR = 'opencode-sandbox';

/**
 * @param {EndoHost} hostAgent
 */
export const main = async hostAgent => {
  await null;
  const { env } = process;

  const credsName = env.ENDO_OPENCODE_CREDS_NAME || 'openrouter-auth';
  const clientName = env.ENDO_OPENCODE_CLIENT_NAME || 'opencode-client';
  const backendName = env.ENDO_OPENCODE_BACKEND_NAME || 'opencode-backend';
  if (backendName !== 'opencode-backend') {
    console.warn(
      `OpenCode backend name is "${backendName}"; Floot's factory only discovers "opencode-backend" unless its own configuration is changed to match.`,
    );
  }
  const workspaceDir =
    env.ENDO_OPENCODE_WORKSPACE_DIR ||
    path.join(os.homedir(), 'opencode-workspaces');
  const configDir =
    env.ENDO_OPENCODE_CONFIG_DIR ||
    path.join(path.dirname(workspaceDir), 'opencode-configs');
  // Private base for per-session MCP Unix sockets; never a world-writable
  // shared tmp (predictable paths there invite socket hijack).
  const mcpDir =
    env.ENDO_OPENCODE_MCP_DIR || path.join(os.homedir(), 'opencode-mcp');
  const rootfs =
    env.ENDO_OPENCODE_SANDBOX_IMAGE || 'oci:localhost/opencode-sandbox:latest';

  // A seed value is used only on first setup, when the secrets catalog has no
  // entry for `credsName`; provideManagedCredentials never overwrites an
  // existing secret from a possibly stale environment variable.
  const seedApiKey = env.ENDO_OPENROUTER_API_KEY || '';

  if (!(await E(hostAgent).has(SANDBOX_DIR, 'sandbox-factory'))) {
    throw Fail`${SANDBOX_DIR}/sandbox-factory is missing — run setup-host.js first.`;
  }
  // Every session's durable state is mounted through this provider; a backend
  // minted without it would fail on first provision.
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'state-provider'))) {
    throw Fail`${SANDBOX_DIR}/state-provider is missing — run setup-host.js first.`;
  }
  // A slice created without the mounter cannot receive its workspace mount.
  if (!(await E(hostAgent).has(SANDBOX_DIR, 'fs-mounter'))) {
    throw Fail`${SANDBOX_DIR}/fs-mounter is missing — run setup-host.js first.`;
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
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  // The MCP socket base must be private and symlink-free: a planted link here
  // would redirect the per-session sockets another process can then squat.
  const mcpInfo = await lstat(mcpDir).catch(() => undefined);
  mcpInfo?.isSymbolicLink() &&
    Fail`ENDO_OPENCODE_MCP_DIR must not be a symlink: ${mcpDir}`;
  if (mcpInfo && !mcpInfo.isDirectory()) {
    throw Fail`ENDO_OPENCODE_MCP_DIR must be a directory: ${mcpDir}`;
  }
  if (mcpInfo) {
    (await stat(mcpDir)).uid === process.getuid() ||
      Fail`ENDO_OPENCODE_MCP_DIR must be owned by the daemon user: ${mcpDir}`;
    await chmod(mcpDir, 0o700);
  } else {
    await mkdir(mcpDir, { recursive: true, mode: 0o700 });
  }

  // The hosted backend factory. It runs with `@agent` host powers (it mints
  // per-session client formulas, registers their mounts, and cancels them on
  // stop), but Floot only ever receives the guarded factory facet. Re-created
  // on every run: it is a pinned unconfined caplet whose module path is tied
  // to a release checkout, and it holds no durable state of its own — sessions
  // are formulas under `opencode-sandbox/sessions`, and the per-session MCP
  // listeners are rebuilt whenever Floot revives a session.
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
      OPENCODE_CLIENT_NAME: clientName,
      OPENCODE_CREDS_NAME: credsName,
      OPENCODE_WORKSPACE_BASE_DIR: workspaceDir,
      OPENCODE_CONFIG_BASE_DIR: configDir,
      OPENCODE_MCP_DIR: mcpDir,
      OPENCODE_SANDBOX_IMAGE: rootfs,
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
    `Hosted OpenCode sandbox ready. Floot sessions on backend "opencode" will provision "${clientName}-<session-id>" under "${SANDBOX_DIR}/sessions".`,
  );
};
harden(main);
