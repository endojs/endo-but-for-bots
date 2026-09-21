// @ts-check

/**
 * The retained provider broker owner the CLI adapters compose: an operator
 * secret read facet, a provider listener runtime, and a grant issuer under
 * one operator policy, exposed as inert per-session scopes. Each adapter
 * supplies its policy (origin, route, credential header, model admission),
 * its account binding, and its label; nothing here names a provider.
 *
 * The slice never holds the provider credential: it gets a loopback-only
 * network namespace shared with a listener container, the host performs the
 * upstream HTTPS request with the secret, and the slice sees only
 * `http://127.0.0.1:<port>`.
 *
 * @module
 */

import { join } from 'node:path';

import { Fail, b, q } from '@endo/errors';

import { makeOwnedNativeService } from '@endo/sandbox/owned-native-service.js';
import { E } from '@endo/eventual-send';

import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeAccountJournal } from './account-oracle.js';

import { makeAccountReadingSource } from './account-source.js';
import { makeBrokerSubscription } from './broker-subscription.js';
import { normalizeHostedModelDescriptor } from './hosted-backend.js';
import { makeProviderBrokerGrantIssuer } from './provider-grant-issuer.js';
import { makePodmanProviderListenerRuntimeKit } from './provider-listener-runtime.js';
import { makeProviderScopes } from './provider-scopes.js';
import { makeResetRedeemer } from './reset-redeemer.js';
import {
  makeSubscriptionPool,
  normalizeSubscriptionSet,
} from './subscription-pool.js';
import { makePublicEgress } from './public-egress.js';

/** @import { BrokerPolicy } from './provider-broker.js' */

// Per-request buffers and simultaneous operations bound host allocations.
export const DEFAULT_MAX_REQUEST_BYTES = 8n * 1024n ** 2n;
export const DEFAULT_MAX_RESPONSE_BYTES = 16n * 1024n ** 2n;
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
harden(DEFAULT_MAX_REQUEST_BYTES);
harden(DEFAULT_MAX_RESPONSE_BYTES);
harden(DEFAULT_REQUEST_TIMEOUT_MS);

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

// The podman listener runtime caps the owner id at 64 characters and cleans up
// by exact label; keep the composition inside that bound.
export const BROKER_OWNER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
harden(BROKER_OWNER_PATTERN);

/**
 * The operator's model admission list, as every adapter's policy builder
 * checks it: nonempty, provider-scoped ids without spaces.
 * @param {unknown} models
 * @param {string} label
 * @returns {string[]}
 */
export const assertBrokerModels = (models, label) => {
  (Array.isArray(models) &&
    models.length > 0 &&
    models.every(
      model =>
        typeof model === 'string' && model.length > 0 && !model.includes(' '),
    )) ||
    Fail`${b(label)} broker models must be a nonempty list of model ids`;
  return [.../** @type {string[]} */ (models)];
};
harden(assertBrokerModels);

/**
 * Construct an inert provider broker owner. Retain the kit before start().
 * close() fences admission immediately and retains failed runtime/issuer
 * cleanup for retry, including listener acquisition that completes after
 * close. Runs only with operator powers: it reads the secret, starts listener
 * containers, and mints leases. Callers hand the returned issuer to the
 * sandbox provisioning path and keep the compose/`dispose` authority.
 *
 * @param {object} options
 * @param {string} options.label - The adapter's name for messages.
 * @param {BrokerPolicy} options.policy - The adapter's operator policy.
 * @param {string} options.accountRef - The operator's selected account.
 * @param {any} options.secret - SecretBlob read facet
 * @param {Parameters<typeof makeProviderBrokerGrantIssuer>[0]['credential']} [options.credential]
 *   Optional retained host-only renewing credential; never returned to scopes.
 * @param {Parameters<typeof makeProviderBrokerGrantIssuer>[0]['adaptRequest']} [options.adaptRequest]
 *   Trusted provider translation, never returned to scopes or read from config.
 * @param {string} options.ownerId - Stable operator-owned cleanup scope
 * @param {string} options.directory - Private host directory for listener state
 * @param {string} options.imageRef - Pinned slice image ref (used for digest checks)
 * @param {string} options.imageDigest - Slice image digest (`sha256:...`)
 * @param {string} options.listenerImageRef - Pinned listener image ref
 * @param {Record<string,string>} [options.env] Trusted operator host environment overrides.
 * @param {boolean} [options.publicInternet] Operator permits public egress grants.
 * @param {number} [options.maxSessions]
 * @param {any} [options.audit]
 * @param {(diagnostic: any) => void} [options.onDiagnostic]
 * @param {(reading: any) => void} [options.onReading] Host-only: what each
 *   inference response's rate-limit headers said about the account.
 * @param {Parameters<typeof makeProviderBrokerGrantIssuer>[0]['pool']} [options.pool]
 *   Several subscriptions in place of `secret`, `credential`, `adaptRequest`
 *   and `onReading`; see the issuer.
 * @param {(diagnostic: any) => void} [options.onListenerDiagnostic] Host-only:
 *   the listener's own per-request failure lines (a stage and header-check
 *   booleans), read from its stderr pipe.
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {any} [options.runtime] - Injectable provider listener runtime (tests)
 * @param {ReturnType<typeof makePodmanProviderListenerRuntimeKit>} [options.runtimeKit]
 *   Injectable retained runtime owner (tests); mutually exclusive with runtime.
 * @param {typeof makeProviderBrokerGrantIssuer} [options.makeIssuer]
 *   Injectable synchronous issuer constructor (tests).
 * @returns {{start: () => Promise<{issuer: any, imageRef: string}>, close: () => Promise<void>}}
 */
