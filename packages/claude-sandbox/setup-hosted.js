// @ts-check
/* global process */
// endo run --UNCONFINED setup-hosted.js --powers @agent
//
// Single-machine hosted provisioning: mint ClaudeCredentials and a shared
// ClaudeClient without inbox forms. Intended for ENDO_EXTRA on a hosted
// daemon alongside setup-host.js and setup-peer.js.
//
// Reads (first match wins):
//   ENDO_FLOOT_AUTH_TOKEN / ANTHROPIC_API_KEY / FLOOT_AUTH_TOKEN — API key
//   ENDO_CLAUDE_CREDS_NAME (default claude-creds)
//   ENDO_CLAUDE_CLIENT_NAME (default claude-client)
//   ENDO_CLAUDE_WORKSPACE_NAME (default claude-workspace)
//   ENDO_CLAUDE_WORKSPACE_DIR — host path (default CLAUDE_SANDBOX workspace)
//   CLAUDE_SANDBOX_IMAGE / ENDO_CLAUDE_SANDBOX_IMAGE — OCI rootfs
//
// Idempotent: skips caps that already exist.

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { makeError, X, q } from '@endo/errors';

import { provisionClaudeSession } from './src/provision-claude-session.js';

/** @import { EndoHost } from '@endo/daemon' */

const nodeFsModuleSpecifier = new URL(
  '../platform/src/fs/extended/node-fs-module.js',
  import.meta.url,
).href;

const credentialsModuleSpecifier = new URL(
  './src/claude-credentials-module.js',
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
  const workspaceName =
    env.ENDO_CLAUDE_WORKSPACE_NAME ||
    env.CLAUDE_WORKSPACE_NAME ||
    'claude-workspace';
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

  if (!(await E(hostAgent).has(workspaceName))) {
    await mkdir(workspaceDir, { recursive: true });
    await E(hostAgent).makeUnconfined('@main', nodeFsModuleSpecifier, {
      powersName: '@none',
      resultName: workspaceName,
      env: harden({ ENDO_FS_ROOT: workspaceDir }),
    });
    console.log(`Minted Filesystem "${workspaceName}" at ${workspaceDir}.`);
  } else {
    console.log(`Filesystem "${workspaceName}" already exists — skipping.`);
  }

  if (!(await E(hostAgent).has(clientName))) {
    const { sessionId, hostMountPoint, rootfsLabel } =
      await provisionClaudeSession(
        hostAgent,
        {
          name: clientName,
          filesystemName: workspaceName,
          credentialsName: credsName,
          rootfs,
          network: 'private',
          sandboxNamespace: 'claude-sandbox',
        },
        { resultName: clientName },
      );
    console.log(
      `Minted ClaudeClient "${clientName}" (session ${sessionId}, workspace ${hostMountPoint}, rootfs ${rootfsLabel}).`,
    );
  } else {
    console.log(`ClaudeClient "${clientName}" already exists — skipping.`);
  }

  // Floot's factory caplet runs with its controller profile as powers, so the
  // host-rooted client must also be named in that profile for `claude-cli`
  // sessions to resolve it. Rebind on every setup run in case either formula
  // was reincarnated or replaced by a deployment.
  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  if (await E(hostAgent).has(flootDir, 'controller-profile')) {
    const flootClientPath = [flootDir, 'controller-profile', clientName];
    if (await E(hostAgent).has(...flootClientPath)) {
      await E(hostAgent).remove(...flootClientPath);
    }
    await E(hostAgent).copy([clientName], flootClientPath);
    console.log(
      `Bound ClaudeClient "${clientName}" into "${flootDir}/controller-profile".`,
    );
  } else {
    console.warn(
      `Floot controller profile "${flootDir}/controller-profile" is absent; skipping ClaudeClient binding.`,
    );
  }

  console.log(
    `Hosted Claude sandbox ready. Floot sessions pinned to claude-cli will bind "${clientName}".`,
  );
};
harden(main);
