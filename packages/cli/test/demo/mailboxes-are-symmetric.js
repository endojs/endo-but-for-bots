/** @import {TestRoutine} from '../_types.js' */

/** @type {TestRoutine} */
export const section = async (execa, testLine) => {
  // Guests can also send their host messages...
  await testLine(
    execa`endo send @host --as alice-agent ${'This is the @doubler you sent me.'}`,
  );
  // The host's own resolve and send commands from earlier sections hold
  // messages 1 through 6, interleaved with its sent messages.
  await testLine(execa`endo inbox`, {
    stdout: /7\. "alice" sent "This is the @doubler you sent me\."/,
  });
  await testLine(execa`endo adopt 7 doubler --name doubler-from-alice`);
  await testLine(execa`endo dismiss 7`);
  await testLine(execa`endo inbox`, {
    stdout: /^(?!7\. "alice" sent "This is the @doubler you sent me\.").*/,
  });
};
