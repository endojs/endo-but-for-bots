// @ts-check

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { makeChildAgentSpawner } from '@endo/exo-agent-factory';

import {
  SubagentSpawnerInterface,
  assertSubagentCapabilities,
  assertSubagentName,
} from './subagent.js';

/** @import { SubagentCapability } from './subagent.js' */

/**
 * Preserve Fae's `SubagentSpawner` surface over a bound child-agent factory.
 * The adapter holds no `EndoHost`. Its only powers are the recursive spawner
 * and a narrow handle-to-locator adapter supplied by the deployment.
 *
 * @param {object} options
 * @param {any} options.factory
 * @param {(handle: any) => string | Promise<string>} options.locateHandle
 */
export const makeSubagentSpawnerAdapter = ({ factory, locateHandle }) => {
  /** @param {any} childSpawner */
  const adapt = childSpawner => makeAdapter(childSpawner);

  /** @param {any} childSpawner */
  const makeAdapter = childSpawner =>
    makeExo('SubagentSpawner', SubagentSpawnerInterface, {
      /**
       * @param {string} name
       * @param {{ systemPrompt?: string, capabilities?: SubagentCapability[] }} [options]
       */
      async spawn(name, options = {}) {
        assertSubagentName(name);
        const { systemPrompt, capabilities = [] } = options;
        assertSubagentCapabilities(capabilities);
        const endowments = Object.fromEntries(
          capabilities.map(({ name: capabilityName, value }) => [
            capabilityName,
            value,
          ]),
        );
        !('subagent-spawner' in endowments) ||
          Fail`Subagent capability name ${q('subagent-spawner')} is reserved`;
        const { handle } = await E(childSpawner).spawn(
          name,
          harden({
            ...(systemPrompt ? { instructions: systemPrompt } : {}),
            ...(capabilities.length > 0 ? { endowments } : {}),
          }),
        );
        const locator = await locateHandle(handle);
        return harden({ name, locator });
      },

      /** @param {string} name */
      stop(name) {
        assertSubagentName(name);
        return E(childSpawner).stop(name);
      },

      list() {
        return E(childSpawner).list();
      },

      /** @param {string} [methodName] */
      help(methodName) {
        if (methodName === 'spawn') {
          return 'spawn(name, { systemPrompt?, capabilities?: [{ name, value }] }) - Create a child with only the listed capabilities.';
        }
        if (methodName === 'stop') {
          return 'stop(name) - Revoke the child namespace and every descendant.';
        }
        if (methodName === 'list') {
          return "list() - Names of this agent's live subagents.";
        }
        return 'Subagent spawner: create, list, and release child agents.';
      },
    });

  const spawner = makeChildAgentSpawner({
    factory,
    spawnerEndowmentName: 'subagent-spawner',
    makeSpawnerEndowment: adapt,
  });
  return makeAdapter(spawner);
};
harden(makeSubagentSpawnerAdapter);