export const makeProviderBrokerKit = ({
  label,
  policy,
  accountRef,
  secret,
  credential,
  adaptRequest,
  ownerId,
  directory,
  imageRef,
  imageDigest,
  listenerImageRef,
  maxSessions,
  env,
  publicInternet = false,
  audit,
  onDiagnostic,
  onReading,
  onListenerDiagnostic,
  pool,
  fetch: fetchAuthority = globalThis.fetch,
  runtime,
  runtimeKit,
  makeIssuer = makeProviderBrokerGrantIssuer,
}) => {
  typeof publicInternet === 'boolean' ||
    Fail`Invalid public network configuration`;
  DIGEST_PATTERN.test(imageDigest) ||
    Fail`${b(label)} broker image digest must be pinned, got ${q(imageDigest)}`;
  (typeof imageRef === 'string' && imageRef.endsWith(`@${imageDigest}`)) ||
    Fail`${b(label)} broker image ref must match its digest, got ${q(imageRef)}`;
  BROKER_OWNER_PATTERN.test(ownerId) ||
    Fail`${b(label)} broker owner id is invalid, got ${q(ownerId)}`;
  (typeof directory === 'string' &&
    directory.startsWith('/') &&
    directory.length > 1) ||
    Fail`${b(label)} broker directory must be absolute`;
  (typeof listenerImageRef === 'string' &&
    listenerImageRef.includes('@sha256:')) ||
    Fail`${b(label)} listener image must be digest-pinned`;
  // A remote exo presence exposes no own properties; `readBase64` is only
  // reachable through eventual send. Accept any object/function presence, but
  // still refuse a local cap that carries an explicitly broken reader
  // (`{ readBase64: null }`), which a typeof check would miss.
  const isPresence = value =>
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null);
  // A broker over several subscriptions has a secret per member, which the
  // pool supplies with each; one over a single credential has this one.
  if (pool === undefined) {
    isPresence(secret) ||
      Fail`${b(label)} broker requires a SecretBlob read facet`;
    Object.hasOwn(secret, 'readBase64') &&
      !isPresence(secret.readBase64) &&
      Fail`${b(label)} broker requires a SecretBlob read facet`;
  }
  typeof fetchAuthority === 'function' ||
    Fail`${b(label)} broker requires an outbound fetch authority`;

  runtime === undefined ||
    runtimeKit === undefined ||
    Fail`Supply one ${b(label)} listener runtime owner`;
  const owner =
    runtimeKit ??
    (runtime === undefined
      ? makePodmanProviderListenerRuntimeKit({
          imageRef: listenerImageRef,
          ownerId,
          stateDirectory: join(directory, 'listener'),
          publicInternet,
          env,
          ...(maxSessions === undefined ? {} : { maxListeners: maxSessions }),
          // The listener's stderr is a pipe to this process and nothing else
          // (its container keeps no log), so without a reader here its
          // failure lines go nowhere.
          ...(onListenerDiagnostic === undefined
            ? {}
            : {
                host: harden({
                  onStderr: chunk => {
                    for (const diagnostic of listenerDiagnostics(chunk)) {
                      onListenerDiagnostic(diagnostic);
                    }
                  },
                }),
              }),
        })
      : { open: async () => runtime, close: () => runtime.dispose() });
  /** @type {ReturnType<typeof makeProviderBrokerGrantIssuer> | undefined} */
  let issuer;
  /** @type {Promise<{issuer: any, imageRef: string}> | undefined} */
  let starting;
  /** @type {Promise<void> | undefined} */
  let closing;
  let stopped = false;
  let issuerReleased = false;
  let runtimeReleased = false;
  const assertOpen = () => {
    !stopped || Fail`${b(label)} broker is closed`;
  };
  const start = () => {
    assertOpen();
    starting ??= Promise.resolve().then(async () => {
      assertOpen();
      const listener = await owner.open();
      assertOpen();
      issuer = makeIssuer({
        runtime: listener,
        secret,
        ...(credential === undefined ? {} : { credential }),
        ...(adaptRequest === undefined ? {} : { adaptRequest }),
        fetch: fetchAuthority,
        imageDigest,
        accountRef,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        policy,
        ...(publicInternet
          ? {
              makePublicNetwork: () =>
                makePublicEgress({ policy: 'public-internet' }),
            }
          : {}),
        ...(audit === undefined ? {} : { audit }),
        ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
        ...(onReading === undefined ? {} : { onReading }),
        ...(pool === undefined ? {} : { pool }),
      });
      assertOpen();
      return harden({ issuer, imageRef });
    });
    return starting;
  };
  const close = () => {
    stopped = true;
    if (closing) return closing;
    // Both native disposal entrypoints fence synchronously. In particular,
    // issuer disposal revokes transport authority before queued listener
    // acquisition settles, and runtime closure owns its late native results.
    const revoking = (async () => {
      if (issuer && !issuerReleased) {
        await issuer.dispose();
        issuerReleased = true;
      }
    })();
    const releasing = (async () => {
      if (!runtimeReleased) {
        await owner.close();
        runtimeReleased = true;
      }
    })();
    const attempt = (async () => {
      const results = await Promise.allSettled([
        starting?.catch(() => {}),
        revoking,
        releasing,
      ]);
      const failures = results.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw AggregateError(failures, `${label} broker cleanup pending`);
    })();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return attempt;
  };
  return harden({ start, close });
};
harden(makeProviderBrokerKit);

