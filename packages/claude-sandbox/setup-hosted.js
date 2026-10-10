// @ts-check
/* global process */
// endo run --UNCONFINED setup-hosted.js --powers @agent
//
// Single-machine hosted provisioning: mint ClaudeCredentials and the
// `claude-backend` hosted backend factory that creates one isolated
// ClaudeClient per Floot session (with its Endo tools bridged in over MCP),
// without inbox forms. Intended for ENDO_EXTRA alongside setup-host.js and
// setup-peer.js, after floot-factory-setup.js.
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
//   ENDO_CLAUDE_BACKEND_NAME (default claude-backend) — the name Floot's
//     factory discovers the backend under, in its controller profile
//   ENDO_CLAUDE_WORKSPACE_DIR — base host path for per-session workspaces
//   ENDO_CLAUDE_CONFIG_DIR — base host path for per-session Claude config dirs
//   ENDO_CLAUDE_MCP_DIR — base host path for per-session MCP sockets
//   CLAUDE_SANDBOX_IMAGE / ENDO_CLAUDE_SANDBOX_IMAGE — OCI rootfs
//
// Idempotent: credentials and the workspace directory are reused; the backend
// caplet — the one formula whose module path is tied to a release checkout —
// is re-created on every run and re-bound into the Floot profile.

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { Fail, makeError, X, q } from '@endo/errors';

import { toCurrentSpecifier } from './src/current-specifier.js';

/** @import { EndoHost } from '@endo/daemon' */

const credentialsModuleSpecifier = toCurrentSpecifier(
  new URL('./src/claude-credentials-module.js', import.meta.url).href,
);

const backendModuleSpecifier = toCurrentSpecifier(
  new URL('./src/claude-backend-module.js', import.meta.url).href,
);

// Kept in sync with setup-host.js and the provisioner's sessions directory.
const SANDBOX_DIR = 'claude-sandbox';

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
  const backendName =
    env.ENDO_CLAUDE_BACKEND_NAME || env.CLAUDE_BACKEND_NAME || 'claude-backend';
  const workspaceDir =
    env.ENDO_CLAUDE_WORKSPACE_DIR ||
    env.CLAUDE_SANDBOX_WORKSPACE_DIR ||
    env.CLAUDE_SANDBOX_MOUNT_DIR?.replace(
      /\/claude-mounts$/,
      '/claude-workspace',
    ) ||
    path.join(os.homedir(), 'claude-workspace');
  const configDir =
    env.ENDO_CLAUDE_CONFIG_DIR ||
    path.join(path.dirname(workspaceDir), 'claude-configs');
  const mcpDir =
    env.ENDO_CLAUDE_MCP_DIR || path.join(os.tmpdir(), 'claude-mcp');
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
  apiKey ||
    Fail`ENDO_CLAUDE_OAUTH_TOKEN (or ENDO_FLOOT_AUTH_TOKEN / ANTHROPIC_API_KEY / FLOOT_AUTH_TOKEN) is required.`;
  const credsKind =
    env.ENDO_CLAUDE_CREDS_KIND ||
    env.CLAUDE_CREDS_KIND ||
    (oauthToken ? 'oauthToken' : undefined) ||
    inferCredentialKind(apiKey) ||
    'apiKey';

  const hasSandboxFactory = await E(hostAgent).has(
    'claude-sandbox',
    'sandbox-factory',
  );
  hasSandboxFactory ||
    Fail`claude-sandbox/sandbox-factory is missing — run setup-host.js first.`;

  await provisionCredentials(hostAgent, {
    name: credsName,
    apiKey,
    kind: credsKind,
  });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(mcpDir, { recursive: true });

  // The hosted backend factory. It runs with `@agent` host powers (it mints
  // per-session client formulas, registers their mounts, and cancels them on
  // stop), but Floot only ever receives the guarded factory facet. Re-created
  // on every run: it is a pinned unconfined caplet whose module path is tied
  // to a release checkout, and it holds no durable state of its own — sessions
  // are formulas under `claude-sandbox/sessions`, and the per-session MCP
  // listeners are rebuilt whenever Floot revives a session.
  const backendPath = [SANDBOX_DIR, 'backend'];
  if (await E(hostAgent).has(...backendPath)) {
    await E(hostAgent).remove(...backendPath);
  }
  await E(hostAgent).makeUnconfined('@main', backendModuleSpecifier, {
    powersName: '@agent',
    resultName: backendPath,
    env: harden({
      CLAUDE_CLIENT_NAME: clientName,
      CLAUDE_CREDS_NAME: credsName,
      CLAUDE_WORKSPACE_BASE_DIR: workspaceDir,
      CLAUDE_CONFIG_BASE_DIR: configDir,
      CLAUDE_MCP_DIR: mcpDir,
      CLAUDE_SANDBOX_IMAGE: rootfs,
    }),
  });
  console.log(
    `Minted the Claude hosted backend at "${backendPath.join('/')}".`,
  );

  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  if (await E(hostAgent).has(flootDir, 'controller-profile')) {
    // Floot's factory discovers hosted backends by name in its own profile
    // (controller-profile), not at the host root, so the factory facet must be
    // copied in. Re-copying (remove + copy) keeps it pointed at the backend
    // minted above across restarts and release pruning.
    const flootBackendPath = [flootDir, 'controller-profile', backendName];
    if (await E(hostAgent).has(...flootBackendPath)) {
      await E(hostAgent).remove(...flootBackendPath);
    }
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
      if (await E(hostAgent).has(...flootAssetPath)) {
        await E(hostAgent).remove(...flootAssetPath);
      }
      await E(hostAgent).copy([assetServerName], flootAssetPath);
      console.log(
        `Bound "${assetServerName}" into "${flootDir}/controller-profile".`,
      );
    } else {
      console.log(
        `Asset server "${assetServerName}" is absent; new-project publishing stays disabled.`,
      );
    }

    // Remove the legacy credential-in-profile bindings an earlier deployment
    // may have left: Floot refuses a bare ClaudeClient and no longer looks for
    // a provisioner; both are now behind the backend factory.
    const legacyPaths = [clientName, 'claude-session-provisioner'].map(
      legacyName => [flootDir, 'controller-profile', legacyName],
    );
    const legacyPresent = await Promise.all(
      legacyPaths.map(legacyPath => E(hostAgent).has(...legacyPath)),
    );
    await Promise.all(
      legacyPaths
        .filter((_, index) => legacyPresent[index])
        .map(legacyPath => E(hostAgent).remove(...legacyPath)),
    );
  } else {
    console.warn(
      `Floot controller profile "${flootDir}/controller-profile" is absent; skipping the "${backendName}" binding.`,
    );
  }

  console.log(
    `Hosted Claude sandbox ready. Floot sessions on backend "claude" will provision "${clientName}-<session-id>" under "${SANDBOX_DIR}/sessions".`,
  );
};
harden(main);
