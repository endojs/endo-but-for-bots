// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

/** @param {any} host */
export const make = host => {
  let armed = false;
  let failWrite = false;
  let entered;
  let release;
  const writing = new Promise(resolve => {
    entered = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let nativeEnabled = false;
  const guests = new Map();
  let terminated = 0;
  const backend = Far('LifecycleBackend', {
    describe: () =>
      harden({
        id: 'test',
        title: 'Test',
        kind: 'hosted',
        continuity: 'explicit',
        toolOwnership: 'endo',
      }),
    listModels: () =>
      harden([
        {
          id: 'm',
          title: 'Model',
          description: '',
          default: true,
          defaultReasoningEffort: null,
          reasoningEfforts: [],
        },
      ]),
    create: async () => {
      entered();
      await gate;
      return harden({
        run: Far('LifecycleRun', {
          send: () => {
            throw Error('Disposed native session must not send');
          },
          interrupt: () => undefined,
          acknowledge: () => undefined,
        }),
        admin: Far('LifecycleAdmin', {
          terminate: () => {
            terminated += 1;
          },
        }),
      });
    },
    destroy: () => undefined,
    stop: () => undefined,
  });
  return Far('FactoryLifecyclePowers', {
    list: (...args) => E(host).list(...args),
    has: (...args) =>
      guests.has(args[0]) || (nativeEnabled && args[0] === 'codex-backend')
        ? true
        : E(host).has(...args),
    lookup: (...args) =>
      guests.has(args[0])
        ? guests.get(args[0])
        : nativeEnabled && args[0] === 'codex-backend'
          ? backend
          : E(host).lookup(...args),
    locate: (...args) => E(host).locate(...args),
    copy: (...args) => E(host).copy(...args),
    provideGuest: (...args) => {
      if (!nativeEnabled) return E(host).provideGuest(...args);
      const { agentName } = args[1];
      if (guests.has(agentName)) return undefined;
      const store = new Map([['user', harden({})]]);
      guests.set(
        agentName,
        Far('LifecycleGuest', {
          has: name => store.has(name),
          lookup: name => store.get(name),
          storeValue: (value, name) => {
            store.set(name, value);
          },
          remove: name => {
            store.delete(name);
          },
          list: prefix => harden(prefix === 'tools' ? [] : [...store.keys()]),
          locate: () => 'test-locator',
          followMessages: () => makeBufferedReader().reader,
        }),
      );
      return undefined;
    },
    remove: (...args) =>
      guests.delete(args[0]) ? undefined : E(host).remove(...args),
    storeValue: async (value, name) => {
      let fail = false;
      if (armed) {
        armed = false;
        fail = failWrite;
        entered();
        await gate;
      }
      await E(host).storeValue(value, name);
      if (fail) throw Error('Injected lost write acknowledgement');
    },
    arm: (fail = false) => {
      armed = true;
      failWrite = fail;
    },
    writing: () => writing,
    enableNative: () => {
      nativeEnabled = true;
    },
    terminated: () => terminated,
    release: () => release(),
  });
};
harden(make);
