// @ts-check

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const StandInResponderInterface = M.interface('StandInResponderLauncher', {
  has: M.callWhen(M.string()).returns(M.boolean()),
  provide: M.callWhen(M.record()).returns(M.undefined()),
  setPaused: M.callWhen(M.string(), M.boolean())
    .optional(M.opt(M.string()))
    .returns(M.undefined()),
  remove: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  describe: M.callWhen().returns(M.arrayOf(M.record())),
});

/**
 * Records what the factory asks of a responder. The real one, which follows
 * mail, arrives with the pinned-responder phase.
 */
export const make = async () => {
  /** @type {Map<string, any>} */
  const responders = new Map();
  return makeExo('StandInResponderLauncher', StandInResponderInterface, {
    has: async name => responders.has(name),
    provide: async ({ name, startAfter }) => {
      if (!responders.has(name)) {
        responders.set(
          name,
          harden({
            name,
            paused: true,
            ...(startAfter === undefined ? {} : { startAfter }),
          }),
        );
      }
    },
    setPaused: async (name, paused, startAfter) => {
      responders.set(
        name,
        harden({
          name,
          paused,
          ...(startAfter === undefined ? {} : { startAfter }),
        }),
      );
    },
    remove: async (_guestName, name) => {
      responders.delete(name);
    },
    describe: async () => harden([...responders.values()]),
  });
};
harden(make);
