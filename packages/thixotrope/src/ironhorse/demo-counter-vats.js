// @ts-check
import harden from '@endo/harden';

export const counterSource = `
(() => {
  let count = 0n;
  return Far('Counter', {
    incr: () => ++count,
    read: () => count,
  });
})()
`;
harden(counterSource);

export const callerSource = `
Far('CounterCaller', {
  incr: () => E(counter).incr(),
  read: () => E(counter).read(),
})
`;
harden(callerSource);
