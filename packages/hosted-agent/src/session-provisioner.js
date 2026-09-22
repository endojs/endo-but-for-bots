// @ts-check

/**
 * One session provisioner for every hosted backend.
 *
 * A hosted backend records one approved plan per Floot session with the
 * daemon's session owner and starts the owner's native controller with the
 * tool set Floot pinned. The lifecycle is the same for every runtime: inspect
 * the record, settle the model pin, compose the plan, refuse a placement the
 * controller or the storage owner would refuse, create the record or reopen
 * it in place, rebinding what it was recorded with only under a request that
 * names that binding, stop whatever ran before, heal the recorded
 * directories, and start. Only the plan's own fields, the private paths the
 * runtime needs, the fields that cannot change between incarnations, the
 * bindings a request may authorize changing and the pin policy differ between
 * runtimes; an adapter declares those and copies none of the algorithm.
 *
 * Every provision re-resolves the guest roots and the protected roots (host
 * records, the runtime directory, the broker's directory) and refuses a guest
 * root that resolves into protected storage, an operator workspace that is not
 * an existing canonical directory, and one that overlaps any root: exported
 * through 9P, it would expose other sessions' storage, host checkpoints, or
 * this session's own sockets and mount point. These checks are point-in-time;
 * an operator who replaces a directory afterwards, or an ancestor of it, does
 * so with host authority this provisioner does not check again while the
 * session runs.
 *
 * @module
 */

import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { Fail, b, q } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { recordedPinAnswers, revisedPin } from './backend-catalog.js';
import { resolveFuturePath } from './hosted-setup.js';
import {
  containsPath,
  isNormalizedAbsolutePath,
  makeSandboxSessionId,
  readMounterEnv,
  readRecordedPath,
} from './session-plan.js';

/**
 * What a hosted backend asks the provisioner to record for a session, beyond
 * its id: the network policy the broker must attest, the pin and persona the
 * plan carries, an optional pinned subscription and an optional
 * operator-supplied workspace. An adapter may carry further fields its plan
 * records (Codex's container mounts).
 * @typedef {object} SessionRequest
 * @property {'off' | 'public-internet'} networkPolicy
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {string} [systemPrompt]
 * @property {string} [subscription] A pinned pool member; absent means auto.
 * @property {string} [workspaceHostPath] Operator-supplied worktree; never
 *   owned, never removed.
 */

/**
 * The placement every hosted plan records and no reopen may change, by field
 * and the name a refusal gives it; an adapter adds its own (the pinned image,
 * the credential kind, the account).
 */
const PLACEMENT_NAMES = harden({
  sessionId: 'identity',
  sandboxSessionId: 'identity',
  workspaceDir: 'workspace',
  workspaceHostPath: 'workspace',
  workspaceMountPoint: 'private directories',
  mounterSocketDir: 'private directories',
});

/**
 * The bindings a reopen may be authorized to change, the same three for
 * every hosted backend: `image`, the pinned image the plan records as
 * `rootfs`; `account`, the account authority it records as `accountRef`
 * (and, for an adapter whose credential has a kind, that kind); and
 * `provider`, the record's dependencies, the broker, the sandbox and state
 * services and the storage owner, which change together when a backend is
 * re-minted over other services.
 */
const IMAGE = 'image';
const ACCOUNT = 'account';
const PROVIDER = 'provider';
const BINDINGS = harden([IMAGE, ACCOUNT, PROVIDER]);
/** The plan fields every backend binds, by field and binding name. */
const SHARED_REBINDABLE = harden({ rootfs: IMAGE, accountRef: ACCOUNT });

/**
 * What a reopen is authorized to rebind: the names of the bindings it may
 * change, or none. An unknown name is refused rather than ignored, so an
 * authorization meant for another adapter's binding cannot pass as one.
 *
 * @param {unknown} value
 * @param {ReadonlySet<string>} known
 * @param {string} label
 * @returns {readonly string[]}
 */
const readRebind = (value, known, label) => {
  if (value === undefined) return harden([]);
  // A statement rather than `Array.isArray(value) || Fail`: only control
  // flow narrows.
  if (!Array.isArray(value)) {
    throw Fail`${b(label)} rebind must list the bindings a reopen may change`;
  }
  /** @type {string[]} */
  const names = [];
  for (const name of value) {
    (typeof name === 'string' && known.has(name)) ||
      Fail`${b(label)} cannot rebind ${q(name)}; it rebinds ${q([...known])}`;
    names.push(name);
  }
  return harden([...new Set(names)]);
};

