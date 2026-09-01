// @ts-check
/// <reference types="ses"/>

import { Fail, q } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { E } from '@endo/eventual-send';

import { assertGitCredentialForUrl } from './git-credential.js';
import {
  captureGitRefPattern,
  getGitRemotePullDestination,
  gitRefspecMatchesPattern,
  normalizeGitRef,
  normalizeGitRemotePolicy,
  normalizeGitRemoteUrl,
  parseGitRefspec,
  requireGitRemoteBoolean,
  validateGitPushRefspec,
} from './git-remote-policy.js';
import { gitPairingTokenFor, isGitReadOnly } from './git.js';
import {
  GitRemoteControllerInterface,
  GitRemoteInterface,
} from './interfaces.js';

/**
 * @import {
 *   GitDirection,
 *   GitRemote,
 *   GitRemoteAuditEvent,
 *   GitRemoteController,
 *   GitRemoteCredential,
 *   GitRemoteEndpoint,
 *   GitRemoteKit,
 *   NormalizedRemotePolicy,
 *   RemoteOperationResult,
 *   RemotePolicy,
 *   RemotePullResult,
 *   RemoteSnapshot,
 * } from './types.js'
 */

/**
 * Host-private map from a remote exo to its controller exo.  The
 * controller is a companion accessed through a daemon-side host method
 * (`getGitRemoteController`); its durable state lives on the remote
 * formula rather than a separate top-level formula.
 *
 * @type {WeakMap<object, object>}
 */
const remoteControllers = new WeakMap();
const AUDIT_LIMIT = 128;

/**
 * @type {(remote: unknown) => GitRemoteController | undefined}
 */
export const getGitRemoteController = remote =>
  /** @type {GitRemoteController | undefined} */ (
    remoteControllers.get(/** @type {object} */ (remote))
  );
harden(getGitRemoteController);

/**
 * Factor the reusable `{ url, transport, credential }` sub-bundle out of
 * `GitRemote` as a repo-less `GitRemoteEndpoint` ("authority to talk to
 * this remote").  Both operations then fall out of composition:
 * `GitRemote` is `GitRemoteEndpoint` x an existing `Git` (fetch / pull /
 * push), and clone is `GitRemoteEndpoint` x an empty destination mount
 * (returns a fresh `Git`).
 *
 * The endpoint owns url normalization and the credential lifecycle
 * (resolution, the usable-material check, version fencing, and change
 * notification) that `makeGitRemote` previously inlined.  It carries no
 * `Git`, no refspecs, and no directions: those are repo-binding policy
 * that stays on `GitRemote`.  `url` and `allowLocalFileTransport` are
 * immutable for a remote's lifetime (no controller setter mutates
 * them), so a `GitRemote` builds its endpoint once at construction.
 *
 * @param {object} args
 * @param {string} args.url  Remote endpoint URL (https, or file when
 *   `allowLocalFileTransport`).
 * @param {object} [args.credential]  Daemon-minted Git credential cap.
 * @param {boolean} [args.allowLocalFileTransport]
 * @returns {GitRemoteEndpoint}
 */
