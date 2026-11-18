// @ts-check
// Helpers of the W4.4 tests (m4-renewal*.test.js, m4-secrets-full.test.js):
// a Secrets store over a temporary state directory (key file outside it,
// under H/tmp), and stored-form credentials built from fake tokens.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SECRETS_KEY_VARIABLE,
  findSecretsFiles,
  makeSecretStore,
} from '../../resources/agent-host/impl/secrets/store.js';

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** @param {string} tag */
export const makeStoreDirs = tag => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const root = mkdtempSync(join(harnessRoot, 'tmp', `${tag}-`));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  const files = findSecretsFiles({
    stateDir,
    env: { [SECRETS_KEY_VARIABLE]: join(root, 'keys', 'secrets.key') },
  });
  return {
    root,
    stateDir,
    files,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
};

/**
 * @param {ReturnType<typeof makeStoreDirs>['files']} files
 * @param {() => number} [now]
 */
export const openStore = (files, now) =>
  makeSecretStore({
    file: files.file,
    keyFile: files.keyFile,
    stateDir: files.stateDir,
    ...(now === undefined ? {} : { now }),
  });

/**
 * A stored-form credential value (`credentials.js`).
 * @param {object} fields
 * @param {'claude' | 'codex'} [fields.provider]
 * @param {string} fields.accessToken
 * @param {string} [fields.refreshToken]
 * @param {number} fields.expiresAtMs
 * @param {string} [fields.accountId]
 * @param {string[]} [fields.scopes]
 * @param {{ startedAtMs: number }} [fields.pendingRefresh]
 */
export const storedCredential = ({ provider = 'claude', ...rest }) =>
  JSON.stringify({ version: 1, provider, ...rest });

/**
 * A store holding one member credential under key `k1`.
 * @param {import('../../resources/agent-host/impl/secrets/store.js').SecretStore} store
 * @param {string} value
 * @param {string} [key]
 */
export const seedCredential = async (store, value, key = 'k1') => {
  await store.create(key, `member ${key}`, 'subscription credential');
  return store.replace(key, value);
};
