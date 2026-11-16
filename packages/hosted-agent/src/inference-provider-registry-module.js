// @ts-check
// prefer-endo-primitives-exempt: disposal hooks require callable remotables;
// makeExo creates method-bearing objects, not callable facets.

/** @import { ERef } from '@endo/eventual-send' */

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { Far } from '@endo/far';
import { M } from '@endo/patterns';
import { randomUUID } from 'node:crypto';

import {
  makeEndoSecretParticipant,
  makeInferenceProviderRegistry,
} from './inference-provider-registry.js';
import { makeSnapshotJournal } from './snapshot-journal.js';

const RegistryRootInterface = M.interface('InferenceProviderRegistry', {
  directoryFor: M.call(M.string()).returns(M.remotable()),
  useFor: M.call(M.string(), M.string()).returns(M.remotable()),
  inferenceFor: M.call(M.string()).returns(M.remotable()),
  revokeGrant: M.callWhen(M.string()).returns(M.undefined()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(RegistryRootInterface);

/**
 * Root-private provider registry caplet. Its powers are the root host, which
 * owns the snapshot namespace and `@secrets`; an issuer factory is retained by
 * name and resolved anew after daemon restart.
 *
 * @param {ERef<any>} powers
 * @param {any} context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, context, { env } = {}) => {
  const issuerFactoryName =
    env?.INFERENCE_PROVIDER_ISSUER_FACTORY ||
    Fail`Provider registry has no issuer factory`;

  const registry = await makeInferenceProviderRegistry({
    journal: makeSnapshotJournal({
      powers,
      prefix: 'inference-provider-registry-v1-',
    }),
    secrets: makeEndoSecretParticipant(powers),
    makeIssuer: async ({ descriptor, secret }) => {
      const factory = await E(powers).lookup(issuerFactoryName);
      return harden({
        openEndpoint: spec =>
          E(factory).openEndpoint(
            harden({
              providerId: descriptor.providerId,
              kind: descriptor.kind,
              defaultModel: descriptor.defaultModel,
            }),
            secret,
            spec,
          ),
        dispose: () => E(factory).disposeProvider(descriptor.providerId),
      });
    },
    validateLimits: limits => {
      (limits && typeof limits === 'object' && !Array.isArray(limits)) ||
        Fail`Invalid provider limits`;
      return harden({ .../** @type {Record<string, unknown>} */ (limits) });
    },
    randomId: randomUUID,
  });
  if (context !== undefined) {
    await E(context).addDisposalHook(
      Far('Dispose inference provider registry', () => registry.close()),
    );
  }
  return makeExo('InferenceProviderRegistry', RegistryRootInterface, {
    directoryFor: ownerId => registry.directoryFor(ownerId),
    useFor: (ownerId, providerId) => registry.useFor(ownerId, providerId),
    inferenceFor: grantId => registry.inferenceFor(grantId),
    revokeGrant: grantId => registry.revokeGrant(grantId),
  });
};
harden(make);
