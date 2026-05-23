// @ts-check
/* global setTimeout, clearTimeout */
/**
 * @import {
 *   BootConfigMessage,
 *   CreateSessionRequest,
 *   OrchestratorConfig,
 *   Session,
 * } from '../protocol.types.js'
 */

import process from 'node:process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { makeSessionManager } from './sessions/session-manager.js';
import { makeNetworkController } from './network/index.js';
import { spawnVm } from './qemu/spawner.js';
import { awaitHello } from './bootstrap/rpc-server.js';
import { makeAgentLink } from './agent/rpc-server.js';
import { makeBrokerClient } from './broker-client/index.js';
import { makeApiServer } from './api/server.js';
import { makeStdioMux } from './stdio/mux.js';

/**
 * Build the orchestrator config from environment with sane defaults.
 *
 * @returns {OrchestratorConfig}
 */
export const configFromEnv = () => {
  const env = process.env;
  return harden({
    socketPath: env.CLAUDE_ORCH_SOCKET || '/run/claude-orch/api.sock',
    imageDir: env.CLAUDE_ORCH_IMAGE_DIR || '/opt/claude-orch/share/images',
    sessionDir: env.CLAUDE_ORCH_SESSION_DIR || '/run/claude-orch/sessions',
    brokerSocketPath:
      env.CLAUDE_ORCH_BROKER_SOCKET || '/run/claude-orch/broker.sock',
    statePath:
      env.CLAUDE_ORCH_STATE_PATH || '/var/lib/claude-orch/sessions.json',
    defaults: {
      arch: process.arch === 'arm64' ? 'aarch64' : 'x86_64',
      vcpus: Number(env.CLAUDE_ORCH_DEFAULT_VCPUS || 2),
      memMB: Number(env.CLAUDE_ORCH_DEFAULT_MEM_MB || 2048),
    },
    bootDeadlineMs: Number(env.CLAUDE_ORCH_BOOT_DEADLINE_MS || 30_000),
    heartbeatTimeoutMs: Number(env.CLAUDE_ORCH_HEARTBEAT_TIMEOUT_MS || 60_000),
  });
};
harden(configFromEnv);

/**
 * Check whether a PID is alive. Returns false if the process has exited
 * or if we lack permission to signal it.
 *
 * @param {number | undefined} pid
 */
