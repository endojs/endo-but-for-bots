// @ts-check

import { homedir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { pathToFileURL } from 'node:url';

import { E } from '@endo/eventual-send';

import {
  installHostedSubscription,
  withSubscriptionSetupLock,
} from './src/subscription-setup.js';

/** Explicit one-shot operator setup. Existing backends are refused before
 * credential access: config changes require deliberate replacement/migration.
 * The lock directory is host-user state, not changeable deployment config.
 * Missing configuration enables nothing. Formula config pins the selected
 * account and never contains credentials.
 * @param {any} host
 */
export const main = async host => {
  if (!env.ENDO_CODEX_HOST_CONFIG) return;
  const config = JSON.parse(env.ENDO_CODEX_HOST_CONFIG);
  const moduleURL = env.ENDO_CODEX_MODULE_PATH
    ? pathToFileURL(env.ENDO_CODEX_MODULE_PATH).href
    : new URL('./src/hosted-subscription-module.js', import.meta.url).href;
  const hostId = await E(host).identify('@agent');
  await withSubscriptionSetupLock(
    { directory: join(homedir(), '.endo-codex-setup-locks'), hostId },
    () => installHostedSubscription(host, { config, moduleURL }),
  );
  console.log('Codex subscription backend registered with Floot.');
};
harden(main);
