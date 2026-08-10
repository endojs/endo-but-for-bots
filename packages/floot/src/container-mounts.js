// @ts-check
// Runtime container filesystem attach for Claude CLI sessions
// (designs/runtime-container-fs-mount.md).
//
// A Floot session often ACQUIRES filesystem authority at runtime — an adopted
// `workspace`, a mount received by mail, a git cap minted mid-conversation —
// and needs that same tree visible inside its sandbox slice so in-container
// Linux tools (git especially) can read, modify, and commit on the bytes the
// cap already grants. This module is the host-side attach registrar:
//
//   session tools --attachContainerMount--> registrar (this module)
//        |                                     | validate innerPath (/mnt/)
//        |                                     | prove possession (guest identify)
//        |                                     | bridge over 9P (provisioner)
//        |                                     | persist {capId, innerPath, mode}
//        v                                     v
//   MCP / exec                       ClaudeClient.setExtraMounts(extras)
//                                        (immediate slice recreate)
//
// Security model is cap-first: the CAP is the policy for which files may be
// read or written. The registrar enforces only possession (the session guest
// must already hold the cap — resolution starts from the guest's own
// petstore), bridge compatibility (EndoGit / Mount / Filesystem), container
// slot safety (innerPath under /mnt/, no overlaps with other attaches), and
// host layout (the bridge provider picks every host path; the guest never
// supplies one). The 9P bridge serves THROUGH the cap, so read-only views,
// denied segments, and subdirectory scoping stay enforced — the host never
// re-derives file authority from a raw host path.
//
// Attach records are keyed by CAP identity (daemon formula id), not Floot
// session id, and ref-counted by the set of session ids so a shared
// ClaudeClient is safe: the bind (and its 9P bridge) is torn down only when
// the last session reference to a (capId, innerPath) pair goes away.
// `ClaudeClient.terminate()` separately unmounts every extra it was handed —
// that destroys the whole CLI environment, not one session's view of it.

import { createHash } from 'node:crypto';

import { E } from '@endo/eventual-send';

/** Petstore name (in the factory's own petstore) persisting attach records. */
const REGISTRY_NAME = 'floot-container-mounts';

/**
 * Normalize and validate a guest-chosen container path. Attaches may only
 * land under `/mnt/` — never over the reserved slice paths (`/workspace`,
 * the Claude config dir, the MCP socket dir), which all live outside it.
 * Segments are restricted to a filename-safe alphabet because the bind list
 * ultimately feeds a container runtime's volume syntax.
 *
 * @param {unknown} rawPath
 * @returns {string} the normalized absolute path
 */
export const normalizeInnerPath = rawPath => {
  if (typeof rawPath !== 'string' || rawPath === '') {
    throw new Error('innerPath must be a non-empty string.');
  }
  if (!rawPath.startsWith('/')) {
    throw new Error(`innerPath must be absolute, got "${rawPath}".`);
  }
  const segments = rawPath.split('/').filter(segment => segment !== '');
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error(
      `innerPath must not contain "." or ".." segments, got "${rawPath}".`,
    );
  }
  if (segments.some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new Error(
      `innerPath segments must match [A-Za-z0-9][A-Za-z0-9._-]*, got "${rawPath}".`,
    );
  }
  if (segments[0] !== 'mnt' || segments.length < 2) {
    throw new Error(
      `innerPath must lie under /mnt/ (e.g. /mnt/project), got "${rawPath}".`,
    );
  }
  return `/${segments.join('/')}`;
};
harden(normalizeInnerPath);

/**
 * Whether `inner` lies strictly inside `outer` (both normalized absolute
 * paths). Nested binds are rejected: a bind inside another bind's subtree
 * would shadow part of the outer cap's view.
 *
 * @param {string} outer
 * @param {string} inner
 */
const isPathWithin = (outer, inner) => inner.startsWith(`${outer}/`);

/**
 * @param {string | string[]} petName
 * @returns {string[]}
 */
const petNamePathOf = petName => {
  const path = Array.isArray(petName)
    ? petName.map(String)
    : String(petName).split('/');
  const segments = path.filter(segment => segment !== '');
  if (segments.length === 0) {
    throw new Error('petName must be a non-empty pet name or pet-name path.');
  }
  return segments;
};

