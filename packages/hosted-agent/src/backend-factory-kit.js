// @ts-check

/**
 * One Floot-facing factory for every hosted backend.
 *
 * Floot discovers hosted backends through `HostedBackendFactoryInterface`:
 * `describe()` names the backend, `modelCatalog()` offers its catalog, and
 * `create(spec, toolSet)` hands back one session's `run` facet (the turn
 * protocol Floot's hosted-turn consumer drives) and its factory-only `admin`
 * facet. Session lifetime belongs to the daemon's session owner, not to the
 * factory: the injected `provisionSession` records the approved plan and its
 * exact dependencies, starts the native controller with the pinned tool set,
 * and returns the owner's forwarding facet; `stopSession` and `removeSession`
 * reach the owner's stop and removal, which retain failed native cleanup and
 * refuse a successor until it succeeds. The factory validates Floot's request,
 * serializes operations per session, retains each session's termination until
 * it succeeds, and translates the facet into the hosted turn protocol. It
 * performs no rollback of its own.
 *
 * An adapter declares what differs: the descriptor, the request fields its
 * runtime has (an effort axis, container mounts, a working directory) and how
 * a session's `run` facet drives its client. It copies none of the lifecycle.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { makeResourceRegistry as makeSessionRegistry } from '@endo/sandbox/resource-registry.js';
import path from 'node:path';

import {
  HostedBackendFactoryInterface,
  HostedTurnBackendAdminInterface,
  HostedTurnBackendInterface,
} from './hosted-backend.js';
import { assertSessionId } from './session-plan.js';

/** @import { DeclaredSubscription } from './subscription-lister.js' */

/** The network policies a session may request; the broker attests each. */
export const NETWORK_POLICIES = harden(['off', 'public-internet']);

/**
 * A client's `interrupt()` refuses when nothing is in flight. For a
 * cancellation barrier that is success, not failure: the turn it would have
 * stopped has already ended (or its reader was closed first, which is what
 * ends the turn).
 *
 * @param {unknown} error
 */
export const isIdleInterrupt = error =>
  error instanceof Error &&
  /no in-flight prompt to interrupt/.test(error.message);
harden(isIdleInterrupt);

/**
 * An operator-supplied workspace, as Floot spells it: the provisioner refuses
 * what would overlap session storage or resolve elsewhere.
 * @param {unknown} value
 * @returns {string | undefined}
 */
const readWorkspaceHostPath = value => {
  if (value === undefined) return undefined;
  const workspaceHostPath = `${value}`;
  (workspaceHostPath.length > 0 &&
    workspaceHostPath.length <= 4096 &&
    path.isAbsolute(workspaceHostPath) &&
    path.normalize(workspaceHostPath) === workspaceHostPath &&
    !workspaceHostPath.includes('\0')) ||
    Fail`workspaceHostPath must be a normalized absolute host path`;
  return workspaceHostPath;
};

/**
 * The bindings a reopen says it may change, as a short list of names; what
 * each names, and whether it is known, is the provisioner's to decide.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {readonly string[]}
 */
const readRebind = (value, label) => {
  // A statement rather than `Array.isArray(value) || Fail`: only control
  // flow narrows.
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    !value.every(
      name => typeof name === 'string' && name.length > 0 && name.length <= 64,
    )
  ) {
    throw Fail`${b(label)} rebind must be a short list of binding names`;
  }
  return harden([...value]);
};

