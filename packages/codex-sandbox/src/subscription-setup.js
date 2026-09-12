// @ts-check

import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { getuid } from 'node:process';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { importCodexSubscription } from './subscription-auth.js';

/** Account selection is formula configuration, not replaceable token metadata.
 * @param {unknown} accountRef
 * @param {any} state
 * @returns {string}
 */
export const assertSubscriptionAccount = (accountRef, state) => {
  if (
    typeof accountRef !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(accountRef)
  ) {
    throw Fail`Codex subscription requires a pinned account reference`;
  }
  state?.accountId === accountRef || Fail`Codex subscription account changed`;
  return accountRef;
};
harden(assertSubscriptionAccount);

/** Cross-process, per-host installation exclusion. The operator fixes the
 * directory independently of deployment configuration. A crashed installer
 * leaves a lock requiring operator recovery; never guess that work has stopped.
 * @template T
 * @param {{directory:string, hostId:string}} options
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export const withSubscriptionSetupLock = async (
  { directory, hostId },
  operation,
) => {
  (isAbsolute(directory) && typeof hostId === 'string' && hostId.length > 0) ||
    Fail`Invalid subscription setup lock identity`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  const owner = typeof getuid === 'function' ? getuid() : undefined;
  // POSIX mode bits: no group/other access to the lock root.
  // eslint-disable-next-line no-bitwise
  const privateMode = (info.mode & 0o077) === 0;
  (info.isDirectory() &&
    privateMode &&
    info.uid === owner &&
    (await realpath(directory)) === directory) ||
    Fail`Subscription setup lock directory must be private and canonical`;
  const name = createHash('sha256').update(hostId).digest('hex');
  const lock = join(directory, name);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw Fail`Codex setup is locked; verify the previous installer stopped before operator recovery`;
  }
  try {
    return await operation();
  } finally {
    await rmdir(lock);
  }
};
harden(withSubscriptionSetupLock);

/** One-shot installation; callers hold the per-host installation lock.
 * Existing installations are deliberately refused before any credential access.
 * Reconfiguration needs explicit teardown/migration, never silent reuse.
 * @param {any} host
 * @param {{config:any, moduleURL:string}} options
 */
export const installHostedSubscription = async (
  host,
  { config, moduleURL },
) => {
  const backendPath = ['codex-subscription-backend'];
  !(await E(host).has(...backendPath)) ||
    Fail`Codex backend already exists; configuration changes require explicit operator replacement`;
  const secretPath = config.secretPath ?? [
    'secrets',
    'codex-subscription-auth',
  ];
  const catalog = await E(host).lookup(['@secrets', 'catalog']);
  const entry = (await E(catalog).list()).find(item =>
    item.petNamePaths.some(
      path => JSON.stringify(path) === JSON.stringify(secretPath),
    ),
  );
  entry || Fail`Configured Codex subscription secret is missing`;
  const secret = await E(host).lookup(secretPath);
  const snapshot = await E(secret).readBase64WithGeneration();
  let stored;
  try {
    stored = JSON.parse(globalThis.atob(snapshot.base64));
  } catch {
    throw Fail`Invalid subscription credential`;
  }
  const state =
    stored?.version === 'BrokerOAuthStateV1'
      ? stored
      : importCodexSubscription(stored);
  const accountRef = assertSubscriptionAccount(
    config.accountRef ?? state.accountId,
    state,
  );
  // Reject a mismatching explicit account before converting the secret.
  if (state !== stored) {
    await E(entry.admin).replaceBase64(globalThis.btoa(JSON.stringify(state)), {
      ifGeneration: snapshot.generation,
    });
  }
  await E(host).makeUnconfined('codex-subscription-worker', moduleURL, {
    powersName: '@agent',
    resultName: backendPath,
    env: harden({
      CODEX_HOST_CONFIG: JSON.stringify({ ...config, accountRef }),
    }),
  });
  const backend = await E(host).lookup(backendPath);
  await E(backend).describe();
  await E(host).copy(backendPath, [
    'floot',
    'controller-profile',
    'codex-backend',
  ]);
};
harden(installHostedSubscription);
