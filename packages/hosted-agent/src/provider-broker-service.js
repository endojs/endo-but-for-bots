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
import { makeProviderBrokerGrantIssuer } from './provider-grant-issuer.js';
import { makePodmanProviderListenerRuntimeKit } from './provider-listener-runtime.js';
import { makeProviderScopes } from './provider-scopes.js';
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
  onListenerDiagnostic,
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
  isPresence(secret) ||
    Fail`${b(label)} broker requires a SecretBlob read facet`;
  Object.hasOwn(secret, 'readBase64') &&
    !isPresence(secret.readBase64) &&
    Fail`${b(label)} broker requires a SecretBlob read facet`;
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
 * @param {Parameters<typeof makeProviderBrokerKit>[0]} options
 */
export const makeProviderBrokerServiceKit = options => {
  const { label } = options;
  const broker = makeProviderBrokerKit(options);
  const scopes = makeProviderScopes({
    openIssuer: async () => (await broker.start()).issuer,
  });
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
  return harden({ service: scopes.service, close });
};
harden(makeProviderBrokerServiceKit);

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
 * @template {{ ownerId: string, directory: string, imageRef: string, imageDigest: string, listenerImageRef: string, publicInternet?: boolean, maxSessions?: number, diagnostics?: boolean }} Config
 * @param {object} options
 * @param {string} options.label
 * @param {(env: Record<string, string>) => Config} options.readConfig The
 *   adapter's persisted operator profile reader.
 * @param {(config: Config) => { policy: BrokerPolicy, accountRef: string, adaptRequest?: Parameters<typeof makeProviderBrokerGrantIssuer>[0]['adaptRequest'] }} options.makePolicy
 *   The adapter's policy for a profile.
 * @param {(config: Config, secret: any) => Parameters<typeof makeProviderBrokerGrantIssuer>[0]['credential']} [options.makeCredential]
 *   Synchronous, inert adapter credential construction, once per owned service.
 *   The secret may include renewal CAS authority, never exposed to sessions.
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
    const kit = makeServiceKit({
      ...config,
      label,
      policy,
      accountRef,
      secret,
      adaptRequest,
      ...(makeCredential === undefined
        ? {}
        : { credential: makeCredential(config, secret) }),
      env,
      ...hooks,
    });
    return harden({ open: async () => kit.service, close: kit.close });
  };
  return makeOwnedNativeService({ readConfig, makeKit, reportError });
};
harden(makeOwnedProviderBrokerService);
