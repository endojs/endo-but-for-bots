// @ts-check

/* eslint-disable no-await-in-loop */

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import { SubagentSpawnerInterface, assertSubagentName } from './subagent.js';

/**
 * Infix that makes a subagent's names in the factory host derivable from its
 * parent's. Teardown enumerates by this prefix, so a subagent tree can be
 * released without any registry beyond the host's own directory.
 */
const SUBAGENT_INFIX = '-sub-';

/** Suffixes appended to an agent's name for the formulas it owns. */
const DRIVER_SUFFIX = '-driver';
const SPAWNER_SUFFIX = '-spawner';

/**
 * Delegation depth at which an agent is no longer given a spawner. The default
 * admits one layer of subagents. Teardown is recursive, so a deployment may
 * raise it; the bound exists to keep a model from opening an unbounded tree of
 * daemon-resident conversations.
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 1;

/** Live subagents one parent may hold at a time. */
export const DEFAULT_MAX_SUBAGENTS = 8;

/**
 * @param {string} parentName
 * @param {string} name
 */
export const subagentAgentName = (parentName, name) =>
  `${parentName}${SUBAGENT_INFIX}${name}`;
harden(subagentAgentName);

/**
 * Provision one Fae agent: its guest, an optional subagent spawner, and the
 * driver caplet that runs its inbox loop.
 *
 * Shared by the factory (which creates root agents) and by a spawner caplet
 * (which creates subagents), so both topologies are identical and a subagent
 * is an ordinary agent that happens to be named after its parent.
 *
 * @param {object} options
 * @param {any} options.hostAgent - Host authority for the agent namespace.
 * @param {string} options.name - Agent name, unique within `hostAgent`.
 * @param {string} options.providerLocator
 * @param {string} options.hostAgentLocator
 * @param {string} options.driverSpecifier
 * @param {string} options.spawnerSpecifier
 * @param {number} options.depth - Delegation depth of the agent being created.
 * @param {number} options.maxDepth
 * @param {string} [options.systemPrompt]
 * @param {boolean} [options.pin]
 * @returns {Promise<{ name: string, profileName: string, locator: string }>}
 */
export const provisionFaeAgent = async ({
  hostAgent,
  name,
  providerLocator,
  hostAgentLocator,
  driverSpecifier,
  spawnerSpecifier,
  depth,
  maxDepth,
  systemPrompt,
  pin = false,
}) => {
  const profileName = `profile-for-${name}`;
  const driverResultName = `${name}${DRIVER_SUFFIX}`;
  const driverHandleName = `${driverResultName}-handle`;
  const driverProfileName = `profile-for-${driverHandleName}`;

  await null;
  !(await E(hostAgent).has(driverResultName)) ||
    Fail`Agent ${q(name)} already exists`;

  // 1. The agent's own guest: inbox, pet store, tools.
  await E(hostAgent).provideGuest(name, { agentName: profileName });

  // 2. A spawner caplet, unless this agent is at the delegation bound. It is a
  //    durable formula rather than a live object so that a revived driver finds
  //    the same capability it had before the daemon restarted.
  /** @type {string | undefined} */
  let spawnerLocator;
  if (depth < maxDepth) {
    const spawnerResultName = `${name}${SPAWNER_SUFFIX}`;
    const spawnerHandleName = `${spawnerResultName}-handle`;
    const spawnerProfileName = `profile-for-${spawnerHandleName}`;
    const spawnerGuest = await E(hostAgent).provideGuest(spawnerHandleName, {
      agentName: spawnerProfileName,
    });
    await E(spawnerGuest).storeLocator('llm-provider', providerLocator);
    await E(spawnerGuest).storeLocator('host-agent', hostAgentLocator);
    await E(hostAgent).makeUnconfined('@main', spawnerSpecifier, {
      powersName: spawnerProfileName,
      resultName: spawnerResultName,
      env: harden({
        SUBAGENT_PARENT: name,
        SUBAGENT_DEPTH: `${depth + 1}`,
        SUBAGENT_MAX_DEPTH: `${maxDepth}`,
      }),
    });
    spawnerLocator = /** @type {string} */ (
      await E(hostAgent).locate(spawnerResultName)
    );
  }

  // 3. The driver's own guest holds capability references to everything the
  //    inbox loop needs, so the driver formula itself carries no configuration.
  const driverGuest = await E(hostAgent).provideGuest(driverHandleName, {
    agentName: driverProfileName,
  });
  await E(driverGuest).storeLocator('llm-provider', providerLocator);
  await E(driverGuest).storeLocator(
    'agent',
    /** @type {string} */ (await E(hostAgent).locate(profileName)),
  );
  if (spawnerLocator !== undefined) {
    await E(driverGuest).storeLocator('subagent-spawner', spawnerLocator);
  }

  await E(hostAgent).makeUnconfined('@main', driverSpecifier, {
    powersName: driverProfileName,
    resultName: driverResultName,
    env: harden({ FAE_SYSTEM_PROMPT: systemPrompt || '' }),
  });

  if (pin) {
    await E(hostAgent).copy([driverResultName], ['@pins', driverResultName]);
  }

  return harden({
    name,
    profileName,
    // The agent's *handle* — its mail address, and the identity that appears
    // as `from` on the messages it sends.
    locator: /** @type {string} */ (await E(hostAgent).locate(name)),
  });
};
harden(provisionFaeAgent);

/**
 * Release an agent provisioned by `provisionFaeAgent`, depth-first.
 *
 * Every formula an agent owns is named after it, so its subtree is derivable
 * from the host directory alone. Cancellation precedes name removal: a name
 * dropped first would strand a running driver with no way to reach it.
 *
 * @param {object} options
 * @param {any} options.hostAgent
 * @param {string} options.name
 * @returns {Promise<void>}
 */