/** @param {() => () => Promise<any>} makeRead */
const lazyModelRead = makeRead => {
  /** @type {(() => Promise<any>) | undefined} */
  let read;
  return async () => {
    read ??= makeRead();
    return read();
  };
};

/**
 * Per-account metadata, never a pool-wide admission decision. Failure does not
 * masquerade as an empty successful catalog or fall back to configured models.
 * @param {string} subscriptionId
 * @param {(() => Promise<any>) | undefined} read
 */
const readCatalogAccount = async (subscriptionId, read) => {
  if (read === undefined) {
    return harden({
      subscriptionId,
      state: 'unsupported',
      observedAt: null,
      models: [],
    });
  }
  try {
    const snapshot = await read();
    const observedAt = /** @type {unknown} */ (snapshot?.observedAt);
    (typeof observedAt === 'number' &&
      Number.isFinite(observedAt) &&
      observedAt >= 0 &&
      Array.isArray(snapshot.models) &&
      Number(snapshot.models.length) <= 4096) ||
      Fail`Invalid provider model catalog`;
    const models = snapshot.models.map(normalizeHostedModelDescriptor);
    new Set(models.map(model => model.id)).size === models.length ||
      Fail`Duplicate provider model identity`;
    return harden({
      subscriptionId,
      state: 'current',
      observedAt: snapshot.observedAt,
      models,
    });
  } catch (_error) {
    return harden({
      subscriptionId,
      state: 'unavailable',
      observedAt: null,
      models: [],
    });
  }
};

/**
 * What an adapter supplies for a broker over several subscriptions.
 *
 * @typedef {object} PooledSubscriptions
 * @property {() => Promise<any>} readSet The declared set, as stored. Read
 *   when a grant is issued, so a member an operator added serves the sessions
 *   opened after it, with no retirement.
 * @property {(member: { id: string, secretName: string }) => any} secretOf
 *   The member's SecretBlob read facet (a presence, or a promise for one).
 * @property {(member: { id: string, subscriptionName: string }) => any} [subscriptionOf]
 *   For a member that is somebody else's subscription: the `Subscription`
 *   held under that name (a presence, or a promise for one), resolved on
 *   every use.
 * @property {(member: any, secret: any) => any} [credentialOf] The member's
 *   shared refreshing credential. Asked once per member.
 * @property {(member: any) => any} [adaptRequestOf]
 * @property {(powers: { member: any, secret: any, credential: any }) => () => Promise<any>} [activeReadOf]
 * @property {(powers: { member: any, secret: any, credential: any }) => () => Promise<any>} [modelReadOf]
 * @property {(powers: { member: any, secret: any, credential: any }) => (request: { idempotencyKey: string, creditId?: string }) => Promise<{ outcome: string }>} [resetRedeemOf]
 *   The member's one call that spends a banked rate-limit reset.
 * @property {() => Promise<any>} [readState] What a previous incarnation kept
 *   of the pool: refusals, and where sessions were last served.
 * @property {(state: any) => Promise<void>} [writeState]
 * @property {() => number} [now]
 */

/**
 * The service kit of a broker over several subscriptions of one provider. One
 * listener runtime, one issuer and one set of scopes, as for a single
 * credential; beneath them a member per subscription, each with its own
 * secret, credential, account source and transport, and one chooser
 * (`subscription-pool.js`) that picks the member for each request.
 *
 * @param {object} powers
 * @param {string} powers.label
 * @param {string} powers.providerId
 * @param {PooledSubscriptions} powers.subscriptions
 * @param {any} powers.brokerOptions
 * @param {(error: unknown) => void} powers.reportAccountError
 */
