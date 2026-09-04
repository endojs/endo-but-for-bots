// @ts-check

import { E } from '@endo/eventual-send';

import { AUTH_SECRET_PETNAME } from './src/credentials.js';
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DEFAULT_MAX_SUBAGENTS,
  makeSubagentSpawner,
} from './src/subagent-host.js';

/**
 * Fae subagent-spawner caplet.
 *
 * One of these is provisioned per agent that is allowed to delegate, and its
 * locator is written into that agent's driver namespace as `subagent-spawner`.
 * It exists as its own formula rather than as an object minted inside the
 * factory so that the capability survives a daemon restart: `revivePins()`
 * restarts the driver, the driver looks the spawner up, and the same formula
 * reincarnates with the same authority.
 *
 * Its own namespace holds two capability references written at creation time:
 *
 *   - `llm-provider`     – the provider config every agent it creates will use
 *   - `host-agent`       – host authority over the agent namespace
 *   - `llm-auth-secret`  – optional; the `SecretBlob` holding the provider auth
 *     token, delegated onward to each agent it creates
 *
 * The exo it returns is the whole of the authority a parent agent gets: create,
 * list, and release agents named beneath itself. `host-agent` never leaves.
 *
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @param {Promise<object> | object | undefined} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, _context, { env } = {}) => {
  const parentName = env?.SUBAGENT_PARENT || '';
  if (parentName === '') {
    throw Error('Subagent spawner requires SUBAGENT_PARENT');
  }
  const parseBound = (text, fallback) => {
    if (text === undefined || text === '') return fallback;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) {
      throw Error(`Subagent spawner received an invalid bound "${text}"`);
    }
    return value;
  };
  const depth = parseBound(env?.SUBAGENT_DEPTH, 1);
  const maxDepth = parseBound(
    env?.SUBAGENT_MAX_DEPTH,
    DEFAULT_MAX_SUBAGENT_DEPTH,
  );
  const maxSubagents = parseBound(
    env?.SUBAGENT_MAX_COUNT,
    DEFAULT_MAX_SUBAGENTS,
  );

  const driverSpecifier = new URL('driver.js', import.meta.url).href;
  const spawnerSpecifier = new URL('subagent-spawner.js', import.meta.url).href;

  // Resolved on first use, not here: this formula is reincarnated by the very
  // lookup a reviving driver performs, and awaiting our own guest inside
  // `make()` would join that provision chain (see driver.js).
  /** @type {Promise<{ hostAgent: any, providerLocator: string, hostAgentLocator: string, authSecretLocator?: string }> | undefined} */
  let contextP;
  const provideContext = () => {
    if (!contextP) {
      contextP = (async () => {
        const [hostAgent, providerLocator, hostAgentLocator, hasAuthSecret] =
          await Promise.all([
            E(powers).lookup('host-agent'),
            E(powers).locate('llm-provider'),
            E(powers).locate('host-agent'),
            E(powers).has(AUTH_SECRET_PETNAME),
          ]);
        const authSecretLocator = hasAuthSecret
          ? /** @type {string} */ (await E(powers).locate(AUTH_SECRET_PETNAME))
          : undefined;
        return harden({
          hostAgent,
          providerLocator: /** @type {string} */ (providerLocator),
          hostAgentLocator: /** @type {string} */ (hostAgentLocator),
          ...(authSecretLocator ? { authSecretLocator } : {}),
        });
      })().catch(error => {
        contextP = undefined;
        throw error;
      });
    }
    return contextP;
  };

  return makeSubagentSpawner({
    provideContext,
    parentName,
    driverSpecifier,
    spawnerSpecifier,
    depth,
    maxDepth,
    maxSubagents,
  });
};
harden(make);
