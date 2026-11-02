// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

/** @param {null | Promise<null>} powers */
export const make = async powers => {
  if ((await powers) !== null)
    throw Error('Controller constructor received authority');
  let ready = false;
  return Far('NativeSessionControllerFixture', {
    activate: async (plan, dependencies) => {
      const dependency = await E(dependencies).get('dependency');
      const audit = await E(dependencies).get('audit');
      await E(audit).writeText(`activated-${plan}`, await E(dependency).ping());
      ready = true;
    },
    send: async text => {
      if (!ready) throw Error('Controller is inert');
      return readerFromIterator(harden([{ type: 'text', text }]));
    },
    status: async () => (ready ? 'ready' : 'inert'),
    interrupt: async () => {},
    terminate: async (plan, dependencies) => {
      ready = false;
      const audit = await E(dependencies).get('audit');
      await E(audit).writeText(`stopped-${plan}`, 'yes');
    },
  });
};
harden(make);
