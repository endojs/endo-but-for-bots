// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

/** @param {any} host */
export const make = host => {
  let armed = false;
  let failWrite = false;
  let entered;
  let release;
  const writing = new Promise(resolve => {
    entered = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  return Far('FactoryLifecyclePowers', {
    list: (...args) => E(host).list(...args),
    has: (...args) => E(host).has(...args),
    lookup: (...args) => E(host).lookup(...args),
    locate: (...args) => E(host).locate(...args),
    copy: (...args) => E(host).copy(...args),
    createDirectory: (...args) => E(host).createDirectory(...args),
    provideGuest: (...args) => E(host).provideGuest(...args),
    remove: (...args) => E(host).remove(...args),
    storeValue: async (value, name) => {
      let fail = false;
      if (armed) {
        armed = false;
        fail = failWrite;
        entered();
        await gate;
      }
      await E(host).storeValue(value, name);
      if (fail) throw Error('Injected lost write acknowledgement');
    },
    arm: (fail = false) => {
      armed = true;
      failWrite = fail;
    },
    writing: () => writing,
    release: () => release(),
  });
};
harden(make);
