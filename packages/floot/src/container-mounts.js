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
//        |                                     | bridge over 9P (bridge provider)
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

/**
 * Petstore name prefix (in the factory's own petstore) for the append-only
 * attach journal. Every snapshot gets a fresh sequence-numbered name, so a
 * failed or interrupted write can never erase the previous one — the same
 * shape the session registry in `agent.js` uses, and for the same reason: a
 * remove-then-store against a single name destroys the only record the moment
 * the store fails.
 */
const REGISTRY_PREFIX = 'floot-container-mounts-v1-';
/**
 * Snapshots kept behind the newest one, so a snapshot that turns out to be
 * unreadable is not the only record.
 */
const REGISTRY_JOURNAL_DEPTH = 4;

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
 * Exported because it is the record's whole identity: a persisted record whose
 * `key` is not the one this derives is rejected on load, and a test that
 * seeds the journal has to derive the same key the registrar will.
 *
 * @param {string} clientKey
 * @param {string} capId
 * @param {string} innerPath
 */
export const attachKeyFor = (clientKey, capId, innerPath) =>
  `a${createHash('sha256')
    .update(`${clientKey}\n${capId}\n${innerPath}`)
    .digest('hex')
    .slice(0, 40)}`;
harden(attachKeyFor);

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
    if (normalizeInnerPath(record.innerPath) !== record.innerPath) {
      return false;
    }
  } catch {
    return false;
  }
  // `key` is the bridge's whole identity — it names the 9P mountpoint and the
  // host mount pet name, and it is what `bridges`, `extrasSignature` and
  // `releaseContainerMountBridge` index by. Accepting it as written would let
  // two records sharing a key collapse onto ONE bridge, so a second bind would
  // silently serve the first record's capability. Recompute it instead: the
  // stored key must be exactly the one this (clientKey, capId, innerPath)
  // derives, which also guarantees the alphabet the bridge's own key guard
  // demands.
  return (
    record.key ===
    attachKeyFor(record.clientKey, record.capId, record.innerPath)
  );
};

/**
 * Build the attach registrar over the Floot factory's host powers.
 *
 * @param {object} options
 * @param {any} options.powers - the factory's own host powers: petstore
 *   (`has`/`lookup`/`remove`/`storeValue`) for persistence and
 *   `identify` on session guests for possession proofs.
 * @param {() => Promise<any>} options.getBridgeProvider - resolves the
 *   host-side bridge provider (`@endo/claude-sandbox`'s
 *   `container-mount-bridge.js`, which holds the `fs-mounter` and root-host
 *   authority; the hosted Claude session provisioner may serve the same two
 *   methods), or a falsy value when this deployment has none. Resolved
 *   lazily per use so a provider bound later in the boot (ENDO_EXTRA
 *   ordering) is still found.
 * @param {string} [options.registryPrefix]
 */