const pidAlive = pid => {
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Build and start the orchestrator. Returns a stop() function for graceful
 * shutdown (used by tests and the bin/claude-orch entry point).
 *
 * Dependencies are injectable so tests can wire stubs that don't require
 * nftables/pfctl, a credential broker, or QEMU on PATH. Defaults pull
 * the real ones from sibling modules.
 *
 * @param {{
 *   config?: OrchestratorConfig,
 *   networkController?: import('../protocol.types.js').NetworkController,
 *   brokerClient?: ReturnType<typeof makeBrokerClient>,
 *   spawnVm?: typeof spawnVm,
 * }} [opts]
 */
export const start = async ({
  config = configFromEnv(),
  networkController,
  brokerClient,
  spawnVm: spawnVmFn = spawnVm,
} = {}) => {
  await mkdir(path.dirname(config.socketPath), {
    recursive: true,
    mode: 0o750,
  });
  await mkdir(config.sessionDir, { recursive: true, mode: 0o750 });
  if (config.statePath) {
    await mkdir(path.dirname(config.statePath), {
      recursive: true,
      mode: 0o750,
    });
  }

  const sessions = makeSessionManager({
    config,
    persistencePath: config.statePath,
  });
  const network = networkController ?? makeNetworkController();
  await network.initialize();

  // Restore prior sessions from disk and mark each one either `unhealthy`
  // (vmPid still alive — we lost the agent link but the VM survives) or
  // `terminated` (vmPid is gone). Subsequent operator action via the
  // API determines next steps.
  if (config.statePath) {
    const restored = await sessions.restoreFromDisk();
    for (const rec of restored) {
      if (pidAlive(rec.vmPid)) {
        sessions.setState(rec.id, 'unhealthy');
      } else {
        sessions.setState(rec.id, 'terminated', {
          failureReason: 'orphaned after orchestrator restart',
        });
      }
    }
  }

  const broker =
    brokerClient ?? makeBrokerClient({ socketPath: config.brokerSocketPath });

  // Track running VMs so terminate can find and kill them.
  /** @type {Map<string, import('./qemu/spawner.js').VmHandle>} */
  const vms = new Map();
  /** @type {Map<string, import('./agent/rpc-server.js').AgentLink>} */
  const agents = new Map();
  /** @type {Map<string, () => Promise<void>>} */
  const netCleanups = new Map();
  /** @type {Map<string, ReturnType<typeof makeStdioMux>>} */
  const stdioMuxes = new Map();
  /**
   * Per-session credential subscription opened against the broker.
   * The first push satisfies BootConfig assembly; subsequent
   * pushes are relayed to the agent over `link.send({type:
   * 'rotate_creds', ...})`. Closed when the session ends.
   *
   * @type {Map<string, import('./broker-client/index.js').CredentialSubscription>}
   */
  const credSubscriptions = new Map();

  /**
   * @param {CreateSessionRequest} request
   * @returns {Promise<Session>}
   */
  const createSession = async request => {
    const record = await sessions.createSession(request);
    return sessions.toSession(record);
  };

  /**
   * @param {string} sessionId
   */
  const markReady = async sessionId => {
    const record = sessions.getRecord(sessionId);
    if (!record) throw new Error(`Unknown session ${sessionId}`);
    if (record.state !== 'pending') {
      throw new Error(
        `Session ${sessionId} is ${record.state}, expected pending.`,
      );
    }

    // Boot path runs under a single try/catch so any failure —
    // network attach, ctl.sock/agent.sock bind, QEMU spawn,
    // bootstrap/agent handshake — leaves the session in
    // `boot_failed` with all per-session resources cleaned up.
    // Pre-PR the early steps threw out of `markReady` without
    // setting state or revoking the broker's per-session record
    // (Copilot review round 3 #14).
    /** @type {ReturnType<typeof makeAgentLink> | undefined} */
    let agentPromise;
    /** @type {ReturnType<typeof spawnVmFn> | undefined} */
    let vm;
    try {
      // Caller has bound the fs.sock; spawn QEMU now.
      const arch = resolveArch(record.request, config);
      const netAttachment = await network.attachSession(record.id, {
        mode: record.request.network,
      });
      netCleanups.set(sessionId, netAttachment.cleanup);
      sessions.setState(sessionId, 'booting', { netAttachment });

      // Open the broker subscription unless the caller supplied
      // their own credentials on the createSession request (which
      // are static and not subject to broker-driven rotation). The
      // subscribe call yields the initial credentials immediately;
      // every subsequent broker push gets relayed to the agent.
      if (!record.request.credentials) {
        const sub = await broker.subscribe(sessionId);
        credSubscriptions.set(sessionId, sub);
        sub.onRotate(creds => {
          // The agent.link may not be set up yet if rotation fires
          // during the brief window between subscribe and the
          // guest connecting — drop silently in that case; the
          // BootConfig delivered later will carry the latest
          // creds via `sub.initial`, refreshed below.
          const link = agents.get(sessionId);
          if (!link) return;
          link.send({ type: 'rotate_creds', credentials: creds });
        });
        sub.onError(msg => {
          // Surface but don't fail the session — the broker will
          // retry on its own schedule.
          // eslint-disable-next-line no-console
          console.error(`[rotation ${sessionId}] broker error: ${msg}`);
        });
      }

      // Boot-phase RPCs: bind the bootstrap (ctl.sock) and agent
      // (agent.sock) UDS endpoints BEFORE spawning the VM, so the
      // guest finds them at boot. The hello/link promises stay
      // outstanding until the guest connects and the handshakes
      // complete.
      const bootstrap = awaitHello({
        ctlSocketPath: record.ctlSocketPath,
        sessionId,
        consumeNonce: (sid, nonce) => sessions.consumeBootNonce(sid, nonce),
        buildBootConfig: async () => buildBootConfigForSession(sessionId),
        deadlineMs: config.bootDeadlineMs,
      });
      agentPromise = makeAgentLink({
        agentSocketPath: record.agentSocketPath,
      });
      await Promise.all([bootstrap.ready, agentPromise.ready]);

      vm = spawnVmFn({
        arch,
        record,
        config,
        netArgs: netAttachment.qemuArgs,
      });
      vms.set(sessionId, vm);

      // If the VM dies unexpectedly, surface the failure AND tear
      // down all per-session resources (net tap, agent socket,
      // stdio mux, broker credentials).
      vm.exitCode
        .then(async code => {
          const cur = sessions.getRecord(sessionId);
          if (!cur) return;
          if (cur.state === 'terminated') return; // graceful DELETE already ran
          const wasReady = cur.state === 'ready' || cur.state === 'unhealthy';
          sessions.setState(
            sessionId,
            wasReady ? 'terminated' : 'boot_failed',
            {
              failureReason: wasReady
                ? `qemu exited ${code}`
                : `qemu exited ${code} before ready`,
            },
          );
          await teardownSession(sessionId).catch(() => {});
        })
        .catch(() => {});

      await bootstrap.hello;
      const link = await agentPromise.link;
      agents.set(sessionId, link);
      // Now that `link` owns the connection, the standalone agent
      // server is no longer needed; teardownSession() will close it
      // via `link.close()` rather than `agentPromise.stop()`.
      agentPromise = undefined;
      await link.ready();

      // Start the stdio multiplexer if the caller asked for an attach stream.
      if (record.request.attachMode === 'stream') {
        const mux = makeStdioMux({
          stdioSocketPath: record.stdioSocketPath,
          attachSocketPath: record.attachSocketPath,
          onError: e => {
            // eslint-disable-next-line no-console
            console.error(`[stdio-mux ${sessionId}]`, e);
          },
        });
        stdioMuxes.set(sessionId, mux);
        await mux.start();
        // Tell the agent to begin attach framing on its end.
        link.send({ type: 'attach', streamId: 'default0' });
      }

      sessions.setState(sessionId, 'ready', { vmPid: vm.pid });
    } catch (e) {
      sessions.setState(sessionId, 'boot_failed', {
        failureReason: /** @type {Error} */ (e).message,
      });
      // If the guest never connected, the agent's listening server
      // is still bound and isn't in the `agents` map — so
      // teardownSession() wouldn't release it. Close it explicitly.
      // Copilot review round 3 #19.
      if (agentPromise) {
        try {
          agentPromise.stop();
        } catch {
          // ignore
        }
      }
      if (vm) {
        try {
          vm.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      // Best-effort cleanup. The broker subscription is closed
      // inside `teardownSession`; nothing else to revoke since the
      // new protocol has no per-session broker state beyond the
      // subscription itself.
      await teardownSession(sessionId).catch(() => {});
      throw e;
    }
  };

  /**
   * @param {string} sessionId
   * @returns {Promise<BootConfigMessage>}
   */
  const buildBootConfigForSession = async sessionId => {
    const record = sessions.getRecord(sessionId);
    if (!record) throw new Error(`Unknown session ${sessionId}`);
    // Caller-supplied credentials (e.g. from a ClaudeCredentials
    // cap on the Endo side) are static and bypass the broker. The
    // markReady path doesn't open a subscription for those
    // sessions, so the BootConfig carries those bytes once and
    // never rotates.
    //
    // Otherwise the broker subscription's `initial` is the
    // freshly-issued credentials (the same that subsequent rotations
    // will push). The subscription was opened in `markReady` above
    // before this callback fires.
    let credentials;
    if (record.request.credentials) {
      credentials = harden(record.request.credentials);
    } else {
      const sub = credSubscriptions.get(sessionId);
      if (!sub) {
        throw new Error(
          `buildBootConfigForSession ${sessionId}: no broker subscription`,
        );
      }
      credentials = harden(sub.initial);
    }
    return harden({
      type: /** @type {'boot_config'} */ ('boot_config'),
      credentials,
      fsMountTag: 'workspace',
      workspaceUidGid: /** @type {[number, number]} */ ([1000, 1000]),
      envExtra: record.request.envExtra ?? {},
      initialPrompt: record.request.initialPrompt,
      agentControlPort: '/dev/virtio-ports/agent',
    });
  };

  /**
   * @param {string} sessionId
   */
  const terminateSession = async sessionId => {
    const link = agents.get(sessionId);
    if (link) {
      try {
        link.send({ type: 'terminate', graceMs: 5000 });
      } catch {
        // Best-effort.
      }
    }
    const vm = vms.get(sessionId);
    if (vm) {
      vm.kill('SIGTERM');
      // SIGKILL escalator. Cleared below on graceful exit; unref'd
      // so a session being torn down can't keep the orchestrator
      // process alive past its own shutdown.
      const killer = setTimeout(() => vm.kill('SIGKILL'), 5000);
      killer.unref();
      await vm.exitCode.catch(() => {});
      clearTimeout(killer);
    }
    await teardownSession(sessionId);
    sessions.setState(sessionId, 'terminated');
    await sessions.forget(sessionId);
  };

  /**
   * @param {string} sessionId
   */
  const teardownSession = async sessionId => {
    const mux = stdioMuxes.get(sessionId);
    if (mux) {
      await mux.stop().catch(() => {});
      stdioMuxes.delete(sessionId);
    }
    if (agents.has(sessionId)) {
      agents.get(sessionId)?.close();
      agents.delete(sessionId);
    }
    if (vms.has(sessionId)) {
      vms.delete(sessionId);
    }
    const cleanup = netCleanups.get(sessionId);
    if (cleanup) {
      await cleanup().catch(() => {});
      netCleanups.delete(sessionId);
    }
    const sub = credSubscriptions.get(sessionId);
    if (sub) {
      await sub.close().catch(() => {});
      credSubscriptions.delete(sessionId);
    }
  };

  const api = makeApiServer({
    socketPath: config.socketPath,
    handlers: {
      createSession,
      listSessions: () => sessions.listSessions(),
      getSession: id => sessions.getSession(id),
      markReady,
      terminateSession,
    },
  });
  // Hold the server in closure rather than returning it: harden() would
  // recursively freeze the http.Server's EventEmitter internals, breaking
  // all subsequent socket/listener operations across the process.
  await api.listen();

  return harden({
    async stop() {
      const ids = sessions.listSessions().map(s => s.id);
      await Promise.allSettled(ids.map(id => terminateSession(id)));
      await api.close();
      await network.shutdown();
    },
  });
};
harden(start);

/**
 * @param {CreateSessionRequest} request
 * @param {OrchestratorConfig} config
 * @returns {import('../protocol.types.js').Arch}
 */
const resolveArch = (request, config) => request.arch ?? config.defaults.arch;
