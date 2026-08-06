/** @import {TestRoutine} from '../_types.js'; */

/** @type {TestRoutine} */
export const section = async (execa, testLine) => {
  await testLine(execa`endo run typescript-runlet.ts a b c`, {
    stdout: 'TypeScript confined: a, b, c',
  });
};
