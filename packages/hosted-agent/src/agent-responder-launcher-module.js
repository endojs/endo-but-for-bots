// @ts-check

/* global setTimeout, clearTimeout */

import { E } from '@endo/eventual-send';
import { Fail, makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

const AgentResponderLauncherInterface = M.interface('AgentResponderLauncher', {
  has: M.callWhen(M.string()).returns(M.boolean()),
  provide: M.callWhen(M.record()).returns(M.undefined()),
  setPaused: M.callWhen(M.string(), M.boolean())
    .optional(M.opt(M.string()))
    .returns(M.undefined()),
  describe: M.callWhen(M.string()).returns(M.record()),
  retry: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  remove: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  register: M.call(M.string(), M.remotable()).returns(M.undefined()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(AgentResponderLauncherInterface);

const WORKERS = 'agent-responder-workers';
const RESPONDERS = 'agent-responders';
const POWERS = 'agent-responder-powers';
const ENDOWMENTS = 'agent-responder-endowments';
const ENDOWMENT_POWERS = 'agent-responder-endowment-powers';
const PROVISIONERS = 'agent-responder-provisioners';
const DIRECTORIES = harden([
  PROVISIONERS,
  RESPONDERS,
  POWERS,
  ENDOWMENTS,
  ENDOWMENT_POWERS,
  WORKERS,
]);

const REGISTRATION_TIMEOUT_MS = 60_000;

const PROVISIONER_SPECIFIER = new URL(
  './agent-responder-provisioner-module.js',
  import.meta.url,
).href;

/**
 * Root-private launcher of one pinned responder per agent. Every effect is
 * keyed by the factory's preallocated responder name, so `provide` and `remove`
 * can repeat after a crash. A dedicated worker makes `remove` a cancellation:
 * ending the worker ends any turn running in it.
 *
 * The daemon terminates any worker holding a reference to a formula it collects,
 * and every per-agent formula is eventually collected. This launcher therefore
 * never receives one. A provisioner caplet in the agent's own worker formulates
 * them and returns plain data, names are reached by path from the root, and each
 * responder registers a control object, which is not a formula.
 *
 * Its env names the retained `AGENT_RESPONDER_FACTORY`, this launcher's own
 * `AGENT_RESPONDER_SELF`, and the entry point of each harness
 * (`AGENT_RESPONDER_SPECIFIER_LAL`, `AGENT_RESPONDER_SPECIFIER_FAE`), since
 * `@endo/lal` and `@endo/fae` depend on this package and not the reverse.
 *
 * @param {any} powers Root host.
 * @param {any} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, _context, { env = {} } = {}) => {
  const factoryName =
    env.AGENT_RESPONDER_FACTORY ||
    Fail`Responder launcher has no agent factory`;
  const selfName =
    env.AGENT_RESPONDER_SELF || Fail`Responder launcher has no pet name`;
  await null;
  /** @type {Map<string, ReturnType<typeof makePromiseKit<any>>>} */
  const controls = new Map();

  /** @param {string} harness */
  const specifierFor = harness => {
    const specifier = env[`AGENT_RESPONDER_SPECIFIER_${harness.toUpperCase()}`];
    if (!specifier) {
      throw makeError(X`Agent operation failed: ${q('invalid-harness')}`);
    }
    return specifier;
  };

  /** @param {string[]} path */
  const has = path => E(powers).has(...path);

  /** @param {string} name */
  const stateDirectoryOf = name => `${name}-state`;

  /** @param {string} name */
  const controlKit = name => {
    let kit = controls.get(name);
    if (kit === undefined) {
      kit = makePromiseKit();
      controls.set(name, kit);
    }
    return kit;
  };

  /**
   * A live responder registers on making, including when the daemon revives its
   * pin, so waiting is only for that to finish.
   *
   * @param {string} name
   */
  const controlOf = name => {
    /** @type {any} */
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(Error(`Responder ${name} has not registered`)),
        REGISTRATION_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    return Promise.race([controlKit(name).promise, timeout]).finally(() =>
      clearTimeout(timer),
    );
  };

  /** @param {string} name */
  const isPinned = async name => {
    await null;
    return (
      (await has([RESPONDERS])) &&
      (await has([RESPONDERS, name])) &&
      (await has([POWERS, name, 'guest'])) &&
      (await has(['@pins', name])) &&
      /** @type {boolean} */ (await has([POWERS, name, 'guest', '@pins', name]))
    );
  };

  /**
   * @param {{ name: string, guestName: string, agentId: string, harness: string }} request
   */
  const provide = async ({ name, guestName, agentId, harness }) => {
    await null;
    if (await isPinned(name)) return;
    for (const directory of DIRECTORIES) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await has([directory]))) {
        // eslint-disable-next-line no-await-in-loop
        await E(powers).makeDirectory(directory);
      }
    }
    // An interrupted attempt left its name behind; its steps are repeatable.
    if (await has([PROVISIONERS, name])) {
      await E(powers).remove(PROVISIONERS, name);
    }
    // Naming an unbound worker path creates the worker without returning it.
    await E(powers).makeUnconfined([WORKERS, name], PROVISIONER_SPECIFIER, {
      powersName: '@agent',
      resultName: [PROVISIONERS, name],
      env: {
        ...(env.AGENT_RESPONDER_INITIAL_BACKOFF_MS === undefined
          ? {}
          : {
              AGENT_RESPONDER_INITIAL_BACKOFF_MS:
                env.AGENT_RESPONDER_INITIAL_BACKOFF_MS,
            }),
        AGENT_FACTORY_NAME: factoryName,
        AGENT_ID: agentId,
        AGENT_RESPONDER_GUEST_NAME: guestName,
        AGENT_RESPONDER_LAUNCHER_NAME: selfName,
        AGENT_RESPONDER_NAME: name,
        AGENT_RESPONDER_SPECIFIER: specifierFor(harness),
      },
    });
    await E(powers).remove(PROVISIONERS, name);
  };

  return makeExo(
    'AgentResponderLauncher',
    /** @type {any} */ (AgentResponderLauncherInterface),
    {
      has: name => isPinned(name),
      provide,
      setPaused: async (name, paused, startAfter) => {
        await E(await controlOf(name)).setPaused(paused, startAfter);
      },
      describe: async name => {
        if (!(await isPinned(name))) {
          return harden({ deferred: [], refused: [] });
        }
        return E(await controlOf(name)).describe();
      },
      retry: async (name, number) => {
        if (!(await isPinned(name))) {
          throw makeError(
            X`Agent operation failed: ${q('message-not-retryable')}`,
          );
        }
        await E(await controlOf(name)).retry(number);
      },
      register: (name, control) => {
        controlKit(name).resolve(control);
        const registered = makePromiseKit();
        registered.resolve(control);
        controls.set(name, registered);
      },
      remove: async (guestName, name) => {
        await null;
        controls.delete(name);
        if ((await has([WORKERS])) && (await has([WORKERS, name]))) {
          await E(powers).cancel([WORKERS, name]);
        }
        if (await has(['@pins', name])) await E(powers).remove('@pins', name);
        const guestPowersName = `${guestName}-agent`;
        if (await has([guestPowersName])) {
          for (const pinned of [name, stateDirectoryOf(name)]) {
            // eslint-disable-next-line no-await-in-loop
            if (await has([guestPowersName, '@pins', pinned])) {
              // eslint-disable-next-line no-await-in-loop
              await E(powers).remove(guestPowersName, '@pins', pinned);
            }
          }
        }
        for (const directory of DIRECTORIES) {
          // eslint-disable-next-line no-await-in-loop
          if ((await has([directory])) && (await has([directory, name]))) {
            // eslint-disable-next-line no-await-in-loop
            await E(powers).remove(directory, name);
          }
        }
      },
    },
  );
};
harden(make);
