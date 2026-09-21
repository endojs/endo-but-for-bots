// @ts-check

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * Generic formula fixture: retain the exact capability slots in stored powers,
 * independent of any hosted-agent provisioning API.
 * @param {any} powers
 */
export const make = async powers => {
  const { sandboxFactory, fsMounter, filesystem, stateProvider } = await powers;
  return makeExo(
    'DependencyBundle',
    M.interface('DependencyBundle', {
      sandboxFactory: M.call().returns(M.any()),
      fsMounter: M.call().returns(M.any()),
      filesystem: M.call().returns(M.any()),
      stateProvider: M.call().returns(M.any()),
    }),
    {
      sandboxFactory: () => sandboxFactory,
      fsMounter: () => fsMounter,
      filesystem: () => filesystem,
      stateProvider: () => stateProvider,
    },
  );
};
harden(make);
