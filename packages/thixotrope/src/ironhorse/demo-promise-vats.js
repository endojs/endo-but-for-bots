// @ts-check
import harden from '@endo/harden';

export const producerSource = `
(() => {
  let resolve;
  return Far('PromiseProducer', {
    makePromise: () => {
      const promise = new Promise(r => { resolve = r; });
      return harden({ promise });
    },
    resolve: value => {
      resolve(value);
      return 'resolved';
    },
  });
})()
`;
harden(producerSource);

export const listenerSource = `
(() => {
  let promise;
  let result = harden({ settled: false });
  return Far('PromiseListener', {
    listen: async () => {
      ({ promise } = await E(producer).makePromise());
      result = harden({ settled: false });
      promise.then(value => { result = harden({ settled: true, value }); });
      return 'listening';
    },
    resolve: value => E(producer).resolve(value),
    read: () => result,
  });
})()
`;
harden(listenerSource);
