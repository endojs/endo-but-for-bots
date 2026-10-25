// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/** Model-free helper factory fixture: real guest capabilities and locators. */
/** @param {any} powers */
export const make = powers =>
  makeExo(
    'TestHelperFactory',
    M.interface('TestHelperFactory', {
      createAgentCapability: M.call(M.string(), M.record()).returns(
        M.promise(),
      ),
    }),
    {
      async createAgentCapability(name, _options) {
        const profileName = `${name}-guest`;
        const agent = await E(powers).provideGuest(
          `${name}-handle`,
          harden({ agentName: profileName }),
        );
        const locator = await E(powers).locate(profileName);
        await E(powers).storeValue(profileName, 'test-last-helper');
        return harden({ profileName, locator, agent });
      },
    },
  );
harden(make);
