// @ts-check
// prefer-endo-primitives-exempt: Endo disposal hooks require a callable Far.

import { decodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { Far } from '@endo/far';
import { M } from '@endo/patterns';
import { strictDecodeUtf8 } from '@endo/utf8/strict-decode.js';

import { makeAnthropicModelRead } from './anthropic-model-read.js';
import { makeProviderBrokerGrantIssuer } from './provider-grant-issuer.js';

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
// This issuer has no target image: the factory only opens InferenceEndpoints,
// which carry no attestation, so no grant ever reports this digest. The
// all-zero value is a deliberate sentinel that satisfies the shared issuer's
// digest shape; it is not an image binding.
const NO_TARGET_IMAGE_DIGEST = `sha256:${'0'.repeat(64)}`;

const AnthropicIssuerFactoryInterface = M.interface(
  'AnthropicApiKeyIssuerFactory',
  {
    openEndpoint: M.callWhen(M.record(), M.remotable(), M.record()).returns(
      M.remotable(),
    ),
    disposeProvider: M.callWhen(M.string()).returns(M.undefined()),
    discoverModels: M.callWhen(M.record(), M.remotable()).returns(M.record()),
  },
);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(AnthropicIssuerFactoryInterface);

/**
 * Root-only Anthropic adapter for the provider registry. The factory retains
 * SecretBlob read facets; its endpoints expose only the provider-neutral
 * InferenceEndpoint contract and re-read the API key for each dispatch.
 *
 * @param {object} options
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {(event: any) => void} [options.audit]
 * @param {(reading: any) => void} [options.onReading]
 */
export const makeAnthropicApiKeyIssuerFactory = ({
  fetch = globalThis.fetch,
  audit,
  onReading,
} = {}) => {
  typeof fetch === 'function' || Fail`Anthropic issuer requires fetch`;
  /** @type {Map<string, { secret: any, issuer: any }>} */
  const issuers = new Map();

  /** @param {any} provider */
  const assertProvider = provider => {
    provider?.authMode === undefined ||
      provider.authMode === 'api-key' ||
      Fail`Anthropic OAuth is not enabled by the API-key issuer`;
    (provider?.kind === 'anthropic' &&
      typeof provider.providerId === 'string' &&
      typeof provider.defaultModel === 'string') ||
      Fail`Invalid Anthropic provider`;
  };

  /** @param {any} provider @param {any} secret */
  const provideIssuer = (provider, secret) => {
    assertProvider(provider);
    const prior = issuers.get(provider.providerId);
    if (prior !== undefined) {
      prior.secret === secret || Fail`Anthropic provider secret changed`;
      return prior.issuer;
    }
    const issuer = makeProviderBrokerGrantIssuer({
      runtime: {},
      secret,
      fetch,
      policy: harden({
        origin: ANTHROPIC_ORIGIN,
        routes: harden([
          harden({ method: 'POST', path: '/v1/messages' }),
          harden({ method: 'POST', path: '/v1/messages/count_tokens' }),
        ]),
        credentialHeader: 'x-api-key',
        anthropicVersion: ANTHROPIC_VERSION,
        clientAuthorization: 'reject',
        maxConcurrentRequests: 2,
        maxRequestBytes: 8n * 1024n * 1024n,
        maxResponseBytes: 16n * 1024n * 1024n,
      }),
      imageDigest: NO_TARGET_IMAGE_DIGEST,
      accountRef: provider.providerId,
      audit,
      onReading,
      // The durable grant is the exact model allowlist. The registry validates
      // it before this inner defense and supports well-shaped typed fallback.
      admits: model =>
        typeof model === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(model),
      catalogState: () => 'current',
    });
    issuers.set(provider.providerId, { secret, issuer });
    return issuer;
  };

  const factory = makeExo(
    'AnthropicApiKeyIssuerFactory',
    AnthropicIssuerFactoryInterface,
    {
      async openEndpoint(provider, secret, spec) {
        return provideIssuer(provider, secret).openEndpoint(spec);
      },
      async disposeProvider(providerId) {
        const prior = issuers.get(providerId);
        issuers.delete(providerId);
        await prior?.issuer.dispose();
      },
      async discoverModels(provider, secret) {
        assertProvider(provider);
        return makeAnthropicModelRead({
          fetch,
          readAuthorization: async () => {
            const encoded = await E(secret).readBase64();
            const token = strictDecodeUtf8(decodeBase64(encoded));
            return harden({ header: 'x-api-key', token });
          },
        })();
      },
    },
  );

  return harden({
    factory,
    async close() {
      const open = [...issuers.values()];
      issuers.clear();
      await Promise.all(open.map(({ issuer }) => issuer.dispose()));
    },
  });
};
harden(makeAnthropicApiKeyIssuerFactory);

/** Endo module entry point for a registry's named issuer factory. */
export const make = async (_powers, context) => {
  await null;
  const made = makeAnthropicApiKeyIssuerFactory();
  if (context !== undefined) {
    await E(context).addDisposalHook(
      Far('Dispose Anthropic API-key issuer factory', () => made.close()),
    );
  }
  return made.factory;
};
harden(make);
