// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeAccountReadingSource } from '@endo/hosted-agent/account-source.js';

/** @param {any} host */
export const make = host => {
  let entered = () => {};
  let release = () => {};
  const gate = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  const writing = new Promise(resolve => {
    entered = () => resolve(undefined);
  });
  const old = makeAccountReadingSource();
  let source = old;
  let armed = false;
  let failWrite = false;
  let writes = 0;
  return Far('OracleLifecyclePowers', {
    has: name => name === 'account-source' || E(host).has(name),
    lookup: name =>
      name === 'account-source' ? source.source : E(host).lookup(name),
    list: () => E(host).list(),
    remove: name => E(host).remove(name),
    storeValue: async (value, name) => {
      if (armed) {
        armed = false;
        entered();
        await gate;
      }
      await E(host).storeValue(value, name);
      writes += 1;
      if (failWrite) throw Error('lost oracle journal acknowledgement');
    },
    arm: fails => {
      armed = true;
      failWrite = fails;
    },
    writing: () => writing,
    release: () => release(),
    writes: () => writes,
    swapSource: () => {
      source = makeAccountReadingSource();
    },
    pushOld: usedPercent =>
      old.accept(
        harden({
          rateLimits: {
            windows: [
              {
                windowId: 'weekly',
                title: 'Weekly',
                usedPercent,
                resetsAt: '2030-01-01T00:00:00.000Z',
              },
            ],
            limitReached: false,
          },
        }),
      ),
  });
};
harden(make);