/**
 * Deterministic bridge key for one (client, cap, innerPath) attach. Names
 * the host-side artifacts (9P mountpoint directory, host mount pet name), so
 * a replay after a daemon restart re-lands on the same layout. The leading
 * letter keeps it a valid pet-name fragment regardless of the hash prefix.
 *
 * @param {string} clientKey
 * @param {string} capId
 * @param {string} innerPath
 */
const attachKeyFor = (clientKey, capId, innerPath) =>
  `a${createHash('sha256')
    .update(`${clientKey}\n${capId}\n${innerPath}`)
    .digest('hex')
    .slice(0, 40)}`;

/**
 * @typedef {object} AttachRecord
 * @property {string} key - deterministic bridge key (see attachKeyFor).
 * @property {string} clientKey - formula id of the owning ClaudeClient.
 * @property {string} capId - formula id of the attached cap.
 * @property {string} innerPath - normalized container path under /mnt/.
 * @property {'ro' | 'rw'} mode
 * @property {string} petName - the pet name used at attach time (display).
 * @property {string[]} sessionIds - Floot sessions referencing this attach.
 */

/**
 * @param {unknown} value
 * @returns {value is AttachRecord}
 */
const isValidRecord = value => {
  if (typeof value !== 'object' || value === null) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof record.key !== 'string' ||
    typeof record.clientKey !== 'string' ||
    typeof record.capId !== 'string' ||
    typeof record.petName !== 'string' ||
    (record.mode !== 'ro' && record.mode !== 'rw') ||
    !Array.isArray(record.sessionIds) ||
    !record.sessionIds.every(id => typeof id === 'string')
  ) {
    return false;
  }
  try {
    return normalizeInnerPath(record.innerPath) === record.innerPath;
  } catch {
    return false;
  }
};

/**
 * Build the attach registrar over the Floot factory's host powers.
 *
 * @param {object} options
 * @param {any} options.powers - the factory's own host powers: petstore
 *   (`has`/`lookup`/`remove`/`storeValue`) for persistence and
 *   `identify` on session guests for possession proofs.
 * @param {() => Promise<any>} options.getBridgeProvider - resolves the
 *   host-side bridge provider (the hosted Claude session provisioner, which
 *   holds the `fs-mounter` and root-host authority), or a falsy value when
 *   this deployment has none. Resolved lazily per use so a provider bound
 *   later in the boot (ENDO_EXTRA ordering) is still found.
 * @param {string} [options.registryName]
 */
