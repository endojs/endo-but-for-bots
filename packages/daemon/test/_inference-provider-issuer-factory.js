// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { randomUUID } from 'node:crypto';

export const make = async () => {
  const instance = randomUUID();
  /** @type {Map<string, Set<any>>} */
  const endpoints = new Map();
  return Far('TestInferenceProviderIssuerFactory', {
    openEndpoint: async (provider, secret, spec) => {
      // The trusted broker-side factory, not the registry or returned endpoint,
      // is the component that receives the retained SecretBlob.
      const key = await E(secret).readBase64();
      let revoked = false;
      const endpoint = Far('TestAgentInferenceEndpoint', {
        request: async message => {
          if (revoked) throw Error('test endpoint revoked');
          return harden({
            status: 200,
            headers: {},
            body: JSON.stringify({
              instance,
              sessionId: spec.sessionId,
              providerId: provider.providerId,
              keyWasPresented: typeof key === 'string' && key.length > 0,
              path: message.path,
            }),
          });
        },
        requestByteStream: async () => {
          throw Error('test stream not implemented');
        },
        attestation: async () =>
          harden({ version: 'test-v1', sessionId: spec.sessionId }),
        revoke: async () => {
          revoked = true;
          endpoints.get(provider.providerId)?.delete(endpoint);
        },
      });
      let providerEndpoints = endpoints.get(provider.providerId);
      if (providerEndpoints === undefined) {
        providerEndpoints = new Set();
        endpoints.set(provider.providerId, providerEndpoints);
      }
      providerEndpoints.add(endpoint);
      return endpoint;
    },
    disposeProvider: async providerId => {
      const providerEndpoints = endpoints.get(providerId) || [];
      await Promise.all(
        [...providerEndpoints].map(endpoint => E(endpoint).revoke()),
      );
      endpoints.delete(providerId);
    },
  });
};
harden(make);
