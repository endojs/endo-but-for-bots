// @ts-check
/* global process */
// endo run --UNCONFINED setup-hosted.js --powers @agent
//
// Single-machine hosted provisioning: mint ClaudeCredentials and a bounded
// provisioner that creates one ClaudeClient per Floot session without inbox
// forms. Intended for ENDO_EXTRA alongside setup-host.js and setup-peer.js.
//
// Reads (first match wins):
//   ENDO_CLAUDE_OAUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN — Claude subscription
//     token from `claude setup-token`. Preferred: the CLI runtime bills against
//     a Pro/Max subscription instead of API credits. Takes precedence over the
//     API key below.
//   ENDO_FLOOT_AUTH_TOKEN / ANTHROPIC_API_KEY / FLOOT_AUTH_TOKEN — API key
//   ENDO_CLAUDE_CREDS_KIND / CLAUDE_CREDS_KIND — force `apiKey` or `oauthToken`
//     when the token prefix is not conclusive
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

import { toCurrentSpecifier } from './src/current-specifier.js';

/** @import { EndoHost } from '@endo/daemon' */

const credentialsModuleSpecifier = toCurrentSpecifier(
  new URL('./src/claude-credentials-module.js', import.meta.url).href,
);

const sessionProvisionerModuleSpecifier = toCurrentSpecifier(
  new URL('./src/claude-session-provisioner.js', import.meta.url).href,
);

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
 * Tokens minted by `claude setup-token` (a Pro/Max subscription grant) carry an
 * `sk-ant-oat` prefix; raw console API keys carry `sk-ant-api`. The prefix is
 * the only signal available here, so an unrecognised token stays an `apiKey`
 * unless the operator names the kind explicitly.
 *
 * @param {string} token
 * @returns {string | undefined}
 */
const inferCredentialKind = token => {
  if (token.startsWith('sk-ant-oat')) return 'oauthToken';
  if (token.startsWith('sk-ant-api')) return 'apiKey';
  return undefined;
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
  if (!CREDENTIAL_KINDS.includes(kind)) {
    throw makeError(
      X`credential kind ${q(kind)} must be one of ${q(CREDENTIAL_KINDS.join(', '))}`,
    );
  }
  if (await E(hostAgent).has(name)) {
    // The kind is frozen into the credential formula's env at mint time, so a
    // switch between an API key and a subscription token cannot be applied in
    // place — the name has to be re-pointed at a freshly minted formula.
    // Sessions provisioned earlier hold the old cap by reference and keep
    // working (on the old secret) until they are re-provisioned.
    let existingKind = 'apiKey';
    try {
      const existing = /** @type {any} */ (await E(hostAgent).lookup(name));
      existingKind = await E(existing).kind();
    } catch {
      // A credential too old to report its kind predates `oauthToken`.
    }
    if (existingKind === kind) {
      console.log(`ClaudeCredentials "${name}" already exists — skipping.`);
      return;
    }
    console.log(
      `ClaudeCredentials "${name}" is kind "${existingKind}" but "${kind}" was configured; re-minting. ` +
        'Existing Claude sessions keep the old credential until re-provisioned.',
    );
    await E(hostAgent).remove(name);
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
  console.log(`Minted ClaudeCredentials "${name}" (kind "${kind}").`);
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

  // A subscription token wins over an API key: the CLI runtime then bills
  // against the Pro/Max plan rather than API credits. ENDO_FLOOT_AUTH_TOKEN is
  // deliberately not overloaded for this — Floot's `claude-api` runtime talks to
  // the Anthropic API directly and still needs a real API key.
  const oauthToken =
    env.ENDO_CLAUDE_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN || '';
  const apiKey =
    oauthToken ||
    env.ENDO_FLOOT_AUTH_TOKEN ||
    env.ANTHROPIC_API_KEY ||
    env.FLOOT_AUTH_TOKEN ||
    '';
  if (!apiKey) {
    throw new Error(
      'ENDO_CLAUDE_OAUTH_TOKEN (or ENDO_FLOOT_AUTH_TOKEN / ANTHROPIC_API_KEY / FLOOT_AUTH_TOKEN) is required.',
    );
  }
  const credsKind =
    env.ENDO_CLAUDE_CREDS_KIND ||
    env.CLAUDE_CREDS_KIND ||
    (oauthToken ? 'oauthToken' : undefined) ||
    inferCredentialKind(apiKey) ||
    'apiKey';

  if (!(await E(hostAgent).has('claude-sandbox', 'sandbox-factory'))) {
    throw new Error(
      'claude-sandbox/sandbox-factory is missing — run setup-host.js first.',
    );
  }

  await provisionCredentials(hostAgent, {
    name: credsName,
    apiKey,
    kind: credsKind,
  });
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
