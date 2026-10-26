// @ts-check

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';

import { ROOT_NAME, SELF_NAME } from './daemon-coordinator.js';

/**
 * @import { ChildAgentPolicy } from './policy.js'
 */

/** The coordinator caplet's module specifier. */
export const coordinatorSpecifier = new URL(
  './daemon-coordinator.js',
  import.meta.url,
).href;
harden(coordinatorSpecifier);

/**
 * Install the child-agent factory in a deploying host, idempotently, and
 * return its root `ChildAgentFactory` facet.
 *
 * Creates the dedicated `agent-factory` child host, formulates the
 * coordinator with that host as its powers, pins the coordinator in the
 * deploying host's `@pins` so the daemon revives it at start, and formulates
 * the root facet as an `evaluate` over the coordinator. Every step checks its
 * name first, so re-running converges.
 *
 * @param {any} host - The deploying host's `EndoHost`.
 * @param {object} options
 * @param {ChildAgentPolicy} options.rootPolicy - Read only on first install;
 *   the coordinator's journal is authoritative afterward.
 * @param {string} [options.name] - Pet name of the child host and its pin.
 * @param {string} [options.specifier]
 */
export const installChildAgentFactory = async (
  host,
  { rootPolicy, name = 'agent-factory', specifier = coordinatorSpecifier },
) => {
  await null;
  if (!(await E(host).has(name))) {
    await E(host).provideHost(undefined, { agentName: name });
  }
  if (!(await E(host).has(name, SELF_NAME))) {
    await E(host).makeUnconfined('@main', specifier, {
      powersName: name,
      resultName: [name, SELF_NAME],
      env: { ENDO_AGENT_FACTORY_POLICY: JSON.stringify(rootPolicy) },
    });
  }
  if (!(await E(host).has('@pins', name))) {
    await E(host).copy([name, SELF_NAME], ['@pins', name]);
  }
  if (!(await E(host).has(name, ROOT_NAME))) {
    await E(host).evaluate(
      '@main',
      'E(coordinator).root()',
      ['coordinator'],
      [[name, SELF_NAME]],
      [name, ROOT_NAME],
    );
  }
  return E(host).lookup([name, ROOT_NAME]);
};
harden(installChildAgentFactory);