export const makeContainerMountRegistrar = ({
  powers,
  getBridgeProvider,
  registryPrefix = REGISTRY_PREFIX,
}) => {
  /** @param {bigint} sequence */
  const journalName = sequence =>
    `${registryPrefix}${`${sequence}`.padStart(20, '0')}`;

  /** @type {readonly AttachRecord[] | undefined} */
  let records;
  /** Sequence the next snapshot claims. */
  let recordsSequence = 0n;
  // Memoize the first load so overlapping callers share one petstore read —
  // a second read resolving after a mutation landed would otherwise assign
  // over the mutated set and resurrect dropped records.
  /** @type {Promise<readonly AttachRecord[]> | undefined} */
  let recordsLoad;
  const loadRecords = () => {
    if (records !== undefined) return Promise.resolve(records);
    if (!recordsLoad) {
      const pending = (async () => {
        await null;
        const names = await E(powers).list();
        const journalNames = (Array.isArray(names) ? names : [])
          .filter(
            name =>
              typeof name === 'string' &&
              name.startsWith(registryPrefix) &&
              /^[0-9]{20}$/.test(name.slice(registryPrefix.length)),
          )
          .sort();
        /** @type {unknown[]} */
        let stored = [];
        let sequence = 0n;
        if (journalNames.length > 0) {
          const latestName = /** @type {string} */ (journalNames.at(-1));
          const snapshot = await E(powers).lookup(latestName);
          if (
            snapshot?.version !== 1 ||
            !Array.isArray(snapshot.records) ||
            typeof snapshot.sequence !== 'bigint' ||
            latestName !== journalName(snapshot.sequence)
          ) {
            throw Error('Floot container-mount journal is corrupt');
          }
          stored = [...snapshot.records];
          sequence = snapshot.sequence + 1n;
        }
        const valid = stored.filter(isValidRecord);
        if (valid.length !== stored.length) {
          console.error(
            `[floot] dropped ${stored.length - valid.length} malformed container-mount record(s) from "${registryPrefix}"`,
          );
        }
        if (records === undefined) {
          records = harden(valid);
          recordsSequence = sequence;
        }
        return records;
      })();
      recordsLoad = pending;
      // A failed read must not brick the registrar for the boot: retry on
      // the next call.
      pending.catch(() => {
        if (recordsLoad === pending) {
          recordsLoad = undefined;
        }
      });
    }
    return recordsLoad;
  };
  // Serialize writes, and make each one append-only: every snapshot claims a
  // fresh sequence-numbered name, so an interrupted or rejected write leaves
  // the previous complete snapshot intact. A remove-then-store against one
  // name would destroy the only record the moment the store failed — and
  // would do so silently, since callers cannot see a swallowed rejection.
  /** @type {Promise<void>} */
  let registryWrite = Promise.resolve();
  const saveRecords = () => {
    const snapshot = harden([...(records || [])]);
    const result = registryWrite.then(async () => {
      await null;
      // Reserve the name before the remote write: a rejected acknowledgement
      // does not prove that storeValue failed to commit. Later saves must use
      // a new name rather than colliding forever with that uncertain snapshot.
      const sequence = recordsSequence;
      recordsSequence += 1n;
      await E(powers).storeValue(
        harden({ version: 1, sequence, records: snapshot }),
        journalName(sequence),
      );
      // Trim only after the new snapshot is durable, so the journal is never
      // momentarily empty, and keep a few behind it so a snapshot that turns
      // out to be unreadable is not the only record.
      if (sequence >= BigInt(REGISTRY_JOURNAL_DEPTH)) {
        await E(powers)
          .remove(journalName(sequence - BigInt(REGISTRY_JOURNAL_DEPTH)))
          .catch(() => undefined);
      }
    });
    // Preserve the rejection for the caller while keeping later writes
    // possible and recording failures even when a caller discards its promise.
    registryWrite = result.catch(error => {
      console.error(
        '[floot] could not persist container-mount records:',
        error instanceof Error ? error.message : String(error),
      );
    });
    return result;
  };

  /**
   * Replace the record set and persist it. A failed write restores the prior
   * set and rethrows, so the registrar never reports a bind it did not record
   * — the failure mode the swallowed-rejection version hid.
   *
   * @param {readonly AttachRecord[]} next
   */
  const commitRecords = async next => {
    await null;
    const previous = records;
    records = harden([...next]);
    try {
      await saveRecords();
    } catch (error) {
      records = previous;
      throw error;
    }
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

  // Serialize every mutating operation (attach, detach, releaseSession, and
  // the arm-time replay). Attach validates against the record set and then
  // awaits a slow bridge mint before appending — an unserialized sibling
  // call could slip a conflicting record into that window (two binds at one
  // innerPath would fail every later provision), and overlapping pushes
  // could apply an older bind set after a newer one. Reads (`list`) stay
  // lock-free.
  /** @type {Promise<unknown>} */
  let registrarChain = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const withRegistrarLock = fn => {
    const run = registrarChain.then(fn, fn);
    registrarChain = run.catch(() => {});
    return run;
  };

  /**
   * @param {AttachRecord} record
   * @returns {Promise<{ mountCap: any, handle: any }>}
   */
  const ensureBridge = async record => {
    await null;
    const existing = bridges.get(record.key);
    if (existing) {
      return existing;
    }
    const provider = await getBridgeProvider();
    if (!provider) {
      throw new Error(
        'Container mounts need a container-mount bridge provider ' +
          '(@endo/claude-sandbox src/container-mount-bridge.js), which is ' +
          'not available in this deployment.',
      );
    }
    /** @type {{ mountCap: any, handle: any }} */
    const bridge = await E(provider).provideContainerMountBridge(
      harden({ key: record.key, capId: record.capId, mode: record.mode }),
    );
    bridges.set(record.key, bridge);
    return bridge;
  };

  /**
   * Tear down the host-side bridge for a record whose last reference is gone.
   * Best-effort, because the record is already dropped and nothing would
   * retry — but never silent: an unreleased bridge is a live 9P export of the
   * guest's capability and a named, restart-surviving daemon `Mount` formula
   * that no record points at any more, so an operator has to be told which
   * key to reap by hand.
   *
   * @param {string} key
   */
  const releaseBridge = async key => {
    await null;
    /** @type {any} */
    let provider;
    try {
      provider = await getBridgeProvider();
    } catch (error) {
      provider = undefined;
      console.error(
        `[floot] could not resolve the container-mount bridge provider to release ${key}; its 9P mount and host mount name are now orphaned:`,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (!provider) {
      console.error(
        `[floot] no container-mount bridge provider is available to release ${key}; its 9P mount and host mount name are now orphaned`,
      );
      return;
    }
    await E(provider)
      .releaseContainerMountBridge(key)
      .catch(error => {
        console.error(
          `[floot] could not release container mount bridge ${key}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
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
   * A record whose bridge cannot be built this boot (its cap's formula was
   * removed, say) is skipped with a warning rather than wedging every other
   * bind for the client. The recorded signature covers only what was
   * actually pushed, so the next push retries the skipped records instead
   * of being deduped away.
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
    if (lastPushedByClient.get(clientKey) === extrasSignature(clientRecords)) {
      return;
    }
    /** @type {AttachRecord[]} */
    const pushedRecords = [];
    const extras = [];
    for (const record of clientRecords) {
      /** @type {{ mountCap: any, handle: any } | undefined} */
      let bridge;
      try {
        // eslint-disable-next-line no-await-in-loop
        bridge = await ensureBridge(record);
      } catch (error) {
        console.warn(
          `[floot] could not bridge container mount ${record.innerPath}; leaving it unbound for now:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (bridge) {
        pushedRecords.push(record);
        extras.push(
          harden({
            cap: bridge.mountCap,
            innerPath: record.innerPath,
            mode: record.mode,
            handle: bridge.handle,
          }),
        );
      }
    }
    const signature = extrasSignature(pushedRecords);
    if (lastPushedByClient.get(clientKey) === signature) return;
    await E(client).setExtraMounts(harden(extras));
    lastPushedByClient.set(clientKey, signature);
  };

  /**
   * The session-facing description of an attach. Two fields are withheld from
   * a session that does not hold the record. `capId`, because formula ids are
   * bearer-capable and a shared client's list would otherwise disclose ids for
   * caps this session never held. And `petName`, because it is guest-authored
   * naming out of ANOTHER session's petstore — "my-secret-repo" says something
   * its owner never offered to share, and it names nothing this session could
   * resolve anyway.
   *
   * @param {AttachRecord} record
   * @param {string} sessionId
   * @param {string} [petName] - the name this session used, when it differs
   *   from the one the first attacher recorded.
   */
  const describeRecord = (record, sessionId, petName) => {
    const heldByThisSession = record.sessionIds.includes(sessionId);
    return harden({
      innerPath: record.innerPath,
      mode: record.mode,
      ...(heldByThisSession ? { petName: petName ?? record.petName } : {}),
      sessions: record.sessionIds.length,
      heldByThisSession,
    });
  };

  /**
   * Translate a live-apply failure after a persisted record mutation into
   * an honest message: the record IS recorded and will replay on the next
   * sandbox start; only the immediate live update failed.
   *
   * @param {string} clientKey
   * @param {string} innerPath
   */
  const applyOrExplain = async (clientKey, innerPath) => {
    await null;
    try {
      await pushExtras(clientKey);
    } catch (error) {
      throw new Error(
        `The bind at "${innerPath}" was recorded and will apply when the sandbox next starts, but updating the live sandbox failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  };

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
  const attachLocked = async ({
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
        await commitRecords(
          (records || []).map(record =>
            record === existing
              ? harden({
                  ...existing,
                  sessionIds: harden([...existing.sessionIds, sessionId]),
                })
              : record,
          ),
        );
      }
      await ensureBridge(existing);
      await applyOrExplain(clientKey, innerPath);
      return describeRecord(
        /** @type {AttachRecord} */ (
          (records || []).find(record => record.key === existing.key)
        ),
        sessionId,
        // The record's own `petName` is whichever session attached first;
        // report the name THIS session used instead of handing it another
        // session's naming.
        petLabel,
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
    try {
      await commitRecords([...(records || []), record]);
    } catch (error) {
      // The record did not land, so nothing will ever reference — or release
      // — the bridge just minted. Drop it rather than orphan a live 9P
      // export of the guest's capability.
      bridges.delete(record.key);
      await releaseBridge(record.key);
      throw error;
    }
    await applyOrExplain(clientKey, innerPath);
    return describeRecord(record, sessionId);
  };

  /** @type {typeof attachLocked} */
  const attach = options => withRegistrarLock(() => attachLocked(options));

  /**
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.clientKey
   * @param {string} options.innerPath
   */
  const detachLocked = async ({
    sessionId,
    clientKey,
    innerPath: rawInnerPath,
  }) => {
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
      await commitRecords(
        (records || []).map(candidate =>
          candidate === record
            ? harden({ ...record, sessionIds: harden(remaining) })
            : candidate,
        ),
      );
      return harden({ innerPath, released: false, sessions: remaining.length });
    }
    await commitRecords(
      (records || []).filter(candidate => candidate !== record),
    );
    // Order matters: recreate the slice WITHOUT the bind first, then release
    // the bridge — unmounting 9P under a live container bind would be busy.
    // The release must run even when the recreate push fails (the record is
    // gone, so nothing would ever release the bridge later; the 9P mounts
    // are lazy-unmount, so a still-bound mountpoint detaches once the
    // container lets go).
    try {
      await pushExtras(clientKey);
    } catch (error) {
      console.warn(
        `[floot] could not update the sandbox after detaching ${innerPath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    bridges.delete(record.key);
    await releaseBridge(record.key);
    return harden({ innerPath, released: true, sessions: 0 });
  };

  /** @type {typeof detachLocked} */
  const detach = options => withRegistrarLock(() => detachLocked(options));

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
  const releaseSessionLocked = async sessionId => {
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
    await commitRecords(
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
    for (const clientKey of shrunkClients) {
      // eslint-disable-next-line no-await-in-loop
      await pushExtras(clientKey).catch(error => {
        console.warn(
          `[floot] could not update container mounts for client ${clientKey}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    for (const record of dropped) {
      bridges.delete(record.key);
      // eslint-disable-next-line no-await-in-loop
      await releaseBridge(record.key);
    }
  };

  /** @type {typeof releaseSessionLocked} */
  const releaseSession = sessionId =>
    withRegistrarLock(() => releaseSessionLocked(sessionId));

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
          'Container mounts are not available for this session (the sandbox client has not been provisioned, or this deployment has no container-mount bridge provider).',
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
      // A fresh presence for a client identity we have pushed to before — the
      // client formula's worker restarted, or a second session resolved the
      // same formula to its own presence — has an empty bind set of its own.
      // The push signature is per identity, so leaving it in place would let
      // `pushExtras` dedupe the replay away and bring the new container up
      // with no /mnt/ binds at all, silently.
      if (clients.get(clientKey) !== client) {
        lastPushedByClient.delete(clientKey);
      }
      clients.set(clientKey, client);
      // The replay itself takes the registrar lock: a tool-driven attach
      // arriving while the replay is mid-push must serialize behind it.
      await withRegistrarLock(async () => {
        await loadRecords();
        if ((records || []).some(record => record.clientKey === clientKey)) {
          await pushExtras(clientKey);
        }
      });
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

    // A Map, not a record: floot merges tool sets with
    // `for (const [name, tool] of ...)` (see src/tool-registry.js), so an
    // object here would throw at merge time.
    /** @type {Map<string, any>} */
    const tools = new Map();
    tools.set(
      'attachContainerMount',
      harden({
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
    );
    tools.set(
      'detachContainerMount',
      harden({
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
    );
    tools.set(
      'listContainerMounts',
      harden({
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
    );

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