export const makeGitRemoteEndpoint = ({
  url,
  credential,
  allowLocalFileTransport = false,
}) => {
  const normalizedUrl = normalizeGitRemoteUrl(url, allowLocalFileTransport);
  const parsed = new URL(normalizedUrl);
  const requiresCredential = parsed.protocol === 'https:';
  if (!requiresCredential && credential !== undefined) {
    throw new Error('GitRemote credentials require https remotes');
  }
  const credentialRecord =
    credential === undefined
      ? undefined
      : assertGitCredentialForUrl(credential, parsed.origin, {
          allowRevoked: true,
        });
  if (requiresCredential && credentialRecord === undefined) {
    throw new Error('GitRemote HTTPS remotes require a Git credential cap');
  }

  /**
   * Returns `undefined` if `requiresCredential` is false.
   *
   * @returns {GitRemoteCredential | undefined}
   * @throws {Error} if the credential material is unavailable.
   */
  const ensureCredentialUsable = () => {
    if (requiresCredential) {
      const record = assertGitCredentialForUrl(
        /** @type {object} */ (credential),
        parsed.origin,
      );
      const material = record.getMaterial();
      if (record.kind === 'bearer' && 'token' in material) {
        return harden({ kind: 'bearer', material });
      }
      if (
        record.kind === 'basic' &&
        'username' in material &&
        'password' in material
      ) {
        return harden({ kind: 'basic', material });
      }
      throw new Error('Git credential material is unavailable');
    }
    return undefined;
  };

  const captureCredentialVersion = () =>
    requiresCredential && credentialRecord !== undefined
      ? credentialRecord.getVersion()
      : undefined;

  /**
   * @param {string} operation
   * @param {number | undefined} version
   */
  const assertCredentialUnchanged = (operation, version) => {
    if (requiresCredential && credentialRecord !== undefined) {
      const currentCredentialRecord = assertGitCredentialForUrl(
        /** @type {object} */ (credential),
        parsed.origin,
        { allowRevoked: true },
      );
      if (currentCredentialRecord.getVersion() !== version) {
        if (currentCredentialRecord.isRevoked()) {
          throw new Error(
            `Git credential for ${q(currentCredentialRecord.audience)} was revoked during ${operation}`,
          );
        }
        throw new Error(
          `Git credential for ${q(currentCredentialRecord.audience)} changed during ${operation}`,
        );
      }
    }
  };

  /**
   * Report whether the credential this endpoint would push with is usable,
   * WITHOUT using it. A credential holds its material in process memory, so a
   * daemon restart leaves the record revoked and the next push is the first
   * thing that says so (forge issue #21). A holder can now ask first.
   *
   * @returns {object}
   */
  const credentialHealth = () => {
    if (!requiresCredential || credentialRecord === undefined) {
      return harden({ required: false });
    }
    const record = assertGitCredentialForUrl(
      /** @type {object} */ (credential),
      parsed.origin,
      { allowRevoked: true },
    );
    return harden({
      required: true,
      kind: record.kind,
      audience: record.audience,
      available: !Object.hasOwn(record.getMaterial(), 'unavailable'),
      revoked: record.isRevoked(),
    });
  };

  /**
   * @param {() => void} onChange
   */
  const watchChange = onChange => {
    if (credentialRecord !== undefined) {
      return credentialRecord.watchChange(onChange);
    }
    return undefined;
  };

  return harden({
    url: normalizedUrl,
    origin: parsed.origin,
    protocol: parsed.protocol,
    requiresCredential,
    allowLocalFileTransport,
    ensureCredentialUsable,
    captureCredentialVersion,
    assertCredentialUnchanged,
    credentialHealth,
    watchChange,
  });
};
harden(makeGitRemoteEndpoint);

/**
 * Mint a paired (guest-held, host-held) facet for one remote endpoint.
 *
 * This facet is the policy gate for remote use.  It validates endpoint,
 * direction, and refspec policy before delegating to the local Git
 * backend's bounded native data plane.
 *
 * @param {object} args
 * @param {object} args.git  The local `Git` capability this remote is
 *   bound to.  Guest operations on the remote always compose with this
 *   Git; revoking the local Git collects the remote too.
 * @param {import('./git.js').GitOperations} args.operations  The
 *   host-private backend authority paired with `git` at construction time
 *   (see `makeGitOperations`). The composing caller that minted `git` is
 *   the one place that ever held both, and hands this in explicitly —
 *   `GitRemote` has no way to recover a backend from `git` itself, but it
 *   does verify (via `gitPairingTokenFor`) that `operations` carries the
 *   ephemeral pairing token minted alongside this specific `git`, not
 *   merely alongside some other daemon-minted Git instance.
 * @param {string} args.name  Remote name (typically 'origin').
 * @param {RemotePolicy} args.policy
 * @param {boolean} [args.revoked]
 * @param {object} [args.credential]
 * @param {(state: { policy: RemotePolicy, revoked: boolean }) => Promise<void> | void} [args.onStateChange]
 * @returns {GitRemoteKit}
 */
