// @ts-check
/* global setImmediate */
/**
 * @import {
 *   CreateSessionRequest,
 *   OrchestratorConfig,
 *   Session,
 *   SessionRecord,
 *   SessionState,
 *   SessionSummary,
 * } from '../../protocol.types.js'
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * In-memory session table plus per-session lifecycle helpers.
 *
 * The session manager owns:
 *   - session id allocation
 *   - the boot nonce (single-use; see DESIGN.md §5.3)
 *   - per-session UDS path allocation under <config.sessionDir>/<id>/
 *   - state transitions and the table of records
 *   - optional disk persistence of the table to a sessions.json file
 *
 * It does NOT own QEMU, networking, RPC, or the API server. Those are
 * orchestrated by the higher-level main entrypoint, which calls
 * session-manager methods at the appropriate lifecycle points.
 *
 * @param {{
 *   config: OrchestratorConfig,
 *   persistencePath?: string,
 * }} opts
 */
export const makeSessionManager = ({ config, persistencePath }) => {
  /** @type {Map<string, SessionRecord>} */
  const sessions = new Map();
  let persistTimer = null;

  // Sessions live under config.sessionDir. Anything restored from disk
  // is treated as untrusted: the JSON file could have been edited or
  // corrupted, and `record.sessionDir` feeds a `rm -rf`-equivalent in
  // `forget()`. Refuse any record whose sessionDir doesn't land inside
  // our sessionDir prefix.
  const sessionDirRoot = path.resolve(config.sessionDir);

  // The minimal record shape downstream code touches after restore:
  // `state` (string), `request.{network, attachMode}`, and the three
  // UDS path strings (`ctlSocketPath`, `agentSocketPath`,
  // `fsSocketPath`; `attachSocketPath` is optional because attachMode
  // can be 'none'). Any record missing one of these will crash a
  // later API read or QEMU spawn, so reject at load time.
  const VALID_NETWORKS = new Set(['egress', 'none']);
  const VALID_ATTACH_MODES = new Set(['stream', 'none']);
  // Every per-session UDS that downstream code reads off the
  // restored record must be present. Today that's the four chardev
  // paths driven by `qemu/args.js` (ctl, agent, fs, stdio) plus the
  // QMP socket QEMU listens on for `system_reset`/`quit` from the
  // orchestrator. `attachSocketPath` is conditional on
  // `attachMode === 'stream'` and checked separately below.
  const SOCKET_PATH_KEYS = /** @type {const} */ ([
    'ctlSocketPath',
    'agentSocketPath',
    'fsSocketPath',
    'stdioSocketPath',
    'qmpSocketPath',
  ]);

  /**
   * @param {unknown} rec
   * @returns {rec is SessionRecord}
   */
  const isPlausibleRecord = rec => {
    if (rec === null || typeof rec !== 'object') return false;
    const r = /** @type {Record<string, unknown>} */ (rec);
    if (typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(r.id))
      return false;
    if (typeof r.sessionDir !== 'string' || r.sessionDir === '') return false;
    const resolved = path.resolve(r.sessionDir);
    // Refuse traversal: sessionDir must be directly under sessionDirRoot
    // and named like the session id.
    if (path.dirname(resolved) !== sessionDirRoot) return false;
    if (path.basename(resolved) !== r.id) return false;

    if (typeof r.state !== 'string' || r.state.length === 0) return false;

    if (r.request === null || typeof r.request !== 'object') return false;
    const req = /** @type {Record<string, unknown>} */ (r.request);
    if (!VALID_NETWORKS.has(/** @type {string} */ (req.network))) return false;
    if (!VALID_ATTACH_MODES.has(/** @type {string} */ (req.attachMode))) {
      return false;
    }

    for (const key of SOCKET_PATH_KEYS) {
      if (typeof r[key] !== 'string' || r[key] === '') return false;
    }
    // attachSocketPath is only present when attachMode === 'stream'.
    if (req.attachMode === 'stream') {
      if (typeof r.attachSocketPath !== 'string' || r.attachSocketPath === '') {
        return false;
      }
    }
    return true;
  };

  /**
   * Strip the API key out of `request.credentials` (and any other
   * sub-key whose name suggests a secret). Sessions don't recreate
   * the BootConfig on restart from disk; the credentials cap that
   * fed the original `createSession` is gone, so persisting the key
   * bytes here would only ever leak them. See kumavis review #2 on
   * PR #328 — the persisted projection used to keep
   * `request.credentials.apiKey` in a world-readable file.
   *
   * @param {SessionRecord} r
   */
  const sanitizeForPersist = r => {
    const { request, ...rest } = r;
    /** @type {Record<string, unknown> | undefined} */
    let sanitizedRequest;
    if (request !== undefined) {
      // Drop `credentials` entirely from the persisted projection.
      // The orchestrator only needs it during the live boot path; if
      // a restart loses the in-memory record's credentials, the
      // session should be torn down (its bootNonce has already been
      // marked used by `restoreFromDisk`).
      const { credentials: _dropCreds, ...restRequest } = request;
      sanitizedRequest = restRequest;
    }
    return {
      ...rest,
      request: sanitizedRequest,
      // Drop runtime-only fields that don't survive restart.
      netAttachment: undefined,
    };
  };

  // Serialize concurrent `persistNow()` calls. Two callers racing
  // on the same `sessions.json.tmp` would have one rename the tmp
  // out from under the other; the loser gets `ENOENT: rename
  // sessions.json.tmp -> sessions.json`. The macOS test runners
  // surfaced this consistently once `consumeBootNonce` started
  // awaiting `persistNow()` directly (Copilot review round 3 #17)
  // while other call sites still routed through `schedulePersist`'s
  // `setImmediate`.
  /** @type {Promise<unknown>} */
  let persistQueue = Promise.resolve();
  const persistNow = () => {
    if (!persistencePath) return Promise.resolve();
    persistQueue = persistQueue
      .catch(() => {
        // a prior write failed; don't propagate the rejection into the next
      })
      .then(async () => {
        const entries = Array.from(sessions.values()).map(sanitizeForPersist);
        const tmp = `${persistencePath}.tmp`;
        // 0600 — sessions.json carries session ids, UDS paths, and a
        // (sanitized) request projection. Cross-UID readers don't need
        // any of that. Set the mode at create time rather than
        // chmod'ing after, so there's no window where the file is
        // world-readable.
        await writeFile(tmp, JSON.stringify(entries, null, 2), {
          mode: 0o600,
        });
        await rename(tmp, persistencePath);
      });
    return persistQueue;
  };

  const schedulePersist = () => {
    if (!persistencePath) return;
    if (persistTimer) return;
    persistTimer = setImmediate(() => {
      persistTimer = null;
      persistNow().catch(() => {
        // best-effort
      });
    });
  };

  /**
   * @param {SessionRecord} record
   * @returns {Session}
   */
  const toSession = record => ({
    id: record.id,
    state: record.state,
    fsSocketPath: record.fsSocketPath,
    controlSocketPath: record.ctlSocketPath,
    attachSocketPath:
      record.request.attachMode === 'stream'
        ? record.attachSocketPath
        : undefined,
    createdAt: record.createdAt,
  });

  /**
   * @param {SessionRecord} record
   * @returns {SessionSummary}
   */
  const toSummary = record => ({
    id: record.id,
    state: record.state,
    createdAt: record.createdAt,
  });

  /**
   * Generate a session id. Short (8 hex) is appended to network device names
   * so the id needs no more entropy than that; the full id is the directory
   * name and the API handle.
   */
  const generateSessionId = () => randomUUID().replace(/-/g, '').slice(0, 16);

  /**
   * @param {CreateSessionRequest} request
   * @returns {Promise<SessionRecord>}
   */
  const createSession = async request => {
    const id = generateSessionId();
    const sessionDir = path.join(config.sessionDir, id);
    // 0o700: only the orchestrator UID can list/traverse the per-session
    // dir, which contains the fs/ctl/agent/stdio/attach UDS endpoints.
    // Anything looser would let any local group member connect to those
    // sockets and impersonate the session.
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });

    /** @type {SessionRecord} */
    const record = {
      id,
      state: 'pending',
      request,
      bootNonce: randomBytes(32).toString('hex'),
      bootNonceUsed: false,
      sessionDir,
      fsSocketPath: path.join(sessionDir, 'fs.sock'),
      ctlSocketPath: path.join(sessionDir, 'ctl.sock'),
      agentSocketPath: path.join(sessionDir, 'agent.sock'),
      stdioSocketPath: path.join(sessionDir, 'stdio.sock'),
      qmpSocketPath: path.join(sessionDir, 'qmp.sock'),
      attachSocketPath: path.join(sessionDir, 'attach.sock'),
      createdAt: new Date().toISOString(),
    };

    sessions.set(id, record);
    schedulePersist();
    return record;
  };

  /**
   * @param {string} id
   * @returns {SessionRecord | undefined}
   */
  const getRecord = id => sessions.get(id);

  /**
   * @param {string} id
   * @returns {Session | undefined}
   */
  const getSession = id => {
    const record = sessions.get(id);
    return record ? toSession(record) : undefined;
  };

  /**
   * @returns {SessionSummary[]}
   */
  const listSessions = () => Array.from(sessions.values(), toSummary);

  /**
   * @param {string} id
   * @param {SessionState} state
   * @param {Partial<SessionRecord>} [updates]
   */
  const setState = (id, state, updates = {}) => {
    const record = sessions.get(id);
    if (!record) {
      throw new Error(`Unknown session ${id}`);
    }
    record.state = state;
    Object.assign(record, updates);
    if (state === 'ready' && !record.readyAt) {
      record.readyAt = new Date().toISOString();
    }
    if (
      (state === 'terminated' || state === 'boot_failed') &&
      !record.terminatedAt
    ) {
      record.terminatedAt = new Date().toISOString();
    }
    schedulePersist();
  };

  /**
   * Validate and single-use the boot nonce from a Hello message.
   * Async because we `await persistNow()` before returning — see
   * Copilot review round 3 #17 for the durability rationale.
   *
   * @param {string} id
   * @param {string} nonce
   * @returns {Promise<boolean>}
   */
  const consumeBootNonce = async (id, nonce) => {
    const record = sessions.get(id);
    if (!record) return false;
    if (record.bootNonceUsed) return false;
    if (record.bootNonce !== nonce) return false;
    record.bootNonceUsed = true;
    record.bootNonce = ''; // purge from memory
    // Flush the consumed-nonce flag to disk synchronously rather
    // than via `schedulePersist()`'s setImmediate(). A crash between
    // consumption and the next state transition would otherwise
    // leave a still-redeemable nonce on disk; awaiting `persistNow()`
    // makes the single-use invariant durable in the strict sense
    // the boot-nonce contract claims. Cheap: the projection is
    // ~few-record JSON, and consumeBootNonce only fires once per
    // session boot. (Copilot review round 3 #17.)
    await persistNow();
    return true;
  };

  /**
   * Remove a session from the table and clean its UDS directory.
   * Leaves the network/QEMU side to the caller (it owns those handles).
   *
   * @param {string} id
   */
  const forget = async id => {
    const record = sessions.get(id);
    if (!record) return;
    sessions.delete(id);
    schedulePersist();
    await rm(record.sessionDir, { recursive: true, force: true });
  };

  /**
   * Restore session records from disk. Called at orchestrator startup.
   * Restored records keep whatever `state` was persisted (we can't
   * prove QEMU is still alive from here); the boot nonce is the only
   * field we mutate, purging it so a session that survives a restart
   * cannot re-redeem its single-use Hello. The caller in `main.js`
   * inspects `vmPid` against `kill(pid, 0)` after this returns and
   * downgrades dead-VM records to `terminated` itself.
   *
   * @returns {Promise<SessionRecord[]>}
   */
  const restoreFromDisk = async () => {
    if (!persistencePath) return [];
    let data;
    try {
      data = await readFile(persistencePath, 'utf8');
    } catch {
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    /** @type {SessionRecord[]} */
    const validated = [];
    for (const rec of parsed) {
      if (isPlausibleRecord(rec)) {
        // The bootNonce can't be reused; if a session somehow re-enters
        // the bootstrap path after restart, it must be torn down.
        rec.bootNonceUsed = true;
        rec.bootNonce = '';
        sessions.set(rec.id, rec);
        validated.push(rec);
      } else {
        // Don't sessions.set() this record — its sessionDir might point
        // anywhere, and forget() would then `rm -rf` it.
        // eslint-disable-next-line no-console
        console.error(
          '[session-manager] refusing to restore implausible record:',
          rec,
        );
      }
    }
    return validated;
  };

  return harden({
    createSession,
    getRecord,
    getSession,
    listSessions,
    setState,
    consumeBootNonce,
    forget,
    toSession,
    restoreFromDisk,
    persistNow,
  });
};
harden(makeSessionManager);
