// @ts-check

// Provider broker and optional shared public egress for the OpenCode sandbox.
//
// Phase 1 injected the OpenRouter key into the slice and let it reach
// https://openrouter.ai directly, which meant a session with network policy
// "off" could not run a turn at all. This composition gives the slice a
// loopback-only network namespace that it shares with a provider listener
// container: the listener is connected to nothing, the host daemon performs
// the HTTPS request with the credential, and the slice sees only
// http://127.0.0.1:<port>. The opencode SDK insists on an API key and sends it
// as a Bearer header, so the listener admits a client Authorization and never
// forwards it (`clientAuthorization: 'strip'`); the broker injects the real
// OpenRouter key upstream.

import { join } from 'node:path';

import { Fail, q } from '@endo/errors';
import { makeProviderBrokerGrantIssuer } from '@endo/hosted-agent/provider-grant-issuer.js';
import { makePublicEgress } from '@endo/hosted-agent/public-egress.js';
import { makePodmanProviderListenerRuntimeKit } from '@endo/hosted-agent/provider-listener-runtime.js';

/** @import { BrokerPolicy } from '@endo/hosted-agent/provider-broker.js' */

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const OPENROUTER_INFERENCE_PATH = '/api/v1/chat/completions';
export const OPENCODE_BROKER_ACCOUNT = 'openrouter';
export const OPENCODE_BROKER_VERSION = 'OpencodeProviderBrokerV1';

// Per-request buffers and simultaneous operations bound host allocations.
export const DEFAULT_MAX_REQUEST_BYTES = 8n * 1024n ** 2n;
export const DEFAULT_MAX_RESPONSE_BYTES = 16n * 1024n ** 2n;
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
// The podman listener runtime caps the owner id at 64 characters and cleans up
// by exact label; keep the composition inside that bound.
const OWNER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The operator policy for one OpenRouter lease issuer. Exported so the
 * deployment can assert the exact origin, route, and credential handling it
 * configured without reproducing the literal.
 *
 * @param {object} options
 * @param {readonly string[]} options.models - provider-scoped model ids the lease admits
 * @param {number} [options.maxConcurrentRequests]
 * @param {bigint} [options.maxRequestBytes]
 * @param {bigint} [options.maxResponseBytes]
 * @returns {BrokerPolicy}
 */