const makePooledBrokerServiceKit = ({
  label,
  providerId,
  subscriptions,
  brokerOptions,
  reportAccountError,
}) => {
  const {
    readSet,
    secretOf,
    subscriptionOf,
    credentialOf,
    adaptRequestOf,
    activeReadOf,
    modelReadOf,
    resetRedeemOf,
    readState = async () => undefined,
    writeState = async () => {},
    now = Date.now,
  } = subscriptions;
  /**
   * @typedef {object} MemberKit
   * @property {any} secret
   * @property {any} credential
   * @property {any} adaptRequest
   * @property {ReturnType<typeof makeAccountReadingSource>} account
   * @property {any} redeemer
   * @property {(() => Promise<any>) | undefined} modelRead
   * @property {(() => any) | undefined} subscription For a wrapped member.
   */
  /** @type {Map<string, MemberKit>} */
  const kits = new Map();
  // A member ID is an authority identity, not an editable display label.
  // Keep tombstones for removed IDs: old grants and account facets can still
  // refer to them. Relabeling or reweighting is safe; rebinding requires a new
  // ID, not pairing a cached credential with a new account/header.
  /** @type {Map<string, string>} */
  const memberBindings = new Map();
  /** @type {ReturnType<typeof normalizeSubscriptionSet> | undefined} */
  let set;
  /** @type {ReturnType<typeof makeSubscriptionPool> | undefined} */
  let chooser;
  /** @type {Promise<void>} */
  let writing = Promise.resolve();

  /**
   * A member that is somebody else's subscription: no secret, credential or
   * redeemer of the operator's. What is known of it is what its share
   * publishes, followed while this broker lives and kept as a reading like
   * any other member's, so the pool ranks it and a view shows it.
   *
   * @param {{ id: string, subscriptionName: string }} member
   */
  const wrappedKitOf = member => {
    subscriptionOf !== undefined ||
      Fail`${b(label)} cannot hold another party's subscription`;
    const subscription = () =>
      /** @type {NonNullable<typeof subscriptionOf>} */ (subscriptionOf)(
        member,
      );
    const account = makeAccountReadingSource({
      activeRead: async () =>
        readingFromShareStatus(await E(subscription()).getStatus()),
      reportError: reportAccountError,
      onChange: () => asSubscription.changed(),
    });
    let live = true;
    let stopFollowing = () => {};
    const follow = async () => {
      await null;
      for (let pause = 5000; live; pause = Math.min(pause * 2, 60_000)) {
        /** @type {any} */
        let events;
        try {
          // eslint-disable-next-line no-await-in-loop
          const reader = await E(subscription()).watchStatus();
          events = iterateReader(reader);
          stopFollowing = () => {
            void Promise.resolve(events?.return?.(undefined)).catch(() => {});
          };
          // Closed while the reader was being had: `close` found nothing to
          // stop, and a quiet share would keep this one parked.
          if (!live) break;
          // eslint-disable-next-line no-await-in-loop
          for await (const event of events) {
            if (!live) break;
            pause = 5000;
            account.accept(
              readingFromShareStatus(/** @type {any} */ (event)?.status),
            );
          }
        } catch (_error) {
          // Its daemon is away, or it was revoked. Looked for again.
        } finally {
          // Ended, or no longer wanted: the far side is told either way.
          stopFollowing();
          stopFollowing = () => {};
        }
        if (!live) return;
        // A pause that does not keep the worker alive on its own.
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => {
          const timer = globalThis.setTimeout(resolve, pause);
          /** @type {any} */ (timer).unref?.();
        });
      }
    };
    void follow();
    return {
      secret: undefined,
      credential: undefined,
      adaptRequest: undefined,
      redeemer: undefined,
      modelRead: undefined,
      subscription,
      account: {
        ...account,
        close: () => {
          live = false;
          // A reader parked on a quiet share would otherwise stay open there.
          stopFollowing();
          account.close();
        },
      },
    };
  };

  /** @param {any} member */
  const kitOf = member => {
    let kit = kits.get(member.id);
    if (kit === undefined && member.subscriptionName !== undefined) {
      kit = wrappedKitOf(member);
      kits.set(member.id, kit);
    }
    if (kit === undefined) {
      const secret = secretOf(member);
      const credential =
        credentialOf === undefined ? undefined : credentialOf(member, secret);
      const account = makeAccountReadingSource({
        ...(activeReadOf === undefined
          ? {}
          : { activeRead: activeReadOf({ member, secret, credential }) }),
        reportError: reportAccountError,
        onChange: () => asSubscription.changed(),
      });
      kit = {
        secret,
        credential,
        adaptRequest:
          adaptRequestOf === undefined ? undefined : adaptRequestOf(member),
        account,
        modelRead:
          modelReadOf === undefined
            ? undefined
            : lazyModelRead(() => modelReadOf({ member, secret, credential })),
        redeemer:
          resetRedeemOf === undefined
            ? undefined
            : makeResetRedeemer(resetRedeemOf({ member, secret, credential })),
        subscription: undefined,
      };
      kits.set(member.id, kit);
    }
    return kit;
  };

  // A provider whose credential names an account (OAuth) has no pool-wide
  // account for a member to inherit, so every member must say which.
  const requireAccountRef = credentialOf !== undefined;
  /** @type {Promise<unknown>} */
  let loading = Promise.resolve();

  /**
   * Read the declared set again, and drop what left it. One at a time and in
   * order: a status reader and the first session can arrive together, and two
   * loads racing would each make a chooser, with refusal marks and warm
   * records the other never sees, and then overwrite each other's state.
   *
   * @returns {Promise<ReturnType<typeof normalizeSubscriptionSet>>}
   */
  const load = () => {
    const result = loading.then(async () => {
      const next = normalizeSubscriptionSet(await readSet(), {
        requireAccountRef,
      });
      const bindings = next.members.map(member => [
        member.id,
        JSON.stringify([
          member.secretName ?? null,
          member.subscriptionName ?? null,
          member.accountRef ?? null,
        ]),
      ]);
      // Validate the entire update before changing any kit, chooser, or pin.
      for (const [id, binding] of bindings) {
        const previous = memberBindings.get(id);
        previous === undefined ||
          previous === binding ||
          Fail`Subscription member authority changed; use a new member ID`;
      }
      for (const [id, binding] of bindings) memberBindings.set(id, binding);
      for (const [id, kit] of kits) {
        if (!next.members.some(member => member.id === id)) {
          kit.account.close();
          kits.delete(id);
        }
      }
      set = next;
      if (chooser === undefined) {
        const initial = await readState().catch(error => {
          console.error(
            `${label} pool state could not be read; starting without it:`,
            error instanceof Error ? error.message : String(error),
          );
          return undefined;
        });
        chooser = makeSubscriptionPool({
          members: () =>
            (set?.members ?? []).map(
              ({ id, label: title, weight, pinnedOnly }) => ({
                id,
                label: title,
                weight,
                ...(pinnedOnly === true ? { pinnedOnly: true } : {}),
              }),
            ),
          readingOf: id => kits.get(id)?.account.peek().rateLimits,
          // Asked per request, so an operator's edit of the set applies.
          cacheLifetimeMs: () => (set?.cacheLifetimeSeconds ?? 300) * 1000,
          now,
          ...(initial === undefined ? {} : { initial }),
          onChange: state => {
            // One write at a time, in order; a failed write is reported and
            // the next change writes the whole state again.
            writing = writing
              .then(() => writeState(state))
              .catch(error =>
                console.error(
                  `${label} pool state could not be kept:`,
                  error instanceof Error ? error.message : String(error),
                ),
              );
          },
        });
      }
      return next;
    });
    loading = result.catch(() => {});
    return result;
  };

  const broker = makeProviderBrokerKit({
    ...brokerOptions,
    label,
    pool: harden({
      members: async () => {
        const { members } = await load();
        return members.map(member => {
          const kit = kitOf(member);
          if (kit.subscription !== undefined) {
            return harden({ id: member.id, subscription: kit.subscription() });
          }
          return harden({
            id: member.id,
            secret: kit.secret,
            ...(kit.credential === undefined
              ? {}
              : { credential: kit.credential }),
            ...(kit.adaptRequest === undefined
              ? {}
              : { adaptRequest: kit.adaptRequest }),
            ...(member.accountRef === undefined
              ? {}
              : { accountRef: member.accountRef }),
            onReading: (/** @type {any} */ reading) => {
              kit.account.accept(reading);
              brokerOptions.onReading?.(reading);
            },
          });
        });
      },
      forSession: (
        /** @type {string} */ sessionId,
        /** @type {string} */ preference,
      ) =>
        (chooser ?? Fail`${b(label)} pool is not loaded`).forSession(
          sessionId,
          preference,
        ),
    }),
  });
  const asSubscription = makeBrokerSubscription({
    providerId,
    label,
    models: [...(brokerOptions.policy?.models ?? [])],
    openEndpoint: async spec =>
      /** @type {any} */ ((await broker.start()).issuer).openEndpoint(spec),
    readings: async () => {
      const { members } = await load();
      // What an `auto` request can be served from, which is all an endpoint
      // of this subscription ever asks for. A lane set aside is not that,
      // and is often a share of this very subscription: counted here, its
      // budget would read as the broker's own headroom, and its status
      // would feed the status it is derived from.
      const serving = members.filter(
        (/** @type {any} */ member) => member.pinnedOnly !== true,
      );
      const counted = serving.length === 0 ? members : serving;
      return counted.map(member => ({
        id: member.id,
        rateLimits: kitOf(member).account.peek().rateLimits,
      }));
    },
    now,
  });
  const scopes = makeProviderScopes({
    openIssuer: async () => (await broker.start()).issuer,
    subscription: asSubscription.subscription,
    // A status reader asks before any session has opened a grant, so the set
    // is read here too; it calls no provider.
    accountSourceOf: async subscriptionId => {
      const { members } = await load();
      const member = members.find(entry => entry.id === subscriptionId);
      return member === undefined ? undefined : kitOf(member).account.source;
    },
    resetRedeemerOf: async subscriptionId => {
      const { members } = await load();
      const member = members.find(entry => entry.id === subscriptionId);
      return member === undefined ? undefined : kitOf(member).redeemer;
    },
    listSubscriptions: async () => {
      const { members } = await load();
      return harden(
        members.map(({ id, label: title, weight, pinnedOnly }) => ({
          id,
          label: title,
          weight,
          // A lane set aside: a picker may say so, and `auto` never uses it.
          ...(pinnedOnly === true ? { pinnedOnly: true } : {}),
        })),
      );
    },
    readModelCatalog: async subscriptionId => {
      const { members } = await load();
      const selected =
        subscriptionId === undefined
          ? members
          : members.filter(member => member.id === subscriptionId);
      subscriptionId === undefined ||
        selected.length === 1 ||
        Fail`Unknown provider subscription`;
      const observedKits = new Map();
      const accounts = await Promise.all(
        selected.map(member =>
          readCatalogAccount(
            member.id,
            modelReadOf === undefined || member.subscriptionName !== undefined
              ? undefined
              : async () => {
                  const kit = kitOf(member);
                  observedKits.set(member.id, kit);
                  return kit.modelRead?.();
                },
          ),
        ),
      );
      // Validate the entire batch after its slowest account finishes. A fast
      // account may have been removed while a different account was pending.
      const latest = await load();
      const currentIds = new Set(latest.members.map(member => member.id));
      return harden({
        accounts: accounts.map(account =>
          account.state === 'current' &&
          (!currentIds.has(account.subscriptionId) ||
            kits.get(account.subscriptionId) !==
              observedKits.get(account.subscriptionId))
            ? {
                subscriptionId: account.subscriptionId,
                state: 'unavailable',
                observedAt: null,
                models: [],
              }
            : account,
        ),
      });
    },
  });
  return harden({
    service: scopes.service,
    close: makeServiceClose({
      label,
      scopes,
      broker,
      closeAccounts: () => {
        for (const kit of kits.values()) kit.account.close();
        asSubscription.close();
      },
    }),
  });
};

