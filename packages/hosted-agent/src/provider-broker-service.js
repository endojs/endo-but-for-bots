// @ts-check

/**
 * The retained provider broker owner the CLI adapters compose: an operator
 * secret read facet, a provider listener runtime, and a grant issuer under
 * one operator policy, exposed as inert per-session scopes. Each adapter
 * supplies its policy (origin, route, credential header), its account
 * binding, its model discovery and its label; nothing here names a provider.
 * Models are admitted by what each account's provider lists for it
 * (`model-catalog.js`), never by an operator list.
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
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeAccountJournal } from './account-oracle.js';
import { makePoolIdentityJournal } from './pool-identity-journal.js';
import { makePoolMemberLifecycle } from './pool-member-lifecycle.js';

import { makeAccountReadingSource } from './account-source.js';
import { makeBrokerSubscription } from './broker-subscription.js';
import { makeModelCatalogOwner } from './model-catalog.js';
import {
  makeProviderBrokerGrantIssuer,
  withDeadline,
} from './provider-grant-issuer.js';
import { makePodmanProviderListenerRuntimeKit } from './provider-listener-runtime.js';
import { makeProviderScopes } from './provider-scopes.js';
import { makeResetRedeemer } from './reset-redeemer.js';
import {
  makeSubscriptionPool,
  normalizeSubscriptionSet,
} from './subscription-pool.js';
import { makePublicEgress } from './public-egress.js';
import { assertAccountAuthority } from './account-authority.js';

/** @import { BrokerPolicy } from './provider-broker.js' */

/** How long a far share gets to say what it lists, for a wrapped member's catalog. */
const WRAPPED_DESCRIBE_DEADLINE_MS = 15_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

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
 * @param {Parameters<typeof makeProviderBrokerGrantIssuer>[0]['admits']} [options.admits]
 *   The one account's model admission, from its catalog owner; required
 *   without a pool.
 * @param {Parameters<typeof makeProviderBrokerGrantIssuer>[0]['catalogState']} [options.catalogState]
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
  admits,
  catalogState,
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
    // Refused here, before the listener runtime is opened for an issuer
    // that would refuse it anyway.
    typeof admits === 'function' ||
      Fail`${b(label)} broker requires model admission from its account's catalog`;
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
        ...(admits === undefined ? {} : { admits }),
        ...(catalogState === undefined ? {} : { catalogState }),
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
 * One account's catalog as a picker or an operator sees it. Per-account
 * metadata from the account's own catalog owner, which is also what admits
 * its requests. Failure does not masquerade as an empty successful catalog
 * or fall back to configured models: there are none.
 *
 * The answer says on its own whether the account is a lane set aside, so a
 * backend that could not list the declared set still knows what an `auto`
 * session may be offered.
 *
 * @param {string} subscriptionId
 * @param {ReturnType<typeof makeModelCatalogOwner>} catalog
 * @param {boolean} [pinnedOnly]
 */
const readCatalogAccount = async (
  subscriptionId,
  catalog,
  pinnedOnly = false,
) =>
  harden({
    subscriptionId,
    ...(pinnedOnly ? { pinnedOnly: true } : {}),
    ...(await catalog.snapshot()),
  });

/**
 * @typedef {object} CatalogOptions
 * @property {number} [lifetimeMs]
 * @property {number} [maxAgeMs]
 * @property {number} [retryMs]
 */

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
 * @param {CatalogOptions} [powers.catalog]
 */
