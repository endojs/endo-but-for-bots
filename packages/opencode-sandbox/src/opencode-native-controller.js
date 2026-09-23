// @ts-check

import { randomBytes } from 'node:crypto';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import {
  WORKSPACE_PATH,
  activateExecutionEnvelope,
  bindRootOf,
} from '@endo/hosted-agent/execution-envelope.js';
import { makeMcpBridgeForToolSet } from '@endo/hosted-agent/mcp-bridge.js';
import { makePublicNetworkEnvironment } from '@endo/hosted-agent/public-network.js';
import { makeHostedSessionSupervisor } from '@endo/hosted-agent/session-supervisor.js';
import { reclaimRecordedMount } from '@endo/hosted-agent/recorded-cleanup.js';
import { makeDefaultMounter } from '@endo/hosted-agent/workspace-projection.js';

import {
  assertHostedAgentPolicyV1,
  hostedPolicyFromSlice,
} from './opencode-hosted-policy.js';
import { makeOpencodeClient } from './opencode-client.js';
import { makeOpencodeConfig, parseModelRef } from './opencode-agent-config.js';
import { OPENROUTER_ORIGIN } from './opencode-broker.js';
import {
  buildOpencodeMcpServer,
  DEFAULT_INNER_DIR,
  DEFAULT_SERVER_NAME,
  DEFAULT_SOCKET_NAME,
  makeMcpSocketServer,
} from './mcp-socket-server.js';
import { rootfsLabel } from './parse-rootfs.js';
import { readSessionPlan } from './opencode-session-plan.js';

/** The CLI's home on the slice's own tmpfs; its store is in memory. */
const OPENCODE_HOME = '/tmp/opencode-home';

/**
 * Inert composition for one dedicated native worker. The shared execution
 * envelope (`@endo/hosted-agent/execution-envelope.js`) activates the plan;
 * what is OpenCode's here is the Endo tool bridge over a per-session MCP
 * socket bound read-only into the slice, the CLI's environment (its database
 * in memory, its home on tmpfs, its configuration inline), and the client run
 * over the slice. Resolver capabilities are never passed into either shared
 * service. Each native owner is retained before its first effect; failed
 * cleanup remains available through terminate retries.
 *
 * The daemon calls terminate without activate when reconstructing a previously
 * started controller. Shared scopes can then be looked up, but lost local 9P/MCP
 * owners cannot be recreated as evidence of release. That path refuses completion.
 * Fresh inert construction is cancelled by the daemon's construction kit instead.
 * The caller must pre-create and own the private mounterSocketDir and keep all
 * mount/socket paths under stable, disjoint ancestry outside guest writes.
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
  return makeHostedSessionSupervisor({
    name: 'OpenCode',
    readPlan: readSessionPlan,
    env,
    context,
    reclaimMount,
    reportError,
    start: async (approved, resolver, owner) => {
      const envelope = await activateExecutionEnvelope(
        approved,
        resolver,
        owner,
        {
          label: 'OpenCode',
          env,
          makeMounter,
          ...(makeFilesystem ? { makeFilesystem } : {}),
          scopeRequest: plan => ({
            providerOrigin: OPENROUTER_ORIGIN,
            // The account authority the plan is bound to, which the grant
            // must report.
            accountRef: plan.accountRef,
            networkPolicy: plan.networkPolicy,
            ...(plan.model ? { model: parseModelRef(plan.model) } : {}),
          }),
          authMode: () => 'api-key',
          // The Endo tools Floot pinned reach the CLI over a per-session MCP
          // socket this controller runs; only JSON crosses it. Its socket
          // has to be serving before the slice can be asked for.
          tools: async ({ plan, resolver: dependencies, own, assertOpen }) => {
            const tools = await E(dependencies).get('tools');
            assertOpen();
            const bridge = await makeBridge(tools);
            assertOpen();
            const mcp = own('mcp', makeMcp({ socketDir: plan.mcpDir, bridge }));
            assertOpen();
            await mcp.start();
            return mcp;
          },
          // The bridge's socket and its stdio shim, read-only: the guest
          // connects to the socket, and nothing it does should replace the
          // shim it runs. OpenCode's own database is in memory and its
          // remaining CLI state lives on tmpfs, so there is no state bind.
          binds: ({ plan }) => [
            {
              role: 'mcp',
              kind: 'bind',
              source: plan.mcpDir,
              destination: DEFAULT_INNER_DIR,
              mode: 'ro',
            },
          ],
          bindRoots: ({ plan }) => [bindRootOf(plan.mcpDir)],
          sliceEnv: ({ plan, attestation, publicNetwork }) => ({
            ...makePublicNetworkEnvironment(publicNetwork),
            OPENROUTER_API_KEY: 'opencode-broker-placeholder',
            HOME: OPENCODE_HOME,
            XDG_CONFIG_HOME: `${OPENCODE_HOME}/.config`,
            // The CLI's own store is a cache of this incarnation, not the
            // record of the conversation: the stack holds that and restores
            // it. An in-memory database is a configuration the fork supports
            // outright (`Database.path()`), and it takes the SQLite/WAL
            // constraint with it — there is no file, so there is no
            // shared-memory index to need a local filesystem for.
            XDG_DATA_HOME: `${OPENCODE_HOME}/.local/share`,
            OPENCODE_DB: ':memory:',
            OPENCODE_CONFIG_CONTENT: JSON.stringify(
              makeOpencodeConfig({
                ...(plan.model ? { model: plan.model } : {}),
                ...(plan.systemPrompt
                  ? { systemPrompt: plan.systemPrompt }
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
            OPENCODE_BRIDGE_DIRECTORY: WORKSPACE_PATH,
            OPENCODE_SERVER_PASSWORD: makePassword(),
            OPENCODE_MCP_SERVER_NAME: DEFAULT_SERVER_NAME,
          }),
          policy: { assertHostedAgentPolicyV1, hostedPolicyFromSlice },
        },
      );
      const { slice, rootfs } = envelope;
      return makeClient({
        sessionId: approved.sessionId,
        createdAt: '',
        slice,
        workspaceMountPoint: approved.workspaceMountPoint,
        workspacePath: WORKSPACE_PATH,
        statePath: `${OPENCODE_HOME}/.local/share`,
        backend: 'podman',
        rootfsLabel: rootfsLabel(rootfs),
        model: approved.model,
        systemPrompt: approved.systemPrompt,
      });
    },
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
