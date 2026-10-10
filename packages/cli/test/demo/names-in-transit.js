/** @import {Context, TestRoutine} from '../_types.js' */

/** @type {TestRoutine} */
export const section = async (execa, testLine) => {
  // In this example, we send alice our "doubler" but let it appear...
  await testLine(
    execa`endo send alice ${'Please enjoy this @counter:doubler.'}`,
  );
  await testLine(execa`endo inbox --as alice-agent`, {
    // Messages 1 through 4 are alice's own record of the adopt and dismiss
    // commands from the previous section and of their results.
    stdout: /^5\. "@host" sent "Please enjoy this @counter\."/m,
  });
  await testLine(execa`endo adopt --as alice-agent 5 counter --name redoubler`);
  await testLine(execa`endo list alice-agent`, {
    stdout: /redoubler/,
  });
  await testLine(execa`endo dismiss --as alice-agent 5`);
};

/** @type {Context} */
export const context = {
  setup: async execa => {
    await execa`endo send alice ${'Please enjoy this @counter:doubler.'}`;
    await execa`endo inbox --as alice-agent`;
    await execa`endo adopt --as alice-agent 5 counter --name redoubler`;
    await execa`endo dismiss --as alice-agent 5`;
  },
};
