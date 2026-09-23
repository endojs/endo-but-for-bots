// @ts-check
import { E } from '@endo/eventual-send';
import {
  makeOwnedProviderBrokerService,
  makeProviderBrokerServiceKit,
} from '../src/provider-broker-service.js';

const digest = `sha256:${'a'.repeat(64)}`;

/** Real formula fixture: fake provider gates, actual capability journal. */
export const make = async (namespace, context) => {
  const control = await E(namespace).lookup('pool-control');
  const construct = makeOwnedProviderBrokerService({
    label: 'Pool retirement fixture',
    readConfig: () => ({
      pool: true,
      ownerId: 'pool-retirement-fixture',
      accountRef: 'pool',
      directory: '/tmp/pool-fixture-never-opened',
      imageRef: `localhost/fixture@${digest}`,
      imageDigest: digest,
      listenerImageRef: `localhost/fixture@${digest}`,
    }),
    makePolicy: () => ({
      policy: { origin: 'https://provider.invalid' },
      accountAuthority: 'pool',
    }),
    makeCredential: (config, secret) => {
      void E(control).note('construct');
      return harden({
        accountRef: config.accountRef,
        current: () => E(secret).renew(),
      });
    },
    makeActiveAccountRead:
      ({ credential }) =>
      async () => {
        await credential.current();
        return {};
      },
    makeModelRead:
      ({ credential }) =>
      async () => {
        await credential.current();
        return harden({ observedAt: 1, models: [] });
      },
    makeServiceKit: options => {
      const kit = makeProviderBrokerServiceKit({
        ...options,
        runtimeKit: {
          open: async () => {
            throw Error('Metadata must not start runtime');
          },
          close: async () => {},
        },
      });
      return harden({
        service: kit.service,
        close: async () => {
          await E(control).note('close-start');
          await kit.close();
          await E(control).note('close-ack');
        },
      });
    },
  });
  return construct(namespace, context);
};
harden(make);
