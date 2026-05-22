// @ts-check
/* global setTimeout, clearTimeout, setInterval, clearInterval */
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
    // Default 0 = disabled. Operators flip this on (e.g., 30_000 for
    // a 30s tick) once the broker is wired with a real rotatePolicy
    // — see DESIGN.md §5.5 and the broker's `rotatePolicy` injection
    // point. With no policy the broker returns noop on every tick
    // and we'd be polling for nothing.
    rotationIntervalMs: Number(env.CLAUDE_ORCH_ROTATION_INTERVAL_MS || 0),
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
          await broker.revoke(sessionId).catch(() => {});
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

      sessions.setState(sessionId, 'ready', { vmPid: vm.child.pid });
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
      // Best-effort cleanup. Credentials may already have been issued
      // by buildBootConfigForSession() above, so revoke them so the
      // broker doesn't hold stale per-session state.
      await teardownSession(sessionId).catch(() => {});
      await broker.revoke(sessionId).catch(() => {});
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
    // cap on the Endo side) take precedence over the broker. v1
    // simply uses them as-is; future v2 may rotate through the
    // broker for revocation tracking even when the caller
    // supplies the initial key.
    const credentials = record.request.credentials
      ? harden(record.request.credentials)
      : await broker.issue(sessionId);
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
      const killer = setTimeout(() => vm.kill('SIGKILL'), 5000);
      await vm.exitCode.catch(() => {});
      clearTimeout(killer);
    }
    await teardownSession(sessionId);
    sessions.setState(sessionId, 'terminated');
    await broker.revoke(sessionId).catch(() => {});
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

  /**
   * Ask the broker for a fresh credential payload for `sessionId`. If
   * the broker returns one (i.e. `rotate_if_needed` is configured
   * with a real policy rather than the v1 noop), push it to the
   * runtime-agent over the agent.sock link as `{type: 'rotate_creds'}`.
   *
   * Returns whether a rotation was actually sent — `false` when the
   * broker returned noop or when no agent link is open. Surfaced on
   * the `start()` return value so operators / future scheduling code
   * can call it; today this is exercised primarily by
   * `e2e-smoke.test.js`'s round-trip case.
   *
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  const rotateCreds = async sessionId => {
    const creds = await broker.rotateIfNeeded(sessionId);
    if (!creds) return false;
    const link = agents.get(sessionId);
    if (!link) return false;
    link.send({ type: 'rotate_creds', credentials: creds });
    return true;
  };

  /**
   * Sweep every ready session, asking the broker whether credentials
   * need refreshing and pushing `rotate_creds` to any agent the broker
   * answers for. Failures on one session don't poison the rest of the
   * sweep. Used by the scheduled-rotation loop below; also exposed on
   * the start() return so operators can force a sweep on demand.
   *
   * @returns {Promise<{ session: string, rotated: boolean, error?: string }[]>}
   */
  const rotateAllSessions = async () => {
    // Sweep in parallel: each session's rotation is independent
    // (broker.rotateIfNeeded is per-session) and we don't want a slow
    // policy on one session to block the rest of the tick. Use
    // `allSettled` so one failure doesn't poison the report.
    const ready = sessions.listRecords().filter(r => r.state === 'ready');
    const settled = await Promise.allSettled(
      ready.map(async r => ({
        session: r.id,
        rotated: await rotateCreds(r.id),
      })),
    );
    return settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            session: ready[i].id,
            rotated: false,
            error: /** @type {Error} */ (s.reason).message,
          },
    );
  };

  // Rotation scheduler. Wakes every `config.rotationIntervalMs` and
  // sweeps ready sessions. Operators enable it only after the broker
  // is configured with a real `rotatePolicy` (e.g. an OAuth refresher
  // — see DESIGN.md §5.5). With the default api-key broker, every
  // tick returns noop and the scheduler is just overhead, so the
  // sensible default is `0` (disabled).
  const rotationIntervalMs = config.rotationIntervalMs ?? 0;
  /** @type {NodeJS.Timeout | null} */
  let rotationTimer = null;
  if (rotationIntervalMs > 0) {
    rotationTimer = setInterval(() => {
      rotateAllSessions().catch(e => {
        // eslint-disable-next-line no-console
        console.error('[rotation] sweep failed:', e);
      });
    }, rotationIntervalMs);
    // Don't hold the event loop open just for the rotation tick.
    if (typeof rotationTimer.unref === 'function') rotationTimer.unref();
  }

  return harden({
    rotateCreds,
    rotateAllSessions,
    async stop() {
      if (rotationTimer) {
        clearInterval(rotationTimer);
        rotationTimer = null;
      }
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