export const releaseFaeAgent = async ({ hostAgent, name }) => {
  const names = await E(hostAgent).list();
  const directory = Array.isArray(names) ? names : [];
  const childPrefix = `${name}${SUBAGENT_INFIX}`;
  const children = directory.filter(
    entry =>
      typeof entry === 'string' &&
      entry.startsWith(childPrefix) &&
      entry.endsWith(DRIVER_SUFFIX) &&
      !entry
        .slice(childPrefix.length, -DRIVER_SUFFIX.length)
        .includes(SUBAGENT_INFIX),
  );
  for (const child of children) {
    await releaseFaeAgent({
      hostAgent,
      name: child.slice(0, -DRIVER_SUFFIX.length),
    });
  }

  const driverResultName = `${name}${DRIVER_SUFFIX}`;
  const spawnerResultName = `${name}${SPAWNER_SUFFIX}`;
  for (const capletName of [driverResultName, spawnerResultName]) {
    if (await E(hostAgent).has(capletName)) {
      await E(hostAgent).cancel(capletName);
    }
  }
  if (await E(hostAgent).has('@pins', driverResultName)) {
    await E(hostAgent).remove('@pins', driverResultName);
  }
  for (const petName of [
    driverResultName,
    `${driverResultName}-handle`,
    `profile-for-${driverResultName}-handle`,
    spawnerResultName,
    `${spawnerResultName}-handle`,
    `profile-for-${spawnerResultName}-handle`,
    name,
    `profile-for-${name}`,
  ]) {
    if (await E(hostAgent).has(petName)) {
      await E(hostAgent).remove(petName);
    }
  }
};
harden(releaseFaeAgent);

/**
 * Mint the `SubagentSpawner` capability one parent agent holds.
 *
 * The spawner is the *only* authority a parent gains over the agent namespace:
 * it can create, enumerate, and release agents named beneath itself, and
 * nothing else. It deliberately does not write into the parent's pet store —
 * the parent binds the returned locator under its own authority — so a
 * compromised parent gains no writer for its own namespace.
 *
 * `provideContext` is called per method rather than at construction: a spawner
 * caplet is reincarnated by the very lookup its parent's driver performs while
 * being revived, and awaiting its own guest inside `make()` would join that
 * provision chain.
 *
 * @param {object} options
 * @param {() => Promise<{ hostAgent: any, providerLocator: string, hostAgentLocator: string }>} options.provideContext
 * @param {string} options.parentName
 * @param {string} options.driverSpecifier
 * @param {string} options.spawnerSpecifier
 * @param {number} options.depth - Depth of the agents this spawner creates.
 * @param {number} options.maxDepth
 * @param {number} [options.maxSubagents]
 */
export const makeSubagentSpawner = ({
  provideContext,
  parentName,
  driverSpecifier,
  spawnerSpecifier,
  depth,
  maxDepth,
  maxSubagents = DEFAULT_MAX_SUBAGENTS,
}) => {
  const childPrefix = `${parentName}${SUBAGENT_INFIX}`;

  /**
   * @param {any} hostAgent
   * @returns {Promise<string[]>}
   */
  const listNames = async hostAgent => {
    const names = await E(hostAgent).list();
    return (Array.isArray(names) ? names : [])
      .filter(
        entry =>
          typeof entry === 'string' &&
          entry.startsWith(childPrefix) &&
          entry.endsWith(DRIVER_SUFFIX),
      )
      .map(entry =>
        entry.slice(childPrefix.length, entry.length - DRIVER_SUFFIX.length),
      )
      .filter(entry => !entry.includes(SUBAGENT_INFIX))
      .sort();
  };

  return makeExo('SubagentSpawner', SubagentSpawnerInterface, {
    /**
     * @param {string} name
     * @param {{ systemPrompt?: string }} [options]
     */
    async spawn(name, options = {}) {
      assertSubagentName(name);
      const { systemPrompt } = options;
      systemPrompt === undefined ||
        (typeof systemPrompt === 'string' && systemPrompt.length <= 32_768) ||
        Fail`Subagent system prompt must be a string of at most 32768 characters`;
      const { hostAgent, providerLocator, hostAgentLocator } =
        await provideContext();
      const existing = await listNames(hostAgent);
      existing.length < maxSubagents ||
        Fail`Subagent limit of ${q(maxSubagents)} reached; stop one first`;
      const { locator } = await provisionFaeAgent({
        hostAgent,
        name: subagentAgentName(parentName, name),
        providerLocator,
        hostAgentLocator,
        driverSpecifier,
        spawnerSpecifier,
        depth,
        maxDepth,
        systemPrompt,
        // Subagents are working memory, not infrastructure: a daemon restart
        // should not resurrect a tree of them behind the user's back.
        pin: false,
      });
      return harden({ name, locator });
    },

    /** @param {string} name */
    async stop(name) {
      assertSubagentName(name);
      const { hostAgent } = await provideContext();
      await releaseFaeAgent({
        hostAgent,
        name: subagentAgentName(parentName, name),
      });
    },

    async list() {
      const { hostAgent } = await provideContext();
      return harden(await listNames(hostAgent));
    },

    /** @param {string} [methodName] */
    help(methodName) {
      if (methodName === 'spawn') {
        return 'spawn(name, { systemPrompt? }) — Create a subagent named beneath this agent and return { name, locator }.';
      }
      if (methodName === 'stop') {
        return 'stop(name) — Cancel a subagent, its own subagents, and every name they own.';
      }
      if (methodName === 'list') {
        return 'list() — Names of this agent’s live subagents.';
      }
      return 'Subagent spawner: create, list, and release agents named beneath one parent agent.';
    },
  });
};
harden(makeSubagentSpawner);