/**
 * @param {object} powers
 * @param {string} powers.label The adapter's name for messages.
 * @param {any} powers.owner The daemon session owner the records belong to.
 * @param {Record<string, string>} powers.dependencies The exact formula
 *   identities a new record is created with.
 * @param {string} powers.workspaceRoot Root of owned per-session workspaces.
 * @param {string} powers.privateRoot Root of per-session private directories:
 *   the mount point, the 9P socket and the adapter's own private paths.
 * @param {readonly string[]} [powers.protectedRoots] Host-only records and
 *   services no guest storage may resolve into.
 * @param {string} [powers.sandboxIdFallback] The adapter's slug when nothing
 *   of a session id survives derivation; recorded ids must not change under
 *   it.
 * @param {Record<string, string>} [powers.privatePaths] Further recorded
 *   private directories, by plan field and name under the session's private
 *   directory (`{ mcpDir: 'mcp' }`): created on every start, never revised.
 * @param {(text: string) => Record<string, any>} powers.readPlan The
 *   adapter's parser: what the controller activates and the storage owner
 *   removes.
 * @param {(context: { request: Record<string, any> }) => Record<string, any>} [powers.fields]
 *   The adapter's own plan fields. Declared image/account binding fields
 *   must be request-independent: inspection projects them with an empty
 *   request without admitting a model or acquiring any session resources.
 * @param {Record<string, string>} [powers.immutable] Adapter fields no reopen
 *   may change, by plan field and the name a refusal gives it.
 * @param {Record<string, string>} [powers.rebindable] Further adapter fields
 *   a reopen may change only under a request that authorizes it, by plan
 *   field and the binding it sits under, `image` or `account`
 *   (`{ credentialKind: 'account' }`); every backend binds `rootfs` under
 *   `image` and `accountRef` under `account`, and its dependencies under
 *   `provider`. A durable session keeps its identity, workspace and
 *   conversation across such a rebind; the incarnation before it is stopped,
 *   and its authority released, first.
 * @param {object} [powers.pin]
 * @param {'catalog-default' | 'runtime-default'} [powers.pin.unpinned] What a
 *   session that names no model gets: the default the account's catalog
 *   marks, refused when it marks none, or the runtime's own default, unpinned
 *   and without asking the catalog.
 * @param {(effort: string) => string} [powers.pin.assertEffort] For a runtime
 *   that runs unpinned, its own check of an effort named without a model.
 * @param {{ resolve(pin: { model?: string, reasoningEffort?: string, subscription?: string }): Promise<{ model: string, reasoningEffort?: string }> }} powers.catalog
 *   Admits a new session's pin against the accounts it may be served from.
 * @param {Record<string, string>} [powers.mounterEnv] Recorded into every
 *   plan for the session's own 9P mounter.
 */