export const makeContainerMountRegistrar = ({
  powers,
  getBridgeProvider,
  registryName = REGISTRY_NAME,
}) => {
  /** @type {readonly AttachRecord[] | undefined} */
  let records;
  const loadRecords = async () => {
    if (records !== undefined) return records;
    await null;
    /** @type {unknown[]} */
    let stored = [];
    if (await E(powers).has(registryName)) {
      const value = await E(powers).lookup(registryName);
      stored = Array.isArray(value) ? [...value] : [];
    }
    const valid = stored.filter(isValidRecord);
    if (valid.length !== stored.length) {
      console.warn(
        `[floot] dropped ${stored.length - valid.length} malformed container-mount record(s) from "${registryName}"`,
      );
    }
    records = harden(valid);
    return records;
  };
  // Serialize writes: storeValue can't overwrite, so each save removes then
  // stores, and concurrent saves would interleave (same pattern as the
  // session registry in agent.js).
  /** @type {Promise<void>} */
  let registryWrite = Promise.resolve();
  const saveRecords = () => {
    const snapshot = harden([...(records || [])]);
    const result = registryWrite.then(async () => {
      await null;
      if (await E(powers).has(registryName)) {
        await E(powers).remove(registryName);
      }
      await E(powers).storeValue(snapshot, registryName);
    });
    registryWrite = result.catch(error => {
      console.error(
        '[floot] could not persist container-mount records:',
        error instanceof Error ? error.message : String(error),
      );
    });
    return registryWrite;
  };

  // Worker-local runtime state, rebuilt each boot: live bridges by record
  // key, the armed ClaudeClient per client identity, which client each armed
  // session resolved to, and the last extras signature pushed per client (so
  // an unchanged set never recreates a live slice).
  /** @type {Map<string, { mountCap: any, handle: any }>} */
  const bridges = new Map();
  /** @type {Map<string, any>} */
  const clients = new Map();
  /** @type {Map<string, string>} */
  const armedSessions = new Map();
  /** @type {Map<string, string>} */
  const lastPushedByClient = new Map();

  /**
   * @param {AttachRecord} record
   */
  const ensureBridge = async record => {
    await null;
    let bridge = bridges.get(record.key);
    if (!bridge) {
      const provider = await getBridgeProvider();
      if (!provider) {
        throw new Error(
          'Container mounts need the hosted Claude session provisioner ' +
            '(@endo/claude-sandbox setup-hosted.js), which is not available ' +
            'in this deployment.',
        );
      }
      bridge = await E(provider).provideContainerMountBridge(
        harden({ key: record.key, capId: record.capId, mode: record.mode }),
      );
      bridges.set(record.key, bridge);
    }
    return bridge;
  };

  /**
   * @param {readonly AttachRecord[]} clientRecords
   */
  const extrasSignature = clientRecords =>
    JSON.stringify(
      clientRecords.map(record => [record.key, record.mode]).sort(),
    );

  /**
   * Ensure every record for `clientKey` is bridged, then hand the client the
   * resulting bind set — which disposes and recreates a live slice
   * immediately (attach/detach is disruptive by design). Skipped when the
   * set is unchanged since the last push, so idempotent re-attaches and
   * ref-count-only changes never restart the container.
   *
   * @param {string} clientKey
   */
  const pushExtras = async clientKey => {
    const client = clients.get(clientKey);
    if (!client) return;
    await loadRecords();
    const clientRecords = (records || []).filter(
      record => record.clientKey === clientKey,
    );
    const signature = extrasSignature(clientRecords);
    if (lastPushedByClient.get(clientKey) === signature) return;
    const extras = [];
    for (const record of clientRecords) {
      // eslint-disable-next-line no-await-in-loop
      const bridge = await ensureBridge(record);
      extras.push(
        harden({
          cap: bridge.mountCap,
          innerPath: record.innerPath,
          mode: record.mode,
          handle: bridge.handle,
        }),
      );
    }
    await E(client).setExtraMounts(harden(extras));
    lastPushedByClient.set(clientKey, signature);
  };

  /**
   * @param {AttachRecord} record
   * @param {string} sessionId
   */
  const describeRecord = (record, sessionId) =>
    harden({
      innerPath: record.innerPath,
      mode: record.mode,
      petName: record.petName,
      capId: record.capId,
      sessions: record.sessionIds.length,
      heldByThisSession: record.sessionIds.includes(sessionId),
    });

  /**
   * @param {object} options
   * @param {string} options.sessionId
   * @param {any} options.sessionGuest
   * @param {string} options.clientKey
   * @param {any} options.client
   * @param {string | string[]} options.petName
   * @param {string} options.innerPath
   * @param {string} [options.mode]
   */
  const attach = async ({
    sessionId,
    sessionGuest,
    clientKey,
    client,
    petName,
    innerPath: rawInnerPath,
    mode: rawMode,
  }) => {
    clients.set(clientKey, client);
    const innerPath = normalizeInnerPath(rawInnerPath);
    const mode = rawMode === undefined || rawMode === '' ? 'rw' : rawMode;
    if (mode !== 'ro' && mode !== 'rw') {
      throw new Error(`mode must be "ro" or "rw", got "${mode}".`);
    }
    const namePath = petNamePathOf(petName);
    const petLabel = namePath.join('/');
    // Possession is the authority check: resolution starts from THIS
    // session guest's own petstore, and the record stores the resolved cap
    // identity (formula id), not the name.
    const capId = await E(sessionGuest).identify(...namePath);
    if (capId === undefined) {
      throw new Error(
        `This session does not hold "${petLabel}" — store or adopt the capability in the session petstore first.`,
      );
    }
    await loadRecords();
    const clientRecords = (records || []).filter(
      record => record.clientKey === clientKey,
    );
    const existing = clientRecords.find(
      record => record.innerPath === innerPath,
    );
    if (existing) {
      if (existing.capId !== `${capId}`) {
        throw new Error(
          `"${innerPath}" is already bound to a different capability; detach it first.`,
        );
      }
      if (existing.mode !== mode) {
        throw new Error(
          `"${innerPath}" is already bound with mode "${existing.mode}"; detach it first to change the mode.`,
        );
      }
      // Idempotent attach to the same (capId, innerPath): join the
      // reference set; the container view does not change.
      if (!existing.sessionIds.includes(sessionId)) {
        records = harden(
          (records || []).map(record =>
            record === existing
              ? harden({
                  ...existing,
                  sessionIds: harden([...existing.sessionIds, sessionId]),
                })
              : record,
          ),
        );
        await saveRecords();
      }
      await ensureBridge(existing);
      await pushExtras(clientKey);
      return describeRecord(
        /** @type {AttachRecord} */ (
          (records || []).find(record => record.key === existing.key)
        ),
        sessionId,
      );
    }
    const overlap = clientRecords.find(
      record =>
        isPathWithin(record.innerPath, innerPath) ||
        isPathWithin(innerPath, record.innerPath),
    );
    if (overlap) {
      throw new Error(
        `"${innerPath}" overlaps the existing bind at "${overlap.innerPath}".`,
      );
    }
    /** @type {AttachRecord} */
    const record = harden({
      key: attachKeyFor(clientKey, `${capId}`, innerPath),
      clientKey,
      capId: `${capId}`,
      innerPath,
      mode,
      petName: petLabel,
      sessionIds: harden([sessionId]),
    });
    // Bridge before persisting: a cap the bridge cannot serve (or a 9P
    // failure) must not leave a phantom record poisoning every replay.
    await ensureBridge(record);
    records = harden([...(records || []), record]);
    await saveRecords();
    await pushExtras(clientKey);
    return describeRecord(record, sessionId);
  };

  /**
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.clientKey
   * @param {string} options.innerPath
   */
  const detach = async ({ sessionId, clientKey, innerPath: rawInnerPath }) => {
    const innerPath = normalizeInnerPath(rawInnerPath);
    await loadRecords();
    const record = (records || []).find(
      candidate =>
        candidate.clientKey === clientKey && candidate.innerPath === innerPath,
    );
    if (!record) {
      throw new Error(`Nothing is bound at "${innerPath}".`);
    }
    if (!record.sessionIds.includes(sessionId)) {
      throw new Error(`This session does not hold the bind at "${innerPath}".`);
    }
    const remaining = record.sessionIds.filter(id => id !== sessionId);
    if (remaining.length > 0) {
      records = harden(
        (records || []).map(candidate =>
          candidate === record
            ? harden({ ...record, sessionIds: harden(remaining) })
            : candidate,
        ),
      );
      await saveRecords();
      return harden({ innerPath, released: false, sessions: remaining.length });
    }
    records = harden((records || []).filter(candidate => candidate !== record));
    await saveRecords();
    // Order matters: recreate the slice WITHOUT the bind first, then release
    // the bridge — unmounting 9P under a live container bind would be busy.
    await pushExtras(clientKey);
    bridges.delete(record.key);
    const provider = await Promise.resolve(getBridgeProvider()).catch(
      () => undefined,
    );
    if (provider) {
      await E(provider)
        .releaseContainerMountBridge(record.key)
        .catch(error => {
          console.warn(
            `[floot] could not release container mount bridge ${record.key}:`,
            error instanceof Error ? error.message : String(error),
          );
        });
    }
    return harden({ innerPath, released: true, sessions: 0 });
  };

  /**
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.clientKey
   */
  const list = async ({ sessionId, clientKey }) => {
    await loadRecords();
    return harden(
      (records || [])
        .filter(record => record.clientKey === clientKey)
        .map(record => describeRecord(record, sessionId)),
    );
  };

  /**
   * Drop every attach reference a (deleted) session holds. Last-reference
   * attaches tear down their bridges; armed survivors of a shared client
   * get a shrunken bind set pushed. The deleted session's own client is
   * forgotten first so no recreate is wasted on a client that is being
   * terminated by the caller.
   *
   * @param {string} sessionId
   */
  const releaseSession = async sessionId => {
    const sessionClientKey = armedSessions.get(sessionId);
    armedSessions.delete(sessionId);
    if (
      sessionClientKey !== undefined &&
      ![...armedSessions.values()].includes(sessionClientKey)
    ) {
      clients.delete(sessionClientKey);
      lastPushedByClient.delete(sessionClientKey);
    }
    await loadRecords();
    if (
      !(records || []).some(record => record.sessionIds.includes(sessionId))
    ) {
      return;
    }
    /** @type {AttachRecord[]} */
    const dropped = [];
    /** @type {Set<string>} */
    const shrunkClients = new Set();
    records = harden(
      (records || []).flatMap(record => {
        if (!record.sessionIds.includes(sessionId)) return [record];
        const remaining = record.sessionIds.filter(id => id !== sessionId);
        if (remaining.length === 0) {
          dropped.push(record);
          shrunkClients.add(record.clientKey);
          return [];
        }
        return [harden({ ...record, sessionIds: harden(remaining) })];
      }),
    );
    await saveRecords();
    for (const clientKey of shrunkClients) {
      // eslint-disable-next-line no-await-in-loop
      await pushExtras(clientKey).catch(error => {
        console.warn(
          `[floot] could not update container mounts for client ${clientKey}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    const provider = await Promise.resolve(getBridgeProvider()).catch(
      () => undefined,
    );
    for (const record of dropped) {
      bridges.delete(record.key);
      if (provider) {
        // eslint-disable-next-line no-await-in-loop
        await E(provider)
          .releaseContainerMountBridge(record.key)
          .catch(error => {
            console.warn(
              `[floot] could not release container mount bridge ${record.key}:`,
              error instanceof Error ? error.message : String(error),
            );
          });
      }
    }
  };

  /**
   * Per-session kit: the three session tools plus the `arm` hook getAgent
   * calls once the session's ClaudeClient has resolved. The tools are built
   * BEFORE the client exists (the MCP bridge snapshots the tool map when the
   * socket server starts), so they resolve the armed state lazily at call
   * time and fail with a clear message until armed.
   *
   * @param {object} options
   * @param {string} options.sessionId
   * @param {any} options.sessionGuest
   */
  const makeSessionKit = ({ sessionId, sessionGuest }) => {
    /** @type {{ clientKey: string, client: any } | undefined} */
    let armed;
    const requireArmed = () => {
      if (!armed) {
        throw new Error(
          'Container mounts are not available for this session (the sandbox client has not been provisioned, or this deployment has no hosted Claude provisioner).',
        );
      }
      return armed;
    };

    /**
     * Arm the kit with the session's resolved client and REPLAY: persisted
     * attaches for this client are re-bridged and pushed before the first
     * turn, so a daemon restart rebuilds the same container view.
     *
     * @param {object} options2
     * @param {string} options2.clientKey
     * @param {any} options2.client
     */
    const arm = async ({ clientKey, client }) => {
      armed = { clientKey, client };
      armedSessions.set(sessionId, clientKey);
      clients.set(clientKey, client);
      await loadRecords();
      if ((records || []).some(record => record.clientKey === clientKey)) {
        await pushExtras(clientKey);
      }
    };

    /**
     * Session-bound facet methods (the tools below wrap these; tests and
     * future UI mirrors can call them directly).
     *
     * @param {{ petName: string | string[], innerPath: string, mode?: string }} options2
     */
    const attachForSession = async ({ petName, innerPath, mode }) => {
      const { clientKey, client } = requireArmed();
      return attach({
        sessionId,
        sessionGuest,
        clientKey,
        client,
        petName,
        innerPath,
        mode,
      });
    };
    /**
     * @param {{ innerPath: string }} options2
     */
    const detachForSession = async ({ innerPath }) => {
      const { clientKey } = requireArmed();
      return detach({ sessionId, clientKey, innerPath });
    };
    const listForSession = async () => {
      const { clientKey } = requireArmed();
      return list({ sessionId, clientKey });
    };

    const tools = harden({
      attachContainerMount: harden({
        schema: () =>
          harden({
            type: 'function',
            function: {
              name: 'attachContainerMount',
              description:
                'Bind a filesystem capability from this session’s petstore ' +
                'into the sandbox container at a path under /mnt/, so ' +
                'in-container shell tools (git, editors, builds) can read and ' +
                'write the capability’s tree. EndoGit capabilities attach ' +
                'their worktree (in-container `git status` / `git commit` then ' +
                'operate on the same repository), and Mount or Filesystem ' +
                'capabilities attach directly. Applying the bind RESTARTS the ' +
                'sandbox immediately, which aborts the current turn — the ' +
                'result of this call may not come back; verify with ' +
                'listContainerMounts on the next turn.',
              parameters: {
                type: 'object',
                properties: {
                  petName: {
                    type: 'string',
                    description:
                      'Pet name (or slash-separated pet-name path) of the capability in this session’s petstore.',
                  },
                  innerPath: {
                    type: 'string',
                    description:
                      'Absolute container path under /mnt/, e.g. /mnt/project.',
                  },
                  mode: {
                    type: 'string',
                    enum: ['rw', 'ro'],
                    description: 'Bind mode; defaults to rw.',
                  },
                },
                required: ['petName', 'innerPath'],
              },
            },
          }),
        /**
         * @param {{ petName?: string, innerPath?: string, mode?: string }} args
         */
        execute: async ({ petName, innerPath, mode } = {}) => {
          const result = await attachForSession({
            petName: `${petName ?? ''}`,
            innerPath: `${innerPath ?? ''}`,
            mode,
          });
          return (
            `Attached "${result.petName}" at ${result.innerPath} (${result.mode}). ` +
            'The sandbox was recreated with the new bind; in-container tools ' +
            `now see the tree at ${result.innerPath}.`
          );
        },
        help: () =>
          'attachContainerMount({petName, innerPath, mode?}) — bind a held filesystem capability into the sandbox under /mnt/ (restarts the sandbox).',
      }),
      detachContainerMount: harden({
        schema: () =>
          harden({
            type: 'function',
            function: {
              name: 'detachContainerMount',
              description:
                'Drop this session’s reference to a container bind made ' +
                'with attachContainerMount. The bind (and its host bridge) is ' +
                'removed when no session references it, which restarts the ' +
                'sandbox without the bind.',
              parameters: {
                type: 'object',
                properties: {
                  innerPath: {
                    type: 'string',
                    description:
                      'The container path under /mnt/ to detach, as given to attachContainerMount.',
                  },
                },
                required: ['innerPath'],
              },
            },
          }),
        /**
         * @param {{ innerPath?: string }} args
         */
        execute: async ({ innerPath } = {}) => {
          const result = await detachForSession({
            innerPath: `${innerPath ?? ''}`,
          });
          return result.released
            ? `Detached ${result.innerPath}; the bind was removed and the sandbox recreated without it.`
            : `Released this session's reference to ${result.innerPath}; ${result.sessions} other session(s) still hold it, so the bind stays.`;
        },
        help: () =>
          'detachContainerMount({innerPath}) — drop this session’s reference to a /mnt/ bind; the last reference removes it.',
      }),
      listContainerMounts: harden({
        schema: () =>
          harden({
            type: 'function',
            function: {
              name: 'listContainerMounts',
              description:
                'List the runtime container binds under /mnt/ for this ' +
                'session’s sandbox: inner path, mode, source pet name, and ' +
                'how many sessions reference each bind.',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          }),
        execute: async () => {
          const mounts = await listForSession();
          if (mounts.length === 0) {
            return 'No runtime container binds are attached.';
          }
          return JSON.stringify(mounts, null, 2);
        },
        help: () =>
          'listContainerMounts() — list the runtime /mnt/ binds for this session’s sandbox.',
      }),
    });

    return harden({
      arm,
      attach: attachForSession,
      detach: detachForSession,
      list: listForSession,
      tools,
    });
  };

  return harden({ makeSessionKit, releaseSession });
};
harden(makeContainerMountRegistrar);