/**
 * What a share says of itself, as a raw account reading, so that a member
 * which is somebody else's subscription is ranked and shown like the rest:
 * its budget is a window that resets when the period ends, and a share that
 * cannot serve is a full window until the time it names.
 *
 * @param {any} status
 */
export const readingFromShareStatus = status => {
  if (status === null || typeof status !== 'object') return harden({});
  const instant = (/** @type {unknown} */ value) =>
    typeof value === 'string' && Number.isFinite(Date.parse(value))
      ? new Date(Date.parse(value)).toISOString()
      : '';
  const budget =
    status.budget !== null && typeof status.budget === 'object'
      ? status.budget
      : undefined;
  const tokens = Number(budget?.tokens);
  const spent = Number(budget?.spent) + Number(budget?.reserved ?? 0);
  const windows = [];
  if (budget !== undefined && tokens > 0 && Number.isFinite(spent)) {
    const seconds = Number(budget.periodSeconds);
    windows.push({
      windowId: 'secondary',
      title: 'Share budget',
      usedPercent: Math.max(0, Math.min(100, (spent / tokens) * 100)),
      ...(Number.isSafeInteger(seconds) && seconds > 0
        ? { windowSeconds: seconds }
        : {}),
      resetsAt: instant(budget.periodEndsAt),
    });
  }
  const blocked = status.available === false;
  if (blocked && !windows.some(window => window.usedPercent >= 100)) {
    // Blocked by something other than its own budget: what is beneath it, a
    // floor, a revocation. All a holder is told is until when, if that.
    windows.push({
      windowId: 'primary',
      title: 'Share availability',
      usedPercent: 100,
      resetsAt: instant(status.blockedUntil),
    });
  }
  return harden({
    plan: {
      planId: 'share',
      title: 'Share',
      state: status.over === true ? 'expired' : 'active',
    },
    rateLimits: { windows, limitReached: blocked },
  });
};
harden(readingFromShareStatus);

