// @ts-check

/**
 * The per-session native controller the daemon session owner starts for a
 * recorded Claude session: the `client` role of the record. The shared
 * execution envelope (`@endo/hosted-agent/execution-envelope.js`) activates
 * the approved plan: it acquires a scope from the native sandbox service and
 * an inference grant from the provider broker, holds the grant and the
 * broker's evidence to the recorded image, account and network policy,
 * projects the recorded workspace through this session's own 9P mounter, and
 * asks for a slice over the attested mount table it checks twice. What is
 * Claude's here: the persistent config directory the state provider prepares
 * (the conversation transcript lives there), the Endo tool bridge over a
 * per-session MCP socket bound read-only into the slice, the CLI's
 * environment, and the Claude CLI client run over the slice. The slice never
 * holds the provider credential: it sees the listener's loopback endpoint and
 * a placeholder. Construction is inert; the daemon supplies every dependency
 * by exact recorded identity through the resolver, and the guest never sees
 * a recorded path.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertCopyData } from '@endo/hosted-agent/copy-data.js';
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

import { ANTHROPIC_ORIGIN } from './claude-broker.js';
import { makeClaudeClient } from './claude-client.js';
import { CREDENTIAL_ENV_VARS } from './claude-credential-kinds.js';
import { readClaudeSessionPlan } from './claude-session-plan.js';
import {
  CONFIG_PATH,
  assertHostedAgentPolicyV1,
  hostedPolicyFromSlice,
} from './claude-hosted-policy.js';
import { writeClaudeTranscript } from './claude-transcript-writer.js';
import { renderNativeContext } from '../oci/native-context-projection.mjs';
import { makeMcpSocketServer } from './mcp-socket-server.js';

/** @import { ClaudeClientArgs } from './claude-client.js' */

/**
 * The conversation id a restored transcript is written under: derived from
 * the session so a retried revival reuses the same file rather than forking a
 * second conversation out of one history.
 *
 * @param {string} sandboxSessionId
 */
