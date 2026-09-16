// @ts-check
/* global process */

/**
 * The per-session native controller the daemon session owner starts for a
 * recorded Claude session: the `client` role of the record. It activates the
 * approved plan by acquiring a scope from the native sandbox service and an
 * inference grant from the provider broker, checking the broker's evidence
 * against the recorded image and network policy, preparing the session's
 * persistent Claude config directory through the state provider, projecting
 * the recorded workspace through this session's own 9P mounter, starting the
 * Endo tool bridge, and only then running the Claude CLI client over a slice
 * that joins the broker's network namespace. The slice never holds the
 * provider credential: it sees the listener's loopback endpoint and a
 * placeholder. Construction is inert; the daemon supplies every dependency
 * by exact recorded identity through the resolver, and the guest never sees
 * a recorded path.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
import {
  HOSTED_SLICE_RESOURCES,
  sliceWritableBytes,
} from '@endo/hosted-agent/hosted-agent-policy.js';
import { M } from '@endo/patterns';
import { SLICE_POLICY_PROFILE } from '@endo/sandbox/policy.js';

import { ANTHROPIC_ORIGIN, CLAUDE_BROKER_ACCOUNT } from './claude-broker.js';
import { makeClaudeClient } from './claude-client.js';
import { CREDENTIAL_ENV_VARS } from './claude-credential-kinds.js';
import { readClaudeSessionPlan } from './claude-session-plan.js';
import {
  assertHostedAgentPolicyV1,
  hostedPolicyFromSlice,
} from './claude-hosted-policy.js';
import { writeClaudeTranscript } from './claude-transcript-writer.js';
import { makeTranscriptResume } from './claude-transcripts.js';
import { startMcpSocketServer } from './mcp-socket-server.js';
import { parseRootfs, rootfsLabel } from './parse-rootfs.js';

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

/** Slice-internal paths; the recorded host paths never reach the guest. */
const WORKSPACE_PATH = '/workspace';
const CONFIG_PATH = '/claude-config';
/**
 * What the CLI holds instead of a credential: it insists on one and sends it
 * to the listener, which never forwards it upstream.
 */
const CREDENTIAL_PLACEHOLDER = 'claude-broker-placeholder';

