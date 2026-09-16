// @ts-check

import { randomBytes } from 'node:crypto';

import { assertCopyData } from '@endo/daemon/copy-data.js';
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { makeMcpBridgeForToolSet } from '@endo/hosted-agent/mcp-bridge.js';
import {
  assertPublicNetworkEvidence,
  makePublicNetworkEnvironment,
} from '@endo/hosted-agent/public-network.js';
import { reclaimRecordedMount } from '@endo/hosted-agent/recorded-cleanup.js';
import {
  makeDefaultMounter,
  makeWorkspaceProjection,
} from '@endo/hosted-agent/workspace-projection.js';
import { M } from '@endo/patterns';

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
import { readSessionPlan } from './opencode-session-plan.js';

const ControllerInterface = M.interface('OpencodeNativeController', {
  activate: M.call(M.string(), M.remotable()).returns(M.promise()),
  send: M.call(M.string()).optional(M.record()).returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
  status: M.call().returns(M.promise()),
  terminate: M.call(M.string(), M.remotable()).returns(M.promise()),
});

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
 * @param {typeof makeDefaultMounter} [powers.makeMounter]
 * @param {(rootPath: string) => object} [powers.makeFilesystem] Projects the
 *   recorded workspace directory for the 9P mount. No daemon filesystem
 *   formula is imported: a worker retaining a disposable formula's value is
 *   closed when that formula is collected, so the plan's path is the only
 *   authority that crosses into this worker.
 * @param {typeof makeMcpBridgeForToolSet} [powers.makeBridge]
 * @param {typeof reclaimRecordedMount} [powers.reclaimMount] Reclaims a lost
 *   worker's recorded kernel mount. Never mounts anything.
 * @param {typeof makeMcpSocketServer} [powers.makeMcp]
 * @param {typeof makeOpencodeClient} [powers.makeClient]
 * @param {() => string} [powers.makePassword]
 * @param {Record<string,string>} [powers.env] Trusted native runner configuration.
 * @param {any} [powers.context] Original daemon context, only for cancellation.
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeOpencodeNativeController = ({
  makeMounter = makeDefaultMounter,
  makeFilesystem,
  makeBridge = makeMcpBridgeForToolSet,
  reclaimMount = reclaimRecordedMount,
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
  /** @type {ReturnType<typeof makeWorkspaceProjection> | undefined} */
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
      const approved = readSessionPlan(text);
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
      // Exactly one of the two is recorded; the parser enforces it.
      // Retained before it is established, so a failed mount is still
      // closed by this owner's ordinary cleanup.
      mounter = makeWorkspaceProjection(
        {
          workspaceRootPath:
            approved.workspaceHostPath ??
            /** @type {string} */ (approved.workspaceDir),
          workspaceMountPoint: approved.workspaceMountPoint,
          mounterSocketDir: approved.mounterSocketDir,
          ...(approved.mounterEnv ? { mounterEnv: approved.mounterEnv } : {}),
        },
        { env, makeMounter, ...(makeFilesystem ? { makeFilesystem } : {}) },
      );
      closeIfStopping();
      await mounter.mount();
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
        const recoveredPlan = readSessionPlan(text);
        // Reaching the shared services is best effort, and never proof either
        // way: a service revived to answer this call holds no scopes from the
        // lost incarnation, and one that cannot be reached cannot be asked.
        // A scope still live in THIS incarnation is found here and closed
        // below, which is the case worth trying for. A slice left behind by a
        // lost runtime is reconciled by the driver's own label sweep, so a
        // failure here is reported, not raised: raising it is what used to
        // leave a session permanently unstoppable whenever a superseded
        // service formula refused to revive.
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
        // The kernel mount outlives every process that knew about it, so it
        // is the one thing this owner must establish. Both run before either
        // is judged: a failed scope close must not skip the unmount.
        const released = await Promise.allSettled([
          closeResources(),
          // Compose the mounter settings exactly as activation does: the
          // operator's are this worker's trusted configuration and the plan's
          // recorded overrides sit on top. Reading only the plan would run a
          // bare `umount` on a host whose mounts go through a privilege
          // helper, and refuse every reclamation with EPERM.
          reclaimMount({
            ...recoveredPlan,
            mounterEnv: { ...env, ...recoveredPlan.mounterEnv },
          }),
        ]);
        const failures = released.flatMap(result =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        const diagnosed = recovered.flatMap(result =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length) {
          throw AggregateError(
            [...diagnosed, ...failures],
            'Original local 9P/MCP cleanup ownership is unavailable',
          );
        }
        for (const error of diagnosed) reportError(error);
        stopped = true;
        return;
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
