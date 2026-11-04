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
const RELEASED_GUESTS = 'agent-factory-released-guests';

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
    /**
     * The daemon terminates a worker that references a formula it collects, and
     * this worker references the guests it serves. So release empties the guest
     * and sets its formula aside until `purgeReleased` runs on the next daemon
     * start, when no worker holds it yet.
     * @param name
     */
    release: async name => {
      const powersName = agentNameOf(name);
      if (await E(powers).has(powersName)) {
        const guest = E(powers).lookup(powersName);
        for (const { number } of await E(guest).listMessages()) {
          // eslint-disable-next-line no-await-in-loop
          await E(guest).dismiss(number);
        }
      }
      if (!(await E(powers).has(RELEASED_GUESTS))) {
        await E(powers).makeDirectory(RELEASED_GUESTS);
      }
      for (const petName of [powersName, name]) {
        // eslint-disable-next-line no-await-in-loop
        if (await E(powers).has(petName)) {
          // eslint-disable-next-line no-await-in-loop
          await E(powers).storeIdentifier(
            [RELEASED_GUESTS, petName],
            // eslint-disable-next-line no-await-in-loop
            await E(powers).identify(petName),
          );
          // eslint-disable-next-line no-await-in-loop
          await E(powers).remove(petName);
        }
      }
    },
    purgeReleased: async () => {
      if (!(await E(powers).has(RELEASED_GUESTS))) return;
      for (const petName of await E(powers).list(RELEASED_GUESTS)) {
        // eslint-disable-next-line no-await-in-loop
        await E(powers).remove(RELEASED_GUESTS, petName);
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

  const guests = makeRootGuestParticipant(powers);
  await guests.purgeReleased();

  const factory = await makeAgentFactory({
    journal: makeSnapshotJournal({ powers, prefix: 'agent-factory-v1-' }),
    registry: retainedByName(registryName, [
      'directoryFor',
      'useFor',
      'inferenceFor',
      'revokeGrant',
      'listGrants',
    ]),
    guests,
    inventory: makeOwnerInventoryParticipant(powers),
    responders: retainedByName(responderName, [
      'has',
      'provide',
      'setPaused',
      'describe',
      'retry',
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
