// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { ShellInterface } from '@endo/exo-shell/src/interfaces.js';
import { M, mustMatch } from '@endo/patterns';

const NetworkPolicy = M.or('off', 'public-internet');
export const EnvironmentRecipeShape = harden({
  policy: {
    allowedCommands: M.arrayOf(M.string()),
    timeoutMs: M.number(),
    maxOutputBytes: M.number(),
  },
  networkPolicy: NetworkPolicy,
});
harden(EnvironmentRecipeShape);

/** @param {any} recipe */
export const assertEnvironmentRecipe = recipe => {
  mustMatch(recipe, EnvironmentRecipeShape);
  const { policy } = recipe;
  (policy.allowedCommands.length > 0 &&
    policy.allowedCommands.every(command =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(command),
    ) &&
    Number.isInteger(policy.timeoutMs) &&
    policy.timeoutMs > 0 &&
    policy.timeoutMs <= 0x7fff_ffff &&
    Number.isInteger(policy.maxOutputBytes) &&
    policy.maxOutputBytes > 0 &&
    policy.maxOutputBytes <= 0xffff_ffff) ||
    Fail`Invalid environment execution bounds`;
};
harden(assertEnvironmentRecipe);

const AdminInterface = M.interface('EnvironmentAdmin', {
  inspect: M.callWhen().returns(M.record()),
  stop: M.callWhen().returns(M.undefined()),
  setNetworkPolicy: M.callWhen(NetworkPolicy).returns(M.undefined()),
  dispose: M.callWhen().returns(M.undefined()),
  help: M.call().returns(M.string()),
});

/**
 * One durable recipe and minimum lifecycle fence, not a command journal.
 * Only Shell crosses to a model. The exact runner/workspace dependencies are
 * resolved lazily; inspection and formula restoration do not start native work.
 * Active intent after process loss is refused, never adopted or replayed.
 * Admin stop preserves storage; explicit dispose waits for native stop first.
 * The private state directory uses the daemon's atomic formula-backed text
 * publication, not guest-writable storage or a mutable inventory lookup.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {any} options.recipe
 * @param {any} options.directory
 * @param {(role: 'runner' | 'workspace') => Promise<any>} options.resolve
 */