const transcriptSessionUuid = sandboxSessionId => {
  const digest = createHash('sha256').update(sandboxSessionId).digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `a${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
};

/**
 * What the CLI holds instead of a credential: it insists on one and sends it
 * to the listener, which never forwards it upstream.
 */
const CREDENTIAL_PLACEHOLDER = 'claude-broker-placeholder';

/**
 * Inert composition for one dedicated native worker. Resolver capabilities
 * are never passed into the shared sandbox service. Each native owner is
 * retained before its first effect; failed cleanup remains available through
 * terminate retries.
 *
 * The daemon calls terminate without activate when reconstructing a
 * previously started controller. The lost local 9P/MCP owners are never
 * recreated as evidence of release; that path instead reclaims the one
 * resource the plan recorded and nothing else will take down — the kernel 9P
 * mount — and completes only when that reclamation is proved. See
 * `@endo/hosted-agent/recorded-cleanup.js` for the evidence it requires.
 * Fresh inert construction is cancelled by the daemon's construction kit
 * instead. The caller must pre-create and own the private mounterSocketDir
 * and keep all mount/socket paths under stable, disjoint ancestry outside
 * guest writes. Each operation requests the shared hosted policy resource
 * settings; the sandbox verifies their enforcement before handing off the slice.
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
 * @param {typeof makeClaudeClient} [powers.makeClient]
 * @param {Record<string,string>} [powers.env] Trusted native runner configuration.
 * @param {any} [powers.context] Original daemon context, only for cancellation.
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeClaudeNativeController = (powers = {}) => {
  if ('makeResume' in powers)
    throw Error('Obsolete Claude ambient resume hook is not supported');
  const {
    makeMounter = makeDefaultMounter,
    makeFilesystem,
    makeBridge = makeMcpBridgeForToolSet,
    reclaimMount = reclaimRecordedMount,
    makeMcp = makeMcpSocketServer,
    makeClient = makeClaudeClient,
    env = {},
    context,
    reportError = error =>
      console.error('Claude native cleanup pending', error),
  } = powers;
  return makeHostedSessionSupervisor({
    name: 'Claude',
    readPlan: readClaudeSessionPlan,
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
          label: 'Claude',
          env,
          makeMounter,
          ...(makeFilesystem ? { makeFilesystem } : {}),
          scopeRequest: plan => ({
            providerOrigin: ANTHROPIC_ORIGIN,
            // The account authority the plan is bound to, which the grant
            // must report.
            accountRef: plan.accountRef,
            ...(plan.subscription ? { subscription: plan.subscription } : {}),
            networkPolicy: plan.networkPolicy,
            ...(plan.model ? { model: plan.model } : {}),
          }),
          // The grant's authentication mode is the broker's own: a pool
          // renews and reports `oauth`; a single token, subscription or API
          // key, is held as `api-key`. The plan records the credential kind
          // for the placeholder variable, not the mode, so none is required
          // beyond the grant check's own.
          // The persistent Claude config directory: the conversation
          // transcript lives there, apart from the workspace, and survives
          // the incarnation.
          prepare: async ({ plan, resolver: dependencies, assertOpen }) => {
            const stateProvider = await E(dependencies).get('stateProvider');
            assertOpen();
            const state = await E(stateProvider).prepareSessionDirectory(
              plan.sandboxSessionId,
            );
            assertCopyData(harden(state));
            return state;
          },
          // The Endo tools Floot pinned reach the CLI over a per-session MCP
          // socket this controller runs; only JSON crosses it.
          tools: async ({ plan, resolver: dependencies, own, assertOpen }) => {
            const tools = await E(dependencies).get('tools');
            assertOpen();
            const bridge = await makeBridge(tools);
            assertOpen();
            const mcp = own('mcp', makeMcp({ socketDir: plan.mcpDir, bridge }));
            await mcp.start();
            return mcp;
          },
          // The CLI's own home and the MCP socket directory are binds
          // attested as binds, each held to the deployment-owned root its
          // session directory sits under.
          binds: ({ plan, prepared: state, tools: mcp }) => [
            {
              role: 'claude-state',
              kind: 'bind',
              source: state.directory,
              destination: CONFIG_PATH,
              mode: 'rw',
            },
            {
              role: 'mcp',
              kind: 'bind',
              source: plan.mcpDir,
              destination: mcp.innerDir,
              mode: 'ro',
            },
          ],
          bindRoots: ({ plan, prepared: state }) => [
            bindRootOf(state.directory),
            bindRootOf(plan.mcpDir),
          ],
          // The CLI reaches the listener's loopback endpoint and holds a
          // placeholder under the variable its credential kind reads; the
          // listener never forwards it.
          sliceEnv: ({ plan, attestation, publicNetwork }) => ({
            ...makePublicNetworkEnvironment(publicNetwork),
            ANTHROPIC_BASE_URL: attestation.endpoint,
            [CREDENTIAL_ENV_VARS[plan.credentialKind]]: CREDENTIAL_PLACEHOLDER,
          }),
          policy: { assertHostedAgentPolicyV1, hostedPolicyFromSlice },
        },
      );
      const { slice, prepared: state, tools: mcp } = envelope;
      return makeClient({
        sessionId: approved.sessionId,
        createdAt: '',
        // The client stops its protocol and disposes its slice. The shared
        // supervisor independently closes the scope and withdraws authority;
        // its mount-release proof does not rely on best-effort client cleanup.
        slice,
        workspaceMountPoint: approved.workspaceMountPoint,
        workspacePath: WORKSPACE_PATH,
        backend: 'podman',
        rootfsLabel: approved.rootfs,
        model: approved.model,
        reasoningEffort: approved.reasoningEffort,
        systemPrompt: approved.systemPrompt,
        mcpConfigPath: mcp.innerConfigPath,
        // The OCI root is read-only. Claude Code and its Bash tool still need
        // per-session config/state, so HOME stays on the slice's writable
        // tmpfs while CLAUDE_CONFIG_DIR — the transcript — is the persistent
        // mount. IS_SANDBOX: Claude refuses bypass-permissions mode for uid 0
        // unless the caller attests the process is already inside a sandbox;
        // this process is root only inside a rootless Podman user namespace.
        env: harden({
          HOME: '/tmp/claude-home',
          XDG_CONFIG_HOME: '/tmp/claude-home/.config',
          CLAUDE_CONFIG_DIR: CONFIG_PATH,
          IS_SANDBOX: '1',
        }),
        sha256: text => createHash('sha256').update(text).digest('hex'),
        projectNativeContext: (checkpoint, suffix) => {
          const rows = checkpoint.payload
            .slice(0, -1)
            .split('\n')
            .map(line => JSON.parse(line));
          const leafUuid = [...new Set(rows.map(row => row.uuid))].at(-1);
          return renderNativeContext({
            cwd: WORKSPACE_PATH,
            payload: checkpoint.payload,
            leafUuid,
            suffix,
          });
        },
        // A new incarnation restores what the stack holds, even when the CLI
        // store survived. Claude Code names a conversation's file for its session id
        // and its directory for the cwd it ran in, so both are derived rather
        // than discovered — the same records must always land in the same
        // place, or a retried revival writes a second conversation beside the
        // first.
        restoreTranscript: async records => {
          const sessionUuid = transcriptSessionUuid(approved.sandboxSessionId);
          const restored = writeClaudeTranscript(records, {
            sessionUuid,
            cwd: WORKSPACE_PATH,
            // The pinned CLI stamps its own version on records it writes;
            // a restored file is honest that the stack wrote it.
            version: 'endo-restored',
            ...(approved.model ? { model: approved.model } : {}),
          });
          if (restored === '') return undefined;
          const projectDir = path.join(
            state.directory,
            'projects',
            WORKSPACE_PATH.replace(/\//g, '-'),
          );
          await mkdir(projectDir, { recursive: true, mode: 0o700 });
          await writeFile(
            path.join(projectDir, `${sessionUuid}.jsonl`),
            restored,
            { mode: 0o600 },
          );
          // Retain identity of exactly the projection we wrote before prompt
          // admission, never derive expected history from a later guest file.
          const leafStart = restored.lastIndexOf('\n', restored.length - 2) + 1;
          return harden({
            payload: restored,
            sessionId: sessionUuid,
            leafUuid: JSON.parse(restored.slice(leafStart)).uuid,
            prefixSha256: createHash('sha256').update(restored).digest('hex'),
          });
        },
      });
    },
  });
};
harden(makeClaudeNativeController);

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
  const controller = makeClaudeNativeController({ env, context });
  const powers = await powersP;
  powers === null || Fail`Claude native controller requires null powers`;
  return controller;
};
harden(make);
