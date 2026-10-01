// @ts-check
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { toPassableError } from '@endo/pass-style';
import { makeShell } from '@endo/exo-shell';
import {
  assertEnvironmentRecipe,
  EnvironmentRunnerInterface,
  EnvironmentControllerInterface,
} from '@endo/exo-shell/environment-interfaces.js';
import { mountAsFilesystem } from '@endo/platform/fs/extended/from-mount.js';
import { makeSandboxRuntime } from '@endo/sandbox/runtime.js';
import { readRuntimeConfig } from '@endo/sandbox/runtime-config.js';
import { makeOwnedNativeService } from '@endo/sandbox/owned-native-service.js';
import { makeResourceRegistry } from '@endo/sandbox/resource-registry.js';
import { assertPrivateDirectory } from '@endo/sandbox/private-directory.js';
import { makeSandboxSpawner } from '@endo/sandbox/spawner.js';
import { makeStateStorageOperations } from './session-state-storage.js';
import { makeDefaultMounter } from './workspace-projection.js';
import { readMounterEnv } from './session-plan.js';
import { makePodmanProviderListenerRuntimeKit } from './provider-listener-runtime.js';
import { makePublicEgress } from './public-egress.js';
import {
  makePublicNetworkEnvironment,
  assertPublicNetworkEvidence,
} from './public-network.js';

/** @param {string} id */
const storageId = id => {
  /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(id) ||
    Fail`Invalid environment formula identity`;
  return `environment-${createHash('sha256').update(id).digest('hex')}`;
};

/** A host-private child directory, never a guest-selected path or symlink. */
/** @param {string} directory */
const privateDirectory = async directory => {
  await fs.mkdir(directory, { mode: 0o700 });
};
/** @param {string} directory */
const retainedHome = async directory => {
  try {
    await privateDirectory(directory);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST')
      throw error;
    const stat = await fs.lstat(directory);
    (stat.isDirectory() && !stat.isSymbolicLink()) ||
      Fail`Invalid environment home`;
  }
};

