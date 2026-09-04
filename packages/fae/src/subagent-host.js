// @ts-check

/* eslint-disable no-await-in-loop */

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import { AUTH_SECRET_PETNAME } from './credentials.js';
import {
  DRIVER_SUFFIX,
  HANDLE_SUFFIX,
  SPAWNER_SUFFIX,
  SUBAGENT_INFIX,
  SubagentSpawnerInterface,
  agentNamePattern,
  assertSubagentName,
} from './subagent.js';

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
 * The direct subagents of `parentName` visible in a host directory listing.
 *
 * Matching is anchored rather than `startsWith`/`endsWith`: an agent's *handle*
 * is `p.sub.X`, and if X is itself `driver` that handle ends in `-driver` too.
 * A suffix test therefore reported a phantom subagent named `''` — one that
 * counted against the bound, could never be stopped (the empty string is not a
 * legal name), and whose teardown recursed into an agent that does not exist,
 * cancelling a live sibling's handle on the way. Requiring an inner name that
 * is itself a legal agent name distinguishes the two.
 *
 * A grandchild's driver matches the prefix as well; its inner segment carries
 * the infix, and since an agent name may not contain the infix's delimiter,
 * `agentNamePattern` rejects it. That is the whole of the depth check.
 *
 * @param {string[]} directory
 * @param {string} parentName
 * @returns {string[]}
 */
export const subagentNamesIn = (directory, parentName) => {
  const childPrefix = `${parentName}${SUBAGENT_INFIX}`;
  /** @type {string[]} */
  const names = [];
  for (const entry of directory) {
    if (
      typeof entry === 'string' &&
      entry.startsWith(childPrefix) &&
      entry.endsWith(DRIVER_SUFFIX)
    ) {
      const inner = entry.slice(childPrefix.length, -DRIVER_SUFFIX.length);
      if (agentNamePattern.test(inner)) {
        names.push(inner);
      }
    }
  }
  return names.sort();
};
harden(subagentNamesIn);

/**
 * The pet name of the guest *agent* behind a handle name. `provideGuest(name,
 * { agentName })` binds the handle at `name` and the agent it fronts at
 * `agentName`; cancelling the agent is what actually releases the guest.
 *
 * @param {string} handleName
 */