export const makeEnvironment = async ({ id, recipe, directory, resolve }) => {
  harden(recipe);
  assertEnvironmentRecipe(recipe);
  const text = await E(directory).maybeReadText('lifecycle');
  let state =
    text === undefined
      ? harden({ phase: 'idle', networkPolicy: recipe.networkPolicy })
      : JSON.parse(text);
  mustMatch(
    harden(state),
    harden({
      phase: M.or('idle', 'active', 'disposed'),
      networkPolicy: NetworkPolicy,
    }),
  );
  let uncertain = state.phase === 'active';
  let closed = false;
  let fenced = false;
  let epoch = 0n;
  let chain = Promise.resolve();
  /** @type {any} */
  let controller;
  /** @type {any} */
  let nativeShell;
  /** @type {Promise<any> | undefined} */
  let activation;
  /** @type {Promise<void> | undefined} */
  let stopping;
  /** @type {Promise<void> | undefined} */
  let maintenance;
  const revivals = new Set();
  const publish = async next => {
    // Keep uncertainty on a lost acknowledgement, even if the write committed.
    uncertain = true;
    await E(directory).writeText('lifecycle', JSON.stringify(next));
    state = harden(next);
    uncertain = false;
  };
  const check = () => {
    (!closed && !fenced) || Fail`Environment execution is stopped`;
    !uncertain ||
      Fail`Interrupted environment requires explicit operator cleanup`;
    state.phase !== 'disposed' || Fail`Environment storage is disposed`;
  };
  const inOrder = operation => {
    check();
    const version = epoch;
    const pending = chain.then(async () => {
      check();
      version === epoch || Fail`Environment execution was stopped`;
      return operation();
    });
    chain = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
  const start = () => {
    if (nativeShell) return Promise.resolve(nativeShell);
    if (activation) return activation;
    const version = epoch;
    const assertAdmission = () => {
      (!closed && !fenced && version === epoch) ||
        Fail`Environment activation stopped`;
    };
    activation = (async () => {
      await publish({ ...state, phase: 'active' });
      assertAdmission();
      const runner = await resolve('runner');
      assertAdmission();
      const dependencies = makeExo(
        'EnvironmentDependencies',
        M.interface('EnvironmentDependencies', {
          get: M.callWhen('workspace').returns(M.remotable()),
        }),
        {
          get: role => {
            assertAdmission();
            const pending = resolve(role).then(value => {
              assertAdmission();
              return value;
            });
            revivals.add(pending);
            void pending.then(
              () => revivals.delete(pending),
              () => revivals.delete(pending),
            );
            return pending;
          },
        },
      );
      controller = await E(runner).provideEnvironment(
        id,
        harden({ ...recipe, networkPolicy: state.networkPolicy }),
        dependencies,
      );
      assertAdmission();
      nativeShell = await E(controller).open();
      assertAdmission();
      return nativeShell;
    })();
    void activation.catch(() => {});
    return activation;
  };
  const stop = () => {
    fenced = true;
    epoch += 1n;
    if (stopping) return stopping;
    // Reach the retained controller before waiting for its open/command queue.
    const original = controller;
    const early = original ? E(original).stop() : Promise.resolve();
    const earlyOutcome = Promise.allSettled([early]);
    stopping = (async () => {
      await activation?.catch(() => {});
      await Promise.allSettled([...revivals]);
      const outcomes = [
        ...(await earlyOutcome),
        ...(await Promise.allSettled([
          controller && controller !== original
            ? E(controller).stop()
            : Promise.resolve(),
        ])),
      ];
      const failures = outcomes.flatMap(outcome =>
        outcome.status === 'rejected' ? [outcome.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(failures, 'Environment cleanup pending');
      await chain;
      // A lost owner is not evidence of quiescence. Do not revive a runner to
      // infer cleanup from a missing map entry.
      !uncertain ||
        controller ||
        Fail`Interrupted environment requires explicit operator cleanup`;
      if (state.phase !== 'disposed')
        await publish({ ...state, phase: 'idle' });
      controller = undefined;
      nativeShell = undefined;
      activation = undefined;
      fenced = closed || maintenance !== undefined;
    })().finally(() => {
      stopping = undefined;
    });
    void stopping.catch(() => {});
    return stopping;
  };
  const shell = makeExo('EnvironmentShell', ShellInterface, {
    inspect: async () => recipe.policy,
    exec: (command, args, options = {}) =>
      inOrder(async () => {
        recipe.policy.allowedCommands.includes(command) ||
          Fail`Command is not in the environment allowlist`;
        const selected = await start();
        const version = epoch;
        const result = await E(selected).exec(command, args, harden(options));
        check();
        version === epoch || Fail`Environment command was interrupted`;
        return result;
      }),
  });
  const administer = operation => {
    (!closed && !maintenance) ||
      Fail`Environment administration is closed or busy`;
    fenced = true;
    epoch += 1n;
    const pending = Promise.resolve().then(operation);
    maintenance = pending.then(
      () => {
        maintenance = undefined;
        fenced = closed;
      },
      error => {
        maintenance = undefined;
        // Failed publication/deletion cannot reopen command admission.
        fenced = true;
        throw error;
      },
    );
    void maintenance.catch(() => {});
    return maintenance;
  };
  const admin = makeExo('EnvironmentAdmin', AdminInterface, {
    inspect: async () =>
      harden({
        phase: state.phase,
        networkPolicy: state.networkPolicy,
        interrupted: uncertain,
        active: nativeShell !== undefined,
      }),
    stop: () => {
      !maintenance || Fail`Environment administration is busy`;
      return stop();
    },
    setNetworkPolicy: networkPolicy =>
      administer(async () => {
        await stop();
        !closed || Fail`Environment is closed`;
        state.phase !== 'disposed' || Fail`Environment storage is disposed`;
        await publish({ phase: 'idle', networkPolicy });
      }),
    dispose: () =>
      administer(async () => {
        await stop();
        if (state.phase === 'disposed') return;
        await publish({ ...state, phase: 'active' });
        // Disposal is explicit host authority. The runner's storage operation
        // verifies allocation ownership; the workspace is never deleted here.
        const runner = await resolve('runner');
        await E(runner).removeEnvironmentStorage(id);
        await publish({ ...state, phase: 'disposed' });
      }),
    help: () =>
      'stop preserves development storage. dispose stops native work then deletes only owned development storage. Retain this admin until disposal succeeds before removing durable roots. Automatic GC and process-loss recovery are not supported.',
  });
  return harden({
    shell,
    admin,
    shutdown: async () => {
      closed = true;
      fenced = true;
      epoch += 1n;
      await maintenance?.catch(() => {});
      await stop();
    },
  });
};
harden(makeEnvironment);
