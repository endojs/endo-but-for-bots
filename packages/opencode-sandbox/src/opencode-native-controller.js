// @ts-check
/* global process */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rmdir } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { promisify } from 'node:util';

import {
  makeFsMounterKit,
  mountIdentity,
} from '@endo/9p-server/mount-caplet.js';
import { makeFsBridge9p } from '@endo/9p-server/src/fs-bridge.js';
import { assertCopyData } from '@endo/daemon/copy-data.js';
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { makeMcpBridgeForToolSet } from '@endo/hosted-agent/mcp-bridge.js';
import {
  assertPublicNetworkEvidence,
  makePublicNetworkEnvironment,
} from '@endo/hosted-agent/public-network.js';
import { M } from '@endo/patterns';
import { assertNativePodmanProfile } from '@endo/sandbox/native-podman-profile.js';

import { makeOpencodeClient } from './opencode-client.js';
import { makeOpencodeConfig, parseModelRef } from './opencode-agent-config.js';
import {
  OPENCODE_BROKER_ACCOUNT,
  OPENROUTER_ORIGIN,
} from './opencode-broker.js';
import {
  buildOpencodeMcpServer,
  DEFAULT_INNER_DIR,
  DEFAULT_SERVER_NAME,
  DEFAULT_SOCKET_NAME,
  makeMcpSocketServer,
} from './mcp-socket-server.js';
import { parseRootfs, rootfsLabel } from './parse-rootfs.js';

const ControllerInterface = M.interface('OpencodeNativeController', {
  activate: M.call(M.string(), M.remotable()).returns(M.promise()),
  send: M.call(M.string()).optional(M.record()).returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
  status: M.call().returns(M.promise()),
  terminate: M.call(M.string(), M.remotable()).returns(M.promise()),
});

/**
 * The recorded deployment resource profile. JSON carries no bigint, so the two
 * OCI int64 quantities travel as decimal digit strings and are widened here.
 * @typedef {object} PlanNativeProfile
 * @property {number} uid
 * @property {number} gid
 * @property {string} memoryBytes
 * @property {string} cpuQuotaMicros
 * @property {number} pids
 * @property {number} cpuPeriodMicros
 * @property {number} maxConcurrentOperations
 */

/**
 * @typedef {object} NativePlan
 * @property {string} sessionId
 * @property {string} sandboxSessionId
 * @property {string} rootfs Explicit effective image; no environment fallback.
 * @property {'off' | 'public-internet'} networkPolicy
 * @property {string} workspaceMountPoint Kernel mount, distinct from backing storage.
 * @property {string} mcpDir Private, recorded native socket/relay directory.
 * @property {string} mounterSocketDir Private 9P socket parent.
 * @property {ReturnType<typeof assertNativePodmanProfile>} nativeProfile
 * @property {string} [model]
 * @property {string} [systemPrompt]
 * @property {string} [opencodeSessionId]
 */

const NATURAL_TEXT = /^(0|[1-9][0-9]*)$/;

/**
 * The plan is the parser's input edge for operator resource settings: refuse
 * anything but the exact recorded shape, with no defaults, before any scope
 * is acquired. The sandbox factory checks the same profile again at its own
 * boundary on every actual Podman operation.
 * @param {unknown} value
 */
const readNativeProfile = value => {
  (typeof value === 'object' && value !== null) ||
    Fail`Missing native controller profile`;
  const { memoryBytes, cpuQuotaMicros, ...counts } =
    /** @type {Record<string, unknown>} */ (value);
  for (const quantity of [memoryBytes, cpuQuotaMicros]) {
    (typeof quantity === 'string' && NATURAL_TEXT.test(quantity)) ||
      Fail`Native profile quantities must be decimal digit strings`;
  }
  return assertNativePodmanProfile(
    harden({
      ...counts,
      memoryBytes: BigInt(/** @type {string} */ (memoryBytes)),
      cpuQuotaMicros: BigInt(/** @type {string} */ (cpuQuotaMicros)),
    }),
  );
};