const ControllerInterface = M.interface('ClaudeNativeController', {
  activate: M.call(M.string(), M.remotable()).returns(M.promise()),
  send: M.call(M.string()).optional(M.record()).returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
  status: M.call().returns(M.promise()),
  terminate: M.call(M.string(), M.remotable()).returns(M.promise()),
});

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
 * guest writes. Each operation requests the recorded native profile; those
 * are the sandbox's checks, and this helper is not itself evidence of the
 * hosted envelope on a live host.
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
 * @param {typeof startMcpSocketServer} [powers.startMcp]
 * @param {typeof makeClaudeClient} [powers.makeClient]
 * @param {typeof makeTranscriptResume} [powers.makeResume]
 * @param {Record<string,string>} [powers.env] Trusted native runner configuration.
 * @param {any} [powers.context] Original daemon context, only for cancellation.
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeClaudeNativeController = ({
  makeMounter = makeDefaultMounter,
  makeFilesystem,
  makeBridge = makeMcpBridgeForToolSet,
  reclaimMount = reclaimRecordedMount,
  startMcp = startMcpSocketServer,
  makeClient = makeClaudeClient,
  makeResume = makeTranscriptResume,
  env = {},
  context,
  reportError = error => console.error('Claude native cleanup pending', error),
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
  /** @type {Awaited<ReturnType<typeof startMcpSocketServer>> | undefined} */
  let mcp;
  /** @type {ReturnType<typeof makeClaudeClient> | undefined} */
  let client;
  const assertOpen = () => {
    !stopping || Fail`Claude native controller is stopping`;
  };

  // This operation must be reachable while activation is waiting for a native
  // acquisition. Parents are released only after the sandbox acknowledges
  // stop; the broker grant is revoked beside them so a failed release of
  // either is retained for a later terminate. The client's own terminate is
  // best-effort by contract, so this owner never routes its release through
  // it: a failure here rejects, and a later terminate re-invokes every
  // release, each idempotent on success.
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
      throw AggregateError(failures, 'Claude native cleanup pending');
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
      const approved = readClaudeSessionPlan(text);
      const sandbox = await E(resolver).get('sandboxService');
      assertOpen();
      sandboxScope = await E(sandbox).provideScope(approved.sandboxSessionId);
      closeIfStopping();
      const broker = await E(resolver).get('brokerService');
      assertOpen();
      brokerScope = await E(broker).provideScope(
        approved.sandboxSessionId,
        harden({
          providerOrigin: ANTHROPIC_ORIGIN,
          accountRef: CLAUDE_BROKER_ACCOUNT,
          networkPolicy: approved.networkPolicy,
          ...(approved.model ? { model: approved.model } : {}),
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
        Fail`Claude rootfs must match the broker's pinned image`;
      const publicNetwork = assertPublicNetworkEvidence(evidence.network);
      (approved.networkPolicy === 'public-internet') ===
        (publicNetwork !== undefined) ||
        Fail`Broker network evidence does not match the recorded policy`;
      assertOpen();
      const stateProvider = await E(resolver).get('stateProvider');
      assertOpen();
      // The persistent Claude config directory: the conversation transcript
      // lives there, apart from the workspace, and survives the incarnation.
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
      const tools = await E(resolver).get('tools');
      assertOpen();
      const bridge = await makeBridge(tools);
      assertOpen();
      mcp = await startMcp({ socketDir: approved.mcpDir, bridge });
      closeIfStopping();
      // The attested mount table. The workspace is the 9P projection this
      // controller just established, so the sandbox can prove the slice sees
      // a projection rather than host data; the CLI's own home and the MCP
      // socket directory are binds attested as binds, each held to the
      // deployment-owned root its session directory sits under. `/tmp` and
      // `/run` are declared with ceilings rather than left to whatever
      // `--read-only-tmpfs` gives, which matters because `HOME` is on `/tmp`.
      const mounts = [
        {
          role: 'workspace',
          kind: /** @type {const} */ ('attach'),
          source: approved.workspaceMountPoint,
          destination: WORKSPACE_PATH,
          mode: /** @type {const} */ ('rw'),
        },
        {
          role: 'claude-state',
          kind: /** @type {const} */ ('bind'),
          source: state.directory,
          destination: CONFIG_PATH,
          mode: /** @type {const} */ ('rw'),
        },
        {
          role: 'mcp',
          kind: /** @type {const} */ ('bind'),
          source: approved.mcpDir,
          destination: mcp.innerDir,
          mode: /** @type {const} */ ('ro'),
        },
        {
          role: 'tmp',
          kind: /** @type {const} */ ('tmpfs'),
          destination: '/tmp',
          sizeBytes: 1024n ** 3n,
        },
        {
          role: 'run',
          kind: /** @type {const} */ ('tmpfs'),
          destination: '/run',
          sizeBytes: 256n * 1024n ** 2n,
        },
      ];
      // A public-network session gets the operator's generated nameserver
      // file as a declared mount, the way Codex does, rather than as a
      // `generatedFiles` entry the attested table has no row for. The
      // hosted contract expects this row whenever the policy is
      // public-internet, so writing the file some other way would leave the
      // handoff check looking for a mount that is not there.
      if (publicNetwork) {
        /** @type {any[]} */ (mounts).unshift({
          role: /** @type {const} */ ('resolver'),
          kind: /** @type {const} */ ('resolver'),
          source: publicNetwork.resolverConfigPath,
          destination: /** @type {const} */ ('/etc/resolv.conf'),
          mode: /** @type {const} */ ('ro'),
        });
      }
      const options = harden({
        rootfs,
        // The policy path derives the namespace from the attested sidecar
        // rather than being handed a container to join.
        network: 'broker-only',
        cwd: WORKSPACE_PATH,
        policy: {
          profile: SLICE_POLICY_PROFILE,
          imageDigest: evidence.imageDigest,
          uid: 1000,
          gid: 1000,
          brokerSidecar: { container: evidence.brokerSidecar.container },
          resources: {
            ...HOSTED_SLICE_RESOURCES,
            writableBytes: sliceWritableBytes(mounts),
          },
          mounts,
          // The parents of this session's own directories: the roots this
          // deployment owns and allocates under. A bind outside them is
          // refused, which is what makes the row worth attesting.
          bindRoots: [
            path.dirname(state.directory),
            path.dirname(approved.mcpDir),
          ],
          attestationArgv: ['/bin/sleep', 'infinity'],
        },
        env: {
          ...makePublicNetworkEnvironment(publicNetwork),
          // The CLI reaches the listener's loopback endpoint and holds a
          // placeholder under the variable its credential kind reads; the
          // listener never forwards it.
          ANTHROPIC_BASE_URL: attestation.endpoint,
          [CREDENTIAL_ENV_VARS[approved.credentialKind]]:
            CREDENTIAL_PLACEHOLDER,
        },
      });
      assertCopyData(options);
      // `make`, not `makeResolved`: the runtime returns a slice only once its
      // mount table verifies against the anchor's own, which is also what
      // lets this adapter take runtime attaches it previously had to refuse.
      const slice = await E(sandboxScope).make(options);
      // Checked twice. The runtime proved the slice's confinement to itself;
      // this proves the slice it returned is the one this session was
      // promised — the hosted contract's controls, this profile's roles, and
      // no mount the table did not declare. Codex has always done this at its
      // authority handoff; the other two did not, because they had no
      // attestation to restate.
      assertHostedAgentPolicyV1(
        hostedPolicyFromSlice({
          attestation: await E(slice).policy(),
          sessionId: approved.sandboxSessionId,
          credentialInjection: 'broker-only',
          brokerTransport: 'loopback-sidecar',
          executionDomain: 'guest',
          ...(publicNetwork ? { networkPolicy: 'public-internet' } : {}),
        }),
        {
          imageDigest: evidence.imageDigest,
          sessionId: approved.sandboxSessionId,
          ...(publicNetwork ? { networkPolicy: 'public-internet' } : {}),
        },
      );
      closeIfStopping();
      const resume = makeResume(state.directory, {
        debug: Boolean(process.env.ENDO_CLAUDE_DEBUG_RESUME),
      });
      let resumePriorConversation = false;
      try {
        resumePriorConversation = resume.detectPriorConversation();
      } catch {
        // The per-spawn detector decides; a failed one-shot read resumes nothing.
      }
      client = makeClient({
        sessionId: approved.sessionId,
        createdAt: '',
        // The client disposes the slice on its terminate; every other owner
        // is released by this controller afterwards, never through the
        // client's best-effort mount handle.
        slice,
        workspaceMountPoint: approved.workspaceMountPoint,
        workspacePath: WORKSPACE_PATH,
        backend: 'podman',
        rootfsLabel: rootfsLabel(rootfs),
        model: approved.model,
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
        resumePriorConversation,
        detectPriorConversation: resume.detectPriorConversation,
        resolveResumeSessionId: resume.resolveResumeSessionId,
        describeTranscripts: resume.describeTranscripts,
        // A new incarnation with an empty store restores what the stack
        // holds. Claude Code names a conversation's file for its session id
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
          return sessionUuid;
        },
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
        const recoveredPlan = readClaudeSessionPlan(text);
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
      // Fence a still-pending activation by releasing what it has acquired
      // so far; a completed activation is released once, after the client
      // has disposed its slice.
      const early = client ? undefined : closeResources();
      await Promise.allSettled([activating, early]);
      if (client) await E(client).terminate();
      await closeResources();
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
      void (
        client ? E(client).terminate().then(closeResources) : closeResources()
      ).catch(reportError);
    };
    void E(context).whenCancelled().then(lost, lost);
  }
  return makeExo('ClaudeNativeController', ControllerInterface, {
    activate,
    send: async (prompt, options = {}) => {
      assertOpen();
      if (client === undefined)
        throw Fail`Claude native controller is not active`;
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