export const makeSessionProvisioner = ({
  label,
  owner,
  dependencies,
  workspaceRoot,
  privateRoot,
  protectedRoots = [],
  sandboxIdFallback = 'session',
  privatePaths = {},
  readPlan,
  fields = () => ({}),
  immutable = {},
  rebindable = {},
  pin: { unpinned = 'catalog-default', assertEffort = effort => effort } = {},
  catalog,
  mounterEnv,
}) => {
  readRecordedPath('workspace root', workspaceRoot);
  readRecordedPath('private root', privateRoot);
  (!containsPath(workspaceRoot, privateRoot) &&
    !containsPath(privateRoot, workspaceRoot)) ||
    Fail`${b(label)} storage roots must be disjoint`;
  for (const root of protectedRoots) {
    // Setup persists these paths; a spelling the plan reader would refuse is
    // a configuration error to fix there, not to normalize here.
    isNormalizedAbsolutePath(root) ||
      Fail`${b(label)} protected root ${q(root)} must be a normalized absolute path`;
  }
  if (mounterEnv !== undefined) readMounterEnv(mounterEnv);
  const roots = harden([workspaceRoot, privateRoot, ...protectedRoots]);
  const privateNames = harden(Object.keys(privatePaths));
  const immutableNames = harden({
    ...PLACEMENT_NAMES,
    ...Object.fromEntries(
      privateNames.map(name => [name, 'private directories']),
    ),
    ...immutable,
  });
  for (const [field, name] of Object.entries(rebindable)) {
    name === IMAGE ||
      name === ACCOUNT ||
      Fail`${b(label)} rebindable field ${q(field)} must sit under ${q(IMAGE)} or ${q(ACCOUNT)}, not ${q(name)}`;
    !Object.hasOwn(SHARED_REBINDABLE, field) ||
      Fail`${b(label)} rebindable field ${q(field)} is bound for every backend`;
  }
  const rebindableNames = harden({ ...SHARED_REBINDABLE, ...rebindable });
  const bindings = harden(new Set(BINDINGS));

  /**
   * The recorded pin answers a reopen that names it, or nothing; a new
   * session's pin, or a changed one, is admitted by the account's catalog
   * now, and missing discovery refuses rather than substituting. An effort
   * changed on its own keeps the recorded model. A record without a model is
   * a new pin too, unless the runtime runs its own default unpinned.
   *
   * @param {Record<string, any> | undefined} recorded
   * @param {Record<string, any>} request
   * @returns {Promise<{ model?: string, reasoningEffort?: string }>}
   */
  const settlePin = async (recorded, request) => {
    if (
      recorded !== undefined &&
      (recorded.model !== undefined || unpinned === 'runtime-default') &&
      recordedPinAnswers(recorded, request)
    ) {
      return harden({
        ...(recorded.model === undefined ? {} : { model: recorded.model }),
        ...(recorded.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: recorded.reasoningEffort }),
      });
    }
    const asked = revisedPin(recorded, request);
    if (!asked.model && unpinned === 'runtime-default') {
      // The runtime's own default runs, unpinned, as it did before discovery;
      // nobody picks a model from the list for it. An effort is then the
      // runtime's axis, checked as such.
      return harden(
        asked.reasoningEffort
          ? { reasoningEffort: assertEffort(asked.reasoningEffort) }
          : {},
      );
    }
    return catalog.resolve(asked);
  };

  /**
   * An operator-supplied workspace may not overlap any root. This is the
   * spelling check; aliases are refused against the canonical roots below.
   * @param {unknown} foreign
   */
  const assertForeignSpelling = foreign => {
    if (!isNormalizedAbsolutePath(foreign)) {
      throw Fail`workspaceHostPath ${q(foreign)} must be a normalized absolute path`;
    }
    for (const root of roots) {
      (!containsPath(root, foreign) && !containsPath(foreign, root)) ||
        Fail`workspaceHostPath ${q(foreign)} must be disjoint from the session storage roots`;
    }
  };

  /**
   * Resolve even roots not created yet: lexical disjointness alone admits
   * aliases into host checkpoints or service-private state. Rechecked before
   * every activation, for owned workspaces too, not just foreign ones.
   * @param {Record<string, any>} plan
   */
  const assertPlacement = async plan => {
    const canonical = await Promise.all(
      roots.map(root => resolveFuturePath(root, label)),
    );
    for (const [index, root] of canonical.slice(0, 2).entries()) {
      for (const other of canonical.slice(index + 1)) {
        (!containsPath(root, other) && !containsPath(other, root)) ||
          Fail`${b(label)} guest storage overlaps protected session storage`;
      }
    }
    if (plan.workspaceHostPath === undefined) return;
    const foreign = plan.workspaceHostPath;
    const info = await lstat(foreign).catch(error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
        return undefined;
      throw error;
    });
    (info !== undefined && info.isDirectory() && !info.isSymbolicLink()) ||
      Fail`workspaceHostPath ${q(foreign)} must be an existing directory`;
    // A path spelled through an alias (a symbolic link above its last
    // component, `/var` for `/private/var`) could resolve inside a root the
    // spelling check cleared, so the recorded path must be its own canonical
    // form and disjoint from the roots' canonical forms, which need not exist
    // yet.
    const resolved = await realpath(foreign);
    resolved === foreign ||
      Fail`workspaceHostPath ${q(foreign)} must be a canonical path; it resolves to ${q(resolved)}`;
    for (const root of canonical) {
      (!containsPath(root, foreign) && !containsPath(foreign, root)) ||
        Fail`workspaceHostPath ${q(foreign)} must be disjoint from the session storage roots`;
    }
  };

  /**
   * @param {string} sessionId
   * @param {Record<string, any>} request A `SessionRequest`, with the
   *   adapter's own fields.
   * @param {any} toolSet
   */
  const provision = async (sessionId, request, toolSet) => {
    const sandboxSessionId = makeSandboxSessionId(sessionId, sandboxIdFallback);
    const privateDir = join(privateRoot, sandboxSessionId);
    const record = await E(owner).inspect(sessionId);
    const recorded =
      record?.plan === undefined ? undefined : readPlan(record.plan);
    const pin = await settlePin(recorded, request);
    const owned = request.workspaceHostPath === undefined;
    if (!owned) assertForeignSpelling(request.workspaceHostPath);
    const proposed = harden({
      sessionId,
      sandboxSessionId,
      ...fields({ request }),
      networkPolicy: request.networkPolicy,
      ...(owned
        ? { workspaceDir: join(workspaceRoot, sandboxSessionId) }
        : { workspaceHostPath: request.workspaceHostPath }),
      workspaceMountPoint: join(privateDir, 'workspace'),
      ...Object.fromEntries(
        privateNames.map(name => [name, join(privateDir, privatePaths[name])]),
      ),
      mounterSocketDir: join(privateDir, '9p'),
      ...(mounterEnv === undefined ? {} : { mounterEnv }),
      ...(request.subscription ? { subscription: request.subscription } : {}),
      ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
      ...pin,
    });
    const text = JSON.stringify(proposed);
    // The controller and the storage owner parse exactly this text later;
    // refuse now what they would refuse then.
    const plan = readPlan(text);
    const authorized = readRebind(request.rebind, bindings, label);
    // Whether the record's dependencies are those this backend holds now.
    const rebound =
      record !== undefined &&
      Object.entries(dependencies).some(
        ([role, id]) => record.references?.[role] !== id,
      );
    if (record !== undefined) {
      if (recorded === undefined) {
        throw Fail`Session ${q(sessionId)} has an incomplete record; destroy it before reuse`;
      }
      // What a record was created with as its placement cannot be revised: a
      // request naming different storage or a re-rooted backend is a
      // different session. The network policy, the pin, the subscription and
      // the persona may change between incarnations.
      for (const [name, what] of Object.entries(immutableNames)) {
        recorded[name] === plan[name] ||
          Fail`Session ${q(sessionId)} ${b(what)} cannot change; destroy the session first`;
      }
      // What a record was bound to may change between incarnations only
      // under a request that names it: the pinned image, the account or the
      // credential kind a broker re-minted since now carries, and the
      // services the record depends on. The session keeps its identity,
      // workspace and conversation; the incarnation bound before is stopped
      // first, below, and the daemon refuses the revision while any of its
      // authority is still held.
      const changed = new Set(
        Object.entries(rebindableNames)
          .filter(([name]) => recorded[name] !== plan[name])
          .map(([, what]) => what),
      );
      if (rebound) changed.add(PROVIDER);
      for (const what of changed) {
        authorized.includes(what) ||
          Fail`Session ${q(sessionId)} ${b(what)} cannot change without a reopen that authorizes rebinding it; destroy the session, or reopen it with rebind: [${q(what)}]`;
      }
    } else {
      authorized.length === 0 ||
        Fail`Session ${q(sessionId)} has no record to rebind`;
    }
    await assertPlacement(plan);
    if (record === undefined) {
      await E(owner).create(sessionId, text, harden({ ...dependencies }));
    } else {
      // Stop before reuse, whatever the record's phase: an interrupted start
      // is retried through its cleanup here rather than only through
      // deletion, and a live incarnation from an earlier backend cannot keep
      // a tool authority this request does not hold. A revision the stop
      // did not clear the way for is the daemon's to refuse.
      await E(owner).stop(sessionId);
      if (rebound) {
        await E(owner).revise(sessionId, text, harden({ ...dependencies }));
      } else if (record.plan !== text) {
        await E(owner).revise(sessionId, text);
      }
    }
    // Only a recorded plan owns these; the mounter creates the mount point.
    // Idempotent on every start, so a record whose directories were never
    // created, or were removed between incarnations, heals here rather than
    // failing at the controller until it is destroyed.
    for (const directory of [
      privateDir,
      ...privateNames.map(name => plan[name]),
      plan.mounterSocketDir,
      ...(plan.workspaceDir === undefined ? [] : [plan.workspaceDir]),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    return E(owner).start(sessionId, toolSet);
  };
  /**
   * Diagnostic only: no catalog read, activation, mutation or authorization.
   * Project only declared binding fields and dependency identities, never
   * tools, persona, credentials or incarnation references. A later reopen
   * still compares the actual record against its own proposed bindings.
   * @param {string} sessionId
   */
  const inspectBindings = async sessionId => {
    const record = await E(owner).inspect(sessionId);
    const plan = record === undefined ? undefined : readPlan(record.plan);
    const proposedFields = fields({ request: {} });
    /** @param {Record<string, any>} values */
    const project = values =>
      Object.fromEntries(
        [IMAGE, ACCOUNT].map(binding => [
          binding,
          Object.fromEntries(
            Object.entries(rebindableNames)
              .filter(([, name]) => name === binding)
              .map(([field]) => [field, values[field] ?? null]),
          ),
        ]),
      );
    const proposed = {
      ...project(proposedFields),
      provider: { ...dependencies },
    };
    const recorded =
      plan === undefined
        ? null
        : {
            ...project(plan),
            provider: Object.fromEntries(
              Object.keys(dependencies).map(role => [
                role,
                record.references?.[role] ?? null,
              ]),
            ),
          };
    const changed =
      recorded === null
        ? []
        : [...bindings].filter(binding =>
            Object.entries(proposed[binding]).some(
              ([key, value]) => recorded[binding][key] !== value,
            ),
          );
    return harden({ recorded, proposed, changed });
  };

  // The names a request may authorize, declared with the function so the
  // factory's descriptor can carry them to an operator.
  return harden(
    Object.assign(provision, {
      rebindable: harden([...bindings]),
      inspectBindings,
    }),
  );
};
harden(makeSessionProvisioner);