/**
 * @param {object} powers
 * @param {string} powers.label The adapter's name for messages.
 * @param {((sessionId: string, request: Record<string, any>, toolSet: any) => Promise<any>) & { rebindable?: readonly string[], inspectBindings?: (sessionId: string) => Promise<any> }} powers.provisionSession
 *   Record (or reopen) the session's plan with the daemon owner and start its
 *   native controller with the pinned tool set, returning the client facet.
 *   A rejection leaves whatever the owner acquired under the owner's retained
 *   cleanup; the factory does not roll back.
 * @param {(sessionId: string) => Promise<void>} powers.stopSession The
 *   owner's stop: fences the facet, awaits the controller's native cleanup
 *   acknowledgement, and retains failure for retry. Durable workspace and
 *   native state survive.
 * @param {(sessionId: string) => Promise<void>} powers.removeSession The
 *   owner's removal: native cleanup, then the recorded storage owner's
 *   deletion, retaining failure and refusing reuse until it succeeds.
 * @param {{ catalog(subscriptionId?: string): Promise<any> }} powers.catalog
 *   What each account of the broker lists, as the runtime offers it.
 * @param {boolean} [powers.publicInternetEnabled] Verified operator broker
 *   policy.
 * @param {() => Promise<DeclaredSubscription[]>} [powers.listSubscriptions]
 *   The provider's subscriptions a session may be pinned to; none when the
 *   broker holds one credential.
 * @param {() => Record<string, any>} powers.describe The fixed part of the
 *   descriptor: `id`, `title`, `continuity`, `providerId` where the runtime
 *   spends one provider's credential, and `promptEnvironment`.
 * @param {(spec: Record<string, any>) => Record<string, any>} [powers.readRequest]
 *   The runtime's own request fields, validated in shape: an effort, a
 *   working directory. Whether an account lists a model, and the effort it
 *   offers, is the provisioner's to admit against the catalog.
 * @param {(value: unknown) => readonly unknown[] | undefined} [powers.readContainerMounts]
 *   The container mounts a session may declare; by default none, refused
 *   rather than claimed.
 * @param {(session: { client: any, spec: Record<string, any>, request: Record<string, any>, subscription: string | undefined }) => Record<string, any>} powers.makeRun
 *   The session's `run` facet over the owner's client facet: `send`,
 *   `models`, `interrupt`, `acknowledge`, `status` and `help`.
 * @param {string} powers.adminHelp
 * @param {string} [powers.exoName]
 */
