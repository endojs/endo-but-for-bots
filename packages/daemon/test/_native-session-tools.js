// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

/** @param {null | Promise<null>} powers */
export const make = async powers => {
  if ((await powers) !== null) throw Error('Unexpected constructor authority');
  let identity = 'inert';
  return Far('NativeToolBindingFixture', {
    activate: async (_plan, dependencies) => {
      const tools = await E(dependencies).get('tools');
      identity = (await E(tools).describe()).toolSetId;
    },
    status: async () => identity,
    interrupt: async () => {},
    terminate: async () => {
      identity = 'stopped';
    },
  });
};
harden(make);