/** @param {string} text */
const readPlan = text => {
  const value = JSON.parse(text);
  assertCopyData(harden(value));
  (typeof value === 'object' && value !== null && !Array.isArray(value)) ||
    Fail`Native controller plan must be a record`;
  /** @type {Omit<NativePlan, 'nativeProfile'> & { nativeProfile?: PlanNativeProfile }} */
  const recorded = value;
  for (const name of ['sessionId', 'sandboxSessionId', 'rootfs']) {
    (typeof value[name] === 'string' && value[name] !== '') ||
      Fail`Missing native controller plan field ${name}`;
  }
  /** @type {NativePlan} */
  const plan = harden({
    ...recorded,
    nativeProfile: readNativeProfile(recorded.nativeProfile),
  });
  ['off', 'public-internet'].includes(plan.networkPolicy) ||
    Fail`Unknown native controller network policy`;
  for (const nativePath of [
    plan.workspaceMountPoint,
    plan.mcpDir,
    plan.mounterSocketDir,
  ]) {
    (typeof nativePath === 'string' &&
      isAbsolute(nativePath) &&
      normalize(nativePath) === nativePath &&
      !nativePath.includes('\0')) ||
      Fail`Native controller requires recorded absolute paths`;
  }
  return plan;
};

/**
 * Inert composition for one dedicated native worker. Resolver capabilities are
 * never passed into either shared service. Each native owner is retained before
 * its first effect; failed cleanup remains available through terminate retries.
 *
 * The daemon calls terminate without activate when reconstructing a previously
 * started controller. Shared scopes can then be looked up, but lost local 9P/MCP
 * owners cannot be recreated as evidence of release. That path refuses completion.
 * Fresh inert construction is cancelled by the daemon's construction kit instead.
 * The caller must pre-create and own the private mounterSocketDir and keep all
 * mount/socket paths under stable, disjoint ancestry outside guest writes.
 * Each operation requests the recorded native profile: explicit identity and
 * resource settings, a trusted startup gate, and kernel observation of the
 * gate's posture and declared mounts before release. Those are the sandbox's
 * checks; this helper records and forwards the profile and is not itself
 * evidence of the hosted envelope on a live host.
 *
 * @param {object} [powers]
 * @param {(env: Record<string,string>) => ReturnType<typeof makeFsMounterKit>} [powers.makeMounter]
 * @param {typeof makeMcpBridgeForToolSet} [powers.makeBridge]
 * @param {typeof makeMcpSocketServer} [powers.makeMcp]
 * @param {typeof makeOpencodeClient} [powers.makeClient]
 * @param {() => string} [powers.makePassword]
 * @param {Record<string,string>} [powers.env] Trusted native runner configuration.
 * @param {any} [powers.context] Original daemon context, only for cancellation.
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeOpencodeNativeController = ({
  makeMounter = env =>
    makeFsMounterKit({
      env,
      runProgram: promisify(execFile),
      makeDir: mkdir,
      removeDir: rmdir,
      makeBridge: makeFsBridge9p,
      ...mountIdentity(process),
    }),
  makeBridge = makeMcpBridgeForToolSet,
  makeMcp = makeMcpSocketServer,
  makeClient = makeOpencodeClient,
  makePassword = () => randomBytes(24).toString('hex'),
  env = {},
  context,
  reportError = error =>
    console.error('OpenCode native cleanup pending', error),
} = {}) => {
  let stopping = false;
  let stopped = false;
  /** @type {string | undefined} */
  let originalText;
  /** @type {Promise<void> | undefined} */
  let activating;
  /** @type {Promise<void> | undefined} */
  let closing;
  /** @type {any} */
  let sandboxScope;
  /** @type {any} */
  let brokerScope;
  /** @type {ReturnType<typeof makeFsMounterKit> | undefined} */
  let mounter;
  /** @type {ReturnType<typeof makeMcpSocketServer> | undefined} */
  let mcp;
  /** @type {ReturnType<typeof makeOpencodeClient> | undefined} */
  let client;
  const assertOpen = () => {
    !stopping || Fail`OpenCode native controller is stopping`;
  };

  // This operation must be reachable while activation is waiting for a native
  // acquisition. Parents are released only after the sandbox acknowledges stop.
  const closeResources = async () => {
    const sandboxClosed = sandboxScope
      ? E(sandboxScope).close()
      : Promise.resolve();
    const results = await Promise.allSettled([
      sandboxClosed.then(() => mounter?.close()),
      brokerScope ? E(brokerScope).revoke() : Promise.resolve(),
      mcp?.close(),
    ]);
    const failures = results.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length)
      throw AggregateError(failures, 'OpenCode native cleanup pending');
  };
  const closeIfStopping = () => {
    if (stopping) void closeResources().catch(() => {});
    assertOpen();
  };
  /**
   * @param {string} text
   * @param {any} resolver
   */
  const activate = (text, resolver) => {
    assertOpen();
    if (activating) {
      text === originalText || Fail`Native controller plan cannot change`;
      return activating;
    }
    originalText = text;
    activating = (async () => {
      const approved = readPlan(text);
      const sandbox = await E(resolver).get('sandboxService');
      assertOpen();
      sandboxScope = await E(sandbox).provideScope(approved.sandboxSessionId);
      closeIfStopping();
      const broker = await E(resolver).get('brokerService');
      assertOpen();
      brokerScope = await E(broker).provideScope(
        approved.sandboxSessionId,
        harden({
          providerOrigin: OPENROUTER_ORIGIN,
          accountRef: OPENCODE_BROKER_ACCOUNT,
          networkPolicy: approved.networkPolicy,
          ...(approved.model ? { model: parseModelRef(approved.model) } : {}),
        }),
      );
      closeIfStopping();
      await E(brokerScope).start();
      assertOpen();
      const [attestation, evidence] = await Promise.all([
        E(brokerScope).attestation(),
        E(brokerScope).sandboxEvidence(),
      ]);
      assertCopyData(harden(attestation));
      assertCopyData(harden(evidence));
      const rootfs = parseRootfs(approved.rootfs);
      (rootfs.kind === 'oci' &&
        typeof evidence.imageDigest === 'string' &&
        /^sha256:[a-f0-9]{64}$/.test(evidence.imageDigest) &&
        rootfs.ref.endsWith(`@${evidence.imageDigest}`) &&
        attestation.imageDigest === evidence.imageDigest) ||
        Fail`OpenCode rootfs must match the broker's pinned image`;
      const publicNetwork = assertPublicNetworkEvidence(evidence.network);
      (approved.networkPolicy === 'public-internet') ===
        (publicNetwork !== undefined) ||
        Fail`Broker network evidence does not match the recorded policy`;
      assertOpen();
      const stateProvider = await E(resolver).get('stateProvider');
      assertOpen();
      const state = await E(stateProvider).prepareSessionDirectory(
        approved.sandboxSessionId,
      );
      assertCopyData(harden(state));
      assertOpen();
      const filesystem = await E(resolver).get('filesystem');
      assertOpen();
      mounter = makeMounter({
        ...env,
        XDG_RUNTIME_DIR: approved.mounterSocketDir,
        NINEP_SOCKET_DIR: approved.mounterSocketDir,
      });
      closeIfStopping();
      await E(mounter.mounter).mount(filesystem, approved.workspaceMountPoint);
      assertOpen();
      const mounts = [
        {
          hostPath: approved.workspaceMountPoint,
          innerPath: '/workspace',
          mode: 'rw',
        },
        { hostPath: state.directory, innerPath: '/opencode-state', mode: 'rw' },
      ];
      const tools = await E(resolver).get('tools');
      assertOpen();
      const bridge = await makeBridge(tools);
      assertOpen();
      mcp = makeMcp({ socketDir: approved.mcpDir, bridge });
      closeIfStopping();
      await mcp.start();
      assertOpen();
      mounts.push({
        hostPath: approved.mcpDir,
        innerPath: DEFAULT_INNER_DIR,
        mode: 'ro',
      });
      const options = harden({
        rootfs,
        mounts,
        network: 'join',
        networkRef: evidence.brokerSidecar.container,
        backend: 'podman',
        nativeProfile: approved.nativeProfile,
        cwd: '/workspace',
        ...(publicNetwork
          ? {
              generatedFiles: [
                {
                  innerPath: '/etc/resolv.conf',
                  contents: `nameserver ${publicNetwork.dnsHost}\n`,
                },
              ],
            }
          : {}),
        env: {
          ...makePublicNetworkEnvironment(publicNetwork),
          OPENROUTER_API_KEY: 'opencode-broker-placeholder',
          HOME: '/tmp/opencode-home',
          XDG_CONFIG_HOME: '/tmp/opencode-home/.config',
          XDG_DATA_HOME: '/opencode-state',
          OPENCODE_CONFIG_CONTENT: JSON.stringify(
            makeOpencodeConfig({
              ...(approved.model ? { model: approved.model } : {}),
              ...(approved.systemPrompt
                ? { systemPrompt: approved.systemPrompt }
                : {}),
              baseUrl: `${attestation.endpoint}/api/v1`,
              allowLoopbackHttp: true,
              mcpServers: {
                [DEFAULT_SERVER_NAME]: buildOpencodeMcpServer({
                  innerDir: DEFAULT_INNER_DIR,
                  socketName: DEFAULT_SOCKET_NAME,
                }),
              },
            }),
          ),
          OPENCODE_AUTH_CONTENT: '{}',
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
          OPENCODE_PURE: '1',
          OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          OPENCODE_DISABLE_MODELS_FETCH: '1',
          OPENCODE_BRIDGE_DIRECTORY: '/workspace',
          OPENCODE_SERVER_PASSWORD: makePassword(),
          OPENCODE_MCP_SERVER_NAME: DEFAULT_SERVER_NAME,
          ...(approved.opencodeSessionId
            ? { OPENCODE_SESSION_ID: approved.opencodeSessionId }
            : {}),
        },
      });
      assertCopyData(options);
      const slice = await E(sandboxScope).makeResolved(options);
      closeIfStopping();
      client = makeClient({
        sessionId: approved.sessionId,
        createdAt: '',
        slice,
        cleanupProvision: closeResources,
        workspaceMountPoint: approved.workspaceMountPoint,
        workspacePath: '/workspace',
        statePath: '/opencode-state',
        backend: 'podman',
        rootfsLabel: rootfsLabel(rootfs),
        model: approved.model,
        systemPrompt: approved.systemPrompt,
        opencodeSessionId: approved.opencodeSessionId,
        resumePriorConversation: Boolean(approved.opencodeSessionId),
      });
      // No initialPrompt: only foreground sends may initiate recorded turns.
    })();
    return activating;
  };
  /**
   * @param {string} text
   * @param {any} resolver
   */
  const terminate = (text, resolver) => {
    stopping = true;
    if (originalText !== undefined)
      text === originalText || Fail`Cleanup must use the original native plan`;
    else {
      originalText = text;
    }
    if (closing) return closing;
    closing = (async () => {
      if (!activating) {
        // Recovery only. Never create substitutes for an earlier owner.
        const recoveredPlan = readPlan(text);
        const recovered = await Promise.allSettled([
          (async () => {
            if (sandboxScope) return;
            const sandbox = await E(resolver).get('sandboxService');
            sandboxScope = await E(sandbox).lookupScope(
              recoveredPlan.sandboxSessionId,
            );
          })(),
          (async () => {
            if (brokerScope) return;
            const broker = await E(resolver).get('brokerService');
            brokerScope = await E(broker).lookupScope(
              recoveredPlan.sandboxSessionId,
            );
          })(),
        ]);
        const released = await Promise.allSettled([closeResources()]);
        throw AggregateError(
          [...recovered, ...released].flatMap(result =>
            result.status === 'rejected' ? [result.reason] : [],
          ),
          'Original local 9P/MCP cleanup ownership is unavailable',
        );
      }
      const early = client ? E(client).terminate() : closeResources();
      await Promise.allSettled([activating, early]);
      if (client) await E(client).terminate();
      else await closeResources();
      stopped = true;
    })().catch(error => {
      closing = undefined;
      throw error;
    });
    return closing;
  };
  if (context !== undefined) {
    const lost = () => {
      stopping = true;
      // Lost context fences now, even if an acquisition is waiting for close.
      // Its rejection is diagnostic; it is never converted to release proof.
      void (client ? E(client).terminate() : closeResources()).catch(
        reportError,
      );
    };
    void E(context).whenCancelled().then(lost, lost);
  }
  return makeExo('OpencodeNativeController', ControllerInterface, {
    activate,
    send: async (prompt, options = {}) => {
      assertOpen();
      if (client === undefined)
        throw Fail`OpenCode native controller is not active`;
      return E(client).send(prompt, options);
    },
    interrupt: async () => {
      if (client) await E(client).interrupt();
    },
    status: async () =>
      harden({
        ...(client ? await E(client).status() : {}),
        stopping,
        stopped,
      }),
    terminate,
  });
};
harden(makeOpencodeNativeController);

/**
 * Dedicated native constructor. No host or session dependencies are imported
 * through powers; the daemon supplies them only after persisted startup intent.
 * @param {null | Promise<null>} powersP
 * @param {any} context
 * @param {{env?: Record<string,string>}} [options]
 */
export const make = async (powersP, context, { env = {} } = {}) => {
  // The worker passes promised powers/context. Observe context loss before
  // awaiting the slot-free input; construction still acquires no native work.
  const controller = makeOpencodeNativeController({ env, context });
  const powers = await powersP;
  powers === null || Fail`OpenCode native controller requires null powers`;
  return controller;
};
harden(make);
