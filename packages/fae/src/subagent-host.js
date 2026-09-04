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
  reservedSubagentSuffixes,
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
 * Keyed on the agent's own handle — `p.sub.X` — rather than on its driver
 * caplet. Teardown cancels several formulas, and any of them can fail; keying
 * on the driver meant a child whose driver went down but whose spawner would
 * not vanished from its parent's listing the moment the first step succeeded.
 * It then counted against no bound, no retry revisited it, and `spawn` refused
 * the name forever because the pre-check still saw the leftovers. The handle
 * is dropped last, and only when everything beneath it is gone, so a child in
 * that state stays enumerable and a retry finishes the job.
 *
 * Matching is anchored at both ends. `p.sub.X-driver` and `p.sub.X-handle` are
 * `p.sub.<something>` too, so the inner segment must be a name a subagent
 * could legally have — which excludes the reserved suffixes — and an agent
 * name may not contain the infix's delimiter, which excludes a grandchild.
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
    if (typeof entry === 'string' && entry.startsWith(childPrefix)) {
      const inner = entry.slice(childPrefix.length);
      if (
        agentNamePattern.test(inner) &&
        !reservedSubagentSuffixes.some(suffix => inner.endsWith(suffix))
      ) {
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

  const driverResultName = `${name}${DRIVER_SUFFIX}`;
  const spawnerResultName = `${name}${SPAWNER_SUFFIX}`;
  const driverHandleName = `${driverResultName}${HANDLE_SUFFIX}`;
  const spawnerHandleName = `${spawnerResultName}${HANDLE_SUFFIX}`;

  /**
   * Cancel one powers guest and drop the names it owns.
   *
   * The *guest* is what is cancelled, never the caplet running on it:
   * `makeUnconfined` registers `thisDiesIfThatDies(powersId)`, so a driver or
   * spawner caplet is cancelled along with the guest whose powers it holds.
   * Cancelling it separately would be a second cancel of a dead formula — and
   * `cancel` is not idempotent. `cancelValue` deletes the controller, so
   * `provideController` re-runs the formula before cancelling the fresh one.
   *
   * The guest's own name is dropped *first*, because it is the sentinel a
   * retry tests. Left for last, a removal loop interrupted partway would leave
   * the sentinel bound over a formula that is already gone, and the retry
   * would cancel — and so reincarnate — it.
   *
   * A cancel that fails drops nothing: those names are the only way back.
   *
   * @param {string} guestName - The powers guest to cancel.
   * @param {string[]} owned - `guestName` first, then everything it owns.
   */
  const releaseGuest = async (guestName, owned) => {
    // The retry argument above rests on this ordering, so it is asserted
    // rather than left to a comment.
    owned[0] === guestName ||
      Fail`releaseGuest must drop ${q(guestName)} first, not ${q(owned[0])}`;
    try {
      if (await E(hostAgent).has(guestName)) {
        await E(hostAgent).cancel(guestName);
      }
    } catch (error) {
      // Keep going where it is safe to: the caller is told what failed.
      failures.push(error);
      return;
    }
    for (const petName of owned) {
      try {
        if (await E(hostAgent).has(petName)) {
          await E(hostAgent).remove(petName);
        }
      } catch (error) {
        failures.push(error);
      }
    }
  };

  // Quiesce this agent before looking at what it owns.
  //
  // Its subtree is enumerated from the host directory, once. Releasing the
  // children first — the obvious depth-first order — left the agent answering
  // mail and its spawner minting agents throughout, so a subagent created
  // during the recursion was not in the snapshot, was never released, and
  // afterwards was reachable by nothing: its parent's spawner was gone, and
  // the grandparent's enumeration rejects a name a level too deep. Nothing in
  // the recursion needs this agent's spawner — teardown drives `hostAgent`
  // directly — so depth-first buys nothing and costs quiescence.
  await releaseGuest(profileNameFor(driverHandleName), [
    profileNameFor(driverHandleName),
    driverHandleName,
    driverResultName,
  ]);
  if (failures.length === 0) {
    // A pin is a name, not a formula. Dropped with the driver it pins, and
    // kept if that driver would not go down, so a restart before a successful
    // retry still revives an agent somebody is trying to save.
    try {
      if (await E(hostAgent).has('@pins', driverResultName)) {
        await E(hostAgent).remove('@pins', driverResultName);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  await releaseGuest(profileNameFor(spawnerHandleName), [
    profileNameFor(spawnerHandleName),
    spawnerHandleName,
    spawnerResultName,
  ]);

  // Still live means still spawning, so do not enumerate: a retry starts from
  // the top, and this agent is still enumerable by its own parent because its
  // handle is dropped last.
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Releasing agent "${name}" could not stop it; nothing beneath it was touched, so retry once the cause is cleared`,
    );
  }

  const names = await E(hostAgent).list();
  const directory = Array.isArray(names) ? names : [];
  for (const child of subagentNamesIn(directory, name)) {
    try {
      await releaseFaeAgent({
        hostAgent,
        name: subagentAgentName(name, child),
      });
    } catch (error) {
      // One stubborn grandchild must not leave this agent's own guest bound
      // and its names half-dropped; the error names the child and a retry
      // reaches it, because this agent's handle stays bound below.
      failures.push(error);
    }
  }

  await releaseGuest(profileNameFor(name), [profileNameFor(name)]);

  // The agent's handle is what its parent enumerates by, so it goes last and
  // only when nothing of this agent — or anything beneath it — is left. A
  // half-released agent that had already lost this name would be invisible to
  // the recursion that is supposed to come back for it.
  if (failures.length === 0) {
    try {
      if (await E(hostAgent).has(name)) {
        await E(hostAgent).remove(name);
      }
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Releasing agent "${name}" did not complete; what could not be released is still bound and still enumerable, so retry once the cause is cleared`,
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

  // `spawn` and `stop` are serialized against each other.
  //
  // Both read the host directory and then act on it, so concurrent calls
  // interleave between the check and the act: two spawns of one name both pass
  // the pre-check and the second silently reuses the first's guest, and two
  // stops of one agent both see the guest bound and both cancel it — which the
  // daemon answers by re-incarnating the formula before cancelling it again.
  // A model can issue both, since tool calls within a turn are not ordered.
  /** @type {Promise<any>} */
  let inTurn = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const serially = operation => {
    const result = inTurn.then(operation);
    inTurn = result.catch(() => undefined);
    return result;
  };

  return makeExo('SubagentSpawner', SubagentSpawnerInterface, {
    /**
     * @param {string} name
     * @param {{ systemPrompt?: string }} [options]
     */
    async spawn(name, options = {}) {
      assertSubagentName(name);
      return serially(async () => {
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
      });
    },

    /** @param {string} name */
    async stop(name) {
      assertSubagentName(name);
      return serially(async () => {
        const { hostAgent } = await provideContext();
        await releaseFaeAgent({
          hostAgent,
          name: subagentAgentName(parentName, name),
        });
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