const LISTENER_DIAGNOSTIC_PREFIX = 'Provider HTTP diagnostic: ';

/**
 * The listener worker's failure lines out of one chunk of its stderr. The
 * stream also carries whatever else the container's Node prints at startup;
 * only lines the worker wrote as diagnostics, and that parse as the fixed
 * shape it writes (a stage, optional boolean header checks), are returned.
 *
 * @param {Uint8Array} chunk
 * @returns {Array<{ stage: string, checks?: Record<string, boolean> }>}
 */
export const listenerDiagnostics = chunk => {
  const out = [];
  for (const line of new TextDecoder().decode(chunk).split('\n')) {
    if (line.startsWith(LISTENER_DIAGNOSTIC_PREFIX)) {
      try {
        const { stage, checks } = JSON.parse(
          line.slice(LISTENER_DIAGNOSTIC_PREFIX.length),
        );
        if (typeof stage === 'string' && stage.length <= 32) {
          out.push(
            harden({
              stage,
              ...(checks && typeof checks === 'object'
                ? {
                    checks: Object.fromEntries(
                      Object.entries(checks)
                        .filter(([, value]) => typeof value === 'boolean')
                        .slice(0, 16),
                    ),
                  }
                : {}),
            }),
          );
        }
      } catch (_error) {
        // A torn or foreign line is not a diagnostic.
      }
    }
  }
  return harden(out);
};
harden(listenerDiagnostics);

/**
 * Retain one operator broker before exposing inert per-session scope facets.
 * All scopes share its issuer, runtime, account policy, and configured limits.
 * The service accepts only approved copy specifications; session controllers
 * receive no secret, operator shutdown, or daemon namespace lookup authority.
 *
 * This local kit must remain owned through failed cleanup. The daemon
 * entrypoint retains it across context cancellation, and retains the supplied
 * secret as an exact durable dependency of the operator service formula.
 * Never look up a mutable secret name at session startup or compose this per
 * session. There is deliberately no result-only asynchronous constructor here.
 *
 * close() immediately fences both the scopes and the underlying broker. It
 * reaches cancellation-dependent runtime opening without waiting for scope
 * drain first, and succeeds only after both owners acknowledge release. Failed
 * stages remain retryable; successful stages are not repeated.
 *
 * Scope lookup recovers ownership only within this service incarnation. An
 * empty lookup after service loss does not prove earlier listeners stopped.
 *
 * @param {Parameters<typeof makeProviderBrokerKit>[0] & { providerId?: string, activeAccountRead?: () => Promise<any>, modelRead?: () => Promise<any>, resetRedeem?: (request: { idempotencyKey: string, creditId?: string }) => Promise<{ outcome: string }>, subscriptions?: PooledSubscriptions }} options
 *   `activeAccountRead` is the adapter's one read of its provider's usage
 *   endpoint, host-only and only ever run on request. `resetRedeem` is its
 *   one call that spends a banked rate-limit reset, an operator's and never
 *   run by anything here. `subscriptions` makes
 *   this a broker over several credentials of one provider instead of one.
 */
export const makeProviderBrokerServiceKit = options => {
  const {
    label,
    activeAccountRead,
    modelRead,
    resetRedeem,
    subscriptions,
    providerId = label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    ...brokerOptions
  } = options;
  const reportAccountError = (/** @type {unknown} */ error) =>
    console.error(
      `${label} account read failed:`,
      error instanceof Error ? error.message : String(error),
    );
  if (subscriptions !== undefined) {
    return makePooledBrokerServiceKit({
      label,
      providerId,
      subscriptions,
      brokerOptions,
      reportAccountError,
    });
  }
  // What the account behind this broker's credential has left, as the
  // transport reads it from each response. The source is a facet of the
  // service, so an account oracle can hold it without the scopes' authority,
  // and it cannot reach the secret.
  const account = makeAccountReadingSource({
    ...(activeAccountRead === undefined
      ? {}
      : { activeRead: activeAccountRead }),
    reportError: reportAccountError,
    onChange: () => asSubscription.changed(),
  });
  const asSubscription = makeBrokerSubscription({
    providerId,
    label,
    models: [...(brokerOptions.policy?.models ?? [])],
    openEndpoint: async spec =>
      /** @type {any} */ ((await broker.start()).issuer).openEndpoint(spec),
    readings: async () => [
      { id: 'default', rateLimits: account.peek().rateLimits },
    ],
  });
  const broker = makeProviderBrokerKit({
    ...brokerOptions,
    label,
    onReading: reading => {
      account.accept(reading);
      brokerOptions.onReading?.(reading);
    },
  });
  const scopes = makeProviderScopes({
    openIssuer: async () => (await broker.start()).issuer,
    accountSource: account.source,
    readModelCatalog: async subscriptionId => {
      subscriptionId === undefined ||
        subscriptionId === 'default' ||
        Fail`Unknown provider subscription`;
      return harden({
        accounts: [await readCatalogAccount('default', modelRead)],
      });
    },
    subscription: asSubscription.subscription,
    ...(resetRedeem === undefined
      ? {}
      : { resetRedeemer: makeResetRedeemer(resetRedeem) }),
  });
  return harden({
    service: scopes.service,
    close: makeServiceClose({
      label,
      scopes,
      broker,
      closeAccounts: () => {
        account.close();
        asSubscription.close();
      },
    }),
  });
};
harden(makeProviderBrokerServiceKit);