export const buildOpencodeBrokerPolicy = ({
  models,
  maxConcurrentRequests = 4,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) => {
  (Array.isArray(models) &&
    models.length > 0 &&
    models.every(
      model =>
        typeof model === 'string' && model.length > 0 && !model.includes(' '),
    )) ||
    Fail`OpenCode broker models must be a nonempty list of model ids`;
  return harden({
    origin: OPENROUTER_ORIGIN,
    authMode: /** @type {const} */ ('api-key'),
    routes: [
      {
        method: /** @type {const} */ ('POST'),
        path: OPENROUTER_INFERENCE_PATH,
      },
    ],
    clientAuthorization: /** @type {const} */ ('strip'),
    models: [...models],
    maxConcurrentRequests,
    maxRequestBytes,
    maxResponseBytes,
  });
};

/**
 * Construct an inert OpenRouter broker owner. Retain the kit before start().
 * close() fences admission immediately and retains failed runtime/issuer cleanup
 * for retry, including listener acquisition that completes after close. Runs
 * only with operator powers: it reads the OpenRouter secret, starts listener
 * containers, and mints leases. Callers hand the returned issuer to the
 * sandbox provisioning path and keep the compose/`dispose` authority.
 *
 * @param {object} options
 * @param {any} options.secret - `secrets/openrouter-auth` SecretBlob read facet
 * @param {string} options.ownerId - Stable operator-owned cleanup scope
 * @param {string} options.directory - Private host directory for listener state
 * @param {string} options.imageRef - Pinned slice image ref (used for digest checks)
 * @param {string} options.imageDigest - Slice image digest (`sha256:...`)
 * @param {string} options.listenerImageRef - Pinned listener image ref
 * @param {readonly string[]} options.models - Model ids this broker admits
 * @param {Record<string,string>} [options.env] Trusted operator host environment overrides.
 * @param {boolean} [options.publicInternet] Operator permits public egress grants.
 * @param {number} [options.maxSessions]
 * @param {any} [options.audit]
 * @param {(diagnostic: any) => void} [options.onDiagnostic]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {any} [options.runtime] - Injectable provider listener runtime (tests)
 * @param {ReturnType<typeof makePodmanProviderListenerRuntimeKit>} [options.runtimeKit]
 *   Injectable retained runtime owner (tests); mutually exclusive with runtime.
 * @param {typeof makeProviderBrokerGrantIssuer} [options.makeIssuer]
 *   Injectable synchronous issuer constructor (tests).
 * @returns {{start: () => Promise<{issuer: any, imageRef: string}>, close: () => Promise<void>}}
 */
export const makeOpencodeBrokerKit = ({
  secret,
  ownerId,
  directory,
  imageRef,
  imageDigest,
  listenerImageRef,
  models,
  maxSessions,
  env,
  publicInternet = false,
  audit,
  onDiagnostic,
  fetch: fetchAuthority = globalThis.fetch,
  runtime,
  runtimeKit,
  makeIssuer = makeProviderBrokerGrantIssuer,
}) => {
  typeof publicInternet === 'boolean' ||
    Fail`Invalid public network configuration`;
  DIGEST_PATTERN.test(imageDigest) ||
    Fail`OpenCode broker image digest must be pinned, got ${q(imageDigest)}`;
  (typeof imageRef === 'string' && imageRef.endsWith(`@${imageDigest}`)) ||
    Fail`OpenCode broker image ref must match its digest, got ${q(imageRef)}`;
  OWNER_PATTERN.test(ownerId) ||
    Fail`OpenCode broker owner id is invalid, got ${q(ownerId)}`;
  (typeof directory === 'string' &&
    directory.startsWith('/') &&
    directory.length > 1) ||
    Fail`OpenCode broker directory must be absolute`;
  (typeof listenerImageRef === 'string' &&
    listenerImageRef.includes('@sha256:')) ||
    Fail`OpenCode listener image must be digest-pinned`;
  // A remote exo presence exposes no own properties; `readBase64` is only
  // reachable through eventual send. Accept any object/function presence, but
  // still refuse a local cap that carries an explicitly broken reader
  // (`{ readBase64: null }`), which the old typeof check missed.
  const isPresence = value =>
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null);
  isPresence(secret) || Fail`OpenCode broker requires a SecretBlob read facet`;
  Object.hasOwn(secret, 'readBase64') &&
    !isPresence(secret.readBase64) &&
    Fail`OpenCode broker requires a SecretBlob read facet`;
  typeof fetchAuthority === 'function' ||
    Fail`OpenCode broker requires an outbound fetch authority`;

  const policy = buildOpencodeBrokerPolicy({ models });
  runtime === undefined ||
    runtimeKit === undefined ||
    Fail`Supply one OpenCode listener runtime owner`;
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
    !stopped || Fail`OpenCode broker is closed`;
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
        fetch: fetchAuthority,
        imageDigest,
        accountRef: OPENCODE_BROKER_ACCOUNT,
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
        throw AggregateError(failures, 'OpenCode broker cleanup pending');
    })();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return attempt;
  };
  return harden({ start, close });
};
harden(makeOpencodeBrokerKit);

/**
 * Transitional convenience entrypoint. If startup and rollback both fail, the
 * rejected promise does not retain a public cleanup handle or prove release.
 * Native owners must retain makeOpencodeBrokerKit() before starting instead.
 * @param {Parameters<typeof makeOpencodeBrokerKit>[0]} options
 */
export const makeOpencodeBroker = async options => {
  const kit = makeOpencodeBrokerKit(options);
  try {
    const broker = await kit.start();
    return harden({ ...broker, dispose: kit.close });
  } catch (error) {
    try {
      await kit.close();
    } catch (cleanupError) {
      throw AggregateError(
        [error, cleanupError],
        'OpenCode broker startup and cleanup failed',
      );
    }
    throw error;
  }
};
harden(makeOpencodeBroker);
