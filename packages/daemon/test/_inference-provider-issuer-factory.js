// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { randomUUID } from 'node:crypto';

const TestIssuerFactoryInterface = M.interface('TestIssuerFactory', {
  openEndpoint: M.callWhen(M.record(), M.remotable(), M.record()).returns(
    M.remotable(),
  ),
  disposeProvider: M.callWhen(M.string()).returns(M.undefined()),
});
const TestInferenceEndpointInterface = M.interface('TestInferenceEndpoint', {
  request: M.callWhen(M.record()).returns(M.record()),
  requestByteStream: M.callWhen(M.record()).returns(M.record()),
  attestation: M.callWhen().returns(M.record()),
  revoke: M.callWhen().returns(M.undefined()),
});

export const make = async () => {
  const instance = randomUUID();
  /** @type {Map<string, Set<any>>} */
  const endpoints = new Map();
  return makeExo(
    'TestInferenceProviderIssuerFactory',
    TestIssuerFactoryInterface,
    {
      openEndpoint: async (provider, secret, spec) => {
        // The trusted broker-side factory, not the registry or returned endpoint,
        // is the component that receives the retained SecretBlob.
        const key = await E(secret).readBase64();
        let revoked = false;
        const endpoint = makeExo(
          'TestAgentInferenceEndpoint',
          TestInferenceEndpointInterface,
          {
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
          },
        );
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
    },
  );
};
harden(make);
