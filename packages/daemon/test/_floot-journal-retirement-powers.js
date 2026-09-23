// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

/**
 * Real daemon storage, with inert inference and one injected remove failure.
 * @param {any} host
 */
export const make = host => {
  let fault;
  const backend = Far('JournalTestBackend', {
    describe: () =>
      harden({
        id: 'test',
        title: 'Test',
        kind: 'hosted',
        continuity: 'explicit',
        toolOwnership: 'endo',
      }),
    modelCatalog: () =>
      harden({
        accounts: [
          {
            subscriptionId: 'default',
            state: 'current',
            observedAt: 1,
            models: [
              {
                id: 'm',
                title: 'Model',
                description: '',
                default: true,
                defaultReasoningEffort: null,
                reasoningEfforts: [],
              },
            ],
          },
        ],
      }),
    create: () =>
      harden({
        run: Far('JournalTestRun', {
          send: () => {
            const stream = makeBufferedReader();
            stream.push(
              harden({ type: 'text-delta', text: 'journal evidence' }),
            );
            stream.push(harden({ type: 'end' }));
            return stream.reader;
          },
          interrupt: () => undefined,
          acknowledge: () => undefined,
        }),
        admin: Far('JournalTestAdmin', { terminate: () => undefined }),
      }),
    stop: () => undefined,
    destroy: () => undefined,
  });
  return Far('JournalRetirementPowers', {
    list: (...args) => E(host).list(...args),
    has: name => name === 'codex-backend' || E(host).has(name),
    lookup: name => (name === 'codex-backend' ? backend : E(host).lookup(name)),
    locate: (...args) => E(host).locate(...args),
    copy: (...args) => E(host).copy(...args),
    provideGuest: (...args) => E(host).provideGuest(...args),
    storeValue: (...args) => E(host).storeValue(...args),
    armRemoval: (prefix, kind, after) => {
      fault = { prefix, kind, after };
    },
    remove: async name => {
      const hit =
        fault &&
        name.startsWith(fault.prefix) &&
        (fault.kind === 'schema'
          ? name.endsWith('-schema')
          : name.includes('-floot-turn-'));
      const after = fault?.after;
      if (hit) fault = undefined;
      if (hit && !after) throw Error('Injected journal removal failure');
      await E(host).remove(name);
      if (hit) throw Error('Injected journal removal acknowledgement lost');
    },
  });
};
harden(make);
