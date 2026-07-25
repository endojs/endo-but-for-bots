// @ts-check
/* global process */
// endo run --UNCONFINED setup-hosted.js --powers @agent
//
// Single-machine hosted provisioning: mint ClaudeCredentials and a bounded
// provisioner that creates one ClaudeClient per Floot session without inbox
// forms. Intended for ENDO_EXTRA alongside setup-host.js and setup-peer.js.
//
// Reads (first match wins):
//   ENDO_FLOOT_AUTH_TOKEN / ANTHROPIC_API_KEY / FLOOT_AUTH_TOKEN — API key
//   ENDO_CLAUDE_CREDS_NAME (default claude-creds)
//   ENDO_CLAUDE_CLIENT_NAME (default claude-client)
//   ENDO_CLAUDE_PROVISIONER_NAME (default claude-session-provisioner)
//   ENDO_CLAUDE_WORKSPACE_DIR — base host path for per-session workspaces
//   CLAUDE_SANDBOX_IMAGE / ENDO_CLAUDE_SANDBOX_IMAGE — OCI rootfs
//
// Idempotent: skips caps that already exist.

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { makeError, X, q } from '@endo/errors';

/** @import { EndoHost } from '@endo/daemon' */

const credentialsModuleSpecifier = new URL(
  './src/claude-credentials-module.js',
  import.meta.url,
).href;

const sessionProvisionerModuleSpecifier = new URL(
  './src/claude-session-provisioner.js',
  import.meta.url,
).href;

const CREDENTIAL_KINDS = harden(['apiKey', 'oauthToken']);

/**
 * @param {string} name
 */
const assertSafeCredentialName = name => {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(name)) {
    throw makeError(X`Invalid credential name: ${q(name)}`);
  }
};

const credentialsDir = () =>
  process.env.CLAUDE_CREDENTIALS_DIR ||
  path.join(os.homedir(), '.endo-claude-credentials');

/**
 * @param {string} name
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
const persistKeyToSidecar = async (name, apiKey) => {
  assertSafeCredentialName(name);
  const dir = credentialsDir();
  await mkdir(dir, { mode: 0o700, recursive: true });
  const file = path.join(dir, `${name}.key`);
  await writeFile(file, `${apiKey}\n`, { mode: 0o600 });
  return file;
};

/**
 * @param {EndoHost} hostAgent
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.apiKey
 * @param {string} [spec.kind]
 */
const provisionCredentials = async (
  hostAgent,
  { name, apiKey, kind = 'apiKey' },
) => {
  if (!(await E(hostAgent).has(name))) {
    if (!CREDENTIAL_KINDS.includes(kind)) {
      throw makeError(
        X`credential kind ${q(kind)} must be one of ${q(CREDENTIAL_KINDS.join(', '))}`,
      );
    }
    const credentialsFile = await persistKeyToSidecar(name, apiKey);
    await E(hostAgent).makeUnconfined('@main', credentialsModuleSpecifier, {
      powersName: '@none',
      resultName: name,
      env: harden({
        CREDENTIALS_FILE: credentialsFile,
        CREDENTIALS_KIND: kind,
      }),
    });
    console.log(`Minted ClaudeCredentials "${name}".`);
  } else {
    console.log(`ClaudeCredentials "${name}" already exists — skipping.`);
  }
};

/**
 * @param {EndoHost} hostAgent
 */