export const makeGitRemote = ({
  git,
  operations,
  name,
  policy,
  revoked: initialRevoked = false,
  credential,
  onStateChange,
}) => {
  const gitReadOnly = isGitReadOnly(git);
  if (gitReadOnly !== false) {
    throw new Error(
      gitReadOnly === undefined
        ? 'GitRemote requires a daemon-minted Git cap'
        : 'GitRemote cannot be constructed from a read-only Git',
    );
  }
  if (
    operations === undefined ||
    operations === null ||
    typeof operations !== 'object' ||
    operations.backend === undefined
  ) {
    throw new Error('GitRemote requires a daemon-minted Git cap');
  }
  const { backend, pairingToken } = operations;
  // `operations` is a free-standing capability: nothing about its own shape
  // ties it to `git`. Verify it was actually minted alongside this specific
  // `git` — via the ephemeral pairing token, not `backend` object identity
  // — not merely alongside *some* daemon-minted Git instance, so a caller
  // cannot pair a genuine `git` for one repo with a genuine `GitOperations`
  // for another.
  if (pairingToken === undefined || pairingToken !== gitPairingTokenFor(git)) {
    throw new Error('GitRemote requires operations minted for this git cap');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('GitRemote name must be a non-empty string');
  }
  if (
    !policy ||
    typeof policy !== 'object' ||
    typeof policy.url !== 'string' ||
    policy.url.length === 0
  ) {
    throw new Error('GitRemote policy must include a non-empty url');
  }

  // The policy record is mutable through the controller; we keep a
  // mutable struct here and freeze each read view we hand out.
  /** @type {NormalizedRemotePolicy} */
  let currentPolicy = normalizeGitRemotePolicy({ name, policy });
  // GitRemote = GitRemoteEndpoint x existing Git: the endpoint owns the
  // `{ url, transport, credential }` sub-bundle and its credential
  // lifecycle; this maker keeps the repo-binding policy (directions,
  // refspecs) and composes with the bound `git` below.  `url` and
  // `allowLocalFileTransport` never change after construction, so the
  // endpoint is built once.
  const endpoint = makeGitRemoteEndpoint({
    url: currentPolicy.url,
    credential,
    allowLocalFileTransport: currentPolicy.allowLocalFileTransport,
  });

  let revoked = initialRevoked;
  let operationEpoch = 0;
  /** @type {'policy' | 'revoke' | undefined} */
  let operationInvalidation;
  /** @type {Set<AbortController>} */
  const activeOperationControllers = new Set();

  const abortActiveOperations = () => {
    for (const abortController of [...activeOperationControllers]) {
      abortController.abort();
    }
  };

  const invalidateOperations = reason => {
    operationEpoch += 1;
    operationInvalidation = reason;
    abortActiveOperations();
  };

  const beginOperation = () => {
    const abortController = new AbortController();
    activeOperationControllers.add(abortController);
    return {
      signal: abortController.signal,
      finish: () => {
        activeOperationControllers.delete(abortController);
      },
    };
  };

  endpoint.watchChange(abortActiveOperations);

  const persistState = async (nextPolicy, nextRevoked) => {
    await null;
    if (onStateChange !== undefined) {
      await onStateChange(harden({ policy: nextPolicy, revoked: nextRevoked }));
    }
  };

  const ensureLive = () => {
    if (revoked) {
      throw new Error(`GitRemote ${q(name)} has been revoked`);
    }
  };

  const ensureDirection = direction => {
    ensureLive();
    if (!currentPolicy.allowedDirections.includes(direction)) {
      throw new Error(
        `GitRemote ${q(name)} does not permit ${q(direction)} (allowed: ${currentPolicy.allowedDirections.join(', ')})`,
      );
    }
  };

  const ensureCredentialUsable = () => endpoint.ensureCredentialUsable();

  const captureOperationFence = () =>
    harden({
      epoch: operationEpoch,
      credentialVersion: endpoint.captureCredentialVersion(),
    });

  const assertOperationFence = (operation, fence) => {
    if (operationEpoch !== fence.epoch) {
      if (revoked || operationInvalidation === 'revoke') {
        throw new Error(`GitRemote ${q(name)} was revoked during ${operation}`);
      }
      throw new Error(
        `GitRemote ${q(name)} policy changed during ${operation}`,
      );
    }
    endpoint.assertCredentialUnchanged(operation, fence.credentialVersion);
  };

  const operationError = (operation, fence, err) => {
    try {
      assertOperationFence(operation, fence);
    } catch (fenceErr) {
      return fenceErr;
    }
    return err;
  };

  const snapshotPolicy = () => harden({ name, ...currentPolicy });

  /** @type {GitRemoteAuditEvent[]} */
  const auditLog = [];
  let auditSequence = 0;
  const recordAudit = event => {
    auditSequence += 1;
    auditLog.push(
      harden({
        sequence: auditSequence,
        ...event,
      }),
    );
    // Preserve the `'create'` entry across rolling shifts past
    // `AUDIT_LIMIT` so the audit log always names the policy the
    // remote was constructed against.  The shift removes the second
    // entry (the oldest non-`'create'` event) when the head is the
    // sentinel.
    if (auditLog.length > AUDIT_LIMIT) {
      const headIsCreate =
        /** @type {{ type?: string }} */ (auditLog[0])?.type === 'create';
      if (headIsCreate && auditLog.length > 1) {
        auditLog.splice(1, 1);
      } else {
        auditLog.shift();
      }
    }
  };

  recordAudit({ type: 'create', policy: snapshotPolicy(), revoked });

  /**
   * @param {string} type
   * @param {unknown} result
   */
  const recordOperationSuccess = (type, result) => {
    const record =
      /** @type {{ updatedRefs?: unknown, fetch?: { updatedRefs?: unknown }, integration?: unknown, head?: unknown }} */ (
        result
      );
    const updatedRefs =
      type === 'pull' ? record.fetch?.updatedRefs : record.updatedRefs;
    recordAudit({
      type,
      outcome: 'ok',
      ...(updatedRefs === undefined ? {} : { updatedRefs }),
      ...(record.integration === undefined
        ? {}
        : { integration: record.integration }),
      ...(record.head === undefined ? {} : { head: record.head }),
    });
  };

  /**
   * @param {string} type
   * @param {unknown} err
   * @param {{ appliedLocally?: boolean }} [extra]
   */
  const recordOperationFailure = (type, err, extra = {}) => {
    recordAudit({
      type,
      outcome: 'error',
      message:
        /** @type {{ message?: string }} */ (err)?.message || String(err),
      ...(extra.appliedLocally ? { appliedLocally: true } : {}),
    });
  };

  /**
   * Runtime gate for caller-supplied push overrides (`source` /
   * `destination` on `push()` options). `normalizeGitRemotePolicy`
   * shape-validates policy refspecs at construction; this runtime check covers
   * the override path only.  The default push (no
   * override) ships `currentPolicy.pushRefspecs` directly without
   * passing through this gate.
   *
   * @param {string} candidate
   */
  const assertPushRefspecAllowed = candidate => {
    const parsed = parseGitRefspec(candidate, 'GitRemote push refspec');
    if (parsed.force && !currentPolicy.allowForcePush) {
      throw new Error('GitRemote push force requires allowForcePush');
    }
    // Revalidate the concrete (post-override) refspec against the full
    // construction-time policy gate.  A wildcard policy refspec can
    // syntactically match a concrete override whose src or dst is a tag
    // (`refs/heads/tags/v1:refs/tags/v1` under `refs/heads/*:refs/*`) or
    // a deletion; the wildcard match below does not re-derive those
    // properties, so without this the tag / delete policy is bypassed.
    // Reuse the same `validateGitPushRefspec` that gates policy refspecs at
    // construction rather than inlining a parallel tag / delete check.
    validateGitPushRefspec(candidate, currentPolicy, 'GitRemote push refspec');
    const allowed = currentPolicy.pushRefspecs.some(refspec => {
      const policyRefspec = parseGitRefspec(
        refspec,
        'GitRemote policy.pushRefspecs[]',
      );
      return gitRefspecMatchesPattern(parsed, policyRefspec);
    });
    if (!allowed) {
      throw new Error(
        `GitRemote ${q(name)} push refspec is outside policy: ${q(candidate)}`,
      );
    }
  };

  /**
   * @param {unknown} options
   */
  const pushRefspecsFromOptions = options => {
    const opts =
      /** @type {{ source?: unknown, destination?: unknown, force?: unknown, forceWithLease?: unknown, setUpstream?: unknown }} */ (
        options || {}
      );
    // Read the request-side authority flags coerce-free, exactly as
    // `requireGitRemoteBoolean` reads the policy-side ones. The guard on this
    // record is `M.recordOf(M.string(), M.any())`, so nothing upstream
    // constrains the value, and an agent emitting the very common `'false'`
    // would otherwise get a truthy read and a real force push. Fail closed.
    const force = requireGitRemoteBoolean(
      opts.force,
      false,
      'GitRemote.push force',
    );
    const setUpstream = requireGitRemoteBoolean(
      opts.setUpstream,
      false,
      'GitRemote.push setUpstream',
    );
    if (force && opts.forceWithLease !== undefined) {
      throw new Error(
        'GitRemote.push force and forceWithLease are mutually exclusive',
      );
    }
    if (opts.source === undefined && opts.destination === undefined) {
      if (setUpstream || opts.forceWithLease !== undefined) {
        throw new Error(
          'GitRemote.push setUpstream and forceWithLease require an explicit source',
        );
      }
      return harden({
        refspecs: harden([...currentPolicy.pushRefspecs]),
        forceWithLease: undefined,
        setUpstream: false,
      });
    }
    const source = normalizeGitRef(opts.source, 'GitRemote.push source');
    const destination = normalizeGitRef(
      opts.destination ?? source,
      'GitRemote.push destination',
    );
    const forceWithLease = opts.forceWithLease;
    if (
      forceWithLease !== undefined &&
      (typeof forceWithLease !== 'string' ||
        !/^[0-9a-f]{40}$/iu.test(forceWithLease))
    ) {
      throw new Error(
        'GitRemote.push forceWithLease must be a 40-character hexadecimal object ID',
      );
    }
    // Git reads a null-OID lease as "expect this ref NOT to exist" — create-only
    // rather than guard-an-update, the opposite of what the option publishes.
    // An agent deriving a lease from a ref it could not resolve emits exactly
    // this value, so reject it rather than silently inverting the semantics.
    if (forceWithLease !== undefined && /^0{40}$/u.test(forceWithLease)) {
      throw new Error(
        'GitRemote.push forceWithLease must not be the null object ID',
      );
    }
    if (forceWithLease !== undefined && !currentPolicy.allowForcePush) {
      throw new Error('GitRemote.push forceWithLease requires allowForcePush');
    }
    // The lease names ONE concrete remote ref. Git matches a `--force-with-lease`
    // refname with `refname_match` (DWIM, no globbing) and does not warn when an
    // entry matches nothing, so a wildcard destination would bind the lease to
    // nothing. That fails CLOSED — the refspec carries no `+`, so the push
    // degrades to a plain non-force push rather than an unguarded force — but it
    // silently falsifies the guarantee this option publishes.
    if (forceWithLease !== undefined && destination.includes('*')) {
      throw new Error(
        'GitRemote.push forceWithLease requires a concrete destination ref',
      );
    }
    // `--force-with-lease` supplies the force. Do not also prefix the refspec
    // with `+`, because that would override the lease check in git push; the
    // mutual-exclusion guard above is what keeps `opts.force` from doing so.
    const refspec = `${force ? '+' : ''}${source}:${destination}`;
    assertPushRefspecAllowed(refspec);
    return harden({
      refspecs: harden([refspec]),
      // Explicit `undefined`, matching the policy-refspec branch above: one
      // function should not return the same field present-but-undefined on one
      // path and absent on another.
      forceWithLease:
        forceWithLease === undefined
          ? undefined
          : harden({ ref: destination, expectedOid: forceWithLease }),
      setUpstream,
    });
  };

  /**
   * @param {unknown} branch
   */
  const normalizePullBranch = branch => {
    if (branch !== undefined) {
      const ref = normalizeGitRef(branch, 'GitRemote.pull branch');
      // The local merge / rebase integration step may only target a ref
      // the fetch policy is allowed to populate — i.e. the destination
      // of one of `currentPolicy.fetchRefspecs`.  Without this, a holder
      // whose policy only fetches `refs/remotes/origin/main` could ask
      // to integrate an unrelated existing local ref (`refs/heads/private`),
      // gaining local-integration authority outside the remote policy.
      // Reuse the remote-policy module's matcher rather than a parallel
      // policy implementation here.
      const withinFetchPolicy = currentPolicy.fetchRefspecs.some(refspec => {
        const { dst } = parseGitRefspec(refspec, 'GitRemote.pull fetchRefspec');
        return captureGitRefPattern(ref, dst) !== undefined;
      });
      if (!withinFetchPolicy) {
        throw new Error(
          `GitRemote ${q(name)} pull branch is outside fetch policy: ${q(ref)}`,
        );
      }
      return ref;
    }
    const destination = getGitRemotePullDestination(currentPolicy);
    destination !== undefined ||
      Fail`GitRemote.pull requires a branch when fetchRefspecs are empty or wildcarded`;
    return destination;
  };

  /**
   * @param {unknown} options
   */
  const fetchOptionsFromOptions = options => {
    const opts = /** @type {{ prune?: boolean, tags?: boolean }} */ (
      options || {}
    );
    if (opts.tags && !currentPolicy.allowTags) {
      throw new Error('GitRemote fetch tags require allowTags: true');
    }
    if (opts.prune && !currentPolicy.allowDelete) {
      throw new Error('GitRemote fetch prune requires allowDelete: true');
    }
    return harden({ prune: !!opts.prune, tags: !!opts.tags });
  };

  const remote = makeExo('GitRemote', GitRemoteInterface, {
    /** @returns {Promise<RemoteSnapshot>} */
    async inspect() {
      ensureLive();
      return snapshotPolicy();
    },

    /**
     * Whether the credential this remote would push with is usable right now.
     * Deliberately NOT part of `inspect()`: the snapshot is policy, and a test
     * asserts it carries nothing credential-shaped. This reports health only —
     * kind, audience, availability, revocation — never material.
     *
     * @returns {Promise<object>}
     */
    async credentialHealth() {
      ensureLive();
      return endpoint.credentialHealth();
    },

    /**
     * @param {Parameters<GitRemote['fetch']>[0]} [options]
     * @returns {Promise<RemoteOperationResult>}
     */
    async fetch(options = {}) {
      await null;
      let fence;
      try {
        ensureDirection('fetch');
        const fetchOptions = fetchOptionsFromOptions(options);
        fence = captureOperationFence();
        const transportCredential = ensureCredentialUsable();
        const activeOperation = beginOperation();
        let result;
        try {
          result = await backend.remoteFetch({
            url: currentPolicy.url,
            refspecs: currentPolicy.fetchRefspecs,
            prune: fetchOptions.prune,
            tags: fetchOptions.tags,
            credential: transportCredential,
            signal: activeOperation.signal,
          });
        } finally {
          activeOperation.finish();
        }
        assertOperationFence('fetch', fence);
        recordOperationSuccess('fetch', result);
        return result;
      } catch (err) {
        const finalErr =
          fence === undefined ? err : operationError('fetch', fence, err);
        recordOperationFailure('fetch', finalErr);
        throw finalErr;
      }
    },

    /**
     * @param {Parameters<GitRemote['pull']>[0]} [options]
     * @returns {Promise<RemotePullResult>}
     */
    async pull(options = {}) {
      await null;
      let fence;
      let appliedLocally = false;
      try {
        ensureDirection('fetch');
        const fetchOptions = fetchOptionsFromOptions(options);
        fence = captureOperationFence();
        const transportCredential = ensureCredentialUsable();
        const opts =
          /** @type {{ branch?: unknown, strategy?: 'merge' | 'rebase' | 'ff-only' }} */ (
            options
          );
        const activeOperation = beginOperation();
        let fetch;
        try {
          fetch = await backend.remoteFetch({
            url: currentPolicy.url,
            refspecs: currentPolicy.fetchRefspecs,
            prune: fetchOptions.prune,
            tags: fetchOptions.tags,
            credential: transportCredential,
            signal: activeOperation.signal,
          });
        } finally {
          activeOperation.finish();
        }
        assertOperationFence('pull', fence);
        const branch = normalizePullBranch(opts.branch);
        /** @type {'merge' | 'rebase' | 'ff-only'} */
        const strategy = opts.strategy || 'ff-only';
        const headBefore = await E(git).revParse('HEAD');
        switch (strategy) {
          case 'ff-only':
            await E(git).merge(branch, { fastForwardOnly: true });
            break;
          case 'merge':
            await E(git).merge(branch);
            break;
          case 'rebase':
            await E(git).rebase({ mode: 'start', upstream: branch });
            break;
          default:
            throw new Error(
              'GitRemote.pull strategy must be merge, rebase, or ff-only',
            );
        }
        const head = await E(git).revParse('HEAD');
        const headOidBefore =
          /** @type {{ oid?: string }} */ (headBefore).oid || '';
        const headOid = /** @type {{ oid?: string }} */ (head).oid || '';
        /** @type {'up-to-date' | 'fast-forward' | 'merge' | 'rebase'} */
        let integration;
        if (headOidBefore === headOid) {
          integration = 'up-to-date';
        } else {
          appliedLocally = true;
          switch (strategy) {
            case 'ff-only':
              integration = 'fast-forward';
              break;
            case 'merge':
              integration = 'merge';
              break;
            case 'rebase':
              integration = 'rebase';
              break;
            default:
              throw new Error(
                'GitRemote.pull strategy must be merge, rebase, or ff-only',
              );
          }
        }
        const result = harden({
          fetch,
          integration,
          head,
        });
        assertOperationFence('pull', fence);
        recordOperationSuccess('pull', result);
        return /** @type {RemotePullResult} */ (result);
      } catch (err) {
        const finalErr =
          fence === undefined ? err : operationError('pull', fence, err);
        recordOperationFailure('pull', finalErr, { appliedLocally });
        throw finalErr;
      }
    },

    /**
     * @param {Parameters<GitRemote['push']>[0]} [options]
     * @returns {Promise<RemoteOperationResult>}
     */
    async push(options = {}) {
      await null;
      let fence;
      try {
        ensureDirection('push');
        fence = captureOperationFence();
        const transportCredential = ensureCredentialUsable();
        const { refspecs, forceWithLease, setUpstream } =
          pushRefspecsFromOptions(options);
        const activeOperation = beginOperation();
        let result;
        try {
          result = await backend.remotePush({
            url: currentPolicy.url,
            refspecs,
            forceWithLease,
            setUpstream,
            credential: transportCredential,
            signal: activeOperation.signal,
          });
        } finally {
          activeOperation.finish();
        }
        assertOperationFence('push', fence);
        recordOperationSuccess('push', result);
        return result;
      } catch (err) {
        const finalErr =
          fence === undefined ? err : operationError('push', fence, err);
        recordOperationFailure('push', finalErr);
        throw finalErr;
      }
    },
  });

  const recordPolicyChange = method => {
    recordAudit({
      type: 'policy',
      method,
      policy: snapshotPolicy(),
      revoked,
    });
  };

  const controller = makeExo(
    'GitRemoteController',
    GitRemoteControllerInterface,
    {
      async inspect() {
        return harden({ ...snapshotPolicy(), revoked });
      },

      async audit() {
        return harden([...auditLog]);
      },

      async setAllowedDirections(directions) {
        const nextPolicy = normalizeGitRemotePolicy({
          name,
          policy: {
            ...currentPolicy,
            allowedDirections: /** @type {GitDirection[]} */ ([...directions]),
          },
        });
        await persistState(nextPolicy, revoked);
        currentPolicy = nextPolicy;
        invalidateOperations('policy');
        recordPolicyChange('setAllowedDirections');
      },

      async setFetchRefspecs(refspecs) {
        const nextPolicy = normalizeGitRemotePolicy({
          name,
          policy: { ...currentPolicy, fetchRefspecs: [...refspecs] },
        });
        await persistState(nextPolicy, revoked);
        currentPolicy = nextPolicy;
        invalidateOperations('policy');
        recordPolicyChange('setFetchRefspecs');
      },

      async setPushRefspecs(refspecs) {
        const nextPolicy = normalizeGitRemotePolicy({
          name,
          policy: {
            ...currentPolicy,
            allowedBranches: undefined,
            pushRefspecs: [...refspecs],
          },
        });
        await persistState(nextPolicy, revoked);
        currentPolicy = nextPolicy;
        invalidateOperations('policy');
        recordPolicyChange('setPushRefspecs');
      },

      async setAllowedBranches(branches) {
        const nextPolicy = normalizeGitRemotePolicy({
          name,
          policy: {
            ...currentPolicy,
            pushRefspecs: [],
            allowedBranches: [...branches],
          },
        });
        await persistState(nextPolicy, revoked);
        currentPolicy = nextPolicy;
        invalidateOperations('policy');
        recordPolicyChange('setAllowedBranches');
      },

      async setAllowForcePush(flag) {
        const nextPolicy = normalizeGitRemotePolicy({
          name,
          policy: { ...currentPolicy, allowForcePush: !!flag },
        });
        await persistState(nextPolicy, revoked);
        currentPolicy = nextPolicy;
        invalidateOperations('policy');
        recordPolicyChange('setAllowForcePush');
      },

      async setAllowTags(flag) {
        const nextPolicy = normalizeGitRemotePolicy({
          name,
          policy: { ...currentPolicy, allowTags: !!flag },
        });
        await persistState(nextPolicy, revoked);
        currentPolicy = nextPolicy;
        invalidateOperations('policy');
        recordPolicyChange('setAllowTags');
      },

      async setAllowDelete(flag) {
        const nextPolicy = normalizeGitRemotePolicy({
          name,
          policy: { ...currentPolicy, allowDelete: !!flag },
        });
        await persistState(nextPolicy, revoked);
        currentPolicy = nextPolicy;
        invalidateOperations('policy');
        recordPolicyChange('setAllowDelete');
      },

      async revoke() {
        revoked = true;
        invalidateOperations('revoke');
        recordAudit({ type: 'revoke', policy: snapshotPolicy(), revoked });
        await persistState(currentPolicy, true);
      },
    },
  );

  // Register the controller in the host-private companion map.
  remoteControllers.set(remote, controller);

  const typedRemote = /** @type {GitRemote} */ (remote);
  const typedController = /** @type {GitRemoteController} */ (controller);
  return harden({
    remote: typedRemote,
    controller: typedController,
  });
};
harden(makeGitRemote);