/**
 * @param {object} owners
 * @param {string} owners.label
 * @param {{ close(): Promise<void> }} owners.scopes
 * @param {{ close(): Promise<void> }} owners.broker
 * @param {() => void} owners.closeAccounts
 */
const makeServiceClose = ({ label, scopes, broker, closeAccounts }) => {
  let scopesReleased = false;
  let brokerReleased = false;
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => {
    if (closing) return closing;
    const closingScopes = (async () => {
      if (!scopesReleased) {
        await scopes.close();
        scopesReleased = true;
      }
    })();
    const closingBroker = (async () => {
      if (!brokerReleased) {
        await broker.close();
        brokerReleased = true;
      }
    })();
    closeAccounts();
    closing = (async () => {
      const results = await Promise.allSettled([closingScopes, closingBroker]);
      const failures = results.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw AggregateError(
          failures,
          `${label} broker service cleanup pending`,
        );
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  return close;
};

/**
 * Construct a module-instance retained operator entrypoint. Its sole powers
 * argument is the original SecretBlob read facet, not a host or session
 * powers bundle. Provision makeUnconfined with that secret's name as
 * powersName once: the daemon formula stores the resolved powers ID and
 * retains its dependency. Subsequent sessions never look up a secret through
 * a mutable namespace.
 *
 * Cancellation reaches the retained broker kit even during later lazy
 * opening. Failed cleanup remains in the shared native-owner registry until a
 * subsequent invocation retries it; live duplicates refuse without affecting
 * the original. Separate processes still depend on the broker runtime's
 * native ownership checks, and process loss is not a cleanup acknowledgement.
 *
 * @template {{ ownerId: string, directory: string, imageRef: string, imageDigest: string, listenerImageRef: string, publicInternet?: boolean, maxSessions?: number, diagnostics?: boolean, pool?: boolean }} Config
 * @param {object} options
 * @param {string} options.label
 * @param {(env: Record<string, string>) => Config} options.readConfig The
 *   adapter's persisted operator profile reader.
 * @param {(config: Config) => { policy: BrokerPolicy, accountRef: string, adaptRequest?: Parameters<typeof makeProviderBrokerGrantIssuer>[0]['adaptRequest'] }} options.makePolicy
 *   The adapter's policy for a profile.
 * @param {(config: Config, secret: any) => Parameters<typeof makeProviderBrokerGrantIssuer>[0]['credential']} [options.makeCredential]
 *   Synchronous, inert adapter credential construction, once per owned service.
 *   The secret may include renewal CAS authority, never exposed to sessions.
 * @param {(powers: { config: Config, secret: any, credential: any, accountRef: string }) => () => Promise<any>} [options.makeActiveAccountRead]
 *   Synchronous, inert construction of the adapter's one read of its
 *   provider's usage endpoint, for an account oracle's `refresh()`. Host-only:
 *   it holds the credential. Run only on request, never at start.
 * @param {(powers: { config: Config, secret: any, credential: any, accountRef: string }) => () => Promise<any>} [options.makeModelRead]
 *   Lazy, inert construction of host-only model discovery using the same
 *   credential owner. Runs only on explicit catalog requests.
 * @param {(powers: { config: Config, secret: any, credential: any, accountRef: string }) => (request: { idempotencyKey: string, creditId?: string }) => Promise<{ outcome: string }>} [options.makeResetRedeem]
 *   Synchronous, inert construction of the adapter's one call that spends a
 *   banked rate-limit reset. Host-only, and run only when an operator redeems.
 * @param {typeof makeProviderBrokerServiceKit} [options.makeServiceKit]
 * @param {(error: unknown) => void} [options.reportError]
 * @param {(...args: string[]) => void} [options.log] Where the host-only
 *   failure and admission lines go; the worker's stderr by default.
 */
export const makeOwnedProviderBrokerService = ({
  label,
  readConfig,
  makePolicy,
  makeCredential,
  makeActiveAccountRead,
  makeModelRead,
  makeResetRedeem,
  makeServiceKit = makeProviderBrokerServiceKit,
  reportError = error =>
    console.error(`${label} broker cleanup pending`, error),
  log = (...args) => console.error(...args),
}) => {
  /**
   * @param {Config} config
   * @param {{readBase64(): Promise<string>}} secret
   * @param {Record<string,string>} env
   */
  const makeKit = (config, secret, env) => {
    const { policy, accountRef, adaptRequest } = makePolicy(config);
    // Runtime hooks are not configuration fields, and the failure hooks are
    // not optional. An upstream failure reaches the slice as a bare 502 —
    // provider-http.js deliberately refuses to echo the cause — so these
    // lines are the only place a cause exists: a 429 from an account out of
    // quota and an outage are the same 502 without them. They are host-only,
    // written only on a failure, and bounded: a stage, a status, and a
    // credential-screened excerpt of a body that was refused, never one that
    // was served. They used to sit behind the operator's `diagnostics`
    // boolean, which is recorded when the broker is minted, so learning why
    // a request failed first took retiring the broker.
    //
    // What `diagnostics` still gates is the admission trail, a line for every
    // request whether or not anything went wrong.
    const hooks = {
      onDiagnostic: diagnostic =>
        log(`${label} upstream failure`, JSON.stringify(diagnostic)),
      onListenerDiagnostic: diagnostic =>
        log(`${label} listener failure`, JSON.stringify(diagnostic)),
      ...(config.diagnostics === true
        ? {
            audit: ({ event, requests }) =>
              log(`${label} broker event`, event, String(requests)),
          }
        : {}),
    };
    if (config.pool === true) {
      // Several subscriptions: the formula's powers are not one secret but a
      // namespace of the operator's, holding `subscriptions` (the declared
      // set, a stored value an operator rewrites to add a member), each
      // member's secret under its `secretName`, and what the pool keeps.
      const namespace = /** @type {any} */ (secret);
      const state = makeAccountJournal({
        powers: namespace,
        prefix: 'pool-state-v1-',
      });
      const forMember = (/** @type {any} */ member) =>
        /** @type {Config} */ ({
          ...config,
          ...(member.accountRef === undefined
            ? {}
            : { accountRef: member.accountRef }),
        });
      const pooled = makeServiceKit({
        ...config,
        label,
        policy,
        accountRef,
        secret: undefined,
        subscriptions: {
          readSet: () => E(namespace).lookup('subscriptions'),
          // The name is resolved on every use, never captured: a lookup that
          // failed once (a credential caplet that was not up yet) must not be
          // the member's secret for the life of the broker. The three verbs
          // are all a credential's consumers use.
          secretOf: member => {
            const current = () => E(namespace).lookup(member.secretName);
            return harden({
              readBase64: () => E(current()).readBase64(),
              readBase64WithGeneration: () =>
                E(current()).readBase64WithGeneration(),
              /**
               * @param {string} base64
               * @param {any} [options]
               */
              replaceBase64: (base64, options) =>
                E(current()).replaceBase64(base64, options),
            });
          },
          // Somebody else's subscription, held in the same namespace under
          // the name the set gives it. Resolved on every use, like a secret.
          subscriptionOf: member =>
            E(namespace).lookup(member.subscriptionName),
          ...(makeCredential === undefined
            ? {}
            : {
                credentialOf: (member, memberSecret) =>
                  makeCredential(forMember(member), memberSecret),
              }),
          // An adapter's translation can name the account (a ChatGPT account
          // header), so each member has its own.
          adaptRequestOf: member => makePolicy(forMember(member)).adaptRequest,
          ...(makeModelRead === undefined
            ? {}
            : {
                modelReadOf: ({
                  member,
                  secret: memberSecret,
                  credential: memberCredential,
                }) =>
                  makeModelRead({
                    config: forMember(member),
                    secret: memberSecret,
                    credential: memberCredential,
                    accountRef: member.accountRef ?? accountRef,
                  }),
              }),
          ...(makeActiveAccountRead === undefined
            ? {}
            : {
                activeReadOf: ({
                  member,
                  secret: memberSecret,
                  credential: memberCredential,
                }) =>
                  makeActiveAccountRead({
                    config: forMember(member),
                    secret: memberSecret,
                    credential: memberCredential,
                    accountRef: member.accountRef ?? accountRef,
                  }),
              }),
          ...(makeResetRedeem === undefined
            ? {}
            : {
                resetRedeemOf: ({
                  member,
                  secret: memberSecret,
                  credential: memberCredential,
                }) =>
                  makeResetRedeem({
                    config: forMember(member),
                    secret: memberSecret,
                    credential: memberCredential,
                    accountRef: member.accountRef ?? accountRef,
                  }),
              }),
          readState: () => state.read(),
          writeState: kept => state.write(kept),
        },
        env,
        ...hooks,
      });
      return harden({ open: async () => pooled.service, close: pooled.close });
    }
    const credential =
      makeCredential === undefined ? undefined : makeCredential(config, secret);
    const kit = makeServiceKit({
      ...config,
      label,
      policy,
      accountRef,
      secret,
      adaptRequest,
      ...(credential === undefined ? {} : { credential }),
      ...(makeModelRead === undefined
        ? {}
        : {
            modelRead: lazyModelRead(() =>
              makeModelRead({
                config,
                secret,
                credential,
                accountRef,
              }),
            ),
          }),
      ...(makeActiveAccountRead === undefined
        ? {}
        : {
            activeAccountRead: makeActiveAccountRead({
              config,
              secret,
              credential,
              accountRef,
            }),
          }),
      ...(makeResetRedeem === undefined
        ? {}
        : {
            resetRedeem: makeResetRedeem({
              config,
              secret,
              credential,
              accountRef,
            }),
          }),
      env,
      ...hooks,
    });
    return harden({ open: async () => kit.service, close: kit.close });
  };
  return makeOwnedNativeService({ readConfig, makeKit, reportError });
};
harden(makeOwnedProviderBrokerService);
