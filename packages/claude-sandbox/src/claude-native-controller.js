// @ts-check
/* global process */

/**
 * The per-session native controller the daemon session owner starts for a
 * recorded Claude session: the `client` role of the record. It activates the
 * approved plan by acquiring a scope from the native sandbox service,
 * preparing the session's persistent Claude config directory through the
 * state provider, projecting the recorded workspace through this session's
 * own 9P mounter, starting the Endo tool bridge, materialising the session's
 * credential from the recorded credentials capability into the slice's
 * environment, and only then running the Claude CLI client over the slice.
 * Construction is inert; the daemon supplies every dependency by exact
 * recorded identity through the resolver, and the guest never sees a
 * recorded path.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { mkdir, rmdir } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
  makeFsMounterKit,
  mountIdentity,
} from '@endo/9p-server/mount-caplet.js';
import { makeFsBridge9p } from '@endo/9p-server/src/fs-bridge.js';
import { assertCopyData } from '@endo/daemon/copy-data.js';
import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { makeMcpBridgeForToolSet } from '@endo/hosted-agent/mcp-bridge.js';
import { M } from '@endo/patterns';
import { makeNodeFilesystem } from '@endo/platform/fs/extended/node-fs.js';

import { makeClaudeClient } from './claude-client.js';
import { CREDENTIAL_ENV_VARS } from './claude-credential-kinds.js';
import { readClaudeSessionPlan } from './claude-session-plan.js';
import { makeTranscriptResume } from './claude-transcripts.js';
import { startMcpSocketServer } from './mcp-socket-server.js';
import { parseRootfs, rootfsLabel } from './parse-rootfs.js';

/** Slice-internal paths; the recorded host paths never reach the guest. */
const WORKSPACE_PATH = '/workspace';
const CONFIG_PATH = '/claude-config';

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
 * previously started controller. The shared sandbox scope can then be looked
 * up, but the lost local 9P/MCP owners and the issued credential grant cannot
 * be recreated as evidence of release, so that path refuses completion.
 * Fresh inert construction is cancelled by the daemon's construction kit
 * instead. The caller must pre-create and own the private mounterSocketDir
 * and keep all mount/socket paths under stable, disjoint ancestry outside
 * guest writes. Each operation requests the recorded native profile; those
 * are the sandbox's checks, and this helper is not itself evidence of the
 * hosted envelope on a live host.
 *
 * @param {object} [powers]
 * @param {(env: Record<string,string>) => ReturnType<typeof makeFsMounterKit>} [powers.makeMounter]
 * @param {(rootPath: string) => object} [powers.makeFilesystem] Projects the
 *   recorded workspace directory for the 9P mount. No daemon filesystem
 *   formula is imported: a worker retaining a disposable formula's value is
 *   closed when that formula is collected, so the plan's path is the only
 *   authority that crosses into this worker.
 * @param {typeof makeMcpBridgeForToolSet} [powers.makeBridge]
 * @param {typeof startMcpSocketServer} [powers.startMcp]
 * @param {typeof makeClaudeClient} [powers.makeClient]
 * @param {typeof makeTranscriptResume} [powers.makeResume]
 * @param {Record<string,string>} [powers.env] Trusted native runner configuration.
 * @param {any} [powers.context] Original daemon context, only for cancellation.
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeClaudeNativeController = ({
  makeMounter = env =>
    makeFsMounterKit({
      env,
      runProgram: promisify(execFile),
      makeDir: mkdir,
      removeDir: rmdir,
      makeBridge: makeFsBridge9p,
      ...mountIdentity(process),
    }),
  makeFilesystem = rootPath => makeNodeFilesystem({ rootPath }),
  makeBridge = makeMcpBridgeForToolSet,
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
  /** @type {ReturnType<typeof makeFsMounterKit> | undefined} */
  let mounter;
  /** @type {Awaited<ReturnType<typeof startMcpSocketServer>> | undefined} */
  let mcp;
  /** @type {(() => Promise<void>) | undefined} */
  let revokeCredential;
  /** @type {ReturnType<typeof makeClaudeClient> | undefined} */
  let client;
  const assertOpen = () => {
    !stopping || Fail`Claude native controller is stopping`;
  };

  // This operation must be reachable while activation is waiting for a native
  // acquisition. Parents are released only after the sandbox acknowledges
  // stop; the credential grant is revoked beside them so a failed release of
  // either is retained for a later terminate. The client's own terminate is
  // best-effort by contract, so this owner never routes its release through
  // it: a failure here rejects, and a later terminate re-invokes every
  // release — each is idempotent on success — except the revoke, which is
  // tracked and never repeated once it has succeeded.
  const closeResources = async () => {
    const sandboxClosed = sandboxScope
      ? E(sandboxScope).close()
      : Promise.resolve();
    const revoke = revokeCredential;
    const results = await Promise.allSettled([
      sandboxClosed.then(() => mounter?.close()),
      mcp?.close(),
      revoke?.().then(() => {
        // A revoked grant is gone; a retry must not revoke it again.
        if (revokeCredential === revoke) revokeCredential = undefined;
      }),
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
      const stateProvider = await E(resolver).get('stateProvider');
      assertOpen();
      // The persistent Claude config directory: the conversation transcript
      // lives there, apart from the workspace, and survives the incarnation.
      const state = await E(stateProvider).prepareSessionDirectory(
        approved.sandboxSessionId,
      );
      assertCopyData(harden(state));
      assertOpen();
      // The credential is materialised immediately before it flows into the
      // slice environment; the grant is revoked with the other resources.
      // `kind()` is interface-guaranteed on the credentials capability; an
      // unknown kind is refused rather than routed under a coerced name.
      const credentials = await E(resolver).get('credentials');
      assertOpen();
      const kind = await E(credentials).kind();
      assertOpen();
      const envVar = Object.hasOwn(CREDENTIAL_ENV_VARS, kind)
        ? CREDENTIAL_ENV_VARS[/** @type {keyof CREDENTIAL_ENV_VARS} */ (kind)]
        : undefined;
      if (envVar === undefined) {
        throw Fail`Unknown credential kind ${q(kind)}; expected one of ${q(Object.keys(CREDENTIAL_ENV_VARS).join(', '))}`;
      }
      const issued = await E(credentials).issue(approved.sessionId);
      revokeCredential = () => E(credentials).revoke(approved.sessionId);
      closeIfStopping();
      const secret = await E(issued).materialise();
      typeof secret === 'string' || Fail`Credential must materialise as text`;
      assertOpen();
      // Exactly one of the two is recorded; the parser enforces it.
      const filesystem = makeFilesystem(
        approved.workspaceHostPath ??
          /** @type {string} */ (approved.workspaceDir),
      );
      // The recorded mount settings are the operator's; the socket directory
      // is this session's and is never recorded as a setting.
      mounter = makeMounter({
        ...env,
        ...approved.mounterEnv,
        XDG_RUNTIME_DIR: approved.mounterSocketDir,
        NINEP_SOCKET_DIR: approved.mounterSocketDir,
      });
      closeIfStopping();
      // The mounter creates the mount point and must remove it on unmount;
      // the storage owner refuses to rm -rf a path that may still be mounted.
      await E(mounter.mounter).mount(
        filesystem,
        approved.workspaceMountPoint,
        harden({ removeMountPointOnUnmount: true }),
      );
      assertOpen();
      const tools = await E(resolver).get('tools');
      assertOpen();
      const bridge = await makeBridge(tools);
      assertOpen();
      mcp = await startMcp({ socketDir: approved.mcpDir, bridge });
      closeIfStopping();
      const rootfs = parseRootfs(approved.rootfs);
      const options = harden({
        rootfs,
        mounts: [
          {
            hostPath: approved.workspaceMountPoint,
            innerPath: WORKSPACE_PATH,
            mode: 'rw',
          },
          { hostPath: state.directory, innerPath: CONFIG_PATH, mode: 'rw' },
          { hostPath: approved.mcpDir, innerPath: mcp.innerDir, mode: 'ro' },
        ],
        network: approved.network,
        backend: 'podman',
        nativeProfile: approved.nativeProfile,
        cwd: WORKSPACE_PATH,
        env: { [envVar]: secret },
      });
      assertCopyData(options);
      const slice = await E(sandboxScope).makeResolved(options);
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
        const recovered = await Promise.allSettled([
          (async () => {
            if (sandboxScope) return;
            const sandbox = await E(resolver).get('sandboxService');
            sandboxScope = await E(sandbox).lookupScope(
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
