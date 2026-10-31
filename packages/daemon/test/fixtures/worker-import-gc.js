// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

import { makeCollector } from './worker-import-gc-collect.js';

/** @param {any} powersP */
export const make = async powersP => {
  const powers = await powersP;
  const collect = makeCollector();
  /** @type {WeakRef<object>[]} */
  const produced = [];
  return Far('WorkerImportGcProbe', {
    async consume() {
      await null;
      for (let i = 0; i < 32; i += 1) {
        // Deliberately discard both copy-data replies and temporary caps.
        // eslint-disable-next-line no-await-in-loop
        await E(powers).read();
        // eslint-disable-next-line no-await-in-loop
        await E(powers).fresh();
      }
      await collect();
      await collect();
    },
    read() {
      const result = harden({ payload: 'x'.repeat(8192) });
      produced.push(new WeakRef(result));
      return result;
    },
    fresh() {
      const result = Far('TemporaryWorkerCapability', { ping: () => 'worker' });
      produced.push(new WeakRef(result));
      return result;
    },
    async retained() {
      await collect();
      await collect();
      return produced.filter(ref => ref.deref() !== undefined).length;
    },
    ping: () => E(powers).ping(),
  });
};
harden(make);
