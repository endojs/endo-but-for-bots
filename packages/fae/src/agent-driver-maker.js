// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { AgentDriverMakerInterface } from '@endo/exo-agent-factory';

/**
 * Make the descriptor adapter for Fae's landed driver module.
 *
 * The adapter installs only the child, the configured provider, and an
 * explicitly endowed subagent spawner into the private driver guest. It never
 * gives the Fae child an `EndoHost`.
 *
 * @param {object} options
 * @param {any} options.provider
 * @param {any} [options.authSecret]
 * @param {string} [options.driverSpecifier]
 * @param {string} [options.systemPrompt]
 * @param {Record<string, string>} [options.environment]
 */
export const makeFaeAgentDriverMaker = ({
  provider,
  authSecret,
  driverSpecifier = new URL('../driver.js', import.meta.url).href,
  systemPrompt,
  environment = {},
}) =>
  makeExo('FaeAgentDriverMaker', AgentDriverMakerInterface, {
    /**
     * @param {{ agent: any, driverGuest: any, instructions?: string }} context
     */
    async installDriver({ agent, driverGuest, instructions }) {
      await E(driverGuest).storeValue(agent, 'agent');
      await E(driverGuest).storeValue(provider, 'llm-provider');
      if (authSecret !== undefined) {
        await E(driverGuest).storeValue(authSecret, 'llm-auth-secret');
      }
      if (await E(agent).has('subagent-spawner')) {
        const spawner = await E(agent).lookup('subagent-spawner');
        await E(driverGuest).storeValue(spawner, 'subagent-spawner');
      }
      const driverEnvironment = harden({
        ...environment,
        ...(systemPrompt ? { FAE_SYSTEM_PROMPT: systemPrompt } : {}),
        ...(instructions ? { FAE_SUBAGENT_PROMPT: instructions } : {}),
      });
      return harden({
        specifier: driverSpecifier,
        ...(Object.keys(driverEnvironment).length > 0
          ? { env: driverEnvironment }
          : {}),
      });
    },
  });
harden(makeFaeAgentDriverMaker);
