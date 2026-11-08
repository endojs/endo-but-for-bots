// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
// eslint-disable-next-line import/no-relative-packages -- Test-only model discovery.
import { makeTestInference } from '../../floot/test/_inference.js';

/**
 * Real daemon storage, with inert inference and one injected remove failure.
 * @param {any} host
 */
export const make = host => {
  let fault;
  const { catalog } = makeTestInference(() => 'journal evidence');
  return Far('JournalRetirementPowers', {
    list: (...args) => E(host).list(...args),
    createDirectory: (...args) => E(host).createDirectory(...args),
    has: (name, ...rest) =>
      name === 'codex-model-catalog' || E(host).has(name, ...rest),
    lookup: (name, ...rest) =>
      name === 'codex-model-catalog' ? catalog : E(host).lookup(name, ...rest),
    locate: (...args) => E(host).locate(...args),
    copy: (...args) => E(host).copy(...args),
    provideGuest: (...args) => E(host).provideGuest(...args),
    storeValue: (...args) => E(host).storeValue(...args),
    armRemoval: (prefix, kind, after) => {
      fault = { prefix, kind, after };
    },
    remove: async (...names) => {
      const hit = fault && names.join('/') === fault.prefix;
      const after = fault?.after;
      if (hit) fault = undefined;
      if (hit && !after) throw Error('Injected journal removal failure');
      await E(host).remove(...names);
      if (hit) throw Error('Injected journal removal acknowledgement lost');
    },
  });
};
harden(make);
