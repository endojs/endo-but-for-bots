// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { M } from '@endo/patterns';

/** @import { RemotableObject } from '@endo/pass-style' */

/**
 * A native worker that receives only the owner facade, passive snapshots, and
 * session forwarding facets. It never looks up a disposable formula capability.
 * The alternate client role is minted in a different worker with only audit
 * powers; its send method uses the actual hosted PassableReader protocol.
 * @param {any} powers
 * @param {unknown} _context
 * @param {{env?: Record<string, string>}} [options]
 */
export const make = async (powers, _context, { env = {} } = {}) => {
  if (env.ROLE === 'client') {
    const label = env.LABEL;
    return makeExo(
      'SessionOwnerTestClient',
      M.interface('SessionOwnerTestClient', {
        send: M.callWhen(M.string(), M.record()).returns(M.remotable()),
        interrupt: M.callWhen().returns(M.undefined()),
        status: M.callWhen().returns(M.string()),
        terminate: M.callWhen().returns(M.undefined()),
        destroy: M.callWhen().returns(M.undefined()),
      }),
      {
        // The real client accepts per-turn options; this fixture ignores them.
        send: async (text, options) => {
          const reader = readerFromIterator(
            harden([{ type: 'text', text: `${label}:${text}` }]),
          );
          return /** @type {typeof reader & RemotableObject} */ (reader);
        },
        interrupt: () => E(powers).writeText(`interrupted-${label}`, 'yes'),
        status: async () => `ready-${label}`,
        terminate: () => E(powers).writeText(`stopped-${label}`, 'yes'),
        destroy: () => E(powers).writeText(`destroyed-${label}`, 'yes'),
      },
    );
  }
  const owner = await E(powers).provideSessionOwner(['owned-sessions']);
  return makeExo(
    'SessionOwnerProbe',
    M.interface('SessionOwnerProbe', {
      create: M.callWhen(M.string(), M.string(), M.record()).returns(M.any()),
      inspect: M.callWhen(M.string()).returns(M.any()),
      revise: M.callWhen(M.string(), M.string()).returns(M.undefined()),
      client: M.callWhen(M.string()).returns(M.any()),
      stop: M.callWhen(M.string()).returns(M.undefined()),
      remove: M.callWhen(M.string()).returns(M.undefined()),
      ping: M.call().returns(M.string()),
    }),
    {
      create: (name, plan, references) =>
        E(owner).create(name, plan, references),
      inspect: name => E(owner).inspect(name),
      revise: (name, plan) => E(owner).revise(name, plan),
      client: name => E(owner).client(name),
      stop: name => E(owner).stop(name),
      remove: name => E(owner).remove(name),
      ping: () => 'alive',
    },
  );
};
harden(make);