export const makeHostedBackendFactory = ({
  label,
  provisionSession,
  stopSession,
  removeSession,
  catalog,
  publicInternetEnabled = false,
  listSubscriptions = async () => [],
  describe,
  readRequest = () => ({}),
  readContainerMounts = value => {
    const declared = value ?? [];
    (Array.isArray(declared) && declared.length === 0) ||
      Fail`The ${b(label)} backend has no slice attestation for container mounts; refusing the session instead of claiming binds it does not have`;
    return undefined;
  },
  makeRun,
  adminHelp,
  exoName = `${label.replace(/\s+/g, '')}BackendFactory`,
}) => {
  const networkPolicies = harden(
    publicInternetEnabled ? [...NETWORK_POLICIES] : ['off'],
  );
  const sessions = makeSessionRegistry();

  /**
   * @param {Record<string, any>} spec
   * @param {any} toolSet
   */
  const createSession = async (spec, toolSet) => {
    const { sessionId } = spec;
    const networkPolicy = spec.networkPolicy ?? 'off';
    NETWORK_POLICIES.includes(networkPolicy) ||
      Fail`Unknown network policy ${q(networkPolicy)}; expected "off" or "public-internet"`;
    networkPolicies.includes(networkPolicy) ||
      Fail`${b(label)} broker does not permit public internet access`;
    // Shape only: whether the account lists the model is the provisioner's
    // to admit for a new pin, against the catalog; a reopen keeps its
    // recorded pin.
    if (spec.model !== undefined && spec.model !== '') {
      (typeof spec.model === 'string' && spec.model.length <= 256) ||
        Fail`${b(label)} model id must be a bounded string`;
    }
    const containerMounts = readContainerMounts(spec.containerMounts);
    const workspaceHostPath = readWorkspaceHostPath(spec.workspaceHostPath);
    // `auto` is the default and is not recorded; an id must be one the
    // broker declares now, so a typo fails here and not on the first turn.
    const subscription =
      spec.subscription === undefined || spec.subscription === 'auto'
        ? undefined
        : spec.subscription;
    if (subscription !== undefined) {
      const declared = await listSubscriptions().catch(() => {
        throw Fail`${b(label)} subscriptions cannot be listed right now`;
      });
      declared.some(member => member.id === subscription) ||
        Fail`Unknown ${b(label)} subscription ${q(subscription)}`;
    }
    // The adapter's fields first: what the kit validated is never overridden
    // by a reader that happens to name the same field.
    // Shape only: which bindings a reopen may change is the provisioner's,
    // which refuses a name it does not know.
    const rebind =
      spec.rebind === undefined ? undefined : readRebind(spec.rebind, label);
    const request = harden({
      ...readRequest(spec),
      networkPolicy,
      ...(subscription === undefined ? {} : { subscription }),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
      ...(workspaceHostPath ? { workspaceHostPath } : {}),
      ...(containerMounts === undefined ? {} : { containerMounts }),
      ...(rebind === undefined ? {} : { rebind }),
    });
    // A predecessor that cannot stop refuses the successor rather than
    // running beside it: the registry retains its failed stop and rethrows.
    await sessions.stop(sessionId);
    const client = await provisionSession(sessionId, request, toolSet);

    let terminated = false;
    /** @type {Promise<void> | undefined} */
    let stopInFlight;
    const terminate = () => {
      if (terminated) return Promise.resolve();
      if (stopInFlight) return stopInFlight;
      stopInFlight = (async () => {
        await null;
        // The owner's stop is the containment barrier: it does not resolve
        // until the controller acknowledges native cleanup. A failure retains
        // this terminate for retry through the registry.
        await stopSession(sessionId);
        terminated = true;
        sessions.release(sessionId, terminate);
      })().finally(() => {
        if (!terminated) stopInFlight = undefined;
      });
      return stopInFlight;
    };

    const run = makeExo(
      'HostedTurnBackend',
      HostedTurnBackendInterface,
      /** @type {any} */ (makeRun({ client, spec, request, subscription })),
    );
    const admin = makeExo(
      'HostedTurnBackendAdmin',
      HostedTurnBackendAdminInterface,
      { terminate, help: () => adminHelp },
    );
    sessions.retain(sessionId, terminate);
    return harden({ run, admin });
  };

  return makeExo(exoName, HostedBackendFactoryInterface, {
    async describe() {
      // A broker that cannot be asked right now declares nothing here; the
      // descriptor is not the place to fail.
      /** @type {DeclaredSubscription[]} */
      const declared = await listSubscriptions().catch(() => []);
      const subscriptions = declared.map(member => ({
        id: member.id,
        label: member.label,
        ...(member.pinnedOnly === true ? { pinnedOnly: true } : {}),
      }));
      const rebindable = provisionSession.rebindable ?? [];
      return harden({
        ...describe(),
        kind: 'hosted',
        toolOwnership: 'endo',
        ...(subscriptions.length ? { subscriptions } : {}),
        supportedNetworkPolicies: networkPolicies,
        // What a reopen of a session on this backend may be authorized to
        // rebind, as the provisioner names it.
        ...(rebindable.length ? { rebindableBindings: [...rebindable] } : {}),
      });
    },
    modelCatalog: subscriptionId => catalog.catalog(subscriptionId),
    async inspectBindings(spec) {
      const sessionId = assertSessionId(spec?.sessionId, label);
      const inspect = provisionSession.inspectBindings;
      if (!inspect) throw Fail`${b(label)} does not expose binding inspection`;
      return sessions.inOrder(sessionId, () => inspect(sessionId));
    },
    async create(spec, toolSet) {
      const sessionId = assertSessionId(spec?.sessionId, label);
      return sessions.inOrder(sessionId, () => createSession(spec, toolSet));
    },
    async stop(spec) {
      const sessionId = assertSessionId(spec?.sessionId, label);
      return sessions.inOrder(sessionId, async () => {
        // Reach the durable owner even when no admin survived this factory.
        if (!(await sessions.stop(sessionId))) await stopSession(sessionId);
      });
    },
    async destroy(spec) {
      const sessionId = assertSessionId(spec?.sessionId, label);
      return sessions.inOrder(sessionId, async () => {
        // Never underneath a running client.
        await sessions.stop(sessionId);
        await removeSession(sessionId);
      });
    },
    help() {
      return `${label} backend factory: describe, modelCatalog(subscriptionId?), inspectBindings({ sessionId }) (read-only recorded/proposed bindings, not proof of activation), create, stop (keeps state), and idempotent destroy.`;
    },
  });
};
harden(makeHostedBackendFactory);