export const main = async hostAgent => {
  const { env } = process;

  const credsName =
    env.ENDO_CLAUDE_CREDS_NAME || env.CLAUDE_CREDS_NAME || 'claude-creds';
  const clientName =
    env.ENDO_CLAUDE_CLIENT_NAME || env.CLAUDE_CLIENT_NAME || 'claude-client';
  const provisionerName =
    env.ENDO_CLAUDE_PROVISIONER_NAME || 'claude-session-provisioner';
  const workspaceDir =
    env.ENDO_CLAUDE_WORKSPACE_DIR ||
    env.CLAUDE_SANDBOX_WORKSPACE_DIR ||
    env.CLAUDE_SANDBOX_MOUNT_DIR?.replace(
      /\/claude-mounts$/,
      '/claude-workspace',
    ) ||
    path.join(os.homedir(), 'claude-workspace');
  const rootfs =
    env.CLAUDE_SANDBOX_IMAGE ||
    env.ENDO_CLAUDE_SANDBOX_IMAGE ||
    'oci:localhost/claude-code:latest';

  const apiKey =
    env.ENDO_FLOOT_AUTH_TOKEN ||
    env.ANTHROPIC_API_KEY ||
    env.FLOOT_AUTH_TOKEN ||
    '';
  if (!apiKey) {
    throw new Error(
      'ENDO_FLOOT_AUTH_TOKEN (or ANTHROPIC_API_KEY / FLOOT_AUTH_TOKEN) is required.',
    );
  }

  if (!(await E(hostAgent).has('claude-sandbox', 'sandbox-factory'))) {
    throw new Error(
      'claude-sandbox/sandbox-factory is missing — run setup-host.js first.',
    );
  }

  await provisionCredentials(hostAgent, { name: credsName, apiKey });
  await mkdir(workspaceDir, { recursive: true });

  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  if (await E(hostAgent).has(flootDir, 'controller-profile')) {
    // Bind the host-global static asset server into the factory's own profile so
    // its bounded per-session `publishWorkspace` tool can serve new-project
    // workspaces. The factory (agent.js) resolves `asset-server` from its own
    // powers (controller-profile), not the host root, so — like the provisioner
    // below — it must be copied in. We run after endo-fs-asset-server/setup.js in
    // ENDO_EXTRA, which re-mints `asset-server` against the current release each
    // start, so re-copying here (remove + copy) keeps the factory pointed at the
    // fresh capability across restarts and release pruning.
    const assetServerName = env.ENDO_FLOOT_ASSET_SERVER || 'asset-server';
    if (await E(hostAgent).has(assetServerName)) {
      const flootAssetPath = [flootDir, 'controller-profile', assetServerName];
      if (await E(hostAgent).has(...flootAssetPath)) {
        await E(hostAgent).remove(...flootAssetPath);
      }
      await E(hostAgent).copy([assetServerName], flootAssetPath);
      console.log(
        `Bound "${assetServerName}" into "${flootDir}/controller-profile".`,
      );
    } else {
      console.warn(
        `Asset server "${assetServerName}" is absent; new-project publishing will be disabled.`,
      );
    }

    const flootProvisionerPath = [
      flootDir,
      'controller-profile',
      provisionerName,
    ];
    if (await E(hostAgent).has(...flootProvisionerPath)) {
      await E(hostAgent).remove(...flootProvisionerPath);
    }
    if (await E(hostAgent).has(provisionerName)) {
      await E(hostAgent).remove(provisionerName);
    }
    await E(hostAgent).makeUnconfined(
      '@main',
      sessionProvisionerModuleSpecifier,
      {
        powersName: '@agent',
        resultName: provisionerName,
        env: harden({
          FLOOT_DIR: flootDir,
          CLAUDE_CLIENT_NAME: clientName,
          CLAUDE_CREDS_NAME: credsName,
          CLAUDE_WORKSPACE_BASE_DIR: workspaceDir,
          CLAUDE_SANDBOX_IMAGE: rootfs,
        }),
      },
    );
    await E(hostAgent).copy([provisionerName], flootProvisionerPath);

    // Remove the legacy shared binding. The root name is retained so existing
    // single-session/manual users are not disrupted, but hosted Floot now
    // always asks the provisioner for an isolated per-session client.
    const legacyClientPath = [flootDir, 'controller-profile', clientName];
    if (await E(hostAgent).has(...legacyClientPath)) {
      await E(hostAgent).remove(...legacyClientPath);
    }
    console.log(
      `Bound "${provisionerName}" into "${flootDir}/controller-profile".`,
    );
  } else {
    console.warn(
      `Floot controller profile "${flootDir}/controller-profile" is absent; skipping Claude provisioner binding.`,
    );
  }

  console.log(
    `Hosted Claude sandbox ready. Floot sessions pinned to claude-cli will provision "${clientName}-<session-id>".`,
  );
};
harden(main);
