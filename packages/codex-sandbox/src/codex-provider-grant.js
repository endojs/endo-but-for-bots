// @ts-check
import { Fail, makeError, X } from '@endo/errors';
import { assertPublicNetworkEvidence } from '@endo/hosted-agent/public-network.js';

/**
 * Validate the concrete provider grant before it enters a slice.
 *
 * @param {any} grant
 * @param {{ sessionId: string, imageDigest: string, networkNamespaceId: string, providerOrigin: string, accountRef: string, model?: string, authMode?: 'api-key' | 'oauth', networkPolicy?: string }} requirements
 */
export const assertProviderGrantV1 = (grant, requirements) => {
  const keys = [
    'accountRef',
    'authMode',
    'endpoint',
    'imageDigest',
    'grantId',
    'modelAllowlist',
    'networkNamespaceId',
    'providerOrigin',
    'sessionId',
    'version',
  ];
  if (requirements.networkPolicy === 'public-internet') keys.push('network');
  keys.sort();
  if (requirements.networkPolicy === 'public-internet') {
    grant?.network !== undefined ||
      Fail`Broker public network evidence missing`;
    assertPublicNetworkEvidence(grant.network);
  }
  if (
    Object.keys(grant || {})
      .sort()
      .join(',') !== keys.join(',')
  ) {
    throw makeError(X`broker grant attestation is not exact`);
  }
  const accountRef = /** @type {unknown} */ (grant.accountRef);
  if (
    grant.version !== 'ProviderGrantV1' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(grant.grantId || '') ||
    grant.sessionId !== requirements.sessionId ||
    grant.imageDigest !== requirements.imageDigest ||
    grant.networkNamespaceId !== requirements.networkNamespaceId ||
    grant.providerOrigin !== requirements.providerOrigin ||
    typeof accountRef !== 'string' ||
    accountRef === '' ||
    accountRef.length > 256 ||
    accountRef !== requirements.accountRef
  ) {
    throw makeError(X`broker grant identity does not match the session`);
  }
  // Authentication mode is a property of the host-held broker, never a token
  // delivered to the slice. Refuse a silent API-billing downgrade.
  if (
    !['api-key', 'oauth'].includes(grant.authMode) ||
    (requirements.authMode && grant.authMode !== requirements.authMode)
  ) {
    throw makeError(X`broker grant authentication mode is not supported`);
  }
  let origin;
  let endpoint;
  try {
    origin = new URL(grant.providerOrigin);
    endpoint = new URL(grant.endpoint);
  } catch {
    throw makeError(X`broker grant contains an invalid endpoint`);
  }
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== grant.providerOrigin ||
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw makeError(X`broker grant endpoint is not provider-bound loopback`);
  }
  if (
    !Array.isArray(grant.modelAllowlist) ||
    grant.modelAllowlist.length === 0 ||
    grant.modelAllowlist.some(
      model => typeof model !== 'string' || model === '',
    ) ||
    new Set(grant.modelAllowlist).size !== grant.modelAllowlist.length ||
    (requirements.model && !grant.modelAllowlist.includes(requirements.model))
  ) {
    throw makeError(X`broker grant model allowlist is invalid`);
  }
  return harden(grant);
};
harden(assertProviderGrantV1);
