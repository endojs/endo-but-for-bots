// @ts-check
// prefer-endo-primitives-exempt: disposal hooks require callable remotables;
// makeExo creates method-bearing objects, not callable facets.

/* global setInterval, clearInterval */

/** @import { ERef } from '@endo/eventual-send' */

import { E } from '@endo/eventual-send';
import { Fail, makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { Far } from '@endo/far';
import { M } from '@endo/patterns';
import { randomUUID } from 'node:crypto';

import { makeAgentFactory } from './agent-factory.js';
import { makeSnapshotJournal } from './snapshot-journal.js';

const AgentFactoryRootInterface = M.interface('AgentFactory', {
  directoryFor: M.call(M.string()).returns(M.remotable()),
  endowmentFor: M.callWhen(M.string()).returns(M.record()),
  reconcile: M.callWhen().returns(M.record()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(AgentFactoryRootInterface);

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

/**
 * A guest's handle and its powers are separate pet names: `provideGuest` only
 * returns the powers on the call that formulates the guest.
 *
 * @param {string} name
 */
const agentNameOf = name => `${name}-agent`;

/**
 * Dedicated agent guests under root-private names. Provisioning names no owner
 * and introduces no names, so the guest starts with no edge to anyone's
 * inventory.
 *
 * @param {any} powers Root host.
 */
export const makeRootGuestParticipant = powers =>
  harden({
    provide: async name => {
      await E(powers).provideGuest(name, { agentName: agentNameOf(name) });
      return harden({ handleId: await E(powers).identify(name) });
    },
    guestFor: name => E(powers).lookup(agentNameOf(name)),
    release: async name => {
      for (const petName of [agentNameOf(name), name]) {
        // eslint-disable-next-line no-await-in-loop
        if (await E(powers).has(petName)) await E(powers).remove(petName);
      }
    },
    listMail: async name => {
      const messages = await E(E(powers).lookup(agentNameOf(name))).listMessages();
      return harden(
        messages.map(message =>
          harden({
            number: String(message.number),
            type: message.type,
            date: message.date,
            text: (message.strings || []).join(' ').slice(0, 280),
          }),
        ),
      );
    },
    dismissMail: (name, number) =>
      E(E(powers).lookup(agentNameOf(name))).dismiss(BigInt(number)),
  });
harden(makeRootGuestParticipant);

/**
 * The owner's inventory is the guest the app provisioned under the owner key.
 * The entry is the agent's handle, which addresses its mailbox and carries none
 * of its powers.
 *
 * @param {any} powers Root host.
 */
export const makeOwnerInventoryParticipant = powers =>
  harden({
    write: async (ownerId, name, handleId) => {
      // The app provisions the owner's guest at sign-in. Naming an agent never
      // creates one, because a guest made here would miss that provisioning.
      if (!(await E(powers).has(agentNameOf(ownerId)))) {
        throw makeError(
          X`Agent operation failed: ${q('owner-not-provisioned')}`,
        );
      }
      const owner = E(powers).lookup(agentNameOf(ownerId));
      const present = await E(owner).has(name);
      if (present) {
        const existing = await E(owner).identify(name);
        if (existing !== handleId) {
          throw makeError(
            X`Agent operation failed: ${q('agent-name-conflict')}`,
          );
        }
        return;
      }
      await E(owner).storeIdentifier(name, handleId);
    },
    remove: async (ownerId, name, handleId) => {
      if (!(await E(powers).has(agentNameOf(ownerId)))) return;
      const owner = E(powers).lookup(agentNameOf(ownerId));
      if (!(await E(owner).has(name))) return;
      if ((await E(owner).identify(name)) === handleId) {
        await E(owner).remove(name);
      }
    },
  });
harden(makeOwnerInventoryParticipant);

/**
 * Root-private agent factory caplet. Its collaborators are retained by name and
 * resolved anew after a daemon restart, as the provider registry's issuer is.
 *
 * @param {ERef<any>} powers
 * @param {any} context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, context, { env } = {}) => {
  const registryName =
    env?.AGENT_FACTORY_PROVIDER_REGISTRY ||
    Fail`Agent factory has no provider registry`;
  const responderName =
    env?.AGENT_FACTORY_RESPONDER_LAUNCHER ||
    Fail`Agent factory has no responder launcher`;
  const spawnerName = env?.AGENT_FACTORY_SUBAGENT_SPAWNER;
  /**
   * @param {string} name
   * @param {string[]} methods
   */
  const retainedByName = (name, methods) =>
    harden(
      Object.fromEntries(
        methods.map(method => [
          method,
          (...callArguments) => E(E(powers).lookup(name))[method](...callArguments),
        ]),
      ),
    );

  const factory = await makeAgentFactory({
    journal: makeSnapshotJournal({ powers, prefix: 'agent-factory-v1-' }),
    registry: retainedByName(registryName, [
      'directoryFor',
      'useFor',
      'inferenceFor',
      'revokeGrant',
      'listGrants',
    ]),
    guests: makeRootGuestParticipant(powers),
    inventory: makeOwnerInventoryParticipant(powers),
    responders: retainedByName(responderName, [
      'has',
      'provide',
      'setPaused',
      'remove',
    ]),
    spawners:
      spawnerName === undefined
        ? undefined
        : retainedByName(spawnerName, ['provide']),
    randomId: randomUUID,
  });

  const reconcileQuietly = () =>
    factory.reconcile().catch(error => {
      console.error('agent factory reconcile failed', error);
    });
  void reconcileQuietly();
  const interval = setInterval(
    reconcileQuietly,
    Number(env?.AGENT_FACTORY_RECONCILE_MS) || DEFAULT_RECONCILE_INTERVAL_MS,
  );
  interval.unref?.();
  if (context !== undefined) {
    await E(context).addDisposalHook(
      Far('Dispose agent factory', () => clearInterval(interval)),
    );
  }
  return makeExo('AgentFactory', AgentFactoryRootInterface, {
    directoryFor: ownerId => factory.directoryFor(ownerId),
    endowmentFor: agentId => factory.endowmentFor(agentId),
    reconcile: () => factory.reconcile(),
  });
};
harden(make);
