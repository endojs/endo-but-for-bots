// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * @typedef {{ method: string, path: string }} Route
 * @typedef {{ origin: string, routes: Route[], models: string[], expiresAt: number,
 * maxRequests: bigint, maxRequestBytes: bigint, maxResponseBytes: bigint,
 * maxTotalBytes: bigint, maxCostMicrounits: bigint,
 * maxCostMicrounitsPerRequest: bigint, credentialHeader?: 'bearer' | 'x-api-key',
 * anthropicVersion?: string, authMode?: 'api-key' }} BrokerPolicy
 * @typedef {{ url: string, method: string, headers: Record<string, string>,
 * body: string, redirect: 'error', maxResponseBytes: bigint }} UpstreamRequest
 */

/**
 * A bounded inference capability, not an HTTP listener or sandbox attestation.
 * The trusted transport MUST enforce redirect:'error' before following any
 * redirect and maxResponseBytes while reading, and must not forward ambient
 * cookies or credentials. It alone receives the upstream credential.
 * The operator must supply a conservative upper cost bound for each request;
 * reservations are never refunded, including on failure. This is admission
 * accounting, not a claim about actual provider billing.
 * Revocation prevents new dispatch and delivery, but cannot undo a request
 * already dispatched. Production transports must separately support teardown.
 * Literal token echoes are rejected as defense in depth; the upstream remains
 * trusted not to encode or otherwise disclose its own authorization credential.
 *
 * @param {BrokerPolicy} policy
 * @param {object} powers
 * @param {{ readBase64(): Promise<string> }} powers.secret - SecretBlob read facet
 * @param {{ request(request: UpstreamRequest): Promise<{status: number, body: string}> }} powers.transport
 * @param {() => number} powers.now - Trusted epoch-millisecond clock
 * @param {(event: {event: string, requests: bigint}) => void} [powers.audit]
 */