/**
 * Inert host composition. Own the kit before open, retain failed close for
 * retry. Environment controllers reuse native scopes and the Shell spawner;
 * this is neither a conversation supervisor nor a command-effect journal.
 * HOME is native disk. Workspace is an exact Endo Mount projected over 9P.
 * No native owner or path is exposed on Shell. Stop preserves storage; only
 * explicit administrative deletion removes its inode-owned allocation.
 * @param {any} config Immutable operator configuration, not model options.
 * @param {object} [powers]
 * @param {Record<string,string>} [powers.env]
 * @param {any} [powers.runtime]
 * @param {any} [powers.listener]
 * @param {any} [powers.storage]
 * @param {typeof makeDefaultMounter} [powers.makeMounter]
 * @param {typeof makePublicEgress} [powers.makeEgress]
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeEnvironmentRunnerKit = (
  config,
  {
    env = {},
    runtime = makeSandboxRuntime(
      { ...config, env, runAs: { uid: 1000, gid: 1000 } },
      { scratchProvider: null },
    ),
    listener = makePodmanProviderListenerRuntimeKit({
      imageRef: config.listenerImageRef,
      ownerId: `${config.ownerId}-network`,
      stateDirectory: config.networkDirectory,
      publicInternet: config.publicInternet,
      env,
    }),
    storage = makeStateStorageOperations(config.stateRoot),
    makeMounter = makeDefaultMounter,
    makeEgress = makePublicEgress,
    reportError = error => console.error('Environment cleanup pending', error),
  } = {},
) => {
  /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(config.imageRef) ||
    Fail`Environment image must be digest-pinned`;
  let closing = false;
  const owners = makeResourceRegistry();
  const controllers = new Map();
  let native;
  let opening;
  let closeFlight;
  const assertRunnerOpen = () => {
    !closing || Fail`Environment runner is closing`;
  };
  const runner = makeExo(
    'PodmanEnvironmentRunner',
    EnvironmentRunnerInterface,
    {
      provideEnvironment: (id, recipe, dependencies) =>
        owners.inOrder(storageId(id), async () => {
          await null;
          assertRunnerOpen();
          assertEnvironmentRecipe(recipe);
          const key = storageId(id);
          !controllers.has(key) ||
            Fail`Environment already has a retained native owner`;
          let closed = false;
          let started;
          let stopping;
          let scope;
          let slice;
          let mounter;
          let sockets;
          let worker;
          let egress;
          let forget = () => {};
          const assertOpen = () => {
            assertRunnerOpen();
            !closed || Fail`Environment native controller is stopped`;
          };
          const stop = () => {
            closed = true;
            egress?.dispose();
            if (stopping) return stopping;
            const originalScope = scope;
            // A joined slice depends on the listener's network namespace.
            // Stop a listener early only while no scope has been acquired;
            // otherwise native scope cleanup must acknowledge first.
            const earlyWorker = originalScope ? undefined : worker;
            const early = Promise.allSettled([
              originalScope ? E(originalScope).close() : Promise.resolve(),
              earlyWorker?.stop(),
            ]);
            stopping = (async () => {
              await started?.catch(() => {});
              const results = [
                ...(await early),
                ...(await Promise.allSettled([
                  scope && scope !== originalScope
                    ? E(scope).close()
                    : Promise.resolve(),
                ])),
              ];
              const failures = results.flatMap(result =>
                result.status === 'rejected'
                  ? [toPassableError(result.reason)]
                  : [],
              );
              if (failures.length)
                throw new AggregateError(
                  failures,
                  'Environment native cleanup pending',
                );
              if (worker && worker !== earlyWorker) await worker.stop();
              // Native scope/listener acknowledgements precede unmount. Failure
              // keeps all original handles and the registry entry for retry.
              await mounter?.close();
              if (sockets) {
                // Non-recursive removal only after bridge/unmount ACK. Keep
                // the original directory on failure; never sweep runtime roots.
                await fs.rmdir(sockets);
                sockets = undefined;
              }
              forget();
            })().catch(error => {
              stopping = undefined;
              // Native fs/child-process errors can carry enumerable code and
              // stderr properties. Preserve their diagnostics without making
              // a cleanup refusal itself fail the capability wire contract.
              throw toPassableError(error);
            });
            void stopping.catch(() => {});
            return stopping;
          };
          const shell = makeShell({
            cwd: '/workspace',
            policy: recipe.policy,
            spawner: async (argv, options) => {
              assertOpen();
              slice || Fail`Environment has not been opened`;
              return makeSandboxSpawner(slice)(argv, options);
            },
          });
          const controller = makeExo(
            'PodmanEnvironmentController',
            EnvironmentControllerInterface,
            {
              open: () => {
                assertOpen();
                started ??= (async () => {
                  const state = await storage.prepareSessionDirectory(key);
                  assertOpen();
                  const home = path.join(state.directory, 'home');
                  await retainedHome(home);
                  // Socket lifetime is an incarnation, not durable HOME. The
                  // allocation's full identity is too long for Unix sockets.
                  const socketParent = await assertPrivateDirectory(
                    env.XDG_RUNTIME_DIR,
                    fs,
                  );
                  sockets = await fs.mkdtemp(
                    path.join(socketParent, 'env-9p-'),
                  );
                  assertOpen();
                  const workspace = await E(dependencies).get('workspace');
                  assertOpen();
                  mounter = makeMounter({
                    ...env,
                    ...readMounterEnv(
                      Object.fromEntries(
                        [
                          'NINEP_SUDO',
                          'NINEP_MOUNT_PROGRAM',
                          'NINEP_UMOUNT_PROGRAM',
                        ]
                          .filter(name => env[`ENDO_${name}`] !== undefined)
                          .map(name => [name, env[`ENDO_${name}`]]),
                      ),
                    ),
                    XDG_RUNTIME_DIR: sockets,
                    NINEP_SOCKET_DIR: sockets,
                  });
                  const mountPoint = path.join(
                    state.directory,
                    'workspace-mount',
                  );
                  await E(mounter.mounter).mount(
                    mountAsFilesystem(workspace),
                    mountPoint,
                    harden({ removeMountPointOnUnmount: true }),
                  );
                  assertOpen();
                  const mounts = [
                    {
                      hostPath: mountPoint,
                      innerPath: '/workspace',
                      mode: 'rw',
                    },
                    { hostPath: home, innerPath: '/home/node', mode: 'rw' },
                  ];
                  let observation;
                  if (recipe.networkPolicy === 'public-internet') {
                    config.publicInternet ||
                      Fail`Public internet is not enabled by the environment operator`;
                    const network = await listener.open();
                    assertOpen();
                    egress = makeEgress({ policy: 'public-internet' });
                    worker = network.startKit({
                      network: { endpoint: egress.endpoint },
                    });
                    const value = await worker.value;
                    assertOpen();
                    void value.closed.then(() => stop()).catch(reportError);
                    observation = await value.observe();
                    assertPublicNetworkEvidence(observation.network);
                    mounts.push({
                      hostPath: observation.network.resolverConfigPath,
                      innerPath: '/etc/resolv.conf',
                      mode: 'ro',
                    });
                    assertOpen();
                  }
                  scope = await E(native).provideScope(key);
                  assertOpen();
                  slice = await E(scope).makeResolved(
                    harden({
                      rootfs: { kind: 'oci', ref: config.imageRef },
                      backend: 'podman',
                      network: observation ? 'join' : 'none',
                      ...(observation
                        ? { networkRef: observation.containerName }
                        : {}),
                      mounts,
                      scratchHostPath: '',
                      seccomp: 'default',
                      cwd: '/workspace',
                      env: {
                        HOME: '/home/node',
                        CARGO_HOME: '/home/node/.cargo',
                        RUSTUP_HOME: '/home/node/.rustup',
                        CARGO_TARGET_DIR: '/home/node/target',
                        PATH: '/home/node/.cargo/bin:/usr/local/bin:/usr/bin:/bin',
                        LANG: 'C.UTF-8',
                        ...makePublicNetworkEnvironment(observation?.network),
                      },
                    }),
                  );
                  assertOpen();
                  return shell;
                })();
                void started.catch(() => {});
                return started;
              },
              stop,
            },
          );
          forget = () => {
            if (controllers.get(key) === controller) controllers.delete(key);
            owners.release(key, stop);
          };
          controllers.set(key, controller);
          owners.retain(key, stop);
          return controller;
        }),
      removeEnvironmentStorage: id =>
        owners.inOrder(storageId(id), async () => {
          assertRunnerOpen();
          const key = storageId(id);
          !controllers.has(key) ||
            Fail`Environment native owner must stop before storage deletion`;
          await storage.removeSessionDirectory(key);
        }),
    },
  );
  return harden({
    open: () => {
      assertRunnerOpen();
      opening ??= (async () => {
        native = await runtime.openNative();
        assertRunnerOpen();
        return runner;
      })();
      return opening;
    },
    close: () => {
      closing = true;
      closeFlight ??= (async () => {
        // Reach pending native openings outside the registry's drain queue.
        const stopped = Promise.allSettled([
          owners.shutdown(),
          runtime.close(),
        ]);
        await opening?.catch(() => {});
        const results = await stopped;
        const failures = results.flatMap(result =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            'Environment runner shutdown pending',
          );
        // Listener namespaces outlive every dependent native scope, including
        // runner-wide shutdown. Failed containment keeps that owner retained.
        await listener.close();
      })().catch(error => {
        closeFlight = undefined;
        throw error;
      });
      return closeFlight;
    },
  });
};
harden(makeEnvironmentRunnerKit);

/** @param {Record<string,string>} env */
const readConfig = env => {
  const required = name => {
    env[name] || Fail`Missing environment runner configuration ${name}`;
    return env[name];
  };
  const publicInternet = required('ENDO_ENVIRONMENT_PUBLIC_INTERNET');
  ['0', '1'].includes(publicInternet) ||
    Fail`Invalid environment network ceiling`;
  const runtime = readRuntimeConfig(env);
  runtime.ownerId.length <= 56 ||
    Fail`Environment owner is too long for its network scope`;
  return harden({
    ...runtime,
    imageRef: required('ENDO_ENVIRONMENT_IMAGE_REF'),
    listenerImageRef: required('ENDO_ENVIRONMENT_LISTENER_IMAGE_REF'),
    stateRoot: required('ENDO_ENVIRONMENT_STATE_ROOT'),
    networkDirectory: required('ENDO_ENVIRONMENT_NETWORK_DIR'),
    publicInternet: publicInternet === '1',
  });
};

export const make = makeOwnedNativeService({
  readConfig,
  makeKit: (config, powers, env) => {
    powers === null || Fail`Environment runner requires slot-free null powers`;
    return makeEnvironmentRunnerKit(config, { env });
  },
});
harden(make);