const profileNameFor = handleName => `profile-for-${handleName}`;

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
 * @param {string} [options.authSecretLocator] - `SecretBlob` holding the
 *   provider auth token. Absent when the deployment still carries a plaintext
 *   token in the provider config.
 * @param {string} [options.systemPrompt] - Replaces the standing prompt. Only
 *   the factory passes this: it acts with the authority of whoever set the
 *   deployment up.
 * @param {string} [options.delegatedPrompt] - *Appended* to the standing
 *   prompt. This is what a parent model writes for its subagent, and it must
 *   not be able to displace the instructions the deployment gave.
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
  authSecretLocator,
  systemPrompt,
  delegatedPrompt,
  pin = false,
}) => {
  const profileName = profileNameFor(name);
  const driverResultName = `${name}${DRIVER_SUFFIX}`;
  const driverHandleName = `${driverResultName}${HANDLE_SUFFIX}`;
  const driverProfileName = profileNameFor(driverHandleName);
  const spawnerResultName = `${name}${SPAWNER_SUFFIX}`;
  const spawnerHandleName = `${spawnerResultName}${HANDLE_SUFFIX}`;
  const spawnerProfileName = profileNameFor(spawnerHandleName);

  // Every name this agent will own, checked before anything is created.
  //
  // `provideGuest` returns whatever a name already holds, of any formula type,
  // and skips binding its `agentName` in that case — so a collision does not
  // fail where it happens, it fails several steps later, and the rollback then
  // removes a name this call never bound. Checking `name-driver` alone was not
  // enough: `createAgent('secrets')` would have unbound the user's `secrets`
  // directory, and a subagent whose host name lands on a sibling's driver
  // caplet would have left that caplet running with no name to cancel it by.
  const ownedNames = harden([
    [name],
    [profileName],
    [driverResultName],
    [driverHandleName],
    [driverProfileName],
    [spawnerResultName],
    [spawnerHandleName],
    [spawnerProfileName],
    // Release removes this whether or not this call pinned anything, so an
    // operator's pre-existing pin by the same name would be silently dropped.
    ['@pins', driverResultName],
  ]);

  // `name` is the *host* name, which for a subagent carries the infix; the
  // caller validates the agent-level name it derived this from.
  await null;
  for (const owned of ownedNames) {
    !(await E(hostAgent).has(...owned)) ||
      Fail`Cannot create agent ${q(name)}: the name ${q(owned.join('/'))} is already taken`;
  }

  const build = async () => {
    await null;
    // 1. The agent's own guest: inbox, pet store, tools.
    await E(hostAgent).provideGuest(name, { agentName: profileName });

    // 2. A spawner caplet, unless this agent is at the delegation bound. It is
    //    a durable formula rather than a live object so that a revived driver
    //    finds the same capability it had before the daemon restarted.
    /** @type {string | undefined} */
    let spawnerLocator;
    if (depth < maxDepth) {
      const spawnerGuest = await E(hostAgent).provideGuest(spawnerHandleName, {
        agentName: spawnerProfileName,
      });
      await E(spawnerGuest).storeLocator('llm-provider', providerLocator);
      await E(spawnerGuest).storeLocator('host-agent', hostAgentLocator);
      if (authSecretLocator !== undefined) {
        await E(spawnerGuest).storeLocator(
          AUTH_SECRET_PETNAME,
          authSecretLocator,
        );
      }
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
    //    inbox loop needs, so the driver formula itself carries no
    //    configuration.
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
    if (authSecretLocator !== undefined) {
      await E(driverGuest).storeLocator(AUTH_SECRET_PETNAME, authSecretLocator);
    }

    await E(hostAgent).makeUnconfined('@main', driverSpecifier, {
      powersName: driverProfileName,
      resultName: driverResultName,
      env: harden({
        FAE_SYSTEM_PROMPT: systemPrompt || '',
        FAE_SUBAGENT_PROMPT: delegatedPrompt || '',
      }),
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

  try {
    return await build();
  } catch (error) {
    // Several formulations deep by the time a late step can fail. A spawner
    // caplet created before that failure is *running* and holds `host-agent` —
    // the authority to mint more agents — with nothing left naming it, so a
    // half-built agent must be released rather than abandoned. Safe to release
    // wholesale because the pre-check above established that every name it
    // touches was free before this call.
    try {
      await releaseFaeAgent({ hostAgent, name });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Provisioning agent "${name}" failed, and rolling it back failed too`,
        { cause: rollbackError },
      );
    }
    throw error;
  }
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
  /** @type {unknown[]} */
  const failures = [];

  const names = await E(hostAgent).list();
  const directory = Array.isArray(names) ? names : [];
  for (const child of subagentNamesIn(directory, name)) {
    try {
      await releaseFaeAgent({
        hostAgent,
        name: subagentAgentName(name, child),
      });
    } catch (error) {
      // One stubborn grandchild must not leave this agent's own driver,
      // spawner and guest running — the spawner holds `host-agent`, and an
      // agent whose teardown stopped at a child goes on answering mail while
      // the error names only the child.
      failures.push(error);
    }
  }

  const driverResultName = `${name}${DRIVER_SUFFIX}`;
  const spawnerResultName = `${name}${SPAWNER_SUFFIX}`;
  const driverHandleName = `${driverResultName}${HANDLE_SUFFIX}`;
  const spawnerHandleName = `${spawnerResultName}${HANDLE_SUFFIX}`;

  /**
   * Cancel a formula and drop the names that reach it, in that order.
   *
   * Paired, because `cancel` is *not* idempotent: `cancelValue` deletes the
   * controller, so a second cancel of the same id re-runs the formula before
   * cancelling it again. Retrying a teardown that had left a cancelled
   * caplet's name bound would therefore reincarnate it — including the
   * spawner caplet holding `host-agent`, which is the authority this whole
   * path exists to reclaim. Dropping the name in the same step is what makes
   * `has()` false on the retry and the retry safe.
   *
   * A cancel that fails keeps its names: they are the only way back to a
   * formula that may still be running, and the caller is told to retry.
   *
   * @param {string} capletName - The formula to cancel.
   * @param {string[]} reachedBy - Names to drop once it is gone.
   */
  const releaseCaplet = async (capletName, reachedBy) => {
    try {
      if (await E(hostAgent).has(capletName)) {
        await E(hostAgent).cancel(capletName);
      }
    } catch (error) {
      // Keep going: the rest of the tree still has to come down, and the
      // caller is told what failed at the end.
      failures.push(error);
      return;
    }
    try {
      for (const petName of reachedBy) {
        if (await E(hostAgent).has(petName)) {
          await E(hostAgent).remove(petName);
        }
      }
    } catch (error) {
      failures.push(error);
    }
  };

  // Caplets first, then the guests whose powers they run on, then the agent's
  // own guest. Dropping a name does not cancel what it named, so removing
  // these without cancelling would leave every guest incarnated for the life
  // of the daemon — inbox and all — reachable by anyone still holding it.
  await releaseCaplet(driverResultName, [driverResultName]);
  await releaseCaplet(spawnerResultName, [spawnerResultName]);
  await releaseCaplet(profileNameFor(driverHandleName), [
    driverHandleName,
    profileNameFor(driverHandleName),
  ]);
  await releaseCaplet(profileNameFor(spawnerHandleName), [
    spawnerHandleName,
    profileNameFor(spawnerHandleName),
  ]);
  await releaseCaplet(profileNameFor(name), [name, profileNameFor(name)]);

  try {
    // Removed unconditionally: a pin is a name, not a formula, and
    // provisioning refused to start if this one was already taken.
    if (await E(hostAgent).has('@pins', driverResultName)) {
      await E(hostAgent).remove('@pins', driverResultName);
    }
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Releasing agent "${name}" did not complete; what could not be cancelled is still bound, so retry once the cause is cleared`,
    );
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
 * @param {() => Promise<{ hostAgent: any, providerLocator: string, hostAgentLocator: string, authSecretLocator?: string }>} options.provideContext
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
  // The parse the whole scheme rests on is "every segment matches
  // `agentNamePattern`, joined by the infix". The child segment is checked in
  // `spawn`; this is the only place the parent's own name — which arrives from
  // a caplet's environment — can be held to the same rule.
  (typeof parentName === 'string' &&
    parentName
      .split(SUBAGENT_INFIX)
      .every(segment => agentNamePattern.test(segment))) ||
    Fail`Subagent spawner parent ${q(parentName)} is not a well-formed agent name`;
  /**
   * @param {any} hostAgent
   * @returns {Promise<string[]>}
   */
  const listNames = async hostAgent => {
    const names = await E(hostAgent).list();
    return subagentNamesIn(Array.isArray(names) ? names : [], parentName);
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
      const {
        hostAgent,
        providerLocator,
        hostAgentLocator,
        authSecretLocator,
      } = await provideContext();
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
        authSecretLocator,
        delegatedPrompt: systemPrompt,
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
