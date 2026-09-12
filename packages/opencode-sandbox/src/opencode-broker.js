// @ts-check

// Broker-only provider egress for the OpenCode sandbox.
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
import { makeProviderBrokerLeaseIssuer } from '@endo/hosted-agent/provider-lease-issuer.js';
import { makePodmanProviderListenerRuntime } from '@endo/hosted-agent/provider-listener-runtime.js';

/** @import { BrokerPolicy } from '@endo/hosted-agent/provider-broker.js' */

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const OPENROUTER_INFERENCE_PATH = '/api/v1/chat/completions';
export const OPENCODE_BROKER_ACCOUNT = 'openrouter';
export const OPENCODE_BROKER_VERSION = 'OpencodeProviderBrokerV1';

// Conservative ceilings mirroring the sibling Codex broker: 64 bounded
// requests per lease, a full 8 MiB request plus 16 MiB response reserved for
// each, and one cost unit per request so a runaway session cannot drain an
// unbounded account.
export const DEFAULT_MAX_REQUESTS = 64n;
export const DEFAULT_MAX_REQUEST_BYTES = 8n * 1024n ** 2n;
export const DEFAULT_MAX_RESPONSE_BYTES = 16n * 1024n ** 2n;
export const DEFAULT_LEASE_DURATION_MS = 60 * 60 * 1000;
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
 * @param {string[]} options.models - provider-scoped model ids the lease admits
 * @param {bigint} [options.maxRequests]
 * @param {bigint} [options.maxRequestBytes]
 * @param {bigint} [options.maxResponseBytes]
 * @returns {Omit<BrokerPolicy, 'expiresAt'>}
 */
export const buildOpencodeBrokerPolicy = ({
  models,
  maxRequests = DEFAULT_MAX_REQUESTS,
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
    maxRequests,
    maxRequestBytes,
    maxResponseBytes,
    // Every admitted request may reserve a full response; cover the whole
    // request budget rather than a smaller per-window value.
    maxTotalBytes: maxRequests * (maxRequestBytes + maxResponseBytes),
    maxCostMicrounits: maxRequests,
    maxCostMicrounitsPerRequest: 1n,
  });
};

/**
 * Compose the OpenRouter broker over a podman provider-listener runtime. Runs
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
 * @param {string[]} options.models - Model ids this broker admits
 * @param {number} [options.maxSessions]
 * @param {any} [options.audit]
 * @param {(diagnostic: any) => void} [options.onDiagnostic]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {any} [options.runtime] - Injectable provider listener runtime (tests)
 * @returns {Promise<{issuer: any, imageRef: string, dispose: () => Promise<void>}>}
 */
export const makeOpencodeBroker = async ({
  secret,
  ownerId,
  directory,
  imageRef,
  imageDigest,
  listenerImageRef,
  models,
  maxSessions,
  audit,
  onDiagnostic,
  fetch: fetchAuthority = globalThis.fetch,
  runtime,
}) => {
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
  typeof secret?.readBase64 === 'function' ||
    typeof secret?.readBase64 === 'object' ||
    Fail`OpenCode broker requires a SecretBlob read facet`;
  typeof fetchAuthority === 'function' ||
    Fail`OpenCode broker requires an outbound fetch authority`;

  const policy = buildOpencodeBrokerPolicy({ models });
  const listener =
    runtime ??
    (await makePodmanProviderListenerRuntime({
      imageRef: listenerImageRef,
      ownerId,
      stateDirectory: join(directory, 'listener'),
      ...(maxSessions === undefined ? {} : { maxListeners: maxSessions }),
    }));
  let issuer;
  try {
    issuer = makeProviderBrokerLeaseIssuer({
      runtime: listener,
      secret,
      fetch: fetchAuthority,
      imageDigest,
      accountRef: OPENCODE_BROKER_ACCOUNT,
      leaseDurationMs: DEFAULT_LEASE_DURATION_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      policy,
      ...(audit === undefined ? {} : { audit }),
      ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
    });
  } catch (error) {
    // Do not leave the runtime's owner lock held when admission of the issuer
    // itself fails (a future policy/digest option can throw here).
    await listener.dispose().catch(() => {});
    throw error;
  }
  const dispose = async () => {
    const failures = [];
    try {
      await issuer.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await listener.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, 'OpenCode broker cleanup pending');
  };
  // `imageRef` participates in deployment assertions; keep it in the composed
  // value so callers never have to re-derive the pairing. Do not deep-harden
  // the wrapper: `runtime`/`listener` may be caller-owned state (or a test
  // double) whose arrays must stay mutable.
  harden(dispose);
  return harden({ issuer, imageRef, dispose });
};
harden(makeOpencodeBroker);
