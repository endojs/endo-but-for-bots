/** @import {TestRoutine} from '../_types.js'; */

/** @type {TestRoutine} */
export const section = async (execa, testLine) => {
  // `endo make` accepts a TypeScript source, strips its types, and makes a
  // confined worklet from the erased JavaScript.
  await testLine(execa`endo make typescript-counter.ts --name ts-counter`, {
    stdout: 'Object [Alleged: Counter] {}',
  });
  await testLine(execa`endo eval E(ts-counter).incr() ts-counter`, {
    stdout: '1',
  });

  // `endo archive` builds a source-only ZIP from a TypeScript program...
  await testLine(execa`endo archive typescript-runlet.ts --name ts-archive`, {
    stdout: /^\d+ bytes$/,
  });
  // ...which `endo run --archive` can then execute.
  await testLine(execa`endo run --archive ts-archive a b c`, {
    stdout: 'TypeScript confined: a, b, c',
  });
};
