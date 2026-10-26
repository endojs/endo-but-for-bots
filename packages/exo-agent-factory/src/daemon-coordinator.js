// @ts-check

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q } from '@endo/errors';

import { makeChildAgentCoordinator } from './coordinator.js';
import { makeDaemonPrivateHost } from './daemon-host.js';

/**
 * The pet name under which the coordinator's own formula is bound in its
 * private directory. Every durable facet formula names it as its only
 * endowment.
 */
export const SELF_NAME = 'coordinator';
harden(SELF_NAME);

/** The root facet's name in the private directory. */
export const ROOT_NAME = 'root';
harden(ROOT_NAME);

const facetName = (/** @type {number} */ nsId) => `ns${nsId}.facet`;

export const ChildAgentCoordinatorInterface = M.interface(
  'ChildAgentCoordinator',
  {
    root: M.callWhen().returns(M.remotable('ChildAgentFactory')),
    boundFacet: M.callWhen(M.number()).returns(
      M.remotable('BoundChildAgentFactory'),
    ),
    lifecycleFor: M.callWhen(M.string()).returns(M.remotable('AgentLifecycle')),
    faults: M.callWhen().returns(M.record()),
  },
);

/**
 * The coordinator caplet. The deploying host formulates it with
 * `makeUnconfined('@main', specifier, { powersName: 'agent-factory' })` and
 * pins it in its own `@pins`, so the daemon revives it at start.
 *
 * `make` returns before replay. A facet formula's source calls back into this
 * object, and the daemon evaluates such formulas during reconciliation (a
 * lifecycle facet written by a rolled-forward operation) and while starting
 * runners (a runner resolving its lifecycle facet). Waiting for either
 * inside `make` would wait on itself.
 *
 * @param {any} powers - The `agent-factory` child host.
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (powers, _context, { env = {} } = {}) => {
  const rootPolicy = JSON.parse(env.ENDO_AGENT_FACTORY_POLICY || '{}');

  /**
   * @param {string} source
   * @param {string | string[]} resultName
   */
  const evaluateFacet = (source, resultName) =>
    E(powers).evaluate(
      '@main',
      source,
      ['coordinator'],
      [SELF_NAME],
      resultName,
    );

  const host = makeDaemonPrivateHost(powers);
  const coordinator = makeChildAgentCoordinator({
    host,
    rootPolicy,
    formulateLifecycle: async (opKey, path) => {
      await evaluateFacet(
        `E(coordinator).lifecycleFor(${JSON.stringify(opKey)})`,
        path,
      );
    },
    formulateBoundFacet: async nsId => {
      await null;
      const name = facetName(nsId);
      if (await E(host).has(name)) {
        const type = await E(host).formulaType(name);
        if (!(type === 'eval')) {
          throw makeError(
            `Derived name ${q(name)} holds a ${q(type)}, expected "eval"`,
          );
        }
      } else {
        await evaluateFacet(`E(coordinator).boundFacet(${nsId})`, name);
      }
      return E(host).lookup(name);
    },
  });
  coordinator.runnersStarted.catch(error => {
    console.error('Child-agent coordinator could not start a runner', error);
  });

  return makeExo('ChildAgentCoordinator', ChildAgentCoordinatorInterface, {
    async root() {
      await coordinator.replayed;
      return coordinator.rootFacet;
    },
    /** @param {number} nsId */
    async boundFacet(nsId) {
      await coordinator.replayed;
      return coordinator.boundFacet(nsId);
    },
    /** @param {string} opKey */
    async lifecycleFor(opKey) {
      await coordinator.replayed;
      return coordinator.lifecycle(opKey);
    },
    async faults() {
      await coordinator.ready;
      return coordinator.faults();
    },
  });
};
harden(make);
