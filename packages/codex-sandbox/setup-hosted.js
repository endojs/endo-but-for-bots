// @ts-check
/* global process */
// endo run --UNCONFINED setup-hosted.js --powers @agent
//
// Install the machine-scoped Codex home and the bounded Floot provisioner.
// The directory is mounted read/write into every Codex sandbox so the CLI can
// refresh auth.json in place. This setup never reads, copies, or re-seeds the
// auth file; the on-disk file is the source of truth after its first seed.

import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import { E } from '@endo/eventual-send';

import { toCurrentSpecifier } from './src/current-specifier.js';

/** @import { EndoHost } from '@endo/daemon' */

const authSeederModuleSpecifier = toCurrentSpecifier(
  new URL('./src/codex-auth-seeder.js', import.meta.url).href,
);
const sessionProvisionerModuleSpecifier = toCurrentSpecifier(
  new URL('./src/codex-session-provisioner.js', import.meta.url).href,
);

/**
 * Create a conservative config only when none exists. The `wx` open is the
 * seed-once boundary: later daemon starts never replace operator config.
 *
 * @param {string} codexHomeDir
 */
const ensureInitialConfig = async codexHomeDir => {
  const configPath = path.join(codexHomeDir, 'config.toml');
  let file;
  try {
    file = await open(configPath, 'wx', 0o600);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') return;
    throw error;
  }
  try {
    await file.writeFile(
      'cli_auth_credentials_store = "file"\n' +
        'forced_login_method = "chatgpt"\n',
    );
  } finally {
    await file.close();
  }
};
harden(ensureInitialConfig);

/**
 * @param {EndoHost} hostAgent
 */
export const main = async hostAgent => {
  const { env } = process;
  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  const clientName = env.ENDO_CODEX_CLIENT_NAME || 'codex-client';
  const provisionerName =
    env.ENDO_CODEX_PROVISIONER_NAME || 'codex-session-provisioner';
  const seederName = env.ENDO_CODEX_AUTH_SEEDER_NAME || 'codex-auth-seeder';
  const codexHomeName = env.ENDO_CODEX_HOME_NAME || 'codex-home';
  const stateRoot = env.ENDO_STATE_DIR || '/var/lib/endo';
  const codexHomeDir =
    env.ENDO_CODEX_HOME || path.join(stateRoot, 'codex-home');
  const workspaceDir =
    env.ENDO_CODEX_WORKSPACE_DIR || path.join(stateRoot, 'codex-workspace');
  const stateDir =
    env.ENDO_CODEX_SESSION_STATE_DIR || path.join(stateRoot, 'codex-sessions');
  const rootfs =
    env.CODEX_SANDBOX_IMAGE ||
    env.ENDO_CODEX_SANDBOX_IMAGE ||
    'oci:localhost/codex:latest';

  await mkdir(codexHomeDir, { recursive: true, mode: 0o700 });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await ensureInitialConfig(codexHomeDir);

  if (!(await E(hostAgent).has('codex-sandbox', 'sandbox-factory'))) {
    throw new Error(
      'codex-sandbox/sandbox-factory is missing — run setup-host.js first.',
    );
  }
  if (await E(hostAgent).has(codexHomeName)) {
    await E(hostAgent).remove(codexHomeName);
  }
  await E(hostAgent).provideMount(codexHomeDir, codexHomeName);

  if (await E(hostAgent).has(seederName)) {
    await E(hostAgent).remove(seederName);
  }
  await E(hostAgent).makeUnconfined('@main', authSeederModuleSpecifier, {
    powersName: '@none',
    resultName: seederName,
    env: harden({ CODEX_HOME_DIR: codexHomeDir }),
  });

  if (!(await E(hostAgent).has(flootDir, 'controller-profile'))) {
    console.warn(
      `Floot controller profile "${flootDir}/controller-profile" is absent; skipping Codex provisioner binding.`,
    );
    return;
  }

  const provisionerPath = [flootDir, 'controller-profile', provisionerName];
  const seederPath = [flootDir, 'controller-profile', seederName];
  for (const target of [provisionerPath, seederPath]) {
    // eslint-disable-next-line no-await-in-loop
    if (await E(hostAgent).has(...target)) {
      // eslint-disable-next-line no-await-in-loop
      await E(hostAgent).remove(...target);
    }
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
        CODEX_CLIENT_NAME: clientName,
        CODEX_HOME_NAME: codexHomeName,
        CODEX_WORKSPACE_BASE_DIR: workspaceDir,
        CODEX_SESSION_STATE_DIR: stateDir,
        CODEX_SANDBOX_IMAGE: rootfs,
      }),
    },
  );
  await E(hostAgent).copy([provisionerName], provisionerPath);
  await E(hostAgent).copy([seederName], seederPath);
  console.log(
    `Hosted Codex sandbox ready. Floot codex-cli sessions provision "${clientName}-<session-id>" against ${codexHomeDir}.`,
  );
};
harden(main);
