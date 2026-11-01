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

const facetName = (/** @type {number} */ namespaceId) =>
  `ns${namespaceId}.facet`;

/**
 * The pinned caplet's surface. `boundFacet` and `lifecycleFor` wait for
 * replay and then answer through the coordinator's own
 * `ChildAgentCoordinator` facet, so a durable facet formula gets the same
 * fail-closed re-derivation the coordinator defines.
 */
export const ChildAgentCoordinatorCapletInterface = M.interface(
  'ChildAgentCoordinatorCaplet',
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
    formulateLifecycle: async (operationKey, path) => {
      await evaluateFacet(
        `E(coordinator).lifecycleFor(${JSON.stringify(operationKey)})`,
        path,
      );
    },
    formulateBoundFacet: async namespaceId => {
      await null;
      const name = facetName(namespaceId);
      if (await E(host).has(name)) {
        const type = await E(host).formulaType(name);
        if (!(type === 'eval')) {
          throw makeError(
            `Derived name ${q(name)} holds a ${q(type)}, expected "eval"`,
          );
        }
      } else {
        await evaluateFacet(`E(coordinator).boundFacet(${namespaceId})`, name);
      }
      return E(host).lookup(name);
    },
  });
  coordinator.runnersStarted.catch(error => {
    console.error('Child-agent coordinator could not start a runner', error);
  });

  return makeExo(
    'ChildAgentCoordinatorCaplet',
    ChildAgentCoordinatorCapletInterface,
    {
      async root() {
        await coordinator.replayed;
        return coordinator.rootFacet;
      },
      /** @param {number} namespaceId */
      async boundFacet(namespaceId) {
        await coordinator.replayed;
        return coordinator.coordinatorFacet.boundFacet(namespaceId);
      },
      /** @param {string} operationKey */
      async lifecycleFor(operationKey) {
        await coordinator.replayed;
        return coordinator.coordinatorFacet.lifecycleFor(operationKey);
      },
      async faults() {
        await coordinator.ready;
        return coordinator.faults();
      },
    },
  );
};
harden(make);