const makePooledBrokerServiceKit = ({
  label,
  providerId,
  subscriptions,
  brokerOptions,
  reportAccountError,
  catalog: catalogOptions = {},
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
   * @property {ReturnType<typeof makePoolMemberLifecycle>} lifecycle
   * @property {ReturnType<typeof makeModelCatalogOwner>} catalog What the
   *   member's account may be served, as last read from its provider; both
   *   what a picker sees and what admits its requests.
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
  let stopped = false;

  /**
   * A member that is somebody else's subscription: no secret, credential or
   * redeemer of the operator's. What is known of it is what its share
   * publishes, followed while this broker lives and kept as a reading like
   * any other member's, so the pool ranks it and a view shows it.
   *
   * @param {{ id: string, subscriptionName: string }} member
   */
  const wrappedKitOf = member => {
    const lifecycle = makePoolMemberLifecycle();
    subscriptionOf !== undefined ||
      Fail`${b(label)} cannot hold another party's subscription`;
    const subscription = () =>
      /** @type {NonNullable<typeof subscriptionOf>} */ (subscriptionOf)(
        member,
      );
    const account = makeAccountReadingSource({
      activeRead: () =>
        lifecycle.run(async () =>
          readingFromShareStatus(await E(subscription()).getStatus()),
        ),
      reportError: reportAccountError,
      onChange: () => asSubscription.changed(),
    });
    let live = true;
    let stopFollowing = async () => {};
    let wakeFollowing = () => {};
    const follow = async () => {
      await null;
      for (let pause = 5000; live; pause = Math.min(pause * 2, 60_000)) {
        /** @type {any} */
        let events;
        try {
          // eslint-disable-next-line no-await-in-loop
          const reader = await lifecycle.run(
            () => E(subscription()).watchStatus(),
            true,
          );
          events = iterateReader(reader);
          stopFollowing = async () => {
            // Stream history may already contain an unrelated read failure.
            // Independent close retries actual resource release instead of
            // re-observing iterateReader.return()'s cached terminal error.
            await E(reader).close();
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
          // eslint-disable-next-line no-await-in-loop
          await stopFollowing();
          stopFollowing = async () => {};
        }
        if (!live) return;
        // A pause that does not keep the worker alive on its own.
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => {
          const timer = globalThis.setTimeout(resolve, pause);
          wakeFollowing = () => {
            globalThis.clearTimeout(timer);
            resolve(undefined);
          };
          /** @type {any} */ (timer).unref?.();
        });
      }
    };
    const following = follow();
    void following.catch(() => {});
    const closeAccount = async () => {
      live = false;
      wakeFollowing();
      await stopFollowing();
      await following.catch(() => {});
      // Retry any failed reader disposal retained by the follower.
      await stopFollowing();
      await account.close();
    };
    lifecycle.retain(closeAccount);
    // What the share says it admits, as its catalog: ids only, since a
    // share describes no more of what is beneath it than that. Another
    // party's data, bounded and shaped before it is believed, and given a
    // deadline: a far daemon that hangs costs a failed read, not a wedged
    // retirement.
    const catalog = makeModelCatalogOwner({
      read: () =>
        lifecycle.run(async () => {
          const described = await withDeadline(
            E(subscription()).describe(),
            WRAPPED_DESCRIBE_DEADLINE_MS,
          );
          const ids = Array.isArray(described?.models) ? described.models : [];
          return harden({
            observedAt: now(),
            models: [
              ...new Set(
                ids.filter(
                  (/** @type {unknown} */ id) =>
                    typeof id === 'string' && MODEL_ID.test(id),
                ),
              ),
            ]
              .slice(0, 4096)
              .map((/** @type {string} */ id) => ({
                id,
                title: id,
                description: '',
                default: false,
                defaultReasoningEffort: null,
                reasoningEfforts: [],
              })),
          });
        }),
      now,
      ...catalogOptions,
    });
    lifecycle.retain(() => catalog.close());
    return {
      lifecycle,
      secret: undefined,
      credential: undefined,
      adaptRequest: undefined,
      redeemer: undefined,
      catalog,
      subscription,
      account: {
        ...account,
        close: closeAccount,
      },
    };
  };

  /** @param {any} member */
  const kitOf = member => {
    !stopped || Fail`Provider pool is closed`;
    let kit = kits.get(member.id);
    if (kit === undefined && member.subscriptionName !== undefined) {
      kit = wrappedKitOf(member);
      kits.set(member.id, kit);
    }
    if (kit === undefined) {
      const lifecycle = makePoolMemberLifecycle();
      const authority = secretOf(member);
      // Never fence the internal CAS writes of a rotation already sent.
      const rawCredential = credentialOf?.(member, authority);
      const credential =
        rawCredential === undefined
          ? undefined
          : harden({
              accountRef: rawCredential.accountRef,
              current: (...args) =>
                lifecycle.runCredential(() => rawCredential.current(...args)),
            });
      const secret = makeExo(
        'PoolMemberSecretRead',
        M.interface('PoolMemberSecretRead', {
          readBase64: M.call().returns(M.promise()),
        }),
        { readBase64: () => lifecycle.run(() => E(authority).readBase64()) },
      );
      const activeRead = activeReadOf?.({ member, secret, credential });
      const account = makeAccountReadingSource({
        ...(activeRead === undefined
          ? {}
          : { activeRead: () => lifecycle.run(activeRead) }),
        reportError: reportAccountError,
        onChange: () => asSubscription.changed(),
      });
      lifecycle.retain(() => account.close());
      // A catalog read's credential is fenced but not sticky. What is
      // sticky elsewhere is a failure inside `current()` itself (the token
      // read or a renewal exchange), which the lifecycle treats as making
      // retirement uncertain; the credential keeps its own single-flight and
      // write-ahead renewal guards, and its durable intent remains the
      // authority. A catalog read that hits such a failure must not disable
      // the member for inference too, or a picker opening after a restart
      // could retire every account on one transient refresh failure.
      const readCredential =
        rawCredential === undefined
          ? undefined
          : harden({
              accountRef: rawCredential.accountRef,
              current: (...args) =>
                lifecycle.run(() => rawCredential.current(...args)),
            });
      const readModel =
        modelReadOf === undefined
          ? undefined
          : lazyModelRead(() =>
              modelReadOf({ member, secret, credential: readCredential }),
            );
      // Read through the member's lifecycle, so a retired member's credential
      // is not used for a read, and retirement waits for a read in flight.
      const catalog = makeModelCatalogOwner({
        read:
          readModel === undefined ? undefined : () => lifecycle.run(readModel),
        now,
        ...catalogOptions,
      });
      lifecycle.retain(() => catalog.close());
      const redeem = resetRedeemOf?.({ member, secret, credential });
      kit = {
        lifecycle,
        secret,
        credential,
        adaptRequest:
          adaptRequestOf === undefined ? undefined : adaptRequestOf(member),
        account,
        catalog,
        redeemer:
          redeem === undefined
            ? undefined
            : makeResetRedeemer(request =>
                lifecycle.run(() => redeem(request), true),
              ),
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
      !stopped || Fail`Provider pool is closed`;
      const next = normalizeSubscriptionSet(await readSet(), {
        requireAccountRef,
      });
      !stopped || Fail`Provider pool is closed`;
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
      const retiring = [...kits].filter(
        ([id]) => !next.members.some(member => member.id === id),
      );
      for (const [, kit] of retiring) kit.lifecycle.fence();
      await Promise.all(
        retiring.map(async ([id, kit]) => {
          await kit.lifecycle.close();
          kits.delete(id);
        }),
      );
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
            if (stopped) return;
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
            return harden({
              id: member.id,
              subscription: kit.subscription(),
              lifecycle: kit.lifecycle,
              admits: kit.catalog.admits,
              catalogState: () => kit.catalog.peek().state,
              ...(member.pinnedOnly === true ? { pinnedOnly: true } : {}),
            });
          }
          return harden({
            id: member.id,
            lifecycle: kit.lifecycle,
            admits: kit.catalog.admits,
            catalogState: () => kit.catalog.peek().state,
            ...(member.pinnedOnly === true ? { pinnedOnly: true } : {}),
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
    // What an `auto` endpoint may be served: the union of what the accounts
    // not set aside list, from the catalogs held now.
    readModels: async () => {
      const { members } = await load();
      const serving = members.filter(member => member.pinnedOnly !== true);
      const ids = new Set();
      await Promise.all(
        serving.map(async member => {
          const { models } = await kitOf(member).catalog.snapshot();
          for (const model of models) ids.add(model.id);
        }),
      );
      return harden([...ids]);
    },
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
        selected.map(member => {
          const kit = kitOf(member);
          observedKits.set(member.id, kit);
          return readCatalogAccount(
            member.id,
            kit.catalog,
            member.pinnedOnly === true,
          );
        }),
      );
      // Validate the entire batch after its slowest account finishes. A fast
      // account may have been removed while a different account was pending.
      const latest = await load();
      const currentIds = new Set(latest.members.map(member => member.id));
      return harden({
        accounts: accounts.map(account =>
          (account.state === 'current' || account.state === 'stale') &&
          (!currentIds.has(account.subscriptionId) ||
            kits.get(account.subscriptionId) !==
              observedKits.get(account.subscriptionId))
            ? {
                subscriptionId: account.subscriptionId,
                ...(account.pinnedOnly === true ? { pinnedOnly: true } : {}),
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
      closeAccounts: async () => {
        stopped = true;
        for (const kit of kits.values()) kit.lifecycle.fence();
        asSubscription.close();
        await Promise.all([...kits.values()].map(kit => kit.lifecycle.close()));
        await loading;
        await writing;
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
 * @param {Parameters<typeof makeProviderBrokerKit>[0] & { providerId?: string, activeAccountRead?: () => Promise<any>, modelRead?: () => Promise<any>, resetRedeem?: (request: { idempotencyKey: string, creditId?: string }) => Promise<{ outcome: string }>, subscriptions?: PooledSubscriptions, catalog?: CatalogOptions, now?: () => number }} options
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
    catalog: catalogOptions = {},
    now = Date.now,
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
      subscriptions: { now, ...subscriptions },
      brokerOptions,
      reportAccountError,
      catalog: catalogOptions,
    });
  }
  // The one account's catalog: what a picker sees, and what admits every
  // request and every scope that pins a model.
  const catalog = makeModelCatalogOwner({
    read: modelRead,
    now,
    ...catalogOptions,
  });
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
    readModels: async () =>
      harden((await catalog.snapshot()).models.map(model => model.id)),
    openEndpoint: async spec =>
      /** @type {any} */ ((await broker.start()).issuer).openEndpoint(spec),
    readings: async () => [
      { id: 'default', rateLimits: account.peek().rateLimits },
    ],
  });
  const broker = makeProviderBrokerKit({
    ...brokerOptions,
    label,
    admits: catalog.admits,
    catalogState: () => catalog.peek().state,
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
        accounts: [await readCatalogAccount('default', catalog)],
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
      closeAccounts: async () => {
        asSubscription.close();
        await Promise.all([account.close(), catalog.close()]);
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
 * @param {() => void | Promise<void>} owners.closeAccounts
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
    const closingAccounts = closeAccounts();
    closing = (async () => {
      const results = await Promise.allSettled([
        closingScopes,
        closingBroker,
        closingAccounts,
      ]);
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
 * @param {(config: Config) => { policy: BrokerPolicy, accountAuthority: string, adaptRequest?: Parameters<typeof makeProviderBrokerGrantIssuer>[0]['adaptRequest'] }} options.makePolicy
 *   The adapter's policy for a profile, and the account authority the
 *   profile serves (`account-authority.js`): the id the grant reports and
 *   every plan records. The provider account a credential is bound to, where
 *   there is one, is the policy's own `accountRef`.
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
    // This setup flag is not the issuer's runtime pool capability.
    const { pool: pooled, ...serviceConfig } = config;
    const { policy, accountAuthority, adaptRequest } = makePolicy(config);
    const accountRef = assertAccountAuthority(accountAuthority, label);
    // The provider account the adapter's reads and redemptions address: a
    // member's own, else the profile's, else the authority itself for a
    // provider whose account has no id of its own.
    const providerAccountOf = (/** @type {{ accountRef?: string }} */ member) =>
      member.accountRef ??
      /** @type {{ accountRef?: string }} */ (config).accountRef ??
      accountRef;
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
    if (pooled === true) {
      // Several subscriptions: the formula's powers are not one secret but a
      // namespace of the operator's, holding `subscriptions` (the declared
      // set, a stored value an operator rewrites to add a member), each
      // member's secret under its `secretName`, and what the pool keeps.
      const namespace = /** @type {any} */ (secret);
      const state = makeAccountJournal({
        powers: namespace,
        prefix: 'pool-state-v2-',
      });
      const identities = makePoolIdentityJournal({
        namespace,
        providerId: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        origin: policy.origin,
        accountRef,
      });
      /** @type {Map<string, any>} */
      let authorities = new Map();
      const forMember = (/** @type {any} */ member) =>
        /** @type {Config} */ ({
          ...config,
          ...(member.accountRef === undefined
            ? {}
            : { accountRef: member.accountRef }),
        });
      const pooledKit = makeServiceKit({
        ...serviceConfig,
        label,
        policy,
        accountRef,
        secret: undefined,
        subscriptions: {
          readSet: async () => {
            const declared = normalizeSubscriptionSet(
              await E(namespace).lookup('subscriptions'),
              {
                requireAccountRef: makeCredential !== undefined,
              },
            );
            const bound = await identities.bind(declared.members);
            authorities = new Map(
              bound.map(binding => [binding.id, binding.authority]),
            );
            return declared;
          },
          // Identity was durably bound before this callback can construct a
          // credential. Consumers retain the actual capability, never a late
          // mutable pet-name lookup. A failed binding fences the journal.
          secretOf: member =>
            authorities.get(member.id) ?? Fail`Unbound pool secret`,
          // Wrapped subscriptions obey the same durable capability binding.
          subscriptionOf: member =>
            authorities.get(member.id) ?? Fail`Unbound pool subscription`,
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
                    accountRef: providerAccountOf(member),
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
                    accountRef: providerAccountOf(member),
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
                    accountRef: providerAccountOf(member),
                  }),
              }),
          readState: async () => {
            // Legacy observations never identify a credential. Nor may v2
            // observations survive a missing authoritative identity journal.
            if (!identities.wasEstablished()) return undefined;
            const saved = await state.read();
            if (saved?.version !== 2 || !Array.isArray(saved.bindings))
              return undefined;
            const matching = new Set(
              saved.bindings
                .filter(
                  binding => authorities.get(binding.id) === binding.authority,
                )
                .map(binding => binding.id),
            );
            return {
              refusals: Object.fromEntries(
                Object.entries(saved.state?.refusals ?? {}).filter(([id]) =>
                  matching.has(id),
                ),
              ),
              sessions: Object.fromEntries(
                Object.entries(saved.state?.sessions ?? {}).filter(
                  ([, entry]) => matching.has(entry.memberId),
                ),
              ),
            };
          },
          writeState: kept =>
            state.write(
              harden({
                version: 2,
                bindings: [...authorities].map(([id, authority]) => ({
                  id,
                  authority,
                })),
                state: kept,
              }),
            ),
        },
        env,
        ...hooks,
      });
      return harden({
        open: async () => pooledKit.service,
        close: pooledKit.close,
      });
    }
    const credential =
      makeCredential === undefined ? undefined : makeCredential(config, secret);
    const kit = makeServiceKit({
      ...serviceConfig,
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
                accountRef: providerAccountOf({}),
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
              accountRef: providerAccountOf({}),
            }),
          }),
      ...(makeResetRedeem === undefined
        ? {}
        : {
            resetRedeem: makeResetRedeem({
              config,
              secret,
              credential,
              accountRef: providerAccountOf({}),
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