export const makeProviderBrokerLease = (
  policy,
  { secret, transport, now, audit = () => {} },
) => {
  // Copy and validate operator input so later mutation cannot widen authority.
  const {
    origin,
    expiresAt,
    maxRequests,
    maxRequestBytes,
    maxResponseBytes,
    maxTotalBytes,
    maxCostMicrounits,
    maxCostMicrounitsPerRequest,
  } = policy;
  policy.authMode === undefined ||
    policy.authMode === 'api-key' ||
    Fail`Unsupported broker authentication mode`;
  const credentialHeader = policy.credentialHeader ?? 'bearer';
  credentialHeader === 'bearer' ||
    credentialHeader === 'x-api-key' ||
    Fail`Unsupported credential header`;
  const { anthropicVersion } = policy;
  anthropicVersion === undefined ||
    /^\d{4}-\d{2}-\d{2}$/.test(anthropicVersion) ||
    Fail`Invalid Anthropic version`;
  const parsedOrigin = new URL(origin);
  (parsedOrigin.protocol === 'https:' &&
    parsedOrigin.origin === origin &&
    !parsedOrigin.username &&
    !parsedOrigin.password) ||
    Fail`Invalid provider origin`;
  const routes = policy.routes.map(({ method, path }) => {
    // Exact paths only: no normalization, query, fragment, percent escaping,
    // alternate authority or dot segments can affect dispatch.
    (method === 'POST' &&
      ['/v1/responses', '/v1/messages', '/v1/chat/completions'].includes(
        path,
      ) &&
      /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) ||
      Fail`Invalid inference route`;
    return `${method} ${path}`;
  });
  routes.length > 0 || Fail`Inference routes required`;
  const models = [...policy.models];
  (models.length > 0 &&
    models.every(model => typeof model === 'string' && model.length > 0)) ||
    Fail`Models required`;
  Number.isFinite(expiresAt) || Fail`Invalid expiry`;
  for (const limit of [
    maxRequests,
    maxRequestBytes,
    maxResponseBytes,
    maxTotalBytes,
    maxCostMicrounits,
    maxCostMicrounitsPerRequest,
  ]) {
    (typeof limit === 'bigint' && limit > 0n) || Fail`Positive quota required`;
  }
  let revoked = false;
  let requests = 0n;
  let reservedBytes = 0n;
  let reservedCostMicrounits = 0n;
  const checkLive = () => {
    const time = now();
    (!revoked && Number.isFinite(time) && time < expiresAt) ||
      Fail`Broker lease inactive`;
  };
  /** @param {string} event */
  const record = event => {
    // Never pass errors, request data, headers, model names or credentials to
    // an audit hook. A failing sink must not expose its own exception either.
    try {
      audit(harden({ event, requests }));
    } catch (_error) {
      revoked = true;
    }
  };
  const endpoint = makeExo(
    'ProviderInferenceLease',
    M.interface('ProviderInferenceLease', {
      request: M.call(
        M.splitRecord({
          method: M.string(),
          path: M.string(),
          body: M.string(),
        }),
      ).returns(M.promise()),
    }),
    {
      /** @param {{method: string, path: string, body: string}} request */
      async request({ method, path, body }) {
        checkLive();
        routes.includes(`${method} ${path}`) || Fail`Inference route denied`;
        let requestBytes = BigInt(new TextEncoder().encode(body).length);
        requestBytes <= maxRequestBytes || Fail`Request byte quota exceeded`;
        let data;
        try {
          data = JSON.parse(body);
        } catch (_error) {
          Fail`Invalid inference JSON`;
        }
        (data &&
          typeof data === 'object' &&
          !Array.isArray(data) &&
          typeof data.model === 'string' &&
          models.includes(data.model)) ||
          Fail`Model denied`;
        const canonicalBody = JSON.stringify(data);
        const canonicalBytes = BigInt(
          new TextEncoder().encode(canonicalBody).length,
        );
        canonicalBytes <= maxRequestBytes || Fail`Request byte quota exceeded`;
        if (canonicalBytes > requestBytes) requestBytes = canonicalBytes;
        const reservation = requestBytes + maxResponseBytes;
        (requests < maxRequests &&
          reservedBytes + reservation <= maxTotalBytes &&
          reservedCostMicrounits + maxCostMicrounitsPerRequest <=
            maxCostMicrounits) ||
          Fail`Broker quota exhausted`;
        // Reserve synchronously, before retrieving the secret: concurrent calls
        // cannot each spend the same remaining quota.
        requests += 1n;
        reservedBytes += reservation;
        reservedCostMicrounits += maxCostMicrounitsPerRequest;
        record('admitted');
        try {
          checkLive();
          const encoded = await E(secret).readBase64();
          const credential = globalThis.atob(encoded);
          /^[\x21-\x7e]+$/.test(credential) || Fail`Invalid credential`;
          checkLive();
          const response = await E(transport).request(
            harden({
              url: `${origin}${path}`,
              method,
              headers: {
                ...(credentialHeader === 'bearer'
                  ? { authorization: `Bearer ${credential}` }
                  : { 'x-api-key': credential }),
                ...(anthropicVersion === undefined
                  ? {}
                  : { 'anthropic-version': anthropicVersion }),
                'content-type': 'application/json',
              },
              body: canonicalBody,
              redirect: /** @type {const} */ ('error'),
              maxResponseBytes,
            }),
          );
          checkLive();
          (Number.isInteger(response.status) &&
            response.status >= 200 &&
            response.status < 300 &&
            typeof response.body === 'string' &&
            BigInt(new TextEncoder().encode(response.body).length) <=
              maxResponseBytes &&
            !response.body.includes(credential) &&
            !response.body.includes(encoded)) ||
            Fail`Invalid provider response`;
          record('completed');
          checkLive();
          // No upstream headers (including cookies or authentication challenges)
          // escape through the lease. Upstream error bodies are never returned.
          return harden({ status: response.status, body: response.body });
        } catch (_error) {
          record('failed');
          return Fail`Provider request failed`;
        }
      },
    },
  );
  const admin = makeExo(
    'ProviderInferenceLeaseAdmin',
    M.interface('ProviderInferenceLeaseAdmin', {
      revoke: M.call().returns(M.undefined()),
      getStatus: M.call().returns(M.record()),
    }),
    {
      revoke() {
        revoked = true;
        record('revoked');
      },
      getStatus() {
        return harden({
          revoked,
          requests,
          reservedBytes,
          reservedCostMicrounits,
          expiresAt,
        });
      },
    },
  );
  return harden({ endpoint, admin });
};
harden(makeProviderBrokerLease);
